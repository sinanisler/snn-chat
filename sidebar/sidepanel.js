// SNN Chat — Side Panel Script 
// Full chat UI running in Chrome's native side panel (chrome.sidePanel API).
// Communicates with content script & background via chrome.storage.session + runtime messages.

class SNNSidePanel {
  constructor() {
    this.chatHistory = [];
    this.isLoading = false;
    this.totalTokensUsed = 0;
    this.currentDomain = '';
    this.currentTabId = null;        // ← per-tab session tracking
    this.currentSessionId = this.generateId();
    this.pageContext = null;
    this.selection = null;

    // ── Session Lock: single session across all tabs ────────────
    this._chatLockEnabled = false;
    this._chatLockKey = 'snn_chat_history___locked___';

    // ── In-flight request cancellation ─────────────────────────
    this._activeAbortController = null;

    // Active context that WILL be attached to the NEXT user message.
    this.activeContext = null;
    // Track whether context was already used by a message in current session
    this._contextConsumedInSession = false;

    // ── Agent Loop Integration ─────────────────────────────────
    this._agentLoop = null;
    this._agentUI = null;

    // ── Last screenshot for vision follow-up questions ────────
    this._lastScreenshot = null;

    this.cacheDom();
    this.setupListeners();
    this.init();
  }

  // ── DOM Cache ───────────────────────────────────────────────────
  cacheDom() {
    this.el = (id) => document.getElementById(id);
    this.els = {
      chatMessages: this.el('chat-messages'),
      userInput: this.el('user-input'),
      sendBtn: this.el('send-btn'),
      voiceBtn: this.el('voice-btn'),
      modelName: this.el('current-model'),
      selectionBar: this.el('selection-bar'),
      selectionText: this.el('selection-text'),
      welcomeScreen: this.el('welcome-screen'),
      tokenCounter: this.el('token-counter'),
      smartPrompts: this.el('smart-prompts'),
      promptsGrid: this.el('prompts-grid'),
      settingsOverlay: this.el('settings-overlay'),
      settingsBody: this.el('settings-body'),
      historyOverlay: this.el('history-overlay'),
      historyBody: this.el('history-body'),
      // Context indicator above input
      inputContextIndicator: this.el('input-context-indicator'),
      inputContextText: this.el('input-context-text'),
      dismissInputContext: this.el('dismiss-input-context'),
      // Tab indicator in header
      tabDomain: this.el('tab-domain'),
      // Session Lock
      chatLockCheckbox: this.el('chat-lock-checkbox')
    };
  }

  // ── Init ────────────────────────────────────────────────────────
  async init() {
    await this.applySettings();

    // ── Load Session Lock state BEFORE loading sessions ──
    await this._loadChatLockState();

    // ── Get OUR window ID (critical for multi-monitor filtering) ──
    try {
      const win = await chrome.windows.getCurrent();
      this.windowId = win.id;
    } catch (e) {
      this.windowId = null;
    }

    // ── Determine active tab for OUR window ──
    // The background stores per-window: snn_active_tab_{windowId}
    if (this.windowId != null) {
      const key = `snn_active_tab_${this.windowId}`;
      const data = await chrome.storage.session.get(key);
      const snn_active_tab = data[key];
      if (snn_active_tab?.tabId) {
        this.currentTabId = snn_active_tab.tabId;
        this.currentDomain = snn_active_tab.domain || '';
      }
    }

    // Fallback: query directly if storage is empty (first run)
    if (!this.currentTabId) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          this.currentTabId = tab.id;
          this.currentDomain = new URL(tab.url).hostname;
        }
      } catch (e) { /* may fail without tabs permission */ }
    }

    // ── Configure marked (GFM: tables, task lists, strikethrough, etc.) ──
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true
      });
      // Mermaid integration: output <pre class="mermaid"> instead of <pre><code> for mermaid blocks
      marked.use({
        renderer: {
          code(token) {
            if (token.lang === 'mermaid') {
              return `<pre class="mermaid">${token.text}</pre>`;
            }
            return false; // use default renderer for other code blocks
          }
        }
      });
    }

    // ── Configure Mermaid ──
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        securityLevel: 'strict',
        themeVariables: {
          primaryColor: '#0556c7',
          primaryTextColor: '#fff',
          lineColor: '#0556c7',
        }
      });
    }

    await this.loadContext();
    await this.loadMostRecentSession();
    this.renderQuickActions();
    this.setupVoice();
    this.setupContextWatcher();
    this._setupTabTracking();
    this._initAgentLoop();

    // Show welcome or quick actions
    if (this.chatHistory.length === 0) {
      this.els.smartPrompts.style.display = 'block';
    }

    this._updateLockVisuals();

    // ── Pick up any pending context-menu prompt (right-click "Ask SNN about…") ──
    this._checkContextMenuPrompt();
  }

  // ── Event Listeners ─────────────────────────────────────────────
  setupListeners() {
    this.els.sendBtn.addEventListener('click', () => this.sendMessage());
    this.els.userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
    });
    this.els.userInput.addEventListener('input', () => this.autoResize());

    this.el('model-settings-btn').addEventListener('click', () => this.openSettings());
    this.el('settings-btn').addEventListener('click', () => this.openSettings());
    this.el('new-chat-btn').addEventListener('click', () => this.newSession());
    this.el('history-btn').addEventListener('click', () => this.openHistory());
    this.el('clear-context-btn').addEventListener('click', () => this.clearChat());
    this.el('clear-selection').addEventListener('click', () => this.clearSelection());
    this.el('close-settings').addEventListener('click', () => this.closeSettings());
    this.el('close-history').addEventListener('click', () => this.closeHistory());
    this.els.dismissInputContext.addEventListener('click', () => this.dismissInputContext());

    // Session Lock checkbox
    this.els.chatLockCheckbox.addEventListener('change', () => this._toggleChatLock());

    // Overlay backdrop clicks
    this.els.settingsOverlay.addEventListener('click', (e) => {
      if (e.target === this.els.settingsOverlay) this.closeSettings();
    });
    this.els.historyOverlay.addEventListener('click', (e) => {
      if (e.target === this.els.historyOverlay) this.closeHistory();
    });

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Cancel agent loop if running
        if (this._agentLoop && this._agentLoop.isBusy) {
          this._agentLoop.cancel();
          this.showToast('Cancelled');
          return;
        }
        if (this.els.settingsOverlay.classList.contains('visible')) this.closeSettings();
        else if (this.els.historyOverlay.classList.contains('visible')) this.closeHistory();
      }
      if (e.ctrlKey && e.key === 's' && this.els.settingsOverlay.classList.contains('visible')) {
        e.preventDefault(); this.saveSettings();
      }
    });
  }

  // ── Page Context ────────────────────────────────────────────────
  async loadContext() {
    const { snn_page_context } = await chrome.storage.session.get('snn_page_context');
    if (snn_page_context) {
      // Only accept context from the current tab (or if no tabId was stored, accept it)
      if (!snn_page_context.tabId || snn_page_context.tabId === this.currentTabId) {
        this.pageContext = snn_page_context;
        this.currentDomain = snn_page_context.domain || this.currentDomain;
        this._updateTabIndicator();
      }
    }
    // Request fresh extraction from current tab's content script
    chrome.runtime.sendMessage({ action: 'requestPageContent' }).catch(() => {});
  }

  setupContextWatcher() {
    chrome.storage.session.onChanged.addListener((changes) => {
      let needsRefresh = false;
      if (changes.snn_page_context) {
        const ctx = changes.snn_page_context.newValue;
        // Only accept context from the currently active tab
        if (ctx && ctx.tabId && ctx.tabId !== this.currentTabId) return;
        this.pageContext = ctx;
        if (this.pageContext) {
          this.currentDomain = this.pageContext.domain || this.currentDomain;
          this._updateTabIndicator();
        }
        needsRefresh = true;
      }
      if (changes.snn_selection) {
        const sel = changes.snn_selection.newValue;
        // Only accept selection from the currently active tab
        if (sel && sel.tabId && sel.tabId !== this.currentTabId) return;
        this.selection = sel;
        if (this.selection) {
          this.updateSelectionBar();
        } else {
          this.els.selectionBar.style.display = 'none';
        }
        needsRefresh = true;
      }
      // ── Context-menu prompt from background (right-click "Ask SNN about…") ──
      if (changes.snn_context_menu_prompt && changes.snn_context_menu_prompt.newValue) {
        // Process immediately — no debounce (user explicitly invoked)
        this._checkContextMenuPrompt();
      }

      // Debounce: rapid storage changes (e.g. page+selection together,
      // or multiple content extractions) only trigger one UI refresh.
      if (needsRefresh) {
        clearTimeout(this._ctxDebounce);
        this._ctxDebounce = setTimeout(() => this.refreshActiveContext(), 150);
      }
    });
    // Initial active context
    this.refreshActiveContext();
  }

  // ── Context-Menu Prompt Handler ────────────────────────────────
  // Picks up right-click "Ask SNN about…" prompts stored by the
  // background service worker and auto-sends them in the chat.
  async _checkContextMenuPrompt() {
    // Re-entry guard: prevent concurrent processing (e.g. storage
    // listener fires while we're still waiting for page context).
    if (this._ctxMenuInProgress) return;

    try {
      // Don't interrupt an in-flight message — the prompt stays in
      // storage and will be picked up at the end of sendMessage().
      if (this.isLoading) return;

      // ── Retry loop: the background stores the prompt right after
      //     calling sidePanel.open(), so there's a tiny race window
      //     where storage hasn't landed yet.  Poll a few times.
      let data = await chrome.storage.session.get('snn_context_menu_prompt');
      let entry = data.snn_context_menu_prompt;
      let retries = 0;
      while ((!entry || !entry.prompt) && retries < 5) {
        await new Promise(r => setTimeout(r, 100));
        data = await chrome.storage.session.get('snn_context_menu_prompt');
        entry = data.snn_context_menu_prompt;
        retries++;
      }

      if (!entry || !entry.prompt) return; // nothing to do

      // Only process prompts for the current tab (guard cross-tab leakage).
      // If we haven't resolved currentTabId yet, accept anyway — better to
      // answer the wrong tab than silently swallow the user's query.
      if (this.currentTabId != null && entry.tabId != null && entry.tabId !== this.currentTabId) {
        console.warn('[SNN] Context-menu prompt for tab', entry.tabId, 'but we are on tab', this.currentTabId, '— skipping');
        // Clear stale prompt so it doesn't stick around forever
        await chrome.storage.session.remove('snn_context_menu_prompt');
        return;
      }

      // Consume immediately so it never fires twice
      await chrome.storage.session.remove('snn_context_menu_prompt');

      this._ctxMenuInProgress = true;

      // ── UX: Flash the input area to draw user attention ────────
      this._flashInputArea();

      // ── Wait for page context if we don't have it yet ──────────
      // The content script may still be extracting; give it up to 2 s.
      if (!this.pageContext?.content) {
        let waited = 0;
        while (waited < 2000 && !this.pageContext?.content) {
          await new Promise(r => setTimeout(r, 200));
          waited += 200;
        }
      }

      // Ensure page context is ready to attach for page-level prompts
      if (this.pageContext && !this._contextConsumedInSession) {
        this.refreshActiveContext();
      }

      // ── Show brief toast that a query was received ────────────
      const preview = entry.prompt.length > 50
        ? entry.prompt.substring(0, 47) + '…'
        : entry.prompt;
      this.showToast(`→ "${preview}"`, '');

      // ── Inject prompt, focus input briefly, then auto-send ────
      this.els.userInput.value = entry.prompt;
      this.autoResize();
      this.els.userInput.focus();
      // Brief pause so the user can see the query flash in the input
      // before it sends — improves perceived responsiveness.
      await new Promise(r => setTimeout(r, 80));
      this.sendMessage();
    } catch (e) {
      console.warn('[SNN] Context-menu prompt check failed:', e.message);
    } finally {
      this._ctxMenuInProgress = false;
    }
  }

  // ── Flash the input area to draw user attention ───────────────
  _flashInputArea() {
    const wrapper = this.els.userInput?.closest('.sp-input-wrapper');
    if (!wrapper) return;
    wrapper.classList.add('sp-input-flash');
    setTimeout(() => wrapper.classList.remove('sp-input-flash'), 600);
  }

  // ── Active Context Resolution ──────────────────────────────────
  // Decides what context will be attached to the NEXT user message.
  // Priority: selection > page context > nothing.
  refreshActiveContext() {
    // If context was already consumed in this session and nothing
    // new selected, don't re-attach stale page context.
    if (this.selection?.text) {
      this.activeContext = {
        type: 'selection',
        summary: this.selection.text.length > 80
          ? this.selection.text.substring(0, 80) + '...'
          : this.selection.text,
        detail: this.selection.text
      };
    } else if (this.pageContext?.content && !this._contextConsumedInSession) {
      this.activeContext = {
        type: 'page',
        summary: (this.pageContext.title || 'This page') + ' · ' +
                 (this.pageContext.wordCount || 0).toLocaleString() + ' words',
        detail: this.pageContext.content,
        title: this.pageContext.title,
        wordCount: this.pageContext.wordCount
      };
    } else if (this.pageContext?.content && this._contextConsumedInSession) {
      // Page context exists but already used — only attach if user explicitly
      // selected something new. Otherwise no auto-context for ongoing chats.
      this.activeContext = null;
    } else {
      this.activeContext = null;
    }
    this.updateInputContextIndicator();
  }

  // Show a subtle indicator above the input showing what will be attached
  updateInputContextIndicator() {
    if (this.activeContext) {
      this.els.inputContextIndicator.style.display = 'flex';
      const icon = this.activeContext.type === 'selection' ? '📝' : '📄';
      this.els.inputContextIndicator.querySelector('.sp-input-context-icon').textContent = icon;
      this.els.inputContextText.textContent = this.activeContext.summary;
      this.els.inputContextText.title = this.activeContext.type === 'selection'
        ? this.activeContext.detail
        : (this.activeContext.title || '') + ' — ' + (this.activeContext.wordCount || 0) + ' words';
    } else {
      this.els.inputContextIndicator.style.display = 'none';
    }
  }

  dismissInputContext() {
    this.activeContext = null;
    this._contextConsumedInSession = true;
    this.els.inputContextIndicator.style.display = 'none';
    // Also clear any selection
    if (this.selection) this.clearSelection();
  }

  // ── Tab Tracking ────────────────────────────────────────────────
  // Listens for tab-switch messages from the background service worker.
  // CRITICAL: chrome.runtime.sendMessage broadcasts to ALL windows.
  // We MUST filter by windowId to avoid cross-window tab leaks.
  _setupTabTracking() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'tabSwitched') {
        // Only respond to tab switches in OUR window (critical for multi-monitor)
        if (this.windowId != null && message.windowId !== this.windowId) return;
        this._onTabSwitched(message.tabId, message.url, message.domain);
      }
      if (message.action === 'tabClosed') {
        // If the closed tab was our current one, the background will
        // send a tabSwitched for the new active tab shortly after.
        // We just clear stale reference.
        if (message.tabId === this.currentTabId) {
          this.currentTabId = null;
        }
      }
    });
  }

  async _onTabSwitched(tabId, url, domain) {
    if (tabId === this.currentTabId) return; // Same tab, nothing to do

    // ═══════════════════════════════════════════════════════════
    // SESSION LOCK: bypass per-tab session switching entirely
    // Only update tab reference — chat, session, history stay intact
    // ═══════════════════════════════════════════════════════════
    if (this._chatLockEnabled) {
      // Do NOT cancel agent loop — it continues on the original tab
      // Do NOT save/clear/load session — locked session persists

      this.currentTabId = tabId;
      this.currentDomain = domain || '';
      // Keep currentSessionId, chatHistory, _historyKey unchanged

      // Reset per-tab state: context/selection should refresh for new tab
      this.pageContext = null;
      this.selection = null;
      this.activeContext = null;
      this._contextConsumedInSession = false;
      this.els.selectionBar.style.display = 'none';
      this.els.inputContextIndicator.style.display = 'none';

      // Update domain indicator and request fresh page context
      this._updateLockVisuals();
      chrome.runtime.sendMessage({ action: 'requestPageContent' }).catch(() => {});
      this.refreshActiveContext();

      // ── Check for pending context-menu prompts targeting this tab ──
      this._checkContextMenuPrompt();

      this.showToast(`Tab: ${this.currentDomain || 'new tab'} (🔒 session locked)`);
      return;
    }

    // ── Cancel any running agent loop BEFORE clearing state ──
    if (this._agentLoop && this._agentLoop.isBusy) {
      this._agentLoop.cancel('tab-switch');
      // Brief pause to let cancellation propagate
      await new Promise(r => setTimeout(r, 100));
    }

    // Save current session BEFORE aborting/closing anything
    if (this.chatHistory.length) {
      await this.saveChatHistory();
    }

    // ── Now safe to abort in-flight fetch and reset UI ──
    this._resetLoadingState();

    // Switch to the new tab
    this.currentTabId = tabId;
    this.currentDomain = domain || '';
    this.currentSessionId = this.generateId(); // default: new session
    this._historyKey = null;                   // will be rebuilt from tabId
    this.chatHistory = [];
    this.totalTokensUsed = 0;
    this.activeContext = null;
    this.pageContext = null;
    this.selection = null;

    // Clear UI
    this.els.chatMessages.innerHTML = '';
    this.els.welcomeScreen.style.display = '';
    this.els.smartPrompts.style.display = 'block';
    this.els.tokenCounter.style.display = 'none';
    this.els.selectionBar.style.display = 'none';
    this.els.inputContextIndicator.style.display = 'none';

    // Update domain indicator immediately
    this._updateTabIndicator();

    // Request fresh page content extraction from the new tab
    chrome.runtime.sendMessage({ action: 'requestPageContent' }).catch(() => {});

    // Load existing session for this tab (if any).
    // restoreChat() will correctly set _contextConsumedInSession
    // based on whether the restored history already used context.
    await this.loadMostRecentSession();

    // Refresh context for the new tab
    this._updateLockVisuals();
    this.refreshActiveContext();

    // If no session was restored, ensure context can attach fresh
    if (this.chatHistory.length === 0) {
      this._contextConsumedInSession = false;
      this.els.smartPrompts.style.display = 'block';
    }

    // ── Check for pending context-menu prompts targeting this tab ──
    this._checkContextMenuPrompt();

    // Show a subtle toast
    this.showToast(`Switched to ${this.currentDomain || 'new tab'}`);
  }

  // Show current tab domain in the header
  _updateTabIndicator() {
    if (this.els.tabDomain && this.currentDomain) {
      const prefix = this._chatLockEnabled ? '🔒 ' : '';
      this.els.tabDomain.textContent = prefix + this.currentDomain;
      this.els.tabDomain.title = (this._chatLockEnabled ? '[Locked] ' : '') + 'Active tab: ' + this.currentDomain;
    }
  }

  /**
   * Update all UI elements that reflect Session Lock state:
   * domain indicator, input area styling.
   */
  _updateLockVisuals() {
    this._updateTabIndicator();
    const footer = document.querySelector('.sp-input-area');
    if (footer) {
      footer.classList.toggle('sp-locked', this._chatLockEnabled);
    }
  }

  updateSelectionBar() {
    if (!this.selection || !this.selection.text) {
      this.els.selectionBar.style.display = 'none';
      return;
    }
    this.els.selectionBar.style.display = 'flex';
    const text = this.selection.text;
    this.els.selectionText.textContent = text.length > 100 ? text.substring(0, 100) + '...' : text;
  }

  clearSelection() {
    this.selection = null;
    this.els.selectionBar.style.display = 'none';
    chrome.runtime.sendMessage({ action: 'clearSelection' }).catch(() => {});
    this.refreshActiveContext();
  }

  // ── Chat ────────────────────────────────────────────────────────
  async sendMessage() {
    const message = this.els.userInput.value.trim();
    if (!message || this.isLoading) return;

    // ── Snapshot the context that will be attached to THIS message ──
    const contextSnapshot = this.activeContext ? { ...this.activeContext } : null;
    // ── Snapshot tab so we can discard stale responses after tab switch ──
    const sendTabId = this.currentTabId;

    // ── Create abort controller so we can cancel in-flight fetch on tab switch ──
    this._activeAbortController = new AbortController();
    const signal = this._activeAbortController.signal;

    this.isLoading = true;
    this.els.sendBtn.disabled = true;
    this.els.userInput.value = '';
    this.autoResize();
    this.els.smartPrompts.style.display = 'none';
    this.els.welcomeScreen.style.display = 'none';

    // Mark context as consumed so page context won't re-attach automatically
    if (contextSnapshot) {
      this._contextConsumedInSession = true;
    }

    // Render user message with context chip
    this.addMessage('user', message, null, contextSnapshot);

    // ── Push user message to chatHistory NOW so it survives tab switches ──
    this.chatHistory.push({
      role: 'user', content: message,
      contextType: contextSnapshot?.type || 'none',
      context: contextSnapshot
    });
    await this.saveChatHistory();

    // ── Try Agent Loop first ───────────────────────────────────
    // Skip agent loop for informational queries when page context is available —
    // go straight to streaming chat (faster, and the LLM already has the context).
    const skipAgent = this._shouldSkipAgentLoop(message, contextSnapshot);

    if (this._agentLoop && !this._agentLoop.isBusy && !skipAgent) {
      try {
        const agentResult = await this._agentLoop.run(message, contextSnapshot, this.currentTabId);

        // Tab-switch guard: only discard if NOT in locked mode
        if (!this._chatLockEnabled && this.currentTabId !== sendTabId) { this._resetLoadingState(); return; }

        if (agentResult && agentResult.type === 'action') {
          // ── Handle capability queries ────────────────────
          if (agentResult.subtype === 'capabilities' && agentResult.results?.length > 0) {
            const capData = agentResult.results[0].result;
            this._renderCapabilitiesInChat(capData);
            this.chatHistory.push(
              { role: 'assistant', content: this._formatCapabilitiesForHistory(capData) }
            );
            await this.saveChatHistory();
          }
          // ── Render LLM's synthesized response if present ──
          if (agentResult.llmResponse) {
            await this.streamRenderMessage(agentResult.llmResponse);
            this.chatHistory.push(
              { role: 'assistant', content: agentResult.llmResponse }
            );
            await this.saveChatHistory();
          }
          // Agent loop handled it
          this.isLoading = false;
          this.els.sendBtn.disabled = false;
          this.els.userInput.focus();
          if (this.selection) { this.clearSelection(); }
          else { this.activeContext = null; this.refreshActiveContext(); }
          this._checkContextMenuPrompt();
          return;
        }

        // ── Agent returned { type:'chat', content } — stream it directly ──
        if (agentResult && agentResult.type === 'chat' && agentResult.content) {
          await this.streamRenderMessage(agentResult.content);
          this.chatHistory.push(
            { role: 'assistant', content: agentResult.content }
          );
          await this.saveChatHistory();
          this.isLoading = false;
          this.els.sendBtn.disabled = false;
          this.els.userInput.focus();
          if (this.selection) { this.clearSelection(); }
          else { this.activeContext = null; this.refreshActiveContext(); }
          this._checkContextMenuPrompt();
          return;
        }
        // agentResult.type === 'chat' without content → fall through to normal chat
      } catch (agentErr) {
        console.warn('Agent loop failed, falling back to chat:', agentErr.message);
      }
    }

    try {
      const settings = await this.getSettings();
      let context = '';
      let contextType = 'none';

      if (contextSnapshot) {
        context = contextSnapshot.detail || '';
        contextType = contextSnapshot.type;
      }

      let response;
      if (settings.enableStreaming !== false) {
        response = await this.streamResponse(message, context, contextType, signal);
      } else {
        this.addLoadingMsg();
        response = await this.callAPI(message, context, contextType, signal);
        this.removeLoadingMsg();
      }

      // ── Tab-switch guard: discard if user switched tabs during API call ──
      if (!this._chatLockEnabled && this.currentTabId !== sendTabId) { this._resetLoadingState(); return; }

      if (settings.enableStreaming !== false) {
        // Streaming already rendered into DOM; just record in history
        this.chatHistory.push(
          { role: 'assistant', content: response, tokenUsage: this.lastTokenUsage }
        );
      } else {
        this.addMessage('ai', response, this.lastTokenUsage);
        this.chatHistory.push(
          { role: 'assistant', content: response, tokenUsage: this.lastTokenUsage }
        );
      }

      await this.saveChatHistory();
    } catch (error) {
      // ── Tab-switch guard for errors too ──
      if (!this._chatLockEnabled && this.currentTabId !== sendTabId) { this._resetLoadingState(); return; }
      // Don't show AbortError — it's intentional (tab switch cancelled the request)
      if (error.name === 'AbortError') { this._resetLoadingState(); return; }
      this.removeLoadingMsg();
      this.addMessage('ai', `Error: ${error.message}`);
    }

    // Clear active context after sending (selection consumed)
    if (this.selection) {
      this.clearSelection(); // calls refreshActiveContext() internally
    } else {
      this.activeContext = null;
      this.refreshActiveContext();
    }

    this.isLoading = false;
    this.els.sendBtn.disabled = false;
    this.els.userInput.focus();
    this._activeAbortController = null;

    // Flush any context-menu prompt that arrived while we were loading
    this._checkContextMenuPrompt();
  }

  async callAPI(message, context, contextType, signal) {
    const settings = await this.getSettings();
    const apiKey = settings.openrouterKey;
    if (!apiKey) throw new Error('OpenRouter API key not set. Add it in Settings.');

    const model = settings.openrouterModel || 'deepseek/deepseek-v4-flash';
    let systemPrompt = settings.systemPrompt || 'You are a helpful AI assistant. Be concise and accurate.';
    systemPrompt = this._getAugmentedSystemPrompt(systemPrompt);

    let userMessage = message;
    if (context && contextType === 'selection') {
      userMessage = `[Selected text: "${context}"]\n\n${message}`;
      systemPrompt += '\nFocus on the user\'s selected text.';
    } else if (context && contextType === 'page') {
      systemPrompt += `\n\nPage content for reference:\n\n${context}`;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.chatHistory.slice(-8).map(m => ({
        role: m.role,
        content: m.content
      })),
      { role: 'user', content: userMessage }
    ];

    // ── Attach last screenshot as vision content if available ──
    const screenshotData = this._lastScreenshot;
    if (screenshotData) {
      messages[messages.length - 1] = {
        role: 'user',
        content: [
          { type: 'text', text: userMessage },
          { type: 'image_url', image_url: { url: screenshotData } }
        ]
      };
      this._lastScreenshot = null;
    }

    const body = {
      model,
      messages,
      max_tokens: settings.maxTokens || 4096,
      temperature: settings.temperature ?? 0.7
    };
    if (settings.topP !== undefined) body.top_p = settings.topP;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/sinanisler/SNN-Chat',
        'X-Title': 'SNN Chat'
      },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      let err = `API error ${res.status}`;
      try { const d = await res.json(); if (d.error?.message) err = d.error.message; } catch (e) {}
      throw new Error(err);
    }

    const data = await res.json();
    this.lastTokenUsage = {
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
      total_tokens: data.usage?.total_tokens || 0
    };
    return data.choices[0]?.message?.content || '';
  }

  async streamResponse(message, context, contextType, signal) {
    const settings = await this.getSettings();
    const apiKey = settings.openrouterKey;
    if (!apiKey) throw new Error('OpenRouter API key not set.');

    const model = settings.openrouterModel || 'deepseek/deepseek-v4-flash';
    let systemPrompt = settings.systemPrompt || 'You are a helpful AI assistant.';
    systemPrompt = this._getAugmentedSystemPrompt(systemPrompt);
    let userMessage = message;

    if (context && contextType === 'selection') {
      userMessage = `[Selected text: "${context}"]\n\n${message}`;
      systemPrompt += '\nFocus on the user\'s selected text.';
    } else if (context && contextType === 'page') {
      systemPrompt += `\n\nPage content:\n\n${context}`;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.chatHistory.slice(-8).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage }
    ];

    // ── Attach last screenshot as vision content if available ──
    const screenshotData = this._lastScreenshot;
    if (screenshotData) {
      messages[messages.length - 1] = {
        role: 'user',
        content: [
          { type: 'text', text: userMessage },
          { type: 'image_url', image_url: { url: screenshotData } }
        ]
      };
      this._lastScreenshot = null; // consume it
    }

    const body = {
      model, messages, stream: true,
      max_tokens: settings.maxTokens || 4096,
      temperature: settings.temperature ?? 0.7
    };
    if (settings.topP !== undefined) body.top_p = settings.topP;

    // Create streaming message element
    const msgDiv = document.createElement('div');
    msgDiv.className = 'sp-msg sp-msg-ai';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'sp-msg-content';
    msgDiv.appendChild(contentDiv);
    this.els.chatMessages.appendChild(msgDiv);

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/sinanisler/SNN-Chat',
        'X-Title': 'SNN Chat'
      },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      msgDiv.remove();
      throw new Error(`API error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines from buffer
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, newlineIdx).trim();
        buffer = buffer.substring(newlineIdx + 1);

        if (!line) continue; // skip empty lines (SSE heartbeat)

        // Handle SSE comments
        if (line.startsWith(':')) continue;

        // Handle data: prefix
        let data = line;
        if (line.startsWith('data:')) {
          data = line.substring(5).trimStart();
        } else if (line.startsWith('data: ')) {
          data = line.substring(6);
        }

        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            fullResponse += content;
            contentDiv.innerHTML = this.parseMarkdown(fullResponse) + '<span class="sp-cursor">|</span>';
            this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
          }
          if (parsed.usage) {
            this.lastTokenUsage = {
              prompt_tokens: parsed.usage.prompt_tokens || 0,
              completion_tokens: parsed.usage.completion_tokens || 0,
              total_tokens: parsed.usage.total_tokens || 0
            };
          }
        } catch (e) { /* skip malformed JSON lines */ }
      }
    }
    // Process any remaining data in buffer (shouldn't normally happen)
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) fullResponse += content;
          } catch (e) { /* skip */ }
        }
      }
    }

    contentDiv.innerHTML = this.parseMarkdown(fullResponse);
    this.renderMermaid(contentDiv);
    this.addMsgActions(msgDiv, fullResponse);
    this.addTokenInfo(msgDiv);
    this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;

    return fullResponse;
  }

  // ── Message Rendering ──────────────────────────────────────────
  addMessage(role, content, tokenUsage, contextSnapshot) {
    this.els.welcomeScreen.style.display = 'none';

    // ── Context chip: rendered BEFORE the user bubble ──
    if (role === 'user' && contextSnapshot) {
      this.renderContextChip(contextSnapshot);
    }

    const div = document.createElement('div');
    div.className = `sp-msg sp-msg-${role}`;
    div.innerHTML = role === 'ai' ? this.parseMarkdown(content) : this.escapeHtml(content);
    this.els.chatMessages.appendChild(div);

    if (role === 'ai') {
      this.renderMermaid(div);
      this.addMsgActions(div, content);
      if (tokenUsage) this.addTokenInfo(div, tokenUsage);
    }

    this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
  }

  /**
   * Stream-render an AI message character by character.
   * Used for agent loop final responses to give a streaming feel
   * without making an extra API call.
   */
  async streamRenderMessage(content) {
    this.els.welcomeScreen.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'sp-msg sp-msg-ai';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'sp-msg-content';
    div.appendChild(contentDiv);
    this.els.chatMessages.appendChild(div);

    // Render in chunks for smooth visual streaming
    const CHUNK_SIZE = 3; // characters per frame
    let pos = 0;

    return new Promise((resolve) => {
      const renderChunk = () => {
        if (pos >= content.length) {
          // Final render — parse full markdown
          contentDiv.innerHTML = this.parseMarkdown(content);
          this.renderMermaid(div);
          this.addMsgActions(div, content);
          this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
          resolve();
          return;
        }

        const chunk = content.substring(0, pos + CHUNK_SIZE);
        pos += CHUNK_SIZE;

        // Use text rendering for speed during streaming, 
        // then final markdown parse at the end
        contentDiv.innerHTML = this.escapeHtml(chunk).replace(/\n/g, '<br>') + '<span class="sp-cursor">|</span>';
        this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;

        // Adaptive speed: faster for longer content
        const delay = content.length > 2000 ? 5 : (content.length > 500 ? 10 : 20);
        setTimeout(renderChunk, delay);
      };

      renderChunk();
    });
  }

  // ── Context Chip rendering ─────────────────────────────────────
  // Renders a small chip right before the user's message bubble
  // showing what context (page or selection) was attached.
  renderContextChip(ctx) {
    const chip = document.createElement('div');
    chip.className = 'sp-msg-context';

    let icon, label, detail;
    if (ctx.type === 'selection') {
      icon = '📝';
      label = 'Selected text';
      detail = ctx.summary || ctx.detail?.substring(0, 60) || '';
    } else {
      icon = '📄';
      label = 'Page context';
      detail = ctx.title || ctx.summary || '';
      if (ctx.wordCount) detail += ' · ' + ctx.wordCount.toLocaleString() + ' words';
    }

    chip.innerHTML = `
      <span class="sp-msg-context-icon">${icon}</span>
      <span class="sp-msg-context-label">${label}</span>
      <span class="sp-msg-context-detail">${this.escapeHtml(detail)}</span>
    `;
    chip.title = ctx.type === 'selection'
      ? 'Selected: ' + (ctx.detail || '')
      : 'Page: ' + (ctx.title || '') + ' (' + (ctx.wordCount || 0) + ' words)';

    this.els.chatMessages.appendChild(chip);
  }

  addLoadingMsg() {
    this.loadingDiv = document.createElement('div');
    this.loadingDiv.className = 'sp-msg sp-msg-ai loading';
    this.loadingDiv.textContent = 'Thinking...';
    this.els.chatMessages.appendChild(this.loadingDiv);
    this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
  }

  removeLoadingMsg() {
    if (this.loadingDiv) { this.loadingDiv.remove(); this.loadingDiv = null; }
  }

  addMsgActions(msgDiv, content) {
    const actions = document.createElement('div');
    actions.className = 'sp-msg-actions';
    actions.innerHTML = `
      <button class="sp-msg-action copy" title="Copy">Copy</button>
      <button class="sp-msg-action speak" title="Read aloud">Read</button>
    `;

    actions.querySelector('.copy').addEventListener('click', () => {
      navigator.clipboard.writeText(content);
      this.showToast('Copied!', 'success');
    });

    actions.querySelector('.speak').addEventListener('click', () => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      } else {
        const u = new SpeechSynthesisUtterance(content);
        window.speechSynthesis.speak(u);
      }
    });

    msgDiv.appendChild(actions);
  }

  addTokenInfo(msgDiv, tokenUsage) {
    const total = (tokenUsage?.prompt_tokens || 0) + (tokenUsage?.completion_tokens || 0);
    if (total > 0) {
      const info = document.createElement('div');
      info.className = 'sp-msg-tokens';
      info.textContent = `${total.toLocaleString()} tokens`;
      info.title = `Prompt: ${tokenUsage.prompt_tokens || 0}, Completion: ${tokenUsage.completion_tokens || 0}`;
      msgDiv.appendChild(info);
      this.totalTokensUsed += total;
      this.updateTokenCounter();
    }
  }

  // ── Markdown (powered by marked.js — GFM: tables, task lists, strikethrough, links, images) ──
  parseMarkdown(text) {
    if (typeof marked !== 'undefined') {
      return marked.parse(text);
    }
    // Graceful fallback if library fails to load
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, '<br>');
  }

  // ── Mermaid Diagram Rendering ──────────────────────────────────
  async renderMermaid(container) {
    if (typeof mermaid === 'undefined') return;
    const blocks = container.querySelectorAll('pre.mermaid');
    if (blocks.length === 0) return;
    try {
      // mermaid.run() finds and renders all .mermaid elements
      await mermaid.run({ nodes: Array.from(blocks) });
    } catch (e) {
      console.warn('Mermaid render failed:', e.message);
    }
  }

  escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // ── Token Counter ──────────────────────────────────────────────
  updateTokenCounter() {
    if (this.totalTokensUsed > 0) {
      this.els.tokenCounter.style.display = 'block';
      this.els.tokenCounter.textContent = `${this.totalTokensUsed.toLocaleString()} tokens`;
    } else {
      this.els.tokenCounter.style.display = 'none';
    }
  }

  // ── Input ──────────────────────────────────────────────────────
  autoResize() {
    const ta = this.els.userInput;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }

  // ── Quick Actions ──────────────────────────────────────────────
  async renderQuickActions() {
    const settings = await this.getSettings();
    const actions = settings.quickActions || this.getDefaultQuickActions();
    this.els.promptsGrid.innerHTML = actions.map((a) => `
      <button class="sp-prompt-chip" data-prompt="${this.escapeHtml(a.prompt)}">
        ${a.text}
      </button>
    `).join('');

    this.els.promptsGrid.querySelectorAll('.sp-prompt-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        this.els.userInput.value = btn.dataset.prompt;
        this.els.userInput.focus();
        this.sendMessage();
      });
    });
  }

  getDefaultQuickActions() {
    return [
      { text: 'Summarize', prompt: 'Summarize this page concisely.' },
      { text: 'Key points', prompt: 'Extract the key points from this page.' },
      { text: 'Explain simply', prompt: 'Explain this page in simple terms.' },
      { text: 'What is this?', prompt: 'What is this page about? Give a brief overview.' }
    ];
  }

  // ── Settings ────────────────────────────────────────────────────
  async getSettings() {
    try {
      return new Promise((resolve) => {
        chrome.storage.sync.get(['settings'], (result) => {
          const s = result.settings || {};
          if (s.enableStreaming === undefined) s.enableStreaming = true;
          if (s.enableQuickActions === undefined) s.enableQuickActions = true;
          if (s.enableVoiceInput === undefined) s.enableVoiceInput = true;
          if (s.htmlParseLimit === undefined) s.htmlParseLimit = 300;
          if (s.autoScan === undefined) s.autoScan = true;
          if (s.disabledActions === undefined) s.disabledActions = [];
          if (s.agentPrompt === undefined) s.agentPrompt = this._getDefaultAgentPrompt();
          if (!s.quickActions?.length) s.quickActions = this.getDefaultQuickActions();
          resolve(s);
        });
      });
    } catch (e) {
      return { enableStreaming: true, enableQuickActions: true, enableVoiceInput: true, quickActions: this.getDefaultQuickActions() };
    }
  }

  async applySettings() {
    const settings = await this.getSettings();
    const theme = settings.theme || 'auto';
    document.body.className = `theme-${theme}`;
    document.documentElement.style.setProperty('--sp-font-size', `${settings.fontSize || 16}px`);
    this.updateModelDisplay(settings);
    // Cache agent prompt for chat augmentation
    this._agentPromptCache = settings.agentPrompt || this._getDefaultAgentPrompt();
  }

  updateModelDisplay(settings) {
    const model = settings.openrouterModel || 'deepseek/deepseek-v4-flash';
    const name = model.includes('/') ? model.split('/').pop() : model;
    this.els.modelName.textContent = name;
  }

  openSettings() { this.els.settingsOverlay.classList.add('visible'); this.renderSettings(); }
  closeSettings() { this.els.settingsOverlay.classList.remove('visible'); }

  async renderSettings() {
    const settings = await this.getSettings();
    const s = settings; // shorthand

    this.els.settingsBody.innerHTML = `
      <div class="sp-tabs">
        <button class="sp-tab active" data-tab="api">API</button>
        <button class="sp-tab" data-tab="chat">Chat</button>
        <button class="sp-tab" data-tab="actions">Actions</button>
        <button class="sp-tab" data-tab="quickactions">Quick Actions</button>
        <button class="sp-tab" data-tab="appearance">Appearance</button>
      </div>

      <div class="sp-tab-content active" data-tab-content="api">
        <div class="sp-section">
          <h4>OpenRouter API</h4>
          <div class="sp-field">
            <label>API Key</label>
            <input type="password" id="s-openrouter-key" value="${this.escapeHtml(s.openrouterKey || '')}" placeholder="sk-or-...">
          </div>
          <div class="sp-field">
            <label>Model</label>
            <input type="text" id="s-openrouter-model" value="${this.escapeHtml(s.openrouterModel || '')}" placeholder="Select or type..." list="openrouter-models">
            <datalist id="openrouter-models"></datalist>
          </div>
          <div id="s-model-info" class="sp-model-info" style="display:none"></div>
          <button class="sp-btn sp-btn-success" id="s-test-connection">Test Connection</button>
          <div class="sp-status" id="s-status"></div>
        </div>
      </div>

      <div class="sp-tab-content" data-tab-content="chat">
        <div class="sp-section">
          <h4>Response</h4>
          <div class="sp-field">
            <label>Max Tokens</label>
            <input type="number" id="s-max-tokens" value="${s.maxTokens || 4096}" min="256" max="131072">
            <small>Max response length. Modern models support up to 128K.</small>
          </div>
          <div class="sp-field-range">
            <label style="min-width:90px">Temperature</label>
            <input type="range" id="s-temperature" min="0" max="2" step="0.05" value="${s.temperature ?? 0.7}">
            <span id="s-temperature-val">${s.temperature ?? 0.7}</span>
          </div>
          <div class="sp-field-range">
            <label style="min-width:90px">Top P</label>
            <input type="range" id="s-top-p" min="0" max="1" step="0.05" value="${s.topP ?? 0.9}">
            <span id="s-top-p-val">${s.topP ?? 0.9}</span>
          </div>
        </div>
        <div class="sp-section">
          <h4>System Prompt</h4>
          <div class="sp-field">
            <textarea id="s-system-prompt" rows="3">${this.escapeHtml(s.systemPrompt || 'You are a helpful AI assistant. Be concise and accurate. The user may share webpage content — use it to answer their questions.')}</textarea>
            <small>Keep it short for best results.</small>
          </div>
        </div>
        <div class="sp-section">
          <h4>Page Content Limit (words)</h4>
          <div class="sp-field">
            <input type="number" id="s-content-limit" value="${s.contentLimit || 15000}" min="500" max="100000">
          </div>
        </div>
        <div class="sp-section">
          <h4>Features</h4>
          ${this.toggleHtml('s-enable-streaming', 'Streaming Responses', 'See AI responses in real-time', s.enableStreaming !== false)}
          ${this.toggleHtml('s-enable-quick-actions', 'Quick Actions', 'Show prompt suggestions for new chats', s.enableQuickActions !== false)}
          ${this.toggleHtml('s-enable-voice-input', 'Voice Input', 'Click mic button or hold Space to dictate', s.enableVoiceInput !== false)}
        </div>
        <div class="sp-section">
          <h4>Keyboard Shortcut</h4>
          <div class="sp-shortcut-selects">
            <select id="s-shortcut-1">
              <option value="">-</option>
              <option value="Ctrl">Ctrl</option>
              <option value="Shift">Shift</option>
              <option value="Alt">Alt</option>
            </select>
            <span class="sp-shortcut-plus">+</span>
            <select id="s-shortcut-2">
              <option value="">-</option>
              <option value="Ctrl">Ctrl</option>
              <option value="Shift">Shift</option>
              <option value="Alt">Alt</option>
            </select>
            <span class="sp-shortcut-plus">+</span>
            <select id="s-shortcut-3">
              <option value="">-</option>
              ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').map(k => `<option value="${k}">${k}</option>`).join('')}
            </select>
            <button class="sp-btn sp-btn-secondary" id="s-reset-shortcut">Reset</button>
          </div>
        </div>
        <div class="sp-section">
          <h4>Data</h4>
          <button class="sp-btn sp-btn-secondary" id="s-export-history">Export Chat History</button>
          <button class="sp-btn sp-btn-danger" id="s-clear-history" style="margin-left:8px">Clear All History</button>
        </div>
      </div>

      <div class="sp-tab-content" data-tab-content="actions">
        <div class="sp-section">
          <h4>HTML Element Scanning</h4>
          <div class="sp-field">
            <label>Max elements to scan per page</label>
            <input type="number" id="s-html-parse-limit" value="${s.htmlParseLimit || 300}" min="10" max="500" step="10">
            <small>How many links, buttons, and inputs to discover on each page. Higher = more thorough but slower. Set to 500 for full page scan.</small>
          </div>
          <div class="sp-field">
            <label>Auto-scan on page load</label>
            ${this.toggleHtml('s-auto-scan', 'Auto-discover page elements', 'Scan for clickable elements, links, and forms when a page loads', s.autoScan !== false)}
          </div>
        </div>
        <div class="sp-section">
          <h4>Enabled Page Actions</h4>
          <p style="font-size:12px;color:var(--sp-text-secondary);margin-bottom:8px">Uncheck actions to prevent the agent from using them.</p>
          ${this.toggleHtml('s-action-click', 'Click', 'Click buttons, links, and elements', s.disabledActions ? !s.disabledActions.includes('click') : true)}
          ${this.toggleHtml('s-action-type', 'Type / Input', 'Type text into fields and forms', s.disabledActions ? !s.disabledActions.includes('type') : true)}
          ${this.toggleHtml('s-action-scroll', 'Scroll', 'Scroll up, down, or to elements', s.disabledActions ? !s.disabledActions.includes('scroll') : true)}
          ${this.toggleHtml('s-action-highlight', 'Highlight', 'Visually highlight page elements', s.disabledActions ? !s.disabledActions.includes('highlight') : true)}
          ${this.toggleHtml('s-action-hover', 'Hover', 'Hover over elements to trigger tooltips', s.disabledActions ? !s.disabledActions.includes('hover') : true)}
          ${this.toggleHtml('s-action-pressKey', 'Press Key', 'Send keyboard keys (Enter, Escape, etc.)', s.disabledActions ? !s.disabledActions.includes('pressKey') : true)}
        </div>
        <div class="sp-section">
          <h4>Form & Data Actions</h4>
          ${this.toggleHtml('s-action-fillForm', 'Fill Forms', 'Auto-fill multiple form fields', s.disabledActions ? !s.disabledActions.includes('fillForm') : true)}
          ${this.toggleHtml('s-action-selectDropdown', 'Select Dropdowns', 'Choose options from select elements', s.disabledActions ? !s.disabledActions.includes('selectDropdown') : true)}
          ${this.toggleHtml('s-action-checkToggle', 'Toggle Checkboxes', 'Check/uncheck checkboxes and radios', s.disabledActions ? !s.disabledActions.includes('checkToggle') : true)}
          ${this.toggleHtml('s-action-extractTable', 'Extract Tables', 'Extract table data as structured text', s.disabledActions ? !s.disabledActions.includes('extractTable') : true)}
          ${this.toggleHtml('s-action-findElements', 'Find Elements', 'Search page for matching elements', s.disabledActions ? !s.disabledActions.includes('findElements') : true)}
          ${this.toggleHtml('s-action-getPageInfo', 'Page Info', 'Get summary of current page', s.disabledActions ? !s.disabledActions.includes('getPageInfo') : true)}
        </div>
        <div class="sp-section">
          <h4>Navigation & Browser Actions</h4>
          ${this.toggleHtml('s-action-navigate', 'Navigate', 'Go to URLs or page links', s.disabledActions ? !s.disabledActions.includes('navigate') : true)}
          ${this.toggleHtml('s-action-openTab', 'Open Tabs', 'Open URLs in new tabs', s.disabledActions ? !s.disabledActions.includes('openTab') : true)}
          ${this.toggleHtml('s-action-goBack', 'Go Back/Forward', 'Browser history navigation', s.disabledActions ? !s.disabledActions.includes('goBack') : true)}
          ${this.toggleHtml('s-action-screenshot', 'Screenshot', 'Capture visible page area', s.disabledActions ? !s.disabledActions.includes('screenshot') : true)}
          ${this.toggleHtml('s-action-reload', 'Reload Page', 'Refresh the current page', s.disabledActions ? !s.disabledActions.includes('reload') : true)}
        </div>
        <div class="sp-section">
          <h4>Advanced</h4>
          ${this.toggleHtml('s-action-evaluate', 'Execute JavaScript', 'Run custom JS on the page', s.disabledActions ? !s.disabledActions.includes('evaluate') : true)}
          ${this.toggleHtml('s-action-startPicker', 'Element Picker', 'Hover to highlight, click to select elements', s.disabledActions ? !s.disabledActions.includes('startPicker') : true)}
          ${this.toggleHtml('s-action-clipboard', 'Clipboard', 'Read from and write to clipboard', s.disabledActions ? !s.disabledActions.includes('getClipboard') : true)}
          ${this.toggleHtml('s-action-monitor', 'DOM Monitoring', 'Watch for elements to appear/change', s.disabledActions ? !s.disabledActions.includes('startMonitoring') : true)}
        </div>
        <div class="sp-section">
          <h4>Agent System Prompt</h4>
          <p style="font-size:12px;color:var(--sp-text-secondary);margin-bottom:6px">This prompt is prepended to every chat. It tells the AI what it can do on web pages.</p>
          <div class="sp-field">
            <textarea id="s-agent-prompt" rows="4" style="font-size:12px;font-family:monospace;">${this.escapeHtml(s.agentPrompt || this._getDefaultAgentPrompt())}</textarea>
            <small>Edit carefully — this controls how the agent understands its capabilities.</small>
          </div>
          <button class="sp-btn sp-btn-secondary" id="s-reset-agent-prompt" style="margin-top:6px;">Reset to Default</button>
        </div>
      </div>

      <div class="sp-tab-content" data-tab-content="quickactions">
        <div class="sp-section">
          <h4>Manage Quick Actions</h4>
          <p style="font-size:12px;color:var(--sp-text-secondary);margin-bottom:8px">Customize the quick action buttons shown when you start a new chat.</p>
          <div class="sp-qa-list" id="s-qa-list"></div>
          <div style="margin-top:8px;display:flex;gap:8px">
            <button class="sp-btn sp-btn-secondary" id="s-add-qa">+ Add Action</button>
            <button class="sp-btn sp-btn-secondary" id="s-reset-qa">Reset Defaults</button>
          </div>
        </div>
      </div>

      <div class="sp-tab-content" data-tab-content="appearance">
        <div class="sp-section">
          <h4>Theme</h4>
          <div class="sp-field">
            <select id="s-theme">
              <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>Auto (System)</option>
              <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option>
              <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option>
            </select>
          </div>
        </div>
        <div class="sp-section">
          <h4>Display</h4>
          <div class="sp-field-range">
            <label>Font Size</label>
            <input type="range" id="s-font-size" min="16" max="24" value="${s.fontSize || 16}">
            <span id="s-font-size-val">${s.fontSize || 16}px</span>
          </div>
          <small>Minimum 16px for readability. Adjust to your preference.</small>
        </div>
      </div>

      <div class="sp-settings-actions">
        <button class="sp-btn sp-btn-primary" id="s-save">Save Settings</button>
      </div>
    `;

    // Tab switching
    this.els.settingsBody.querySelectorAll('.sp-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.els.settingsBody.querySelectorAll('.sp-tab').forEach(t => t.classList.remove('active'));
        this.els.settingsBody.querySelectorAll('.sp-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        this.els.settingsBody.querySelector(`[data-tab-content="${tab.dataset.tab}"]`)?.classList.add('active');
      });
    });

    // Range sliders
    this.bindRange('s-temperature', 's-temperature-val');
    this.bindRange('s-top-p', 's-top-p-val');
    this.bindRange('s-font-size', 's-font-size-val', 'px');

    // Save
    this.els.settingsBody.querySelector('#s-save').addEventListener('click', () => this.saveSettings());

    // Test connection
    this.els.settingsBody.querySelector('#s-test-connection').addEventListener('click', () => this.testConnection());

    // Quick actions
    this.renderQuickActionsEditor(s.quickActions || this.getDefaultQuickActions());
    this.els.settingsBody.querySelector('#s-add-qa').addEventListener('click', () => this.addQuickActionRow());
    this.els.settingsBody.querySelector('#s-reset-qa').addEventListener('click', () => {
      this.renderQuickActionsEditor(this.getDefaultQuickActions());
    });

    // Reset agent prompt
    this.els.settingsBody.querySelector('#s-reset-agent-prompt')?.addEventListener('click', () => {
      const ta = this.els.settingsBody.querySelector('#s-agent-prompt');
      if (ta) ta.value = this._getDefaultAgentPrompt();
    });

    // Export / Clear
    this.els.settingsBody.querySelector('#s-export-history').addEventListener('click', () => this.exportHistory());
    this.els.settingsBody.querySelector('#s-clear-history').addEventListener('click', () => this.clearAllHistory());
    this.els.settingsBody.querySelector('#s-reset-shortcut').addEventListener('click', () => {
      this.els.settingsBody.querySelector('#s-shortcut-1').value = 'Ctrl';
      this.els.settingsBody.querySelector('#s-shortcut-2').value = 'Shift';
      this.els.settingsBody.querySelector('#s-shortcut-3').value = 'Y';
    });

    // Load shortcut from settings
    const sc = (s.shortcut || 'Ctrl+Shift+Y').split('+');
    if (sc[0]) this.els.settingsBody.querySelector('#s-shortcut-1').value = sc[0];
    if (sc[1]) this.els.settingsBody.querySelector('#s-shortcut-2').value = sc[1];
    if (sc[2]) this.els.settingsBody.querySelector('#s-shortcut-3').value = sc[2];

    // Model input — load models on key input
    const keyInput = this.els.settingsBody.querySelector('#s-openrouter-key');
    keyInput.addEventListener('input', () => {
      clearTimeout(this._modelTimeout);
      const k = keyInput.value.trim();
      if (k.length > 10) {
        this._modelTimeout = setTimeout(() => this.loadModels(k), 1500);
      }
    });
    if (s.openrouterKey?.length > 10) this.loadModels(s.openrouterKey);

    // Model info — fetch when model input changes
    const modelInput = this.els.settingsBody.querySelector('#s-openrouter-model');
    modelInput.addEventListener('change', () => this.fetchModelInfo());
    modelInput.addEventListener('blur', () => this.fetchModelInfo());
    // Allow free space typing — datalist auto-selects on Space otherwise
    modelInput.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        // Manually insert space at cursor
        const start = modelInput.selectionStart;
        const end = modelInput.selectionEnd;
        modelInput.value = modelInput.value.substring(0, start) + ' ' + modelInput.value.substring(end);
        modelInput.selectionStart = modelInput.selectionEnd = start + 1;
        // Trigger input event so any listeners fire
        modelInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    if (s.openrouterModel) this.fetchModelInfo();
  }

  bindRange(inputId, displayId, suffix = '') {
    const input = this.els.settingsBody.querySelector(`#${inputId}`);
    const display = this.els.settingsBody.querySelector(`#${displayId}`);
    if (input && display) {
      input.addEventListener('input', () => { display.textContent = input.value + suffix; });
    }
  }

  toggleHtml(id, label, desc, checked) {
    return `
      <div class="sp-toggle">
        <label class="sp-toggle-switch">
          <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
          <span class="sp-toggle-slider"></span>
        </label>
        <div class="sp-toggle-label">
          <strong>${label}</strong>
          <small>${desc}</small>
        </div>
      </div>`;
  }

  async loadModels(apiKey) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const datalist = this.els.settingsBody.querySelector('#openrouter-models');
      if (datalist) {
        datalist.innerHTML = '';
        data.data.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = `${m.name} (${m.id})`;
          datalist.appendChild(opt);
        });
      }
    } catch (e) {
      console.error('Failed to load models:', e);
    }
  }

  async fetchModelInfo() {
    const modelId = this.els.settingsBody.querySelector('#s-openrouter-model')?.value.trim();
    const infoDiv = this.els.settingsBody.querySelector('#s-model-info');
    if (!modelId || !infoDiv) {
      if (infoDiv) infoDiv.style.display = 'none';
      return;
    }

    infoDiv.style.display = 'block';
    infoDiv.innerHTML = '<div class="sp-model-info-loading">Loading model info...</div>';

    try {
      const apiKey = this.els.settingsBody.querySelector('#s-openrouter-key')?.value.trim();
      if (!apiKey) {
        infoDiv.innerHTML = '<div class="sp-model-info-error">Enter API key to see model details.</div>';
        return;
      }

      const res = await fetch(`https://openrouter.ai/api/v1/models/${encodeURI(modelId)}/endpoints`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = json.data;
      if (!data) throw new Error('No model data');

      let html = '';

      // Description
      if (data.description) {
        html += `<div class="sp-model-info-desc">${this.escapeHtml(data.description.substring(0, 400))}${data.description.length > 400 ? '...' : ''}</div>`;
      }

      // Architecture / modalities
      const arch = data.architecture;
      if (arch) {
        // Input modalities
        if (arch.input_modalities && arch.input_modalities.length > 0) {
          html += '<div class="sp-model-info-row"><span class="sp-model-info-label">Input:</span><div class="sp-model-info-tags">';
          for (const mod of arch.input_modalities) {
            html += `<span class="sp-model-tag sp-model-tag-input">${this.escapeHtml(mod)}</span>`;
          }
          html += '</div></div>';
        }
        // Output modalities
        if (arch.output_modalities && arch.output_modalities.length > 0) {
          html += '<div class="sp-model-info-row"><span class="sp-model-info-label">Output:</span><div class="sp-model-info-tags">';
          for (const mod of arch.output_modalities) {
            html += `<span class="sp-model-tag sp-model-tag-output">${this.escapeHtml(mod)}</span>`;
          }
          html += '</div></div>';
        }
      }

      // Supported parameters (from first endpoint)
      const endpoint = data.endpoints?.[0];
      if (endpoint?.supported_parameters && endpoint.supported_parameters.length > 0) {
        html += '<div class="sp-model-info-row"><span class="sp-model-info-label">Params:</span><div class="sp-model-info-tags">';
        for (const param of endpoint.supported_parameters) {
          html += `<span class="sp-model-tag sp-model-tag-param">${this.escapeHtml(param)}</span>`;
        }
        html += '</div></div>';
      }

      // Context length
      if (endpoint?.context_length) {
        html += `<div class="sp-model-info-row"><span class="sp-model-info-label">Context:</span><span class="sp-model-info-value">${(endpoint.context_length / 1024).toFixed(0)}K tokens</span></div>`;
      }

      // Max completion tokens
      if (endpoint?.max_completion_tokens) {
        html += `<div class="sp-model-info-row"><span class="sp-model-info-label">Max output:</span><span class="sp-model-info-value">${endpoint.max_completion_tokens.toLocaleString()} tokens</span></div>`;
      }

      infoDiv.innerHTML = html || '<div class="sp-model-info-empty">No detailed info available for this model.</div>';
    } catch (e) {
      infoDiv.innerHTML = `<div class="sp-model-info-error">Could not load model info: ${this.escapeHtml(e.message)}</div>`;
    }
  }

  async testConnection() {
    const apiKey = this.els.settingsBody.querySelector('#s-openrouter-key').value.trim();
    const statusEl = this.els.settingsBody.querySelector('#s-status');
    if (!apiKey) {
      statusEl.className = 'sp-status error';
      statusEl.textContent = 'Enter an API key first.';
      return;
    }
    statusEl.className = 'sp-status';
    statusEl.textContent = 'Testing...';
    statusEl.style.display = 'block';
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      statusEl.className = 'sp-status success';
      statusEl.textContent = 'Connection successful!';
    } catch (e) {
      statusEl.className = 'sp-status error';
      statusEl.textContent = `Failed: ${e.message}`;
    }
  }

  renderQuickActionsEditor(actions) {
    const list = this.els.settingsBody.querySelector('#s-qa-list');
    if (!list) return;
    list.innerHTML = actions.map((a, i) => `
      <div class="sp-qa-item" draggable="true" data-index="${i}">
        <span class="sp-qa-drag-handle" title="Drag to reorder">⋮⋮</span>
        <div class="sp-qa-fields">
          <input type="text" class="sp-qa-title" value="${this.escapeHtml(a.text)}" placeholder="Title">
          <textarea class="sp-qa-prompt" placeholder="Prompt" rows="2">${this.escapeHtml(a.prompt)}</textarea>
        </div>
        <button class="sp-qa-remove">×</button>
      </div>
    `).join('');

    // Remove buttons
    list.querySelectorAll('.sp-qa-remove').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.sp-qa-item').remove());
    });

    // Drag and drop
    this._setupQuickActionDrag(list);
  }

  _setupQuickActionDrag(list) {
    let dragSrc = null;

    list.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.sp-qa-item');
      if (!item) return;
      dragSrc = item;
      item.classList.add('sp-qa-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    });

    list.addEventListener('dragend', (e) => {
      const item = e.target.closest('.sp-qa-item');
      if (item) item.classList.remove('sp-qa-dragging');
      list.querySelectorAll('.sp-qa-item').forEach(el => el.classList.remove('sp-qa-drag-over'));
      dragSrc = null;
    });

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const item = e.target.closest('.sp-qa-item');
      if (item && item !== dragSrc) {
        list.querySelectorAll('.sp-qa-item').forEach(el => el.classList.remove('sp-qa-drag-over'));
        item.classList.add('sp-qa-drag-over');
      }
    });

    list.addEventListener('drop', (e) => {
      e.preventDefault();
      const item = e.target.closest('.sp-qa-item');
      if (!item || item === dragSrc || !dragSrc) return;
      list.querySelectorAll('.sp-qa-item').forEach(el => el.classList.remove('sp-qa-drag-over'));

      // Insert dragged item before or after drop target
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        list.insertBefore(dragSrc, item);
      } else {
        list.insertBefore(dragSrc, item.nextSibling);
      }
    });
  }

  addQuickActionRow() {
    const list = this.els.settingsBody.querySelector('#s-qa-list');
    const row = document.createElement('div');
    row.className = 'sp-qa-item';
    row.draggable = true;
    row.innerHTML = `
      <span class="sp-qa-drag-handle" title="Drag to reorder">⋮⋮</span>
      <div class="sp-qa-fields">
        <input type="text" class="sp-qa-title" placeholder="Title">
        <textarea class="sp-qa-prompt" placeholder="Prompt" rows="2"></textarea>
      </div>
      <button class="sp-qa-remove">×</button>
    `;
    row.querySelector('.sp-qa-remove').addEventListener('click', () => row.remove());
    list.appendChild(row);
    row.querySelector('input').focus();
    this._setupQuickActionDrag(list);
  }

  getQuickActionsFromEditor() {
    const items = this.els.settingsBody.querySelectorAll('#s-qa-list .sp-qa-item');
    const actions = [];
    items.forEach(item => {
      const titleInput = item.querySelector('.sp-qa-title');
      const promptTextarea = item.querySelector('.sp-qa-prompt');
      const text = titleInput?.value?.trim() || '';
      const prompt = promptTextarea?.value?.trim() || '';
      if (text && prompt) actions.push({ text, prompt });
    });
    return actions.length ? actions : this.getDefaultQuickActions();
  }

  /**
   * Collect which actions are disabled from the settings checkboxes.
   * Returns an array of action names that are UNCHECKED.
   */
  _getDisabledActionsFromSettings() {
    const s = this.els.settingsBody;
    const allActions = [
      'click', 'type', 'scroll', 'highlight', 'hover', 'pressKey',
      'fillForm', 'selectDropdown', 'checkToggle', 'extractTable', 'findElements', 'getPageInfo',
      'navigate', 'openTab', 'goBack', 'screenshot', 'reload',
      'evaluate', 'startPicker', 'getClipboard', 'startMonitoring'
    ];
    const disabled = [];
    for (const action of allActions) {
      const el = s.querySelector(`#s-action-${action}`);
      if (el && !el.checked) disabled.push(action);
    }
    return disabled;
  }

  /**
   * Returns the default agent system prompt that tells the LLM what SNN can do.
   */
  _getDefaultAgentPrompt() {
    return `[SYSTEM: You are SNN Chat, a browser agent with REAL-TIME web page interaction capabilities. You CAN perform these actions on the current page:
• Click buttons, links, and elements
• Type text into input fields and forms
• Scroll the page up, down, or to elements
• Highlight elements with visual overlays
• Find and list elements matching selectors
• Extract tables and structured data
• Fill forms (single fields or entire forms)
• Select dropdown options, toggle checkboxes
• Press keyboard keys (Enter, Escape, Tab, etc.)
• Hover over elements to trigger tooltips
• Navigate to URLs, open new tabs, go back/forward
• Take screenshots of the page
• Execute custom JavaScript on the page
• Enter element picker mode (hover to pick)
• Monitor DOM changes
• Download files, show notifications, set alarms

When users ask "can you click X?" or "what can you do on this page?", respond with an OFFER to help using these capabilities. Say "Yes! I can click the Sign Up button for you. Want me to?" or "Let me take a screenshot of this page for you." NEVER say you cannot interact with the page. You CAN. If you need more info about the page to perform an action, use getPageInfo or findElements first. If you're not sure what to do, ask the user to clarify.]`;
  }

  async saveSettings() {
    const s = this.els.settingsBody;
    const getVal = (id) => s.querySelector(`#${id}`)?.value || '';
    const getChecked = (id) => s.querySelector(`#${id}`)?.checked;

    const sc1 = getVal('s-shortcut-1');
    const sc2 = getVal('s-shortcut-2');
    const sc3 = getVal('s-shortcut-3');
    const shortcut = [sc1, sc2, sc3].filter(Boolean).join('+') || 'Ctrl+Shift+Y';

    const settings = {
      openrouterKey: getVal('s-openrouter-key'),
      openrouterModel: getVal('s-openrouter-model'),
      maxTokens: parseInt(getVal('s-max-tokens')) || 4096,
      temperature: parseFloat(getVal('s-temperature')) || 0.7,
      topP: parseFloat(getVal('s-top-p')) || 0.9,
      contentLimit: parseInt(getVal('s-content-limit')) || 15000,
      systemPrompt: getVal('s-system-prompt'),
      theme: getVal('s-theme'),
      fontSize: parseInt(getVal('s-font-size')) || 16,
      shortcut,
      enableStreaming: getChecked('s-enable-streaming'),
      enableQuickActions: getChecked('s-enable-quick-actions'),
      enableVoiceInput: getChecked('s-enable-voice-input'),
      quickActions: this.getQuickActionsFromEditor(),
      // Actions tab
      htmlParseLimit: parseInt(getVal('s-html-parse-limit')) || 300,
      autoScan: getChecked('s-auto-scan'),
      agentPrompt: getVal('s-agent-prompt'),
      disabledActions: this._getDisabledActionsFromSettings()
    };

    if (!settings.openrouterKey) {
      this.showToast('No API key set — chat will not work until you add one.', 'warning');
    }

    await chrome.storage.sync.set({ settings });
    await this.applySettings();
    await this.renderQuickActions();
    this.closeSettings();
    this.showToast('Settings saved!', 'success');
  }

  // ── History ─────────────────────────────────────────────────────
  openHistory() { this.els.historyOverlay.classList.add('visible'); this.renderHistory(); }
  closeHistory() { this.els.historyOverlay.classList.remove('visible'); }

  async renderHistory() {
    this.els.historyBody.innerHTML = '<div class="sp-empty-state">Loading...</div>';
    const histories = await this.loadAllHistories();
    if (histories.length === 0) {
      this.els.historyBody.innerHTML = '<div class="sp-empty-state">No chat history yet.<br><small>Start chatting to build history.</small></div>';
      return;
    }

    let html = '<input type="text" class="sp-history-search" id="history-search" placeholder="Search..."><div id="history-list">';
    histories.forEach(h => {
      const msgCount = Math.floor(h.messageCount / 2);
      const date = new Date(h.lastUpdated).toLocaleDateString();
      const preview = h.lastMessage || '';
      const previewShort = preview.length > 60 ? preview.substring(0, 60) + '...' : preview;

      html += `
        <div class="sp-history-item" data-key="${h.key}" data-domain="${h.domain}">
          <div class="sp-history-title">${h.domain} — ${date} (${msgCount} msgs)</div>
          <div class="sp-history-preview">"${this.escapeHtml(previewShort)}"</div>
          <button class="sp-history-delete" data-key="${h.key}">×</button>
        </div>`;
    });
    html += '</div>';

    this.els.historyBody.innerHTML = html;

    // Click to switch
    this.els.historyBody.querySelectorAll('.sp-history-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('sp-history-delete')) return;
        this.switchSession(item.dataset.key, item.dataset.domain);
      });
    });

    // Delete
    this.els.historyBody.querySelectorAll('.sp-history-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSession(btn.dataset.key);
      });
    });

    // Search
    this.els.historyBody.querySelector('#history-search')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      this.els.historyBody.querySelectorAll('.sp-history-item').forEach(item => {
        item.style.display = item.textContent.toLowerCase().includes(q) ? 'block' : 'none';
      });
    });
  }

  async loadAllHistories() {
    const all = await chrome.storage.local.get(null);
    const histories = [];
    for (const key in all) {
      if (!key.startsWith('snn_chat_history_') || !all[key].messages?.length) continue;

      const data = all[key];

      // ── Session Lock: special display for global locked session ──
      if (key === this._chatLockKey) {
        const lastUser = [...data.messages].reverse().find(m => m.role === 'user');
        histories.push({
          key,
          domain: '🔒 Global Session',
          sessionId: '__locked__',
          tabId: null,
          isLocked: true,
          lastUpdated: data.lastUpdated || 0,
          messageCount: data.messages.length,
          lastMessage: lastUser?.content || ''
        });
        continue;
      }

      // New format: snn_chat_history_{tabId}_{sessionId}
      // Old format: snn_chat_history_{domain}_{sessionId}
      const suffix = key.replace('snn_chat_history_', '');
      // Split carefully: session IDs (timestamp_random) contain underscores.
      // Old format: {domain}_{sessionId}  — domain has dots, sessionId has no underscores
      // New format: {tabId}_{timestamp}_{random} — tabId is numeric, sessionId has 1 underscore
      // Strategy: if the first segment is purely numeric (tabId), join the last 2 as sessionId.
      const parts = suffix.split('_');
      let sessionId, domainOrTabId;
      if (/^\d+$/.test(parts[0])) {
        // New format: tabId is first segment, sessionId is last two segments
        domainOrTabId = parts[0];
        sessionId = parts.slice(1).join('_');
      } else {
        // Old format: domain may contain underscores; sessionId is last segment only
        sessionId = parts.pop();
        domainOrTabId = parts.join('_');
      }

      // Determine if this is a tabId (numeric) or domain (string with dots)
      const isTabId = /^\d+$/.test(domainOrTabId);
      const domain = data.domain || (isTabId ? '(tab ' + domainOrTabId + ')' : domainOrTabId);

      const lastUser = [...data.messages].reverse().find(m => m.role === 'user');
      histories.push({
        key,
        domain,
        sessionId,
        tabId: isTabId ? parseInt(domainOrTabId) : null,
        isLocked: false,
        lastUpdated: data.lastUpdated || 0,
        messageCount: data.messages.length,
        lastMessage: lastUser?.content || ''
      });
    }
    histories.sort((a, b) => b.lastUpdated - a.lastUpdated);
    return histories;
  }

  async switchSession(key, domain) {
    await this.saveChatHistory();

    // ── If loading the locked global session, enable Session Lock ──
    if (key === this._chatLockKey) {
      const data = await chrome.storage.local.get([key]);
      if (data[key]) {
        const session = data[key];
        this.chatHistory = session.messages || [];
        this.currentDomain = session.domain || '';
        this.currentSessionId = '__locked__';
        this._historyKey = this._chatLockKey;
        this._chatLockEnabled = true;
        this.els.chatLockCheckbox.checked = true;
        this.totalTokensUsed = 0;
        this._contextConsumedInSession = false;
        this.activeContext = null;
        await this._saveChatLockState();
        this._updateLockVisuals();
        this.restoreChat();
        this.closeHistory();
        this.showToast('🔒 Global session loaded');
        return;
      }
    }

    const data = await chrome.storage.local.get([key]);
    if (data[key]) {
      const session = data[key];
      this.chatHistory = session.messages || [];
      this.currentDomain = session.domain || domain;
      // If session has a tabId, update current tab
      if (session.tabId) {
        this.currentTabId = session.tabId;
      }
      this.currentSessionId = this._extractSessionIdFromKey(key);
      this.historyKey = key;
      this.totalTokensUsed = 0;
      this._contextConsumedInSession = false;
      this.activeContext = null;
      this.restoreChat();
      this.closeHistory();
      this.showToast('Session loaded');
    }
  }

  async deleteSession(key) {
    if (!confirm('Delete this chat session?')) return;
    await chrome.storage.local.remove([key]);
    if (this.historyKey === key) {
      this.chatHistory = [];
      this.els.chatMessages.innerHTML = '';
    }
    this.renderHistory();
    this.showToast('Session deleted');
  }

  async clearAllHistory() {
    if (!confirm('Delete ALL chat history? This cannot be undone.')) return;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('snn_chat_history_'));
    await chrome.storage.local.remove(keys);
    this.chatHistory = [];
    this.els.chatMessages.innerHTML = '';
    if (this.els.historyOverlay.classList.contains('visible')) this.renderHistory();
    this.showToast('All history cleared');
  }

  async exportHistory() {
    const all = await chrome.storage.local.get(null);
    let out = 'SNN Chat History Export\n' + '='.repeat(60) + '\n\n';
    for (const key in all) {
      if (!key.startsWith('snn_chat_history_')) continue;
      const data = all[key];
      // Prefer stored domain, fallback to parsing key
      const domain = data.domain || key.replace('snn_chat_history_', '').split('_').slice(0, -1).join('_');
      out += `Domain: ${domain}\n${'-'.repeat(40)}\n`;
      data.messages?.forEach(m => {
        out += `[${m.role.toUpperCase()}] ${m.content}\n\n`;
      });
      out += '\n';
    }
    const blob = new Blob([out], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `snn-chat-export-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('History exported!', 'success');
  }

  async restoreChat() {
    this.els.chatMessages.innerHTML = '';
    this.totalTokensUsed = 0;
    this.els.welcomeScreen.style.display = this.chatHistory.length === 0 ? '' : 'none';
    this.els.smartPrompts.style.display = this.chatHistory.length === 0 ? 'block' : 'none';

    // Track if any message in this session already used context
    let hasContextMessage = false;

    for (let i = 0; i < this.chatHistory.length; i++) {
      const msg = this.chatHistory[i];
      if (msg.role === 'user') {
        this.addMessage('user', msg.content, null, msg.context || null);
        if (msg.context) hasContextMessage = true;
      } else if (msg.role === 'assistant') {
        this.addMessage('ai', msg.content, msg.tokenUsage);
      } else if (msg.role === 'agent-action') {
        // Restore action history entry (colored status bubble)
        this._renderPersistedActionEntry(msg);
      }
    }

    // If any message already consumed context, mark session accordingly
    this._contextConsumedInSession = hasContextMessage;
    this.refreshActiveContext();
  }

  /**
   * Render a persisted agent-action entry (survives tab switches).
   */
  _renderPersistedActionEntry(msg) {
    const entry = document.createElement('div');
    entry.className = `snn-action-entry snn-action-${msg.status || 'info'}`;
    const icons = { start: '▶️', ok: '✅', fail: '❌', info: 'ℹ️', cancelled: '⬅️' };
    const icon = icons[msg.status] || '•';
    entry.innerHTML = `
      <span class="snn-action-entry-icon">${icon}</span>
      <span class="snn-action-entry-text">${this.escapeHtml(msg.description || '')}</span>
      ${msg.detail ? `<span class="snn-action-entry-detail">${this.escapeHtml(msg.detail)}</span>` : ''}
    `;
    this.els.chatMessages.appendChild(entry);
  }

  // ── Session Management ─────────────────────────────────────────

  /**
   * Key in chrome.storage.local that points to the currently-active
   * session key. This survives sidebar close/reopen so we always
   * restore the session the user was last working in — even if it
   * has fewer messages or an older timestamp than another session.
   */
  static ACTIVE_SESSION_PTR = 'snn_active_session';

  get historyKey() {
    // Session Lock: use fixed key — same session across ALL tabs
    if (this._chatLockEnabled) return this._historyKey || this._chatLockKey;
    const tabId = this.currentTabId || 'unknown';
    return this._historyKey || `snn_chat_history_${tabId}_${this.currentSessionId}`;
  }
  set historyKey(v) { this._historyKey = v; }

  /**
   * Extract the original session ID from a storage key.
   * Key formats:
   *   New: snn_chat_history_{tabId}_{timestamp}_{random}
   *   Old: snn_chat_history_{domain}_{sessionId}
   * Session IDs generated by generateId() always contain one underscore.
   */
  _extractSessionIdFromKey(key) {
    const suffix = key.replace('snn_chat_history_', '');
    const parts = suffix.split('_');
    // New format: first segment is numeric tabId, rest is sessionId
    if (/^\d+$/.test(parts[0])) {
      return parts.slice(1).join('_');
    }
    // Old format: last segment is sessionId
    return parts.pop();
  }

  async loadMostRecentSession() {
    // Session Lock: load from the fixed locked-session key
    if (this._chatLockEnabled) {
      const data = await chrome.storage.local.get([this._chatLockKey]);
      if (data[this._chatLockKey]?.messages?.length) {
        this._historyKey = this._chatLockKey;
        this.currentSessionId = '__locked__';
        this.chatHistory = data[this._chatLockKey].messages;
        this.restoreChat();
      }
      return;
    }
    if (!this.currentTabId) return;

    // ── First: check the active-session pointer ────────────────
    // This is the authoritative record of which session the user
    // was last working in. It survives sidebar close/reopen and
    // new-session creation (newSession writes it immediately).
    const ptrData = await chrome.storage.local.get([SNNSidePanel.ACTIVE_SESSION_PTR]);
    const activePtr = ptrData[SNNSidePanel.ACTIVE_SESSION_PTR];
    if (activePtr?.key) {
      const sessionData = await chrome.storage.local.get([activePtr.key]);
      const session = sessionData[activePtr.key];
      if (session && session.messages?.length) {
        this._historyKey = activePtr.key;
        this.currentSessionId = this._extractSessionIdFromKey(activePtr.key);
        this.chatHistory = session.messages;
        this.restoreChat();
        return;
      }
      // Pointer exists but session is empty or missing — clear the
      // stale pointer and fall through to normal discovery.
      await chrome.storage.local.remove([SNNSidePanel.ACTIVE_SESSION_PTR]);
    }

    // ── Fallback: discover most-recent session by timestamp ────
    const all = await chrome.storage.local.get(null);
    const tabSessions = [];
    const prefix = `snn_chat_history_${this.currentTabId}_`;
    for (const key in all) {
      if (key.startsWith(prefix) && all[key].messages?.length) {
        tabSessions.push({ key, lastUpdated: all[key].lastUpdated || 0, messages: all[key].messages });
      }
    }
    if (tabSessions.length) {
      tabSessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
      const recent = tabSessions[0];
      this._historyKey = recent.key;
      this.currentSessionId = this._extractSessionIdFromKey(recent.key);
      this.chatHistory = recent.messages;
      this.restoreChat();
      // Also write the pointer so future loads pick this session
      await this._saveActiveSessionPtr();
    }
  }

  /**
   * Persist a pointer to the currently-active session so it survives
   * sidebar close/reopen. Called after newSession, saveChatHistory,
   * and clearChat so the pointer always reflects reality.
   */
  async _saveActiveSessionPtr() {
    const key = this._chatLockEnabled ? this._chatLockKey : this.historyKey;
    await chrome.storage.local.set({
      [SNNSidePanel.ACTIVE_SESSION_PTR]: { key, tabId: this.currentTabId, at: Date.now() }
    });
  }

  async saveChatHistory() {
    if (!this.chatHistory.length) return;
    // Session Lock: always save to fixed key; otherwise per-tab key
    const key = this._chatLockEnabled ? this._chatLockKey : this.historyKey;
    // Persist the computed key so subsequent saves target the same session
    if (!this._chatLockEnabled && !this._historyKey) {
      this._historyKey = key;
    }
    await chrome.storage.local.set({
      [key]: {
        domain: this.currentDomain,
        tabId: this._chatLockEnabled ? null : this.currentTabId,
        lastUpdated: Date.now(),
        messages: this.chatHistory
      }
    });
    // Keep the active-session pointer in sync so reopen always
    // restores this session (survives newSession + close/reopen).
    await this._saveActiveSessionPtr();
  }

  async newSession() {
    // Session Lock: just clear chat, keep same locked session
    if (this._chatLockEnabled) {
      if (this.chatHistory.length) await this.saveChatHistory();
      this.chatHistory = [];
      this.totalTokensUsed = 0;
      this._contextConsumedInSession = false;
      this.activeContext = null;
      this.els.chatMessages.innerHTML = '';
      this.els.welcomeScreen.style.display = '';
      this.els.smartPrompts.style.display = 'block';
      this.els.tokenCounter.style.display = 'none';
      this.refreshActiveContext();
      await this.renderQuickActions();
      this.showToast('Chat cleared (🔒 session locked)');
      return;
    }
    // ── Save old session first ────────────────────────────────
    if (this.chatHistory.length) await this.saveChatHistory();
    // ── Create brand-new session identity ─────────────────────
    this.currentSessionId = this.generateId();
    const tabId = this.currentTabId || 'unknown';
    this._historyKey = `snn_chat_history_${tabId}_${this.currentSessionId}`;
    this.chatHistory = [];
    this.totalTokensUsed = 0;
    this._contextConsumedInSession = false;
    this.activeContext = null;
    // ── Persist the pointer NOW so reopen picks up THIS session ──
    // (even though chatHistory is empty — the pointer is what matters)
    await this._saveActiveSessionPtr();
    // ── Clear UI ──────────────────────────────────────────────
    this.els.chatMessages.innerHTML = '';
    this.els.welcomeScreen.style.display = '';
    this.els.smartPrompts.style.display = 'block';
    this.els.tokenCounter.style.display = 'none';
    this.refreshActiveContext();
    await this.renderQuickActions();
    this.showToast('New chat started');
  }

  async clearChat() {
    if (this.chatHistory.length) await this.saveChatHistory();
    this.chatHistory = [];
    this.totalTokensUsed = 0;
    this._contextConsumedInSession = false;
    this.activeContext = null;
    this.els.chatMessages.innerHTML = '';
    this.els.welcomeScreen.style.display = '';
    this.els.smartPrompts.style.display = 'block';
    this.els.tokenCounter.style.display = 'none';
    this.refreshActiveContext();
    this.renderQuickActions();
    // Keep the active-session pointer in sync
    this._saveActiveSessionPtr();
  }

  /**
   * Reset the loading/UI state. Call this whenever an in-flight
   * sendMessage is abandoned (tab switch, cancellation, etc.) to
   * unstick the send button and input.
   */
  _resetLoadingState() {
    this.isLoading = false;
    if (this.els.sendBtn) this.els.sendBtn.disabled = false;
    this.removeLoadingMsg();
    // Abort any in-flight fetch so tokens aren't wasted
    if (this._activeAbortController) {
      this._activeAbortController.abort();
      this._activeAbortController = null;
    }
    // Flush any context-menu prompt that arrived while we were busy
    this._checkContextMenuPrompt();
  }

  // ── Session Lock ──────────────────────────────────────────────

  /**
   * Load Session Lock state from persistent storage.
   * Called once during init(), BEFORE loadMostRecentSession().
   */
  async _loadChatLockState() {
    const { snn_chat_lock } = await chrome.storage.sync.get('snn_chat_lock');
    if (snn_chat_lock) {
      this._chatLockEnabled = true;
      this.els.chatLockCheckbox.checked = true;
      this._historyKey = this._chatLockKey;
      this.currentSessionId = '__locked__';
      this._updateLockVisuals();
    }
  }

  /**
   * Persist Session Lock state to sync storage so it survives
   * browser restarts and side panel reopenings.
   */
  async _saveChatLockState() {
    if (this._chatLockEnabled) {
      await chrome.storage.sync.set({ snn_chat_lock: true });
    } else {
      await chrome.storage.sync.remove('snn_chat_lock');
    }
  }

  /**
   * Toggle Session Lock on/off.
   * LOCKING: saves current session, switches to unified locked session.
   * UNLOCKING: saves locked session, switches back to per-tab mode.
   */
  async _toggleChatLock() {
    const wasLocked = this._chatLockEnabled;
    this._chatLockEnabled = this.els.chatLockCheckbox.checked;

    if (this._chatLockEnabled && !wasLocked) {
      // ═══ LOCKING: save current → switch to unified session ═══
      await this.saveChatHistory();

      const data = await chrome.storage.local.get([this._chatLockKey]);
      if (data[this._chatLockKey]?.messages?.length) {
        // Restore existing locked session
        this.chatHistory = data[this._chatLockKey].messages;
        this.restoreChat();
      } else {
        // Start fresh in locked mode
        this.chatHistory = [];
        this.els.chatMessages.innerHTML = '';
        this.els.welcomeScreen.style.display = '';
        this.els.smartPrompts.style.display = 'block';
      }

      this.currentSessionId = '__locked__';
      this._historyKey = this._chatLockKey;
      this._contextConsumedInSession = false;
      this.totalTokensUsed = 0;
      this.els.tokenCounter.style.display = 'none';
      this._updateLockVisuals();
      this.showToast('🔒 Session Locked — one session across all tabs');
    } else if (!this._chatLockEnabled && wasLocked) {
      // ═══ UNLOCKING: save locked → back to per-tab ═══
      await this.saveChatHistory();

      this.currentSessionId = this.generateId();
      this._historyKey = null;
      this.chatHistory = [];
      this.els.chatMessages.innerHTML = '';
      this.els.welcomeScreen.style.display = '';
      this.els.smartPrompts.style.display = 'block';
      this.els.tokenCounter.style.display = 'none';

      // Clear the active-session pointer so we fall back to
      // per-tab timestamp discovery (not the locked session).
      await chrome.storage.local.remove([SNNSidePanel.ACTIVE_SESSION_PTR]);

      await this.loadMostRecentSession();
      this._updateLockVisuals();
      this.showToast('🔓 Session Unlocked — per-tab sessions restored');
    }

    await this._saveChatLockState();
  }

  /**
   * Smart gateway: skip the agent loop for informational queries
   * when page context is already available. This avoids wasteful
   * non-streaming LLM calls and goes straight to streaming chat.
   */
  _shouldSkipAgentLoop(message, contextSnapshot) {
    if (!contextSnapshot || contextSnapshot.type !== 'page') return false;

    const msg = message.toLowerCase().trim();

    // Action patterns — these NEED the agent loop
    const actionPatterns = [
      /^(click|press|hit|tap|push)\b/,
      /^(type|enter|write|input|fill)\b/,
      /^(scroll|go to|navigate|open)\b/,
      /^(take|capture|grab)\s.*(screenshot|screen)/,
      /^(highlight|select|pick|choose)\b/,
      /^(download|save|copy)\b/,
      /^(fill|submit|complete)\s.*(form|field)/,
      /^(check|uncheck|toggle)\b/,
      /^(hover|mouse\s*over)\b/,
      /^(find|search|look\s*for)\s/,
      /^(extract|get|pull)\s.*(table|data|info)/,
      /^(do|perform|execute|run)\s/,
    ];
    for (const p of actionPatterns) {
      if (p.test(msg)) return false;
    }

    // Informational patterns — page context is enough
    const infoPatterns = [
      /^(summarize|summary|sum\s*up|tldr|overview)\b/,
      /^(what|who|where|when|why|how)\s/,
      /^(explain|describe|tell|elaborate)\b/,
      /^(list|enumerate|name)\b/,
      /^(is|are|does|do|can|could|would|should|will)\s/,
      /^(compare|contrast|analyze)\b/,
      /^(give|provide|show)\s.*(summary|overview|brief)/,
      /^(what's|whats|how's|hows)\s/,
      /^(any|are there)\s/,
    ];
    for (const p of infoPatterns) {
      if (p.test(msg)) return true;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // AGENT LOOP INTEGRATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Build an augmented system prompt that tells the LLM what SNN can do.
   * This prevents the LLM from saying "I can't click/interact with the page."
   */
  _getAugmentedSystemPrompt(basePrompt) {
    // Use the user's custom agent prompt from settings, or the default
    const agentPrompt = this._agentPromptCache || this._getDefaultAgentPrompt();
    return agentPrompt + '\n\n' + (basePrompt || 'You are a helpful AI assistant. Be concise and accurate.');
  }

  /**
   * Render the SNN capabilities list in the chat as a rich message.
   */
  _renderCapabilitiesInChat(capData) {
    if (!capData || !capData.pageActions) return;

    const div = document.createElement('div');
    div.className = 'snn-result-card';

    let actionsHtml = '<div class="snn-capabilities-grid">';
    const allActions = [...(capData.pageActions || []), ...(capData.browserActions || [])];
    for (const a of allActions.slice(0, 12)) {
      actionsHtml += `<div class="snn-capability-chip"><strong>${a.action}</strong><span>${a.description}</span></div>`;
    }
    actionsHtml += `<div class="snn-capability-chip snn-capability-more">+${allActions.length - 12} more actions available</div>`;
    actionsHtml += '</div>';

    if (capData.selectorFormats) {
      actionsHtml += '<div class="snn-capabilities-selectors"><strong>Selector formats:</strong> ';
      actionsHtml += capData.selectorFormats.map(s => `<code>${this.escapeHtml(s)}</code>`).join(' · ');
      actionsHtml += '</div>';
    }

    div.innerHTML = `
      <div class="snn-result-card-header">
        <span class="snn-result-card-icon">🤖</span>
        <span class="snn-result-card-title">${this.escapeHtml(capData.description || 'Here\'s what I can do:')}</span>
      </div>
      <div class="snn-result-card-body">
        ${actionsHtml}
        <p style="margin-top:12px;font-size:14px;">Try saying: <em>"click the login button"</em>, <em>"scroll down"</em>, <em>"highlight all links"</em>, <em>"fill this form"</em>, or <em>"screenshot this page"</em>.</p>
      </div>
    `;

    this.els.chatMessages.appendChild(div);
    this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
  }

  _formatCapabilitiesForHistory(capData) {
    if (!capData) return 'SNN Chat capabilities listed.';
    const count = (capData.pageActions?.length || 0) + (capData.browserActions?.length || 0);
    return `[SNN Capabilities — ${count} actions available]\n\n${capData.description || ''}\n\nTry: "click the login button", "scroll down", "highlight all links", "fill this form", or "screenshot this page".`;
  }

  _initAgentLoop() {
    if (typeof SNNAgentLoop === 'undefined' || typeof SNNAgentUI === 'undefined') {
      console.warn('[SNN] Agent loop classes not loaded.');
      return;
    }

    this._agentLoop = new SNNAgentLoop(this);
    this._agentUI = new SNNAgentUI(this);

    // ── State change callback ──────────────────────────────────
    this._agentLoop.onStateChange = (newState, prevState, detail) => {
      // Update status bar
      if (this._agentUI) this._agentUI.renderStatusBar(newState, detail);

      // Cleanup on terminal states
      if (newState === 'IDLE' || newState === 'CANCELLED') {
        if (this._agentUI) {
          this._agentUI.hideProgress();
          setTimeout(() => this._agentUI.renderStatusBar('IDLE'), 1500);
        }
      }
    };

    // ── Progress callback ──────────────────────────────────────
    this._agentLoop.onProgress = (step, total, description) => {
      if (this._agentUI) this._agentUI.renderProgress(step, total, description);
    };

    // ── Error callback ─────────────────────────────────────────
    this._agentLoop.onError = (errorData) => {
      if (this._agentUI) this._agentUI.renderErrorCard(errorData);
    };

    // ── Result callback ───────────────────────────────────────
    this._agentLoop.onResult = (resultData) => {
      if (resultData.type === 'action_results' && resultData.results) {
        // Save action results as chat history
        const summary = resultData.results.map(r =>
          `${r.step.description || r.step.action}: ${r.result?._duration_ms ? (r.result._duration_ms + 'ms') : 'done'}`
        ).join('\n');
        if (summary) {
          this.chatHistory.push(
            { role: 'assistant', content: `[Agent Actions]\n${summary}`, tokenUsage: null }
          );
          this.saveChatHistory().catch(() => {});
        }
      }
      if (resultData.type === 'capabilities') {
        this.chatHistory.push(
          { role: 'assistant', content: this._formatCapabilitiesForHistory(resultData.data), tokenUsage: null }
        );
        this.saveChatHistory().catch(() => {});
      }
    };

    // ── Blocked callback ───────────────────────────────────────
    this._agentLoop.onBlocked = (question) => {
      if (this._agentUI) {
        return this._agentUI.showPermissionModal(question);
      }
      return Promise.resolve('denied');
    };

    // ── Error retry handlers ───────────────────────────────────
    this._onErrorRetry = () => {
      // Re-run the last task (stored in agent loop internals)
      this.showToast('Retrying...');
      // The agent loop will re-execute from failed step
    };

    this._onErrorTryDifferently = () => {
      this.els.userInput.placeholder = 'How would you like me to try differently?';
      this.els.userInput.focus();
    };
  }

  generateId() {
    return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
  }

  // ── Voice Input ─────────────────────────────────────────────────
  // Mic permission & speech recognition run in the content script
  // (page context) so Chrome shows the normal in-page permission
  // prompt — no redirect to chrome://settings.
  setupVoice() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      // Still check API existence in side panel for early bail-out,
      // but actual recognition happens in the content script.
    }

    this._voiceActive = false;
    this._setupVoiceMessageListener();

    this.els.voiceBtn.addEventListener('click', () => {
      if (this._voiceActive) {
        this._stopVoice();
      } else {
        this._startVoice();
      }
    });

    // Space to talk (when input not focused)
    let spaceDown = false;
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && document.activeElement !== this.els.userInput && !spaceDown) {
        spaceDown = true;
        e.preventDefault();
        this._startVoice();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && spaceDown) {
        spaceDown = false;
        this._stopVoice();
        if (this.els.userInput.value.trim()) setTimeout(() => this.sendMessage(), 100);
      }
    });
  }

  // Listen for voice results forwarded from content script via background
  _setupVoiceMessageListener() {
    this._voiceGen = 0;        // incremented each new session, used to ignore stale events
    this._lastVoiceFinal = '';
    this._lastVoiceInterim = '';
    chrome.runtime.onMessage.addListener((message) => {
      switch (message.action) {
        case 'voice:transcript': {
          const f = message.final || '';
          const im = message.interim || '';
          // Dedup: skip identical duplicates
          if (f === this._lastVoiceFinal && im === this._lastVoiceInterim) break;
          this._lastVoiceFinal = f;
          this._lastVoiceInterim = im;
          if (f) this.els.userInput.value += f;
          this.els.userInput.placeholder = im || 'Ask anything...';
          this.autoResize();
          break;
        }

        case 'voice:error':
          this.els.voiceBtn.classList.remove('listening');
          this._voiceActive = false;
          switch (message.error) {
            case 'not-allowed':
            case 'denied':
              this.showToast('Microphone access denied. Please allow mic access for this website.', 'error');
              break;
            case 'no-speech':
              this.showToast('No speech detected. Try again.', 'error');
              break;
            case 'audio-capture':
            case 'no-mic':
              this.showToast('No microphone found. Please connect a microphone.', 'error');
              break;
            case 'network':
              this.showToast('Network error. Speech recognition requires an internet connection.', 'error');
              break;
            default:
              console.warn('Voice error:', message.error);
              break;
          }
          break;

        case 'voice:ended':
          // Ignore stale ended events from previous sessions
          if (message.gen !== this._voiceGen) break;
          this.els.voiceBtn.classList.remove('listening');
          this._voiceActive = false;
          this.els.userInput.placeholder = 'Ask anything...';
          break;
      }
    });
  }

  async _startVoice() {
    if (this._voiceActive) return;
    this.els.voiceBtn.classList.add('listening');
    this._voiceActive = true;
    this._voiceGen++;
    const gen = this._voiceGen;

    try {
      const response = await chrome.runtime.sendMessage({ action: 'voice:start', gen });
      if (!response?.success) {
        this.els.voiceBtn.classList.remove('listening');
        this._voiceActive = false;
        const err = response?.error || '';
        if (err === 'denied') {
          this.showToast('Microphone access denied. Please allow mic access for this website.', 'error');
        } else if (err === 'no-mic') {
          this.showToast('No microphone found.', 'error');
        } else if (err === 'content-script-unavailable') {
          this.showToast('Voice not available on this page. Refresh and try again.', 'error');
        } else if (err) {
          this.showToast('Voice start failed. Try again.', 'error');
        }
      }
    } catch (err) {
      this.els.voiceBtn.classList.remove('listening');
      this._voiceActive = false;
      this.showToast('Could not start voice input. Refresh the page and try again.', 'error');
    }
  }

  _stopVoice() {
    this._voiceActive = false;
    this.els.voiceBtn.classList.remove('listening');
    chrome.runtime.sendMessage({ action: 'voice:stop' }).catch(() => {});
  }

  // ── Toast ───────────────────────────────────────────────────────
  showToast(msg, type = '') {
    const existing = document.querySelector('.sp-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `sp-toast ${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2500);
  }
}

// ── Start ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  new SNNSidePanel();
});
