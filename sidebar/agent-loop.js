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
   * Main entry point. Uses OpenRouter native tool calling for reliable action selection.
   * The LLM receives all SNN actions as tool definitions and decides what to do.
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
      // ═══════ CAPABILITY FAST-PATH ═══════
      const capResult = this._checkCapabilityQuery(userMessage);
      if (capResult) return await this._handleCapabilityQuery();

      // ═══════ AGENTIC LOOP WITH TOOL CALLING ═══════
      this._transition('PARSING', { message: userMessage });

      const settings = await this.sp.getSettings();
      const apiKey = settings.openrouterKey;
      if (!apiKey) { this._transition('IDLE'); return { type: 'chat' }; }

      const tools = this._getToolDefinitions(settings);
      const systemPrompt = this._buildToolSystemPrompt(settings);

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ];

      // Add page context if available
      if (context?.type === 'page' && context?.detail) {
        messages.splice(1, 0, {
          role: 'system',
          content: `[CURRENT PAGE]\nTitle: ${context.title || 'Unknown'}\nURL: ${context.summary || ''}\nWord count: ${context.wordCount || 0}\n\nThe user may refer to content on this page. Use the page actions (snn_getPageInfo, snn_findElements, etc.) to explore it.`
        });
      }

      const MAX_ITERATIONS = 8;
      let iteration = 0;
      let finalContent = null;

      while (iteration < MAX_ITERATIONS && !this._cancelled) {
        iteration++;
        if (!this._checkTabStillValid()) return;

        const response = await this._callLLMWithTools(messages, tools, settings);
        if (this._cancelled) return;

        const choice = response.choices?.[0];
        if (!choice) break;

        const msg = choice.message;

        // ── Tool calls ──────────────────────────────────────
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Add assistant message (with tool_calls) to history
          messages.push(msg);

          // Execute each tool call
          for (const tc of msg.tool_calls) {
            if (this._cancelled) break;
            if (!this._checkTabStillValid()) return;

            const fnName = tc.function?.name || '';
            const fnArgs = this._safeParseJSON(tc.function?.arguments || '{}');

            // Map tool name to our action and execute
            const actionResult = await this._executeToolCall(fnName, fnArgs, iteration);

            // Add tool result to messages
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: typeof actionResult === 'string' ? actionResult : JSON.stringify(actionResult)
            });
          }

          this._transition('OBSERVING', { iteration });
          continue; // Loop back to let LLM process tool results
        }

        // ── Final content (no more tool calls) ──────────────
        if (msg.content && !msg.tool_calls) {
          finalContent = msg.content;
          break;
        }

        // ── Empty response ──────────────────────────────────
        break;
      }

      if (this._cancelled) return;

      // ═══════ REPORT ═══════
      if (this._stepResults.length > 0) {
        this._transition('REPORTING', { results: this._stepResults });
        if (this.onResult) this.onResult({ type: 'action_results', results: this._stepResults, plan: this._plan });
      }

      this._transition('IDLE');

      // If LLM produced a final answer, return it as chat response
      // so the sidepanel renders it as a normal AI message
      if (finalContent && this._stepResults.length === 0) {
        return { type: 'chat' };
      }

      return {
        type: 'action',
        results: this._stepResults,
        llmResponse: finalContent || null
      };

    } catch (err) {
      if (!this._cancelled) {
        const failData = {
          phase: 'AGENTIC_LOOP',
          totalAttempts: 1,
          error: { code: 'UNHANDLED', message: err.message, retryable: true, suggestion: 'An unexpected error occurred. Try again.' }
        };
        if (this.onError) this.onError(failData);
        this._transition('FAILED', failData);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TOOL DEFINITIONS — All SNN actions as OpenRouter tool schemas
  // ═══════════════════════════════════════════════════════════════

  /**
   * Build the tools array for OpenRouter native tool calling.
   * Only includes actions that are NOT disabled in settings.
   */
  _getToolDefinitions(settings) {
    const disabled = settings.disabledActions || [];
    const enabled = (name) => !disabled.includes(name);

    const allTools = [
      // ── Page Interaction ──────────────────────────────────
      { name: 'snn_click', desc: 'Click a button, link, or element on the page', params: {
        selector: { type: 'string', desc: 'CSS selector, :text("exact"), :contains("partial"), :nth("a.button",2), or :role("button","Name")' }
      }, required: ['selector'] },
      { name: 'snn_type', desc: 'Type text into an input field or textarea', params: {
        selector: { type: 'string', desc: 'Selector for the input/textarea' },
        text: { type: 'string', desc: 'Text to type' },
        clearFirst: { type: 'boolean', desc: 'Clear existing text first (default false)' }
      }, required: ['selector', 'text'] },
      { name: 'snn_scroll', desc: 'Scroll the page in a direction or to top/bottom', params: {
        direction: { type: 'string', desc: 'up, down, left, right, top, or bottom' },
        amount: { type: 'integer', desc: 'Pixels to scroll (ignored for top/bottom)' }
      }, required: ['direction'] },
      { name: 'snn_highlight', desc: 'Visually highlight an element with a colored overlay', params: {
        selector: { type: 'string', desc: 'Selector for the element to highlight' },
        color: { type: 'string', desc: 'CSS color for the highlight border (optional)' }
      }, required: ['selector'] },
      { name: 'snn_hover', desc: 'Hover the mouse over an element to trigger tooltips/dropdowns', params: {
        selector: { type: 'string', desc: 'Selector for the element to hover over' }
      }, required: ['selector'] },
      { name: 'snn_pressKey', desc: 'Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.)', params: {
        key: { type: 'string', desc: 'Key name: Enter, Escape, Tab, ArrowDown, ArrowUp, PageDown, etc.' },
        selector: { type: 'string', desc: 'Optional: target element to send key to' }
      }, required: ['key'] },
      { name: 'snn_wait', desc: 'Wait for a specified number of milliseconds', params: {
        ms: { type: 'integer', desc: 'Milliseconds to wait (default 1000)' }
      }, required: [] },

      // ── Page Info & Extraction ────────────────────────────
      { name: 'snn_getPageInfo', desc: 'Get summary of current page: title, URL, forms, links, images, buttons count', params: {}, required: [] },
      { name: 'snn_findElements', desc: 'Find all elements matching a CSS selector, returns tag, text, visibility, attributes for each', params: {
        selector: { type: 'string', desc: 'CSS selector like "a.nav-link", "button", "input[type=text]", "h2"' },
        limit: { type: 'integer', desc: 'Max results (default 50)' }
      }, required: ['selector'] },
      { name: 'snn_extractTable', desc: 'Extract a table as structured data (headers + rows)', params: {
        selector: { type: 'string', desc: 'CSS selector for the table element (default: first table on page)' }
      }, required: [] },
      { name: 'snn_getElementText', desc: 'Get the full text content of a specific element', params: {
        selector: { type: 'string', desc: 'Selector for the element' }
      }, required: ['selector'] },
      { name: 'snn_takeScreenshot', desc: 'Capture a screenshot of the visible page area', params: {}, required: [] },

      // ── Forms ─────────────────────────────────────────────
      { name: 'snn_fillForm', desc: 'Fill multiple form fields at once', params: {
        fields: { type: 'array', desc: 'Array of {selector, value} objects', items: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } } } }
      }, required: ['fields'] },
      { name: 'snn_selectDropdown', desc: 'Select an option from a dropdown/select element', params: {
        selector: { type: 'string', desc: 'Selector for the select element' },
        value: { type: 'string', desc: 'Option value or visible text to select' }
      }, required: ['selector', 'value'] },
      { name: 'snn_checkToggle', desc: 'Check or uncheck a checkbox/radio input', params: {
        selector: { type: 'string', desc: 'Selector for the checkbox/radio' },
        checked: { type: 'boolean', desc: 'true to check, false to uncheck' }
      }, required: ['selector', 'checked'] },

      // ── Navigation & Browser ──────────────────────────────
      { name: 'snn_navigate', desc: 'Navigate the current tab to a URL. The page links will be auto-detected from navigation.', params: {
        url: { type: 'string', desc: 'Full URL or just the link text (e.g., "homepage", "blog"). If not a full URL, agent will scan page links to find match.' }
      }, required: ['url'] },
      { name: 'snn_openTab', desc: 'Open a URL in a new browser tab', params: {
        url: { type: 'string', desc: 'URL to open' }
      }, required: ['url'] },
      { name: 'snn_goBack', desc: 'Go back in browser history', params: {}, required: [] },
      { name: 'snn_goForward', desc: 'Go forward in browser history', params: {}, required: [] },
      { name: 'snn_reload', desc: 'Reload/refresh the current page', params: {}, required: [] },

      // ── Advanced ──────────────────────────────────────────
      { name: 'snn_evaluate', desc: 'Execute custom JavaScript on the page and return the result', params: {
        code: { type: 'string', desc: 'JavaScript code to execute. Use document.querySelector() etc.' }
      }, required: ['code'] },
      { name: 'snn_startPicker', desc: 'Enter element picker mode: hover to highlight elements, click to select one. Returns element info.', params: {}, required: [] },
      { name: 'snn_copyToClipboard', desc: 'Copy text to the system clipboard', params: {
        text: { type: 'string', desc: 'Text to copy' }
      }, required: ['text'] },
      { name: 'snn_getCapabilities', desc: 'Get the full list of all available actions and capabilities', params: {}, required: [] }
    ];

    // Build OpenRouter tool format
    const tools = [];
    for (const t of allTools) {
      const actionName = t.name.replace('snn_', '');
      if (!enabled(actionName)) continue;

      // Build properties schema
      const properties = {};
      const required = [];
      for (const [key, config] of Object.entries(t.params)) {
        if (key === 'desc') continue;
        if (config.type === 'array') {
          properties[key] = { type: 'array', items: config.items || { type: 'string' }, description: config.desc || '' };
        } else {
          properties[key] = { type: config.type, description: config.desc || '' };
        }
        if (t.required && t.required.includes(key)) required.push(key);
      }

      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.desc,
          parameters: {
            type: 'object',
            properties,
            required: required.length > 0 ? required : undefined
          }
        }
      });
    }

    return tools;
  }

  /**
   * Build the system prompt for the tool-calling LLM.
   */
  _buildToolSystemPrompt(settings) {
    const agentPrompt = settings.agentPrompt || this.sp._getDefaultAgentPrompt?.() || '';
    return `${agentPrompt}

You are SNN Chat, a browser agent that can interact with web pages in real-time. You have access to tools (functions) that let you click, type, scroll, navigate, extract data, fill forms, and more.

HOW TO WORK:
1. When the user asks you to DO something on the page, USE THE TOOLS provided. Don't just describe what you would do — actually call the tools.
2. You can chain multiple tool calls: e.g., navigate → wait → click → findElements.
3. After tools return results, synthesize a helpful response in the user's language.
4. For selectors, prefer :text("exact text") for finding buttons/links by their visible text. Use :contains("partial") for partial matches.
5. When navigating: if the user says "go to X page", use snn_navigate with the link text as the url parameter. The agent will automatically find the correct link.
6. ALWAYS describe what you're about to do before calling tools.

IMPORTANT: Never say you cannot interact with the page. You CAN. Use the tools.`;
  }

  /**
   * Call OpenRouter with tools parameter.
   */
  async _callLLMWithTools(messages, tools, settings) {
    const apiKey = settings.openrouterKey;
    const model = settings.openrouterModel || 'deepseek/deepseek-v4-flash';

    const body = {
      model,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: settings.maxTokens || 4096,
      temperature: settings.temperature ?? 0.7
    };

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/sinanisler/SNN-Chat',
        'X-Title': 'SNN Chat'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      throw new Error(`API error ${res.status}: ${errText.substring(0, 200)}`);
    }

    return await res.json();
  }

  /**
   * Execute a single tool call from the LLM.
   * Maps OpenRouter tool names → SNN action names → dispatch.
   */
  async _executeToolCall(fnName, fnArgs, iteration) {
    // Map tool name to action name (remove snn_ prefix)
    const actionName = fnName.startsWith('snn_') ? fnName.slice(4) : fnName;

    // Special handling for capability query
    if (actionName === 'getCapabilities') {
      const result = await this._dispatchAction({ action: 'getCapabilities', id: this._generateId(), params: {}, timeout: 5000 });
      return result.success ? result.result : { error: 'Could not load capabilities' };
    }

    // Build step for tracking
    const step = {
      id: this._generateId(),
      action: actionName,
      description: this._describeToolCall(fnName, fnArgs),
      params: this._mapToolArgsToParams(actionName, fnArgs),
      timeout: this.DEFAULT_TIMEOUT
    };

    this._plan.push(step);
    this._stepIndex = this._plan.length - 1;

    // Show in UI
    if (this.sp._agentUI) {
      this.sp._agentUI.addActionHistoryEntry(actionName, step.description, 'start');
    }

    this._transition('EXECUTING', { step: this._stepIndex + 1, total: this._plan.length, step });

    // Dispatch with retry
    this._attemptCount = 0;
    let result = await this._dispatchAction(step);

    // Simple retry for failures
    while (!result.success && this._attemptCount < this.MAX_RETRIES && !this._cancelled) {
      this._attemptCount++;
      this._transition('RETRYING', { attempt: this._attemptCount, maxRetries: this.MAX_RETRIES });
      await this._sleep(this.RETRY_DELAYS[this._attemptCount - 1] || 8000);
      if (this._cancelled) break;
      step.params = this._applyRetryStrategy(step, result.error || {}, this._attemptCount).params;
      result = await this._dispatchAction(step);
    }

    // Record result
    if (result.success) {
      this._stepResults.push({ step, result: result.result, attempts: this._attemptCount + 1 });
      if (this.sp._agentUI) {
        this.sp._agentUI.updateLastActionEntry('ok', this._formatActionResult(step, result.result));
      }
      return result.result;
    } else {
      if (this.sp._agentUI) {
        this.sp._agentUI.updateLastActionEntry('fail', result.error?.message || 'Failed');
      }
      return { error: result.error?.message || 'Action failed', code: result.error?.code || 'UNKNOWN' };
    }
  }

  /**
   * Map tool arguments to our internal params format.
   */
  _mapToolArgsToParams(actionName, args) {
    switch (actionName) {
      case 'navigate': return { url: args.url || '' };
      case 'click': return { selector: args.selector || '' };
      case 'type': return { selector: args.selector || '', text: args.text || '', options: args.clearFirst ? { clearFirst: true } : {} };
      case 'scroll': return { direction: args.direction || 'down', amount: args.amount || 500 };
      case 'highlight': return { selector: args.selector || '', options: args.color ? { color: args.color } : {} };
      case 'hover': return { selector: args.selector || '' };
      case 'pressKey': return { key: args.key || 'Enter', selector: args.selector || null };
      case 'wait': return { ms: args.ms || 1000 };
      case 'findElements': return { selector: args.selector || '', options: args.limit ? { limit: args.limit } : {} };
      case 'extractTable': return { selector: args.selector || '' };
      case 'getElementText': return { selector: args.selector || '' };
      case 'fillForm': return { fields: args.fields || [] };
      case 'selectDropdown': return { selector: args.selector || '', value: args.value || '' };
      case 'checkToggle': return { selector: args.selector || '', checked: args.checked !== false };
      case 'openTab': return { url: args.url || '' };
      case 'evaluate': return { code: args.code || '' };
      case 'copyToClipboard': return { text: args.text || '' };
      default: return args || {};
    }
  }

  /**
   * Human-readable description of what a tool call is doing.
   */
  _describeToolCall(fnName, args) {
    const a = args || {};
    switch (fnName) {
      case 'snn_click': return `Click ${a.selector || 'element'}`;
      case 'snn_type': return `Type "${(a.text || '').substring(0, 30)}" into ${a.selector || 'field'}`;
      case 'snn_scroll': return a.direction === 'bottom' ? 'Scroll to bottom of page' : `Scroll ${a.direction || 'down'} ${a.amount || ''}`;
      case 'snn_highlight': return `Highlight ${a.selector || 'element'}`;
      case 'snn_hover': return `Hover over ${a.selector || 'element'}`;
      case 'snn_pressKey': return `Press ${a.key || 'key'}`;
      case 'snn_wait': return `Wait ${a.ms || 1000}ms`;
      case 'snn_getPageInfo': return 'Get page information';
      case 'snn_findElements': return `Find "${a.selector || 'elements'}"`;
      case 'snn_extractTable': return 'Extract table data';
      case 'snn_getElementText': return `Get text of ${a.selector || 'element'}`;
      case 'snn_takeScreenshot': return 'Take screenshot';
      case 'snn_fillForm': return `Fill ${(a.fields || []).length} form fields`;
      case 'snn_selectDropdown': return `Select "${a.value || ''}" in dropdown`;
      case 'snn_checkToggle': return `${a.checked !== false ? 'Check' : 'Uncheck'} toggle`;
      case 'snn_navigate': return `Navigate to ${a.url || 'page'}`;
      case 'snn_openTab': return `Open tab: ${a.url || ''}`;
      case 'snn_goBack': return 'Go back';
      case 'snn_goForward': return 'Go forward';
      case 'snn_reload': return 'Reload page';
      case 'snn_evaluate': return 'Execute JavaScript';
      case 'snn_startPicker': return 'Element picker mode';
      case 'snn_copyToClipboard': return 'Copy to clipboard';
      case 'snn_getCapabilities': return 'List capabilities';
      default: return fnName;
    }
  }

  /**
   * Fast-path capability query detection (no LLM needed).
   */
  _checkCapabilityQuery(msg) {
    const patterns = [
      /^what (can|do) you (do|help)/, /^(can|could) you (click|type|scroll|fill|navigate|help|do|interact)/,
      /^help$/, /^(list|show) (your |available )?(actions|capabilities|commands|tools)/,
      /^what (actions|capabilities|commands|tools)/, /^what can (i|we) (do|ask)/,
      /^how (do|can) (i |you )?use you/, /^capabilities$/
    ];
    return patterns.some(p => p.test(msg.toLowerCase().trim()));
  }

  async _handleCapabilityQuery() {
    if (this.sp._agentUI) {
      this.sp._agentUI.addActionHistoryEntry('getCapabilities', 'Listing what I can do', 'start');
    }
    this._transition('EXECUTING', { step: 1, total: 1, step: { description: 'Listing capabilities' } });
    const capResult = await this._dispatchAction({ action: 'getCapabilities', id: this._generateId(), params: {}, timeout: 5000 });
    if (capResult.success) {
      this._stepResults.push({ step: { action: 'getCapabilities', description: 'Capabilities' }, result: capResult.result, attempts: 1 });
      if (this.sp._agentUI) {
        const count = (capResult.result.pageActions?.length || 0) + (capResult.result.browserActions?.length || 0);
        this.sp._agentUI.updateLastActionEntry('ok', `${count} actions available`);
      }
      this._transition('REPORTING', { results: this._stepResults });
      if (this.onResult) this.onResult({ type: 'capabilities', data: capResult.result });
    } else {
      if (this.sp._agentUI) this.sp._agentUI.updateLastActionEntry('fail', 'Could not load capabilities');
    }
    this._transition('IDLE');
    return { type: 'action', subtype: 'capabilities', results: this._stepResults };
  }

  /**
   * Safely parse JSON without throwing.
   */
  _safeParseJSON(str) {
    try { return JSON.parse(str); } catch (e) { return {}; }
  }
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

      // ── Action history entry ──────────────────────────────
      if (this.sp._agentUI) {
        this.sp._agentUI.addActionHistoryEntry(
          currentStep.action,
          currentStep.description || currentStep.action,
          'start'
        );
      }

      // ═══════ DISPATCH ═══════
      const result = await this._dispatchAction(currentStep);

      if (this._cancelled) return false;

      // ═══════ HANDLE RESULT ═══════
      if (result.success) {
        // Success → observe & verify
        this._transition('OBSERVING', { step: currentStep, result: result.result });
        this._stepResults.push({ step: currentStep, result: result.result, attempts: this._attemptCount + 1 });

        // Update action history to success
        if (this.sp._agentUI) {
          const detail = this._formatActionResult(currentStep, result.result);
          this.sp._agentUI.updateLastActionEntry('ok', detail);
        }

        // ── After navigation, re-scan links for remaining navigation steps ──
        if (currentStep.action === 'navigate') {
          // Re-enhance remaining plan steps with fresh page links
          const remaining = this._plan.slice(this._stepIndex + 1);
          const enhanced = await this._enhanceNavigationPlan(remaining);
          // Replace remaining steps with enhanced ones
          this._plan.splice(this._stepIndex + 1, remaining.length, ...enhanced);
        }

        return true;
      }

      // ═══════ HANDLE ERROR ═══════
      const error = result.error || { code: 'UNKNOWN', message: 'Unknown error', retryable: true, suggestion: 'Try again.' };

      // NEVER go silent — update action history as failed
      if (this.sp._agentUI) {
        this.sp._agentUI.updateLastActionEntry('fail', error.message);
      }

      // Toast the error immediately (NOT a full error card — that only shows on FAILED)
      this.sp.showToast(`${error.message}`, 'error');

      // ── Non-retryable → FAILED ────────────────────────────
      if (!error.retryable) {
        const failData = {
          step: currentStep, error,
          totalAttempts: this._attemptCount + 1,
          message: error.suggestion || 'This action cannot be retried.'
        };
        if (this.onError) this.onError(failData);
        this._transition('FAILED', failData);
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
        const totalAttempts = this._attemptCount + 1;
        const failData = {
          step: currentStep,
          error,
          totalAttempts,
          message: `Failed after ${totalAttempts} attempt${totalAttempts > 1 ? 's' : ''}. ${error.suggestion || 'Try a different approach.'}`
        };
        // Fire onError for the error card (terminal — show full card)
        if (this.onError) this.onError(failData);
        this._transition('FAILED', failData);
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

LANGUAGE: Always respond in English. The description and elementDescription fields MUST be in English regardless of the user's language.

If the user wants to PERFORM AN ACTION on the current webpage (click a button, type text, scroll, fill a form, navigate somewhere, extract data, highlight elements, take a screenshot, etc.), respond with JSON:
{"type":"action","action":"<action_name>","description":"<short English summary>","params":{"selector":"<CSS or :text() or :contains() or :nth()>","text":"<if typing>","url":"<if navigating>","direction":"<if scrolling: up/down/left/right/top/bottom>","amount":<number>,"key":"<if pressing key>","fields":[{"selector":"...","value":"..."}]},"elementDescription":"<describe target element in English>"}

IMPORTANT: Always use :text() or :contains() for text-based selectors. When the user says "click page 2", use :text("2") to find the EXACT visible text, not :text("page 2"). Match what's ACTUALLY on the page.

MULTI-STEP TASKS: If the user says "go to X then Y then Z" or "do A, then B, after that C", respond with a COMPLEX action:
{"type":"action","complex":true,"action":"multi_step","description":"<English summary>","params":{"description":"<full task in English>"}}

CRITICAL FOR NAVIGATION: When the user says "go to homepage", "go to X page", "navigate to Y", use the navigate action. The page links will be auto-detected.

If the user is JUST chatting, respond with:
{"type":"chat"}

Available page actions: click, type, scroll, scrollToElement, highlight, clearHighlights, findElements, getPageInfo, extractTable, getElementText, evaluate, pressKey, hover, waitForElement, wait, fillForm, selectDropdown, checkToggle, getClipboard, copyToClipboard, startPicker, getViewportInfo, startMonitoring, stopMonitoring
Available browser actions: navigate, openTab, closeTab, goBack, goForward, reload, screenshot, download, notify, setAlarm, clearAlarm, getCapabilities

Selector formats:
- "#id" or ".class" — CSS
- ":text('exact text')" — exact text match
- ":contains('partial')" — partial text match
- ":nth('a.button', 2)" — Nth match

Respond ONLY with the JSON object.`;

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
    // EXCLUDE: navigate (needs URL enhancement), multi_step (needs planner), complex (needs planner)
    if (intent.action && intent.action !== 'navigate' && intent.action !== 'multi_step' && !intent.complex) {
      return [{
        id: this._generateId(),
        action: intent.action,
        description: intent.description || intent.action,
        params: intent.params || {},
        elementDescription: intent.elementDescription || '',
        timeout: this.DEFAULT_TIMEOUT
      }];
    }

    // For complex/multi-step queries, ask LLM to build a detailed plan
    if ((intent.type === 'action' && intent.complex) || intent.action === 'multi_step') {
      const settings = await this.sp.getSettings();
      const apiKey = settings.openrouterKey;
      if (!apiKey) return [];

      const systemPrompt = `You are a planner for a browser agent that CAN interact with web pages. Given a user's multi-step goal, produce a JSON array of action steps. Each step: {"id":"sN","action":"<action_name>","description":"<English — what this step does>","params":{...},"elementDescription":"<English — for navigation use the link text>"}.

LANGUAGE: All description and elementDescription fields MUST be in English.

AVAILABLE ACTIONS:
Page: click, type, scroll, scrollToElement, highlight, findElements, getPageInfo, extractTable, getElementText, evaluate, pressKey, hover, waitForElement, wait, fillForm, selectDropdown, checkToggle, startPicker
Browser: navigate (go to URL or page), openTab, goBack, goForward, reload, screenshot

For NAVIGATION: When user says "go to X page", use {"action":"navigate","description":"Go to X page","params":{},"elementDescription":"X"}. The agent will automatically scan the page's links and find the right URL. Do NOT guess URLs.

For MULTI-STEP like "go to A, then B, then C": Create one navigate step per destination. Include waitForElement after each navigation.

For SCROLLING: When user says "scroll to bottom" or "scroll end of page", use {"action":"scroll","params":{"direction":"bottom"},"description":"Scroll to bottom of page"}.

IMPORTANT: Always include a waitForElement step after navigation. Always scroll before clicking if the element might not be in view.

Respond with ONLY the JSON array. Example:
[{"id":"s1","action":"navigate","description":"Go to Homepage","params":{},"elementDescription":"homepage"},{"id":"s2","action":"waitForElement","description":"Wait for page to load","params":{"selector":"body","timeout":5000}}]`;

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

  /**
   * Format an action result into a short user-readable string for chat history.
   */
  _formatActionResult(step, result) {
    if (!result) return '';
    switch (step.action) {
      case 'click': return `Clicked ${result.element || step.params?.selector || 'element'}`;
      case 'type': return `Typed "${(step.params?.text || '').substring(0, 40)}" into ${result.element || step.params?.selector || 'field'}`;
      case 'scroll':
        if (step.params?.direction === 'bottom') return 'Scrolled to bottom of page';
        if (step.params?.direction === 'top') return 'Scrolled to top of page';
        return `Scrolled ${step.params?.direction || 'down'} ${step.params?.amount ? step.params.amount + 'px' : ''}`.trim();
      case 'scrollToElement': return `Scrolled to ${result.element || step.params?.selector || 'element'}`;
      case 'highlight': return `Highlighted ${result.element || step.params?.selector || 'element'}`;
      case 'findElements': return `Found ${result.total || 0} elements matching "${step.params?.selector || ''}"`;
      case 'getPageInfo': return `Page: ${result.title || ''} — ${result.links || 0} links, ${result.forms || 0} forms`;
      case 'extractTable': return `Extracted table with ${result.rowCount || 0} rows`;
      case 'navigate': return `Navigated to ${result.url || step.params?.url || ''}`;
      case 'openTab': return `Opened tab: ${result.url || step.params?.url || ''}`;
      case 'screenshot': return `Screenshot captured`;
      case 'fillForm': return `Filled ${result.succeeded || 0}/${result.total || 0} fields`;
      case 'selectDropdown': return `Selected "${step.params?.value || ''}" in dropdown`;
      case 'checkToggle': return `${result.checked ? 'Checked' : 'Unchecked'} toggle`;
      case 'pressKey': return `Pressed ${step.params?.key || 'key'}`;
      case 'getCapabilities': return `Listed capabilities (${(result.pageActions?.length || 0) + (result.browserActions?.length || 0)} actions)`;
      case 'waitForElement': return `Waited for "${step.params?.selector || 'element'}" (${result.timeMs || '?'}ms)`;
      case 'wait': return `Waited ${step.params?.ms || 1000}ms`;
      default: return `${step.action} completed`;
    }
  }

  /**
   * Scan ALL actionable elements on the page:
   * links, buttons, inputs, forms, selects, textareas.
   * Respects the user's HTML parse limit setting.
   */
  async _scanAllActionableElements() {
    try {
      const settings = await this.sp.getSettings();
      const limit = settings.htmlParseLimit || 80;

      const result = await this._dispatchAction({
        action: 'evaluate',
        id: this._generateId(),
        params: {
          code: `(function() {
            const limit = ${limit};
            const elements = { links: [], buttons: [], inputs: [], forms: [], selects: [] };

            // Links (visible, with href)
            const allLinks = document.querySelectorAll('a[href]');
            for (const a of allLinks) {
              if (elements.links.length >= limit) break;
              const text = (a.textContent || '').trim().substring(0, 80);
              const href = a.href || '';
              if (text && href && !href.startsWith('javascript:') && a.offsetParent !== null) {
                elements.links.push({ text, href: href.substring(0, 200), selector: a.id ? '#' + CSS.escape(a.id) : (a.className ? 'a.' + a.className.split(' ')[0] : 'a') });
              }
            }

            // Buttons
            const allButtons = document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]');
            for (const b of allButtons) {
              if (elements.buttons.length >= limit) break;
              const text = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().substring(0, 60);
              if (text && b.offsetParent !== null) {
                elements.buttons.push({ text, selector: b.id ? '#' + CSS.escape(b.id) : ':contains("' + text.substring(0, 30) + '")', type: b.tagName.toLowerCase() });
              }
            }

            // Inputs
            const allInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea');
            for (const inp of allInputs) {
              if (elements.inputs.length >= limit) break;
              const label = inp.getAttribute('placeholder') || inp.getAttribute('aria-label') || inp.getAttribute('name') || inp.id || (inp.tagName + ' field');
              if (inp.offsetParent !== null) {
                elements.inputs.push({ label: label.substring(0, 60), type: inp.type || 'text', selector: inp.id ? '#' + CSS.escape(inp.id) : (inp.name ? '[name="' + inp.name + '"]' : inp.tagName.toLowerCase()), tag: inp.tagName.toLowerCase() });
              }
            }

            // Forms
            const allForms = document.querySelectorAll('form');
            for (const f of allForms) {
              if (elements.forms.length >= 10) break;
              const id = f.id || '';
              const action = f.action || '';
              const inputCount = f.querySelectorAll('input, textarea, select').length;
              if (inputCount > 0) {
                elements.forms.push({ id: id.substring(0, 40), action: action.substring(0, 100), inputCount, selector: id ? '#' + CSS.escape(id) : 'form' });
              }
            }

            // Selects
            const allSelects = document.querySelectorAll('select');
            for (const s of allSelects) {
              if (elements.selects.length >= limit) break;
              const optCount = s.options.length;
              if (s.offsetParent !== null) {
                elements.selects.push({ optionCount: optCount, selector: s.id ? '#' + CSS.escape(s.id) : (s.name ? '[name="' + s.name + '"]' : 'select'), name: s.name || s.id || '' });
              }
            }

            return JSON.stringify({
              totalLinks: elements.links.length,
              totalButtons: elements.buttons.length,
              totalInputs: elements.inputs.length,
              totalForms: elements.forms.length,
              totalSelects: elements.selects.length,
              elements: elements
            });
          })()`
        },
        timeout: 8000
      });

      if (result.success && result.result?.result) {
        try { return JSON.parse(result.result.result); } catch (e) { return null; }
      }
      return null;
    } catch (e) { return null; }
  }

  /**
   * Enhance a navigation plan by scanning page elements,
   * then matching user's target destinations to actual links/buttons/inputs.
   */
  async _enhanceNavigationPlan(plan) {
    const hasUnresolved = plan.some(s =>
      (s.action === 'navigate' && !s.params?.url) ||
      (s.action === 'click' && !s.params?.selector) ||
      (s.action === 'type' && !s.params?.selector)
    );
    if (!hasUnresolved) return plan;

    // Scan all actionable elements
    const scan = await this._scanAllActionableElements();
    if (!scan || !scan.elements) return plan;

    // Show discovered elements to user via UI
    if (this.sp._agentUI) {
      this.sp._agentUI.showPageElements(scan);
    }

    // Flatten all links for navigation matching
    const allLinks = scan.elements.links || [];

    return plan.map(step => {
      // Resolve navigation steps
      if (step.action === 'navigate' && !step.params?.url && step.elementDescription) {
        const desc = step.elementDescription.toLowerCase();
        let best = null, bestScore = 0;
        for (const link of allLinks) {
          const t = link.text.toLowerCase();
          if (t === desc) { best = link; break; }
          if (t.includes(desc)) { const s = desc.length / t.length; if (s > bestScore) { bestScore = s; best = link; } }
          if ((link.href || '').toLowerCase().includes(desc.replace(/\s+/g, '-'))) { if (0.5 > bestScore) { bestScore = 0.5; best = link; } }
        }
        if (best) {
          return { ...step, params: { ...step.params, url: best.href }, description: `${step.description} → ${best.text}` };
        }
        // Mark as unresolvable — user will see it in the UI
        return { ...step, description: `${step.description} ⚠️ (link not found on page)` };
      }

      // Resolve click steps without selectors
      if (step.action === 'click' && !step.params?.selector && step.elementDescription) {
        const desc = step.elementDescription.toLowerCase();
        // Search buttons first
        const allButtons = scan.elements.buttons || [];
        let best = allButtons.find(b => b.text.toLowerCase().includes(desc));
        if (best) {
          return { ...step, params: { ...step.params, selector: best.selector || `:contains("${best.text.substring(0, 30)}")` }, description: `${step.description} → ${best.text}` };
        }
        // Then links
        const linkBest = allLinks.find(l => l.text.toLowerCase().includes(desc));
        if (linkBest) {
          return { ...step, params: { ...step.params, selector: linkBest.selector || `:contains("${linkBest.text.substring(0, 30)}")` }, description: `${step.description} → ${linkBest.text}` };
        }
      }

      return step;
    });
  }
}

// Export for use in sidepanel.js
// (Attached to window since we're not using modules)
if (typeof window !== 'undefined') {
  window.SNNAgentLoop = SNNAgentLoop;
}
