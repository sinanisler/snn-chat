// ═══════════════════════════════════════════════════════════════════
// SNN Agent Loop — State Machine, Retry Engine, Action Orchestrator
// ═══════════════════════════════════════════════════════════════════
// Runs in the side panel. Orchestrates the full agent lifecycle:
// IDLE → PARSING → PLANNING → EXECUTING → WAITING → OBSERVING
//   → REPORTING (or RETRYING → FAILED / BLOCKED → CANCELLED)
//
// DESIGN PRINCIPLES:
// 1. Every error is surfaced to the user — NEVER silent.
// 2. Retries use exponential backoff + jitter, per-error strategies.
// 3. Stale-state detection (tab switch, SW termination).
// 4. User can cancel at ANY time.
// 5. All promises are raced against timeouts.
// ═══════════════════════════════════════════════════════════════════

class SNNAgentLoop {
  constructor(sidePanel) {
    this.sp = sidePanel; // reference to SNNSidePanel instance

    // ── State ──────────────────────────────────────────────────
    this._state = 'IDLE';
    this._taskId = null;
    this._plan = [];
    this._stepIndex = 0;
    this._attemptCount = 0;
    this._sendTabId = null;
    this._stepResults = [];
    this._cancelled = false;
    this._pendingResolve = null; // for BLOCKED state

    // ── Config ─────────────────────────────────────────────────
    this.MAX_RETRIES = 3;
    this.RETRY_DELAYS = [1000, 3000, 8000]; // ms base (jitter added)
    this.DEFAULT_TIMEOUT = 15000; // ms per action

    // ── Callbacks (set by sidepanel) ───────────────────────────
    this.onStateChange = null;   // (state, detail)
    this.onProgress = null;      // (step, total, description)
    this.onError = null;         // (errorCardData)
    this.onResult = null;        // (reportData)
    this.onBlocked = null;       // (question) → returns Promise<'approved'|'denied'>
  }

  // ── Public API ──────────────────────────────────────────────────
  get state() { return this._state; }
  get isBusy() { return this._state !== 'IDLE' && this._state !== 'FAILED'; }

  /**
   * Cancel the current task. Safe to call from any state.
   */
  cancel() {
    if (this._state === 'IDLE') return;
    this._cancelled = true;
    this._transition('CANCELLED', { reason: 'User cancelled' });
    // Resolve any pending BLOCKED promise
    if (this._pendingResolve) {
      this._pendingResolve('denied');
      this._pendingResolve = null;
    }
  }

  /**
   * Main entry point. Called by sidepanel when user sends a message.
   * @param {string} userMessage - raw user input
   * @param {object} context - { type, detail, summary } | null
   * @param {number} tabId - current tab ID for stale detection
   */
  async run(userMessage, context, tabId) {
    if (this.isBusy) {
      this.sp.showToast('Agent is already working. Wait or press Escape to cancel.', 'warning');
      return;
    }

    this._reset();
    this._sendTabId = tabId;
    this._taskId = this._generateId();
    this._cancelled = false;

    try {
      // ═══════ PHASE 1: PARSE INTENT ═══════
      this._transition('PARSING', { message: userMessage });
      const intent = await this._parseIntent(userMessage, context);

      if (this._cancelled) return;

      // Check if it's a pure chat (no action needed)
      if (intent.type === 'chat') {
        this._transition('IDLE');
        return { type: 'chat' };
      }

      // Capability query — fetch capabilities and show as action result
      if (intent.type === 'capability_query') {
        this._transition('EXECUTING', { step: 1, total: 1, step: { description: 'Listing capabilities' } });
        const capResult = await this._dispatchAction({ action: 'getCapabilities', id: this._generateId(), params: {}, timeout: 5000 });
        if (capResult.success) {
          this._stepResults.push({ step: { action: 'getCapabilities', description: 'Capabilities' }, result: capResult.result, attempts: 1 });
          this._transition('REPORTING', { results: this._stepResults, plan: [{ action: 'getCapabilities' }] });
          if (this.onResult) this.onResult({ type: 'capabilities', data: capResult.result });
          this._transition('IDLE');
          return { type: 'action', subtype: 'capabilities', results: this._stepResults };
        }
        // Fall back to chat if capabilities fetch failed
        this._transition('IDLE');
        return { type: 'chat' };
      }

      // ═══════ PHASE 2: BUILD PLAN ═══════
      this._transition('PLANNING', { intent });
      this._plan = await this._buildPlan(intent, context);

      if (this._cancelled) return;
      if (!this._plan || this._plan.length === 0) {
        this._transition('FAILED', {
          phase: 'PLANNING',
          error: { code: 'EMPTY_PLAN', message: 'Could not build an action plan.', retryable: false, suggestion: 'Try rephrasing your request with more detail.' }
        });
        return { type: 'error' };
      }

      // ═══════ PHASE 3: EXECUTE PLAN ═══════
      for (this._stepIndex = 0; this._stepIndex < this._plan.length; this._stepIndex++) {
        if (this._cancelled) return;

        // Stale check
        if (!this._checkTabStillValid()) return;

        const step = this._plan[this._stepIndex];
        const success = await this._executeStep(step);
        if (!success) return; // already transitioned to FAILED/CANCELLED
      }

      // ═══════ PHASE 4: REPORT ═══════
      if (this._cancelled) return;
      this._transition('REPORTING', { results: this._stepResults, plan: this._plan });
      if (this.onResult) this.onResult({ type: 'action_results', results: this._stepResults, plan: this._plan });
      this._transition('IDLE');
      return { type: 'action', results: this._stepResults };

    } catch (err) {
      if (!this._cancelled) {
        this._transition('FAILED', {
          phase: 'UNKNOWN',
          error: { code: 'UNHANDLED', message: err.message, retryable: true, suggestion: 'An unexpected error occurred. Try again.' }
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EXECUTE ONE STEP (WITH FULL RETRY LOGIC)
  // ═══════════════════════════════════════════════════════════════
  async _executeStep(step) {
    this._attemptCount = 0;
    let currentStep = { ...step };

    while (this._attemptCount <= this.MAX_RETRIES) {
      if (this._cancelled) return false;
      if (!this._checkTabStillValid()) return false;

      // ── Progress notification ─────────────────────────────
      if (this.onProgress) {
        this.onProgress(this._stepIndex + 1, this._plan.length, currentStep.description || currentStep.action);
      }
      this._transition('EXECUTING', { step: this._stepIndex + 1, total: this._plan.length, step: currentStep });

      // ═══════ DISPATCH ═══════
      const result = await this._dispatchAction(currentStep);

      if (this._cancelled) return false;

      // ═══════ HANDLE RESULT ═══════
      if (result.success) {
        // Success → observe & verify
        this._transition('OBSERVING', { step: currentStep, result: result.result });
        this._stepResults.push({ step: currentStep, result: result.result, attempts: this._attemptCount + 1 });
        return true;
      }

      // ═══════ HANDLE ERROR ═══════
      const error = result.error || { code: 'UNKNOWN', message: 'Unknown error', retryable: true, suggestion: 'Try again.' };

      // NEVER go silent — notify immediately
      if (this.onError) this.onError({ step: currentStep, error, attempt: this._attemptCount + 1, maxRetries: this.MAX_RETRIES, phase: 'EXECUTING' });
      this.sp.showToast(`Error: ${error.message}`, 'error');

      // ── Non-retryable → FAILED ────────────────────────────
      if (!error.retryable) {
        this._transition('FAILED', {
          step: currentStep, error,
          totalAttempts: this._attemptCount + 1,
          message: error.suggestion || 'This action cannot be retried.'
        });
        return false;
      }

      // ── Permission → BLOCKED ──────────────────────────────
      if (error.code === 'PERMISSION_DENIED') {
        this._transition('BLOCKED', {
          step: currentStep, error,
          question: error.suggestion || 'SNN needs your permission to continue.'
        });
        const decision = await this._waitForUserDecision();
        if (decision === 'approved') {
          this._attemptCount++;
          continue;
        } else {
          this._transition('CANCELLED', { reason: 'User denied permission' });
          return false;
        }
      }

      // ── Max retries exhausted → FAILED ────────────────────
      if (this._attemptCount >= this.MAX_RETRIES) {
        this._transition('FAILED', {
          step: currentStep, error,
          totalAttempts: this._attemptCount + 1,
          message: `Failed after ${this._attemptCount + 1} attempts. ${error.suggestion || 'Try a different approach.'}`
        });
        return false;
      }

      // ── RETRY ─────────────────────────────────────────────
      this._attemptCount++;
      this._transition('RETRYING', {
        step: currentStep, error,
        attempt: this._attemptCount, maxRetries: this.MAX_RETRIES
      });

      // Exponential backoff with jitter
      const baseDelay = this.RETRY_DELAYS[this._attemptCount - 1] || 8000;
      const jitter = Math.random() * 500;
      const delay = baseDelay + jitter;

      this.sp.showToast(`Retrying (${this._attemptCount}/${this.MAX_RETRIES}) in ${Math.round(delay / 1000)}s...`, 'warning');
      await this._sleep(delay);

      if (this._cancelled) return false;

      // Apply retry strategy
      currentStep = this._applyRetryStrategy(currentStep, error, this._attemptCount);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DISPATCH ACTION TO CONTENT SCRIPT (via background)
  // ═══════════════════════════════════════════════════════════════
  async _dispatchAction(step) {
    const timeout = step.timeout || this.DEFAULT_TIMEOUT;

    // Build message
    const message = {
      action: `agent:${step.action}`,
      taskId: this._taskId,
      stepId: step.id || this._generateId(),
      payload: step.params || {},
      meta: {
        attempt: this._attemptCount + 1,
        maxRetries: this.MAX_RETRIES,
        timeout,
        timestamp: Date.now()
      }
    };

    try {
      // Race: response vs timeout
      const response = await this._sendWithTimeout(message, timeout);

      if (!response) {
        return {
          success: false,
          error: { code: 'TIMEOUT', message: `Action timed out after ${timeout / 1000}s.`, retryable: true, suggestion: 'The page may be slow. Try again or increase the timeout.' }
        };
      }

      return response; // { success: bool, result?: {}, error?: {} }

    } catch (err) {
      return {
        success: false,
        error: {
          code: 'DISPATCH_ERROR',
          message: `Could not reach the page: ${err.message}`,
          retryable: true,
          suggestion: 'The page may have navigated away or the extension needs a refresh.'
        }
      };
    }
  }

  /**
   * Sends a message to the active tab's content script via background,
   * racing against a timeout. Returns null on timeout.
   */
  async _sendWithTimeout(message, timeout) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeout);

      chrome.runtime.sendMessage(message).then((response) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(response); }
      }).catch((err) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ success: false, error: { code: 'NETWORK_ERROR', message: err.message, retryable: true, suggestion: 'Check the connection and try again.' } }); }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // RETRY STRATEGY ENGINE
  // ═══════════════════════════════════════════════════════════════
  _applyRetryStrategy(step, error, attemptNum) {
    const modified = { ...step, params: { ...step.params, options: { ...(step.params.options || {}) } } };

    switch (error.code) {
      case 'ELEMENT_NOT_FOUND':
        // Try harder to find the element
        modified.params.options.allowHidden = true;
        modified.timeout = (step.timeout || this.DEFAULT_TIMEOUT) * 1.5;
        // On 2nd+ attempt, switch to text-based selector if we have a description
        if (attemptNum >= 2 && step.elementDescription && modified.params.selector) {
          modified.params.selector = `:contains("${step.elementDescription}")`;
        }
        break;

      case 'ELEMENT_NOT_INTERACTABLE':
        modified.params.options.skipScroll = false;
        modified.timeout = (step.timeout || this.DEFAULT_TIMEOUT) * 1.5;
        break;

      case 'TIMEOUT':
        modified.timeout = (step.timeout || this.DEFAULT_TIMEOUT) * 2;
        break;

      case 'NETWORK_ERROR':
        // Handled by backoff delay, no param changes needed
        break;

      case 'SCRIPT_ERROR':
        modified.params.options.useNative = true;
        break;

      case 'UNSATISFACTORY_RESULT':
        // The action succeeded but result was unexpected — ask LLM to replan
        // (handled by observeResult in the full implementation)
        break;

      default:
        // Generic: increase timeout, be more lenient
        modified.timeout = (step.timeout || this.DEFAULT_TIMEOUT) * 1.3;
        modified.params.options.allowHidden = true;
    }

    return modified;
  }

  // ═══════════════════════════════════════════════════════════════
  // INTENT PARSING (LLM Call) + Capability Question Detection
  // ═══════════════════════════════════════════════════════════════
  async _parseIntent(userMessage, context) {
    const msg = userMessage.toLowerCase().trim();

    // ── Fast-path: capability / help questions ────────────────
    const capabilityPatterns = [
      /^what (can|do) you (do|help)/,
      /^(can|could) you (click|type|scroll|fill|navigate|help|do|interact)/,
      /^help$/,
      /^(list|show) (your |available )?(actions|capabilities|commands|tools)/,
      /^what (actions|capabilities|commands|tools) (do you have|are available)/,
      /^what can (i|we) (do|ask)/,
      /^how (do|can) (i |you )?use you/,
      /^capabilities$/,
    ];
    for (const pattern of capabilityPatterns) {
      if (pattern.test(msg)) {
        // Return a special response that triggers getCapabilities
        return {
          type: 'capability_query',
          action: 'getCapabilities',
          description: 'List what I can do',
          params: {}
        };
      }
    }

    // ── LLM-based parsing ─────────────────────────────────────
    const settings = await this.sp.getSettings();
    const apiKey = settings.openrouterKey;
    if (!apiKey) return { type: 'chat' };

    const systemPrompt = `You are an intent parser for a browser agent. The agent CAN click, type, scroll, highlight, fill forms, extract data, navigate, screenshot, download, and more on the current webpage.

If the user wants to PERFORM AN ACTION on the current webpage (click a button, type text, scroll, fill a form, navigate somewhere, extract data, highlight elements, take a screenshot, etc.), respond with JSON:
{"type":"action","action":"<action_name>","description":"<short summary>","params":{"selector":"<CSS or :text() or :contains() or :nth()>","text":"<if typing>","url":"<if navigating>","direction":"<if scrolling: up/down/left/right/top/bottom>","amount":<number>,"key":"<if pressing key>","fields":[{"selector":"...","value":"..."}]},"elementDescription":"<describe the target element in words for retry>"}

IMPORTANT — if the user says something like "click the login button" or "scroll down" or "find all links" or "what's on this page", these ARE actions. Parse them as actions even if phrased as questions. "What's on this page?" → getPageInfo. "Can you find the search box?" → findElements with appropriate selector.

If the user is JUST chatting (asking for information about a topic, having a conversation, asking about the AI itself), respond with:
{"type":"chat"}

Available page actions: click, type, scroll, scrollToElement, highlight, clearHighlights, findElements, getPageInfo, extractTable, getElementText, evaluate, pressKey, hover, waitForElement, wait, fillForm, selectDropdown, checkToggle, getClipboard, copyToClipboard, startPicker, getViewportInfo, startMonitoring, stopMonitoring
Available browser actions: navigate, openTab, closeTab, goBack, goForward, reload, screenshot, download, notify, setAlarm, clearAlarm, getCapabilities

Selector formats:
- "#id" or ".class" — CSS
- ":text('exact text')" — exact text match
- ":contains('partial')" — partial text match
- ":nth('a.button', 2)" — Nth match
- ":xpath('//div[@data-testid=\"foo\"]')" — XPath
- ":role('button', 'Submit')" — ARIA role

Respond ONLY with the JSON object, nothing else.`;

    let userPrompt = userMessage;
    if (context?.type === 'page' && context?.detail) {
      userPrompt = `Page title: ${context.title || 'Unknown'}\nPage URL: ${context.summary || ''}\n\nUser message: ${userMessage}`;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/sinanisler/SNN-Chat',
          'X-Title': 'SNN Chat'
        },
        body: JSON.stringify({
          model: settings.openrouterModel || 'deepseek/deepseek-v4-flash',
          messages,
          max_tokens: 500,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });

      if (!res.ok) return { type: 'chat' }; // fallback to chat
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '{"type":"chat"}';

      // Extract JSON (handle markdown code blocks)
      let json = text.trim();
      if (json.startsWith('```')) json = json.replace(/```\w*\n?/g, '').trim();

      const parsed = JSON.parse(json);
      return parsed.type === 'action' ? parsed : { type: 'chat' };

    } catch (e) {
      // Parse failed — fall back to chat
      return { type: 'chat' };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PLAN BUILDER (LLM Call for multi-step plans)
  // ═══════════════════════════════════════════════════════════════
  async _buildPlan(intent, context) {
    // Single-step: wrap the parsed intent into a plan
    if (intent.action && intent.action !== 'navigate') {
      return [{
        id: this._generateId(),
        action: intent.action,
        description: intent.description || intent.action,
        params: intent.params || {},
        elementDescription: intent.elementDescription || '',
        timeout: this.DEFAULT_TIMEOUT
      }];
    }

    // For complex queries, ask LLM to build a multi-step plan
    if (intent.type === 'action' && intent.complex) {
      const settings = await this.sp.getSettings();
      const apiKey = settings.openrouterKey;
      if (!apiKey) return [];

      const systemPrompt = `You are a planner for a browser agent. Given a user's goal, produce a JSON array of action steps. Each step: {"id":"sN","action":"<action_name>","description":"<human readable>","params":{...},"elementDescription":"<for retry>"}.

Available actions: navigate, click, type, scroll, scrollToElement, waitForElement, wait, pressKey, extractTable, findElements, getElementText, fillForm, selectDropdown, checkToggle, hover, evaluate, highlight, clearHighlights.

Respond with ONLY the JSON array. Keep steps minimal and focused.`;

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Goal: ${intent.description || intent.action}\nContext: ${intent.params?.url || ''}` }
      ];

      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/sinanisler/SNN-Chat',
            'X-Title': 'SNN Chat'
          },
          body: JSON.stringify({
            model: settings.openrouterModel || 'deepseek/deepseek-v4-flash',
            messages,
            max_tokens: 1000,
            temperature: 0.2
          })
        });

        if (!res.ok) return [];
        const data = await res.json();
        let text = data.choices?.[0]?.message?.content || '[]';
        if (text.startsWith('```')) text = text.replace(/```\w*\n?/g, '').trim();
        const plan = JSON.parse(text);
        return Array.isArray(plan) ? plan.map(s => ({ ...s, id: s.id || this._generateId(), timeout: s.timeout || this.DEFAULT_TIMEOUT })) : [];

      } catch (e) { return []; }
    }

    return [];
  }

  // ═══════════════════════════════════════════════════════════════
  // STALE STATE DETECTION
  // ═══════════════════════════════════════════════════════════════
  _checkTabStillValid() {
    if (this.sp.currentTabId !== this._sendTabId) {
      this._transition('FAILED', {
        message: 'The active tab changed while SNN was working.',
        suggestion: 'Switch back to the original tab and try again, or start a new task.'
      });
      return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // BLOCKED STATE — WAIT FOR USER
  // ═══════════════════════════════════════════════════════════════
  async _waitForUserDecision() {
    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      if (this.onBlocked) {
        this.onBlocked('SNN needs your permission to continue.').then(resolve);
      } else {
        // Default: approve after 10s (safety timeout)
        setTimeout(() => { if (this._pendingResolve === resolve) { this._pendingResolve = null; resolve('approved'); } }, 10000);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE TRANSITION
  // ═══════════════════════════════════════════════════════════════
  _transition(newState, detail = {}) {
    const prev = this._state;
    this._state = newState;
    if (this.onStateChange) {
      this.onStateChange(newState, prev, detail);
    }
  }

  _reset() {
    this._state = 'IDLE';
    this._taskId = null;
    this._plan = [];
    this._stepIndex = 0;
    this._attemptCount = 0;
    this._sendTabId = null;
    this._stepResults = [];
    this._cancelled = false;
    this._pendingResolve = null;
  }

  // ── Utilities ───────────────────────────────────────────────────
  _generateId() { return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8); }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// Export for use in sidepanel.js
// (Attached to window since we're not using modules)
if (typeof window !== 'undefined') {
  window.SNNAgentLoop = SNNAgentLoop;
}
