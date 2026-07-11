//  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
// SNN Agent Loop â€” State Machine, Retry Engine, Action Orchestrator
//  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
// Runs in the side panel. Orchestrates the full agent lifecycle:
// IDLE â†’ PARSING â†’ PLANNING â†’ EXECUTING â†’ WAITING â†’ OBSERVING
//   â†’ REPORTING (or RETRYING â†’ FAILED / BLOCKED â†’ CANCELLED)
//
// DESIGN PRINCIPLES:
// 1. Every error is surfaced to the user â€” NEVER silent.
// 2. Retries use exponential backoff + jitter, per-error strategies.
// 3. Stale-state detection (tab switch, SW termination).
// 4. User can cancel at ANY time.
// 5. All promises are raced against timeouts.
//  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -



// ── DEBUG LOGGING ──────────────────────────────────────────────────
var SNN_D = {
  enabled: true,
  module: 'AgentLoop',
  _ts: () => new Date().toISOString().slice(11, 23),
  _fmt(o) {
    if (o === undefined) return 'undefined';
    if (o === null) return 'null';
    if (typeof o === 'string') return o.length > 300 ? o.slice(0, 300) + '…(' + o.length + ')' : o;
    if (o instanceof Error) return `[${o.name}] ${o.message}`;
    try { return JSON.stringify(o).slice(0, 500); } catch(e) { return String(o).slice(0, 500); }
  },
  log(...args) { if (!this.enabled) return; console.log(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#81c784;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  warn(...args) { console.warn(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ffb74d;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  error(...args) { console.error(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ef5350;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
};
var D = SNN_D;

class SNNAgentLoop {
  constructor(sidePanel) {
    this.sp = sidePanel; // reference to SNNSidePanel instance

    // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this._state = 'IDLE';
    this._taskId = null;
    this._plan = [];
    this._stepIndex = 0;
    this._attemptCount = 0;
    this._sendTabId = null;
    this._stepResults = [];
    this._cancelled = false;
    this._cancelReason = null;  // 'user' | 'tab-switch' | null
    this._pendingResolve = null; // for BLOCKED state

    // â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this.MAX_RETRIES = 3;
    this.RETRY_DELAYS = [1000, 3000, 8000]; // ms base (jitter added)
    this.DEFAULT_TIMEOUT = 15000; // ms per action

    // â”€â”€ Background-level actions (handled by SW, not forwarded to page) â”€â”€
    this._BG_ACTIONS = new Set([
      'agent:navigate', 'agent:openTab', 'agent:closeTab', 'agent:goBack',
      'agent:goForward', 'agent:reload', 'agent:screenshot', 'agent:download',
      'agent:notify', 'agent:setAlarm', 'agent:clearAlarm', 'agent:listAlarms',
      'agent:listActions', 'agent:getCapabilities', 'agent:page_script'
    ]);

    // â”€â”€ Callbacks (set by sidepanel) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this.onStateChange = null;   // (state, detail)
    this.onProgress = null;      // (step, total, description)
    this.onError = null;         // (errorCardData)
    this.onResult = null;        // (reportData)
    this.onBlocked = null;       // (question) â†’ returns Promise<'approved'|'denied'>
  }

  /**
   * Check if the current model supports image/vision input.
   * Prefers OpenRouter model metadata (architecture.input_modalities)
   * cached by the side panel; falls back to a conservative name heuristic.
   */
  /**
   * Check if the current model supports image/vision input.
   * Delegates to side panel's _getModelInputModalities for authoritative data.
   */
  _modelSupportsVision(modelId) {
    // Delegate to side panel's comprehensive modality detection
    if (this.sp && typeof this.sp._getModelInputModalities === 'function') {
      return this.sp._getModelInputModalities(modelId).has('image');
    }
    if (!modelId) return false;

    // Fallback heuristic for uncached models (standalone)
    const m = modelId.toLowerCase();
    return /gemini|gpt-4o|gpt-4\.1|gpt-4-vision|gpt-4-turbo|claude-3|claude-4|claude-sonnet|claude-opus|llava|pixtral|vision|multimodal|qwen.*vl|grok-2-vision/i.test(m);
  }

  // â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  get state() { return this._state; }
  get isBusy() { return this._state !== 'IDLE' && this._state !== 'FAILED'; }

  /**
   * Cancel the current task. Safe to call from any state.
   * @param {string} reason - 'user' or 'tab-switch'
   */
  cancel(reason = 'user') {
    if (this._state === 'IDLE') return;
    D.warn('CANCEL', { reason, currentState: this._state });
    this._cancelled = true;
    this._cancelReason = reason;
    const label = reason === 'tab-switch' ? 'Tab switched â€” task interrupted' : 'User cancelled';
    this._transition('CANCELLED', { reason: label });
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

    D.log('▶ run START', { msgPreview: userMessage.substring(0, 100), contextType: context?.type, tabId, model: this.sp._selectedModelInfo?.id || 'unknown' });
    this._reset();
    this._sendTabId = tabId;
    this._taskId = this._generateId();
    this._cancelled = false;
    // ── Reset token usage accumulator for this agent run ──
    this.sp.lastTokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    try {
      //  - - - - CAPABILITY FAST-PATH  - - - -
      const capResult = this._checkCapabilityQuery(userMessage);
      if (capResult) return await this._handleCapabilityQuery();

      //  - - - - AGENTIC LOOP WITH TOOL CALLING  - - - -
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
        const limit = settings.contentLimit || 15000;
        const detail = context.detail.length > limit
          ? context.detail.substring(0, limit) + '\n\n[... truncated to ' + limit + ' chars ...]'
          : context.detail;
        messages.splice(1, 0, {
          role: 'system',
          content: `[PAGE CONTENT — ALREADY PROVIDED. DO NOT use any tools to re-read it — answer directly. Answer directly from this content.]\n\nTitle: ${context.title || 'Unknown'}\nURL: ${context.summary || ''}\nWord count: ${context.wordCount || 0}\n\nContent:\n${detail}`
        });
      }

      // Add user-selected text if available (e.g., highlighted table rows, paragraphs, etc.)
      if (context?.type === 'selection' && context?.detail) {
        const limit = settings.contentLimit || 15000;
        const detail = context.detail.length > limit
          ? context.detail.substring(0, limit) + '\n\n[... selection truncated to ' + limit + ' chars ...]'
          : context.detail;
        messages.splice(1, 0, {
          role: 'system',
          content: `[USER-SELECTED TEXT — ALREADY PROVIDED. The user has highlighted this content. Use it directly; do NOT call snn_screenshot or snn_page_script just to re-read it — you already have the selection. The user's instruction relates to THIS selected content.]\n\n${detail}`
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

        // â”€â”€ Tool calls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

            // â”€â”€ If screenshot was taken and model supports vision, inject the image â”€â”€
            // Text-only models (DeepSeek, etc.) get a text summary instead â€” no 404.
            if (fnName === 'snn_screenshot' && this._lastScreenshot) {
              if (this._modelSupportsVision(settings.openrouterModel)) {
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: JSON.stringify({
                    success: true,
                    screenshot: '[Image captured â€” visible in the next message]',
                    message: 'A screenshot of the page was captured. The image will be provided for your analysis.'
                  })
                });
                messages.push({
                  role: 'user',
                  content: [
                    { type: 'text', text: 'Here is the screenshot you just captured. Analyze it and continue with the task.' },
                    { type: 'image_url', image_url: { url: this._lastScreenshot } }
                  ]
                });
              } else {
                // Text-only model: tell the LLM the screenshot was captured, skip image
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: JSON.stringify({
                    success: true,
                    screenshot: '[Screenshot captured and displayed to the user]',
                    message: 'A screenshot of the page was captured successfully. The user can see it in the chat.'
                  })
                });
              }
              this._lastScreenshot = null; // consume it
              this.sp._lastScreenshot = null; // sync with sidepanel
            } else {
              // â”€â”€ Sanitize tool result before sending to LLM â”€â”€
              const sanitizedResult = this._sanitizeToolResultForLLM(fnName, actionResult);
              // Add tool result to messages
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: typeof sanitizedResult === 'string' ? sanitizedResult : JSON.stringify(sanitizedResult)
              });
            }
          }

          this._transition('OBSERVING', { iteration });
          continue; // Loop back to let LLM process tool results
        }

        // â”€â”€ Final content (no more tool calls) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (msg.content && !msg.tool_calls) {
          finalContent = msg.content;
          break;
        }

        // â”€â”€ Empty response â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        break;
      }

      if (this._cancelled) return;

      //  - - - - REPORT  - - - -
      if (this._stepResults.length > 0) {
        this._transition('REPORTING', { results: this._stepResults });
        if (this.onResult) this.onResult({ type: 'action_results', results: this._stepResults, plan: this._plan });
      }

      this._transition('IDLE');

      // If LLM produced a final answer without using tools,
      // return the content so the sidepanel can stream it directly.
      if (finalContent && this._stepResults.length === 0) {
        D.log('▶ run DONE (chat)', { contentLen: finalContent.length });
        return { type: 'chat', content: finalContent };
      }

      D.log('▶ run DONE (action)', { stepResults: this._stepResults.length, llmResponseLen: (finalContent || '').length });
      return {
        type: 'action',
        results: this._stepResults,
        llmResponse: finalContent || null
      };

    } catch (err) {
      D.error('▶ run CRASHED', { error: err.message, stack: err.stack?.split('\n').slice(0,3).join(' | ') });
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

  //  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  // TOOL DEFINITIONS â€” All SNN actions as OpenRouter tool schemas
  //  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

  /**
   * Build the tools array for OpenRouter native tool calling.
   * Only includes actions that are NOT disabled in settings.
   */
  _getToolDefinitions(settings) {
    const disabled = settings.disabledActions || [];
    const enabled = (name) => !disabled.includes(name);

    const allTools = [
      // ── Core Interaction ────────────────────────────────────────
      { name: 'snn_click', desc: 'Click a button, link, or element on the page. Uses multi-strategy click (synthetic events + native click + ancestor click + keyboard) for SPA compatibility. Also use for checkboxes, radio buttons, and to open dropdowns before selecting options.', params: {
        selector: { type: 'string', desc: 'PREFERRED: :role("button","Submit") or :text("exact visible text") or :name("email") or :contains("partial"). CSS only as last resort.' }
      }, required: ['selector'] },
      { name: 'snn_type', desc: 'Type text into an input field or textarea. Use after snn_click to focus the field.', params: {
        selector: { type: 'string', desc: 'PREFERRED: :name("email"), :role("textbox","Search"), :text("placeholder/label"), or CSS as last resort' },
        text: { type: 'string', desc: 'Text to type' },
        clearFirst: { type: 'boolean', desc: 'Clear existing text first (default false)' }
      }, required: ['selector', 'text'] },
      { name: 'snn_scroll', desc: 'Scroll the page in a direction or to top/bottom', params: {
        direction: { type: 'string', desc: 'up, down, left, right, top, or bottom' },
        amount: { type: 'integer', desc: 'Pixels to scroll (ignored for top/bottom)' }
      }, required: ['direction'] },
      { name: 'snn_wait', desc: 'Wait for a specified number of milliseconds (e.g., for page loads, animations, or debounce)', params: {
        ms: { type: 'integer', desc: 'Milliseconds to wait (default 1000)' }
      }, required: [] },

      // ── Page Sensing ─────────────────────────────────────────────
      { name: 'snn_screenshot', desc: 'Capture a screenshot of the visible page area', params: {}, required: [] },
      { name: 'snn_page_script', desc: 'Run a script in the page to read or modify content, styles, and behavior and return the result. Use for ANY page operation not covered by dedicated tools: MODIFYING page styles (CSS, colors, sizes, backgrounds, fonts, visibility, layout), adding/removing/hiding elements, changing text content, reading page data (title, URL, element text, tables), finding elements, extracting info, selecting dropdown options, toggling controls, dispatching keyboard/hover events, highlighting, scrolling, copying to clipboard, navigating history, and more. You CAN change how the page looks — use this tool to do it. Return JSON-serializable data. CRITICAL: Your code runs via eval() at the TOP LEVEL (NOT inside a function) — do NOT use a bare "return" statement. Instead, make the last expression be the value you want returned, or wrap your code in an IIFE: (function(){ /* your code */ return result; })().', params: {
        code: { type: 'string', desc: 'JavaScript code to run (TOP-LEVEL eval — no bare return!). Has access to document, window. Use document.querySelector(), etc.' }
      }, required: ['code'] },

      // ── Navigation & Browser ─────────────────────────────────────
      { name: 'snn_navigate', desc: 'Navigate the current tab to a URL. The page links will be auto-detected from navigation.', params: {
        url: { type: 'string', desc: 'Full URL or just the link text (e.g., "homepage", "blog"). If not a full URL, agent will scan page links to find match.' }
      }, required: ['url'] },
      { name: 'snn_openTab', desc: 'Open a URL in a new browser tab', params: {
        url: { type: 'string', desc: 'URL to open' }
      }, required: ['url'] },
      { name: 'snn_reload', desc: 'Reload/refresh the current page', params: {}, required: [] }
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
    // Core behavioral prompt lives HERE in code — not in user-editable settings.
    // The user's custom instruction (if any) is appended as seasoning at the end.
    const userInstruction = (settings.agentPrompt || '').trim();

    let prompt = `You are SNN Chat, a browser extension agent running inside the USER'S OWN BROWSER. You help the user interact with and customize web pages they are viewing. Modifying page styles, colors, or content via JavaScript in the user's own browser is perfectly legitimate — you are not hacking or altering anyone else's website; you are customizing the user's personal browsing experience, just like a browser extension or dev tools would.

You can click buttons, type into fields, scroll, navigate, take screenshots, run page scripts (including modifying page styles, colors, layouts, and content), reload pages, and open new tabs. You have access to tools (functions) for all of these.

CRITICAL — WHEN TO USE TOOLS:
- ONLY use tools when the user explicitly asks you to PERFORM AN ACTION: click something, type into a field, scroll, navigate to a page, take a screenshot, reload, change how the page looks, etc.
- For informational questions ("summarize this page", "what is this about?", "explain...", "what colors..."), the page content is ALREADY provided to you in the system messages. Answer DIRECTLY from that context — do NOT use any tools to re-read it.
- If you already have the information needed to answer, JUST ANSWER. Don't reach for tools unnecessarily.

WHEN YOU DO USE TOOLS:
1. Say something brief like "On it!" then call the tool immediately.
2. You can chain multiple tool calls: e.g., navigate → wait → click → type.
3. After tools return results, synthesize a helpful response in the user's language.
4. SELECTOR PRIORITY (most robust first — ALWAYS follow this order):
   a) :role("button","Submit") / :role("link","Home") / :role("textbox","Search") — ARIA role + accessible name
   b) :name("email") — form control name/id
   c) :text("exact visible text") — exact visible label/text
   d) :contains("partial text") — partial visible text
   e) CSS selectors only as a LAST RESORT (classes/ids break often)
5. When navigating: if the user says "go to X page", use snn_navigate.
6. The snn_click action uses multiple strategies (synthetic events, native click, ancestor click, keyboard activation) to handle modern SPA frameworks. Use it for buttons, links, checkboxes, radio buttons, and opening dropdowns.
7. snn_type types text into inputs. Click the field first with snn_click, then type with snn_type.
8. MODIFYING THE PAGE: Use snn_page_script to change how the page looks or behaves. You CAN: change colors, fonts, sizes, backgrounds, hide elements, add content, restyle anything, run animations. Example: to make buttons red — snn_page_script with code: document.querySelectorAll('button').forEach(b => b.style.backgroundColor = 'red'). Example: to hide an element — snn_page_script with code: document.querySelector('.banner').style.display = 'none'.
9. For ANY operation not covered by dedicated tools, use snn_page_script. It runs arbitrary JavaScript in the page and returns the result. Use it for: reading page data, finding elements, extracting tables, selecting dropdown options, toggling controls, dispatching keyboard/hover events, highlighting, scrolling to elements, copying to clipboard, navigating history, and more. CRITICAL: Your code runs via eval() at the TOP LEVEL, NOT inside a function — NEVER use a bare "return" statement. Make the last expression the return value, or wrap in an IIFE: (function(){ ...; return x; })().
10. For batch operations on infinite-scroll pages: use snn_scroll to reveal content, then snn_page_script to find and process elements.

CRITICAL RULES:
- NEVER ask for permission or confirmation to do what the user explicitly asked. Just do it.
- NEVER say "I can help with that, would you like me to..." or "Want me to?" — instead say "Let me do that now" and call the tool.
- If a tool call fails, try a different approach (different selector strategy: role → name → text → contains). Don't give up after one failure.
- For simple questions about page content: ANSWER FROM CONTEXT, don't use tools.
- NEVER say you cannot interact with the page — you CAN.`;

    // Append user's custom instruction if they've set one (and it's not the default identity stamp)
    if (userInstruction && userInstruction !== this.sp._getDefaultAgentPrompt?.()) {
      prompt += `\n\n[USER'S CUSTOM INSTRUCTION: ${userInstruction}]`;
    }

    return prompt;
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

    const msgCount = messages.length;
    const lastMsg = messages[msgCount - 1];
    D.log('→ LLM CALL', { model, msgCount, toolCount: tools.length, lastRole: lastMsg?.role, lastContentLen: typeof lastMsg?.content === 'string' ? lastMsg.content.length : 'multipart' });

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
      D.error('← LLM ERROR', { status: res.status, errText: errText.substring(0, 300) });
      throw new Error(`API error ${res.status}: ${errText.substring(0, 200)}`);
    }

    const json = await res.json();
    const choice = json.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;
    D.log('← LLM OK', { finishReason: choice?.finish_reason, contentLen: (choice?.message?.content || '').length, toolCallCount: toolCalls?.length || 0, toolNames: toolCalls?.map(tc => tc.function?.name).join(',') || 'none' });

    // ── Accumulate token usage across agent loop iterations ──
    if (json.usage) {
      if (!this.sp.lastTokenUsage || !this.sp.lastTokenUsage.total_tokens) {
        this.sp.lastTokenUsage = {
          prompt_tokens: json.usage.prompt_tokens || 0,
          completion_tokens: json.usage.completion_tokens || 0,
          total_tokens: json.usage.total_tokens || 0
        };
      } else {
        this.sp.lastTokenUsage.prompt_tokens += json.usage.prompt_tokens || 0;
        this.sp.lastTokenUsage.completion_tokens += json.usage.completion_tokens || 0;
        this.sp.lastTokenUsage.total_tokens += json.usage.total_tokens || 0;
      }
    }

    return json;
  }

  /**
   * Execute a single tool call from the LLM.
   * Maps OpenRouter tool names â†’ SNN action names â†’ dispatch.
   */
  async _executeToolCall(fnName, fnArgs, iteration) {
    // Map tool name to action name (remove snn_ prefix)
    const actionName = fnName.startsWith('snn_') ? fnName.slice(4) : fnName;
    D.log('_executeToolCall', { fnName, actionName, iteration, args: fnArgs });

    // Special handling for capability query
    if (actionName === 'getCapabilities') {
      const result = await this._dispatchAction({ action: 'getCapabilities', id: this._generateId(), params: {}, timeout: 5000 });
      return result.success ? result.result : { error: 'Could not load capabilities' };
    }

    // Build step for tracking
    let params = this._mapToolArgsToParams(actionName, fnArgs);
    let description = this._describeToolCall(fnName, fnArgs);

    // â”€â”€ Navigate URL resolution: if URL is a text description (not a real URL), scan page links â”€â”€
    if (actionName === 'navigate' && params.url && !this._looksLikeURL(params.url)) {
      const scan = await this._scanAllActionableElements();
      if (scan?.elements?.links?.length) {
        const desc = params.url.toLowerCase();
        let best = null, bestScore = 0;
        for (const link of scan.elements.links) {
          const t = (link.text || '').toLowerCase();
          if (t === desc) { best = link; break; }
          if (t.includes(desc)) { const s = desc.length / t.length; if (s > bestScore) { bestScore = s; best = link; } }
          if ((link.href || '').toLowerCase().includes(desc.replace(/\s+/g, '-'))) { if (0.5 > bestScore) { bestScore = 0.5; best = link; } }
        }
        if (best?.href) {
          params.url = best.href;
          description = `${description} â†’ ${best.text || best.href}`;
        }
      }
      // â”€â”€ Fallback: if page scan didn't resolve, construct absolute URL from tab origin â”€â”€
      if (!this._looksLikeURL(params.url)) {
        params.url = await this._buildNavigateFallbackUrl(params.url);
        if (params.url) description = `${description} â†’ ${params.url}`;
      }
    }

    const step = {
      id: this._generateId(),
      action: actionName,
      description,
      params,
      timeout: actionName === 'scrollAndAct' ? 180000 : this.DEFAULT_TIMEOUT
    };

    this._plan.push(step);
    this._stepIndex = this._plan.length - 1;

    // Show in UI
    if (this.sp._agentUI) {
      this.sp._agentUI.addActionHistoryEntry(actionName, step.description, 'start');
    }

    this._transition('EXECUTING', { step: this._stepIndex + 1, total: this._plan.length, step });

    // Dispatch with retry (includes ELEMENT_NOT_FOUND scan recovery)
    this._attemptCount = 0;
    let result = await this._dispatchAction(step);

    while (!result.success && this._attemptCount < this.MAX_RETRIES && !this._cancelled) {
      this._attemptCount++;
      D.warn('RETRY', { attempt: this._attemptCount, maxRetries: this.MAX_RETRIES, action: step.action, errorCode: result.error?.code, errorMsg: result.error?.message });
      this._transition('RETRYING', {
        attempt: this._attemptCount,
        maxRetries: this.MAX_RETRIES,
        error: result.error
      });

      // SCRIPT_ERROR on page_script: retrying with the same code is pointless —
      // the error is in the code itself (e.g., bare "return" via eval). Return the
      // error immediately so the LLM can rewrite the code on the next iteration.
      if (actionName === 'page_script' && result.error?.code === 'SCRIPT_ERROR') {
        D.warn('SKIP RETRY (SCRIPT_ERROR)', { action: step.action, errorMsg: result.error?.message });
        break;
      }

      // ELEMENT_NOT_FOUND: scan page and rewrite selector before retry
      if (result.error?.code === 'ELEMENT_NOT_FOUND' && this._selectorBasedAction(actionName)) {
        const recovered = await this._recoverSelectorFromScan(step, result.error);
        if (recovered) {
          step.params = { ...step.params, ...recovered.params };
          if (recovered.description) {
            step.description = recovered.description;
            description = recovered.description;
          }
          if (this.sp._agentUI) {
            this.sp._agentUI.updateLastActionEntry('start', `Retry with better selector: ${step.params.selector || ''}`);
          }
          this.sp.showToast(`Retrying with better selectorâ€¦`, 'warning');
        } else {
          const baseDelay = this.RETRY_DELAYS[this._attemptCount - 1] || 8000;
          await this._sleep(baseDelay + Math.random() * 400);
        }
      } else {
        const baseDelay = this.RETRY_DELAYS[this._attemptCount - 1] || 8000;
        await this._sleep(baseDelay + Math.random() * 400);
      }

      if (this._cancelled) break;
      const modified = this._applyRetryStrategy(step, result.error || {}, this._attemptCount);
      step.params = modified.params;
      if (modified.timeout) step.timeout = modified.timeout;
      result = await this._dispatchAction(step);
    }

    // Record result
    if (result.success) {
      this._stepResults.push({ step, result: result.result, attempts: this._attemptCount + 1 });
      if (this.sp._agentUI) {
        this.sp._agentUI.updateLastActionEntry('ok', this._formatActionResult(step, result.result));
        // â”€â”€ Render screenshot image in the action entry â”€â”€
        if (actionName === 'screenshot' && result.result?.screenshot) {
          this.sp._agentUI.attachScreenshotToLastEntry(result.result.screenshot);
          // â”€â”€ Store screenshot for vision: next LLM call will include it â”€â”€
          this._lastScreenshot = result.result.screenshot;
          this.sp._lastScreenshot = result.result.screenshot; // also expose to sidepanel
        }
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
      case 'wait': return { ms: args.ms || 1000 };
      case 'openTab': return { url: args.url || '' };
      case 'page_script': return { code: args.code || '' };
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
      case 'snn_wait': return `Wait ${a.ms || 1000}ms`;
      case 'snn_screenshot': return 'Take screenshot';
      case 'snn_page_script': return 'Run Page Script';
      case 'snn_navigate': return `Navigate to ${a.url || 'page'}`;
      case 'snn_openTab': return `Open tab: ${a.url || ''}`;
      case 'snn_reload': return 'Reload page';
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

  //  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  // DISPATCH ACTION TO CONTENT SCRIPT (via background)
  //  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  async _dispatchAction(step) {
    // scrollAndAct needs a long timeout â€” it's an autonomous scroll loop
    const isLongRunning = step.action === 'scrollAndAct';
    const defaultTimeout = isLongRunning ? 180000 : this.DEFAULT_TIMEOUT; // 3 min vs 15s
    const timeout = step.timeout || defaultTimeout;

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

    // â”€â”€ Inject tabId for background actions that need a target tab â”€â”€
    const TAB_DEPENDENT_ACTIONS = new Set([
      'agent:navigate', 'agent:goBack', 'agent:goForward',
      'agent:reload', 'agent:screenshot', 'agent:page_script'
    ]);
    if (TAB_DEPENDENT_ACTIONS.has(message.action) && this._sendTabId) {
      message.payload.tabId = this._sendTabId;
    }

    D.log('→ SEND', { action: message.action, stepId: message.stepId, payload: message.payload, timeout });

    try {
      // Race: response vs timeout
      const response = await this._sendWithTimeout(message, timeout);

      if (!response) {
        D.warn('← TIMEOUT', { action: message.action, timeout });
        return {
          success: false,
          error: { code: 'TIMEOUT', message: `Action timed out after ${timeout / 1000}s.`, retryable: true, suggestion: 'The page may be slow. Try again or increase the timeout.' }
        };
      }

      D.log('← RESPONSE', { action: message.action, success: response.success, errorCode: response.error?.code, resultKeys: response.result ? Object.keys(response.result).join(',') : 'none' });
      return response; // { success: bool, result?: {}, error?: {} }

    } catch (err) {
      D.error('← DISPATCH_ERROR', { action: message.action, error: err.message });
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
    const isBgAction = this._BG_ACTIONS.has(message.action);
    D.log('_sendWithTimeout', { action: message.action, isBgAction, sendTabId: this._sendTabId, timeout });
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; D.warn('_sendWithTimeout TIMEOUT', { action: message.action, timeout }); resolve(null); } }, timeout);

      // Route page actions to the specific tab (not broadcast) to prevent cross-tab interference
      const sendPromise = isBgAction
        ? chrome.runtime.sendMessage(message)
        : (this._sendTabId
            ? chrome.tabs.sendMessage(this._sendTabId, message)
            : Promise.reject(new Error('No target tab')));

      sendPromise.then((response) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(response); }
      }).catch((err) => {
        if (!settled) {
          settled = true; clearTimeout(timer);
          D.warn('_sendWithTimeout SEND FAILED', { action: message.action, isBgAction, error: err.message, willRetry: !isBgAction && !!this._sendTabId });
          if (!isBgAction && this._sendTabId) {
            chrome.runtime.sendMessage(message).then((r) => { D.log('_sendWithTimeout fallback OK', { action: message.action }); resolve(r); }).catch(() => {
              D.error('_sendWithTimeout fallback FAILED', { action: message.action });
              resolve({ success: false, error: { code: 'NETWORK_ERROR', message: 'Could not reach the page. The tab may have closed.', retryable: false, suggestion: 'Reopen the page and try again.' } });
            });
          } else {
            resolve({ success: false, error: { code: 'NETWORK_ERROR', message: err.message, retryable: true, suggestion: 'Check the connection and try again.' } });
          }
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // RETRY STRATEGY ENGINE + ELEMENT_NOT_FOUND SCAN RECOVERY
  // ═══════════════════════════════════════════════════════════════
  _selectorBasedAction(actionName) {
    return [
      'click', 'type', 'scrollToElement', 'waitForElement'
    ].includes(actionName);
  }

  _applyRetryStrategy(step, error, attemptNum) {
    const modified = { ...step, params: { ...step.params, options: { ...(step.params?.options || {}) } } };

    switch (error.code) {
      case 'ELEMENT_NOT_FOUND':
        // Try harder to find the element; scan recovery may already have rewritten selector
        modified.params.options.allowHidden = true;
        modified.timeout = (step.timeout || this.DEFAULT_TIMEOUT) * 1.5;
        // Fallback text selector if we still only have a brittle CSS selector
        if (attemptNum >= 2 && step.elementDescription && modified.params.selector && !String(modified.params.selector).startsWith(':')) {
          const safe = String(step.elementDescription).replace(/"/g, '\\"').substring(0, 60);
          modified.params.selector = `:contains("${safe}")`;
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

      default:
        // Generic: increase timeout, be more lenient
        modified.timeout = (step.timeout || this.DEFAULT_TIMEOUT) * 1.3;
        modified.params.options.allowHidden = true;
    }

    return modified;
  }

  /**
   * After ELEMENT_NOT_FOUND: scan actionable page elements and pick a better selector.
   * Prefers role/name/text over brittle CSS.
   * Returns { params, description } or null if no better match found.
   */
  async _recoverSelectorFromScan(step, error) {
    try {
      const scan = await this._scanAllActionableElements();
      if (!scan?.elements) return null;

      const failedSelector = step.params?.selector || error?.selector || '';
      const hint = this._extractSelectorHint(failedSelector, step);
      if (!hint) return null;

      const match = this._findBestScanMatch(scan.elements, hint, step.action);
      if (!match) return null;

      // Don't retry with the exact same selector
      if (match.selector && match.selector === failedSelector) return null;

      const params = { ...(step.params || {}), selector: match.selector };
      // fillForm fields recovery is handled per-field only when top-level selector exists
      return {
        params,
        description: `${step.description || step.action} â†’ ${match.label || match.selector}`
      };
    } catch (e) {
      console.warn('[SNN Agent] selector recovery failed:', e.message);
      return null;
    }
  }

  /** Pull a human-readable search hint from a failed selector / step description. */
  _extractSelectorHint(selector, step) {
    const sources = [];
    if (step?.elementDescription) sources.push(String(step.elementDescription));
    if (step?.description) sources.push(String(step.description));
    if (selector) {
      // :role("button","Submit") / :text("Foo") / :contains("Bar") / :name("email")
      const m = String(selector).match(/:(?:role|text|contains|name)\((.+)\)\s*$/i);
      if (m) {
        const parts = m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        // For role, prefer the name part
        sources.push(parts[parts.length - 1] || parts[0]);
      } else {
        // CSS-ish: strip symbols, keep words
        sources.push(String(selector).replace(/[#.\[\]="'>\s:+~*]/g, ' '));
      }
    }
    const raw = sources.join(' ').toLowerCase();
    // Drop common action verbs so "click login button" â†’ "login button"
    const cleaned = raw
      .replace(/\b(click|type|hover|highlight|select|check|uncheck|fill|press|get|find|scroll|into|the|a|an|button|link|field|input|element)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || raw.trim() || null;
  }

  /**
   * Score scan results against a text hint. Prefer role/name/text selectors.
   */
  _findBestScanMatch(elements, hint, actionName) {
    if (!hint) return null;
    const h = hint.toLowerCase();
    const candidates = [];

    const push = (list, kind, scoreBoost = 0) => {
      for (const item of (list || [])) {
        const text = (item.text || item.label || item.name || '').toLowerCase();
        const href = (item.href || '').toLowerCase();
        if (!text && !href) continue;

        let score = 0;
        if (text === h) score = 100;
        else if (text.includes(h)) score = 70 + Math.min(20, (h.length / Math.max(text.length, 1)) * 20);
        else if (h.includes(text) && text.length >= 2) score = 50;
        else if (href.includes(h.replace(/\s+/g, '-'))) score = 40;
        else continue;

        score += scoreBoost;

        // Prefer role/name/text selectors over raw CSS
        let selector = item.selector || '';
        let label = item.text || item.label || item.name || selector;

        if (kind === 'button' || kind === 'link' || kind === 'clickable') {
          // Prefer accessible text selectors
          if (item.text) {
            const t = item.text.substring(0, 60).replace(/"/g, '\\"');
            if (item.role) selector = `:role("${item.role}","${t}")`;
            else if (kind === 'button') selector = `:role("button","${t}")`;
            else if (kind === 'link') selector = `:text("${t}")`;
            else selector = `:contains("${t}")`;
          }
        } else if (kind === 'input') {
          if (item.name || item.selector?.includes('name=')) {
            const n = (item.name || '').replace(/"/g, '\\"');
            if (n) selector = `:name("${n}")`;
          }
          if (!selector.startsWith(':') && item.label) {
            const t = item.label.substring(0, 60).replace(/"/g, '\\"');
            selector = `:role("textbox","${t}")`;
          }
        } else if (kind === 'select') {
          if (item.name) selector = `:name("${String(item.name).replace(/"/g, '\\"')}")`;
        }

        candidates.push({ selector, label, score, kind });
      }
    };

    // Weight categories by action type
    if (actionName === 'type') {
      push(elements.inputs, 'input', 15);
      push(elements.selects, 'select', 5);
      push(elements.buttons, 'button', 0);
    } else {
      // click / hover / highlight / getElementText / etc.
      push(elements.buttons, 'button', 15);
      push(elements.links, 'link', 12);
      push(elements.clickables, 'clickable', 8);
      push(elements.inputs, 'input', 2);
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  // ═══════════════════════════════════════════════════════════════
  // STALE STATE DETECTION
  // ═══════════════════════════════════════════════════════════════
  _checkTabStillValid() {
    // Session Lock: tab switches are allowed — agent keeps running on original tab
    if (this.sp._chatLockEnabled) return true;
    if (this.sp.currentTabId !== this._sendTabId) {
      // Tab switched — cancel gracefully, don't show error cards
      this._cancelled = true;
      this._cancelReason = 'tab-switch';
      this._transition('CANCELLED', { reason: 'Tab switched — task interrupted' });
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
    D.log(`STATE: ${prev} → ${newState}`, detail);
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
    this._cancelReason = null;
    this._pendingResolve = null;
    this._lastScreenshot = null;
  }

  // ── Utilities ───────────────────────────────────────────────────
  _generateId() { return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8); }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** Returns true if the string looks like a real URL (has scheme or common TLD pattern). */
  _looksLikeURL(str) {
    if (!str) return false;
    // Full URLs with scheme
    if (/^https?:\/\//i.test(str)) return true;
    // Domain-like patterns: contains a dot with common TLD, or starts with /
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/|$)/.test(str)) return true;
    // Absolute paths
    if (/^\//.test(str)) return true;
    return false;
  }

  /** Fallback: construct an absolute URL from the current tab's origin + slugified text. */
  async _buildNavigateFallbackUrl(rawText) {
    if (!this._sendTabId) return rawText;
    try {
      const tab = await chrome.tabs.get(this._sendTabId);
      if (tab?.url) {
        const origin = new URL(tab.url).origin;
        const slug = rawText.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        return origin + '/' + slug;
      }
    } catch (e) { /* tab might not be accessible */ }
    return rawText;
  }

  /**
   * Strip large payloads (base64 images, etc.) from tool results before
   * sending them to the LLM. The LLM can't process raw image data â€”
   * it just wastes tokens and causes timeouts.
   */
  _sanitizeToolResultForLLM(fnName, result) {
    if (!result || typeof result === 'string') return result;

    const sanitized = { ...result };

    // Strip base64 screenshot data
    if (sanitized.screenshot && typeof sanitized.screenshot === 'string' && sanitized.screenshot.startsWith('data:')) {
      const sizeKB = Math.round((sanitized.screenshot.length * 3) / 4 / 1024);
      sanitized.screenshot = `[Screenshot captured: ${sizeKB}KB â€” visible to user, not to LLM]`;
      sanitized._screenshotStripped = true;
    }

    // Generic: strip any other large base64 blobs
    for (const key of Object.keys(sanitized)) {
      if (typeof sanitized[key] === 'string' && sanitized[key].startsWith('data:image')) {
        const sizeKB = Math.round((sanitized[key].length * 3) / 4 / 1024);
        sanitized[key] = `[Image: ${sizeKB}KB â€” stripped for LLM]`;
      }
    }

    return sanitized;
  }

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
      case 'getPageInfo': return `Page: ${result.title || ''} â€” ${result.links || 0} links, ${result.forms || 0} forms`;
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
   * links, buttons, inputs, forms, selects, textareas, AND
   * generic clickable elements (spans, divs, lis with event handlers,
   * cursor:pointer styles, role attributes, tabindex, onclick, etc.)
   * Respects the user's HTML parse limit setting.
   * Selectors prefer role/name/text over brittle CSS.
   */
  async _scanAllActionableElements() {
    try {
      const settings = await this.sp.getSettings();
      const limit = settings.htmlParseLimit || 300;

      const result = await this._dispatchAction({
        action: 'page_script',
        id: this._generateId(),
        params: {
          code: `(function() {
            const limit = ${limit};
            const elements = { links: [], buttons: [], inputs: [], forms: [], selects: [], clickables: [] };
            const seenSelectors = new Set();

            function makeSelector(el) {
              // Prefer stable, semantic selectors over brittle CSS classes
              if (el.id) return '#' + CSS.escape(el.id);
              if (el.name) return ':name("' + String(el.name).replace(/"/g, '\\\\"') + '")';
              const role = el.getAttribute('role') || '';
              const accName = (el.getAttribute('aria-label') || el.title || '').trim();
              if (role && accName) {
                return ':role("' + role + '","' + accName.substring(0, 60).replace(/"/g, '\\\\"') + '")';
              }
              const text = (el.textContent || '').trim();
              if (text && text.length <= 40 && /^(A|BUTTON|LABEL|SUMMARY)$/i.test(el.tagName)) {
                return ':text("' + text.replace(/"/g, '\\\\"') + '")';
              }
              if (el.className && typeof el.className === 'string') {
                const cls = el.className.trim().split(/\\s+/)[0];
                if (cls && cls.length < 40) return el.tagName.toLowerCase() + '.' + cls;
              }
              return el.tagName.toLowerCase();
            }

            function isVisible(el) {
              if (!el || el.offsetParent === null) return false;
              const s = window.getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }

            // ── Links ──
            const allLinks = document.querySelectorAll('a[href], a:not([href]), [role="link"]');
            for (const a of allLinks) {
              if (elements.links.length >= limit) break;
              const text = (a.textContent || a.getAttribute('aria-label') || a.title || '').trim().substring(0, 80);
              const href = a.href || '';
              const sel = makeSelector(a);
              if (text && isVisible(a) && !href.startsWith('javascript:void') && !seenSelectors.has(sel)) {
                seenSelectors.add(sel);
                elements.links.push({
                  text,
                  href: href.substring(0, 200),
                  selector: sel,
                  tag: a.tagName.toLowerCase(),
                  role: a.getAttribute('role') || 'link',
                  name: a.getAttribute('name') || '',
                  hasHref: !!a.href && a.href !== window.location.href + '#'
                });
              }
            }

            // ── Buttons ──
            const buttonSelector = 'button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"], ' +
              '[class*="btn"]:not(form):not(div.btn-group), [class*="button"]:not(form):not(div.button-group)';
            const allButtons = document.querySelectorAll(buttonSelector);
            for (const b of allButtons) {
              if (elements.buttons.length >= limit) break;
              const text = (b.textContent || b.value || b.getAttribute('aria-label') || b.title || '').trim().substring(0, 60);
              const sel = makeSelector(b);
              if (text && isVisible(b) && !seenSelectors.has(sel)) {
                seenSelectors.add(sel);
                elements.buttons.push({
                  text,
                  selector: sel,
                  type: b.tagName.toLowerCase(),
                  role: b.getAttribute('role') || (b.tagName.toLowerCase() === 'button' ? 'button' : ''),
                  name: b.getAttribute('name') || b.id || ''
                });
              }
            }

            // ── Clickables ──
            const interactiveAttrs = ['onclick', 'ng-click', '@click', 'v-on:click', 'data-click', 'data-action', 'data-url'];
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
              if (elements.clickables.length >= limit) break;
              const tag = el.tagName.toLowerCase();
              if (/^(html|body|head|script|style|meta|link|br|hr|img|svg|path|g|circle|rect|polygon|polyline|line|text)$/i.test(tag)) continue;
              if (/^(a|button|input|select|textarea|form|option|optgroup|label)$/i.test(tag)) continue;

              const sel = makeSelector(el);
              if (!isVisible(el) || seenSelectors.has(sel)) continue;

              let reason = '';
              for (const attr of interactiveAttrs) {
                if (el.hasAttribute(attr)) { reason = attr; break; }
              }
              if (!reason) {
                const role = el.getAttribute('role');
                if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab' || role === 'option' || role === 'treeitem') {
                  reason = 'role=' + role;
                }
              }
              if (!reason && el.hasAttribute('tabindex')) {
                const ti = el.getAttribute('tabindex');
                if (ti !== '-1') reason = 'tabindex=' + ti;
              }
              if (!reason) {
                const cs = window.getComputedStyle(el);
                if (cs.cursor === 'pointer') reason = 'cursor:pointer';
              }
              if (!reason) {
                for (const attr of ['data-id', 'data-value', 'data-href', 'data-target', 'data-toggle', 'data-index']) {
                  if (el.hasAttribute(attr)) { reason = attr; break; }
                }
              }

              if (reason) {
                const text = (el.textContent || el.getAttribute('aria-label') || el.title || '').trim().substring(0, 60);
                if (text && text.length < 200) {
                  seenSelectors.add(sel);
                  elements.clickables.push({
                    text,
                    selector: sel,
                    tag,
                    role: el.getAttribute('role') || '',
                    reason,
                    className: (typeof el.className === 'string' ? el.className.substring(0, 40) : '')
                  });
                }
              }
            }

            // ── Inputs ──
            const allInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea');
            for (const inp of allInputs) {
              if (elements.inputs.length >= limit) break;
              const label = inp.getAttribute('placeholder') || inp.getAttribute('aria-label') || inp.getAttribute('name') || inp.id || (inp.tagName + ' field');
              const sel = makeSelector(inp);
              if (isVisible(inp) && !seenSelectors.has(sel)) {
                seenSelectors.add(sel);
                elements.inputs.push({
                  label: label.substring(0, 60),
                  text: label.substring(0, 60),
                  type: inp.type || 'text',
                  selector: sel,
                  tag: inp.tagName.toLowerCase(),
                  name: inp.getAttribute('name') || inp.id || '',
                  role: inp.getAttribute('role') || 'textbox'
                });
              }
            }

            // ── Forms ──
            const allForms = document.querySelectorAll('form');
            for (const f of allForms) {
              if (elements.forms.length >= 10) break;
              const id = f.id || '';
              const action = f.action || '';
              const inputCount = f.querySelectorAll('input, textarea, select').length;
              if (inputCount > 0 && isVisible(f)) {
                elements.forms.push({
                  id: id.substring(0, 40),
                  action: action.substring(0, 100),
                  inputCount,
                  selector: id ? '#' + CSS.escape(id) : 'form'
                });
              }
            }

            // ── Selects ──
            const allSelects = document.querySelectorAll('select');
            for (const s of allSelects) {
              if (elements.selects.length >= limit) break;
              const optCount = s.options.length;
              const sel = makeSelector(s);
              if (isVisible(s) && !seenSelectors.has(sel)) {
                seenSelectors.add(sel);
                elements.selects.push({
                  optionCount: optCount,
                  selector: sel,
                  name: s.name || s.id || '',
                  label: s.getAttribute('aria-label') || s.name || s.id || 'select',
                  text: s.getAttribute('aria-label') || s.name || s.id || 'select'
                });
              }
            }

            return JSON.stringify({
              totalLinks: elements.links.length,
              totalButtons: elements.buttons.length,
              totalInputs: elements.inputs.length,
              totalForms: elements.forms.length,
              totalSelects: elements.selects.length,
              totalClickables: elements.clickables.length,
              elements: elements
            });
          })()`
        },
        timeout: 10000
      });

      if (result.success && result.result?.result) {
        try { return JSON.parse(result.result.result); } catch (e) { return null; }
      }
      return null;
    } catch (e) { return null; }
  }
}

// Export for use in sidepanel.js
// (Attached to window since we're not using modules)
if (typeof window !== 'undefined') {
  window.SNNAgentLoop = SNNAgentLoop;
}
