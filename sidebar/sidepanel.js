// SNN Chat — Side Panel Script 
// Full chat UI running in Chrome's native side panel (chrome.sidePanel API).
// Communicates with content script & background via chrome.storage.session + runtime messages.

// ── DEBUG LOGGING ──────────────────────────────────────────────────
var SNN_D = {
  enabled: true,
  module: 'SidePanel',
  _ts: () => new Date().toISOString().slice(11, 23),
  _fmt(o) {
    if (o === undefined) return 'undefined';
    if (o === null) return 'null';
    if (typeof o === 'string') return o.length > 300 ? o.slice(0, 300) + '…(' + o.length + ')' : o;
    if (o instanceof Error) return `[${o.name}] ${o.message}`;
    try { return JSON.stringify(o).slice(0, 500); } catch(e) { return String(o).slice(0, 500); }
  },
  log(...args) { if (!this.enabled) return; console.log(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ce93d8;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  warn(...args) { if (!this.enabled) return; console.warn(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ffb74d;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  error(...args) { console.error(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ef5350;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
};
var D = SNN_D;

// ── DIAGRAM CAPABILITY ─────────────────────────────────────────────
// Appended to every plain-chat system prompt. Without it the model has no way
// to know the panel renders mermaid (see renderMermaid) and falls back to
// ASCII art or a markdown table when asked for a diagram.
// The agent path has its own, longer variant in agent-loop.js — that one also
// has to forbid drawing via snn_page_script, a tool chat mode doesn't have.
var MERMAID_PROMPT = `DIAGRAMS: Your replies render as markdown, and a \`\`\`mermaid fenced block renders as a real diagram in this panel.

When asked for a diagram, flowchart, chart, graph, tree, timeline, mind map, architecture view, sequence, or any "show me the structure/flow/relationship of X", you MUST answer with a \`\`\`mermaid block. Never substitute a markdown table or ASCII art, and never say you are unable to draw a diagram — you can.

\`\`\`mermaid
graph TD
  A["Claim"] --> B["Counter-argument"]
  A --> C["Supporting evidence"]
\`\`\`

Available types — pick the one that fits, don't force everything into a flowchart:
graph TD / graph LR (flows, trees, argument maps), sequenceDiagram (interactions over time), stateDiagram-v2 (lifecycles), erDiagram (data models), classDiagram, mindmap (topic breakdown), timeline, gantt (schedules), journey, quadrantChart (2x2 positioning), pie, xychart-beta (bar/line charts), sankey-beta (flow volumes), radar-beta (multi-axis comparison), treemap-beta (nested proportions), block-beta, kanban.

CRITICAL: the "-beta" suffix is REQUIRED where shown — writing "xychart" or "sankey" without it fails to parse and renders nothing.

Syntax rules (violating these renders a broken diagram):
- Wrap EVERY node label in double quotes: A["Label here"]. Unquoted labels break on parentheses, colons, commas, and quotes.
- Keep node ids short and alphanumeric (A, B, C1) — never spaces or punctuation.
- One statement per line.
- No markdown (**bold**, links) inside node labels.`;

class SNNSidePanel {
  constructor() {
    this.chatHistory = [];
    this.isLoading = false;
    this.totalTokensUsed = 0;
    this.totalCost = 0;
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
    // Partial streamed text, kept so an aborted stream can still be saved
    this._streamPartial = '';

    // ── Storage failure tracking (surfaced, never swallowed) ───
    this._lastSaveError = null;
    this._lastSaveToastAt = 0;

    // Active context that WILL be attached to the NEXT user message.
    this.activeContext = null;
    // Track whether context was already used by a message in current session
    this._contextConsumedInSession = false;

    // ── Agent Loop Integration ─────────────────────────────────
    this._agentLoop = null;
    this._agentUI = null;

    // ── Last screenshot for vision follow-up questions ────────
    this._lastScreenshot = null;

    // ── Pending file attachments for next message ────────────
    this._pendingAttachments = []; // { id, name, type, mime, size, dataUrl?, text? }

    // ── Cached OpenRouter model metadata ─────────────────────
    this._modelsData = {};
    this._selectedModelInfo = null;

    // ── Per-session model override (locked after 1st message) ─
    this._sessionModel = null;   // null = use global default
    this._modelLocked = false;   // true after first message sent

    // ── File size limits per type (bytes) ────────────────────
    this._FILE_LIMITS = {
      image: 8 * 1024 * 1024,     // 8 MB
      audio: 10 * 1024 * 1024,    // 10 MB
      video: 20 * 1024 * 1024,    // 20 MB (warn about token cost)
      pdf:    8 * 1024 * 1024,    // 8 MB
      text:   2 * 1024 * 1024,    // 2 MB
      file:   8 * 1024 * 1024     // 8 MB (generic fallback)
    };
    this._MAX_ATTACHMENTS_TOTAL = 6;
    this._MAX_ATTACHMENTS_VIDEO = 1;  // only 1 video at a time

    // ── TTS (Text-to-Speech) state ───────────────────────────
    this._ttsVoices = [];                  // cached voice list
    this._ttsSpeakingMsgEl = null;         // message element currently being read
    this._ttsActiveUtterance = null;       // current SpeechSynthesisUtterance

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
      welcomeScreen: this.el('welcome-screen'),
      tokenCounter: this.el('token-counter'),
      qaTrigger: this.el('qa-trigger'),
      qaPopover: this.el('qa-popover'),
      qaList: this.el('qa-list'),
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
      chatLockBtn: this.el('chat-lock-btn'),
      // Attachments
      attachBar: this.el('attach-bar'),
      attachBtn: this.el('attach-btn'),
      attachInput: this.el('attach-input'),
      // Model Quick Switch
      mqsTrigger: this.el('mqs-trigger'),
      mqsPopover: this.el('mqs-popover'),
      mqsSearch: this.el('mqs-search'),
      mqsList: this.el('mqs-list'),
      mqsCurrentModel: this.el('mqs-current-model')
    };
  }

  // ── Init ────────────────────────────────────────────────────────
  async init() {
    D.log('init START', { windowId: null });
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

    // Mermaid is NOT configured here — it is loaded and initialized on first
    // use by _loadMermaid(). See renderMermaid().

    await this.loadContext();
    await this.loadMostRecentSession();
    this.renderQuickActions();
    this.renderModelQuickSwitch();
    this.setupVoice();
    this._loadVoicesAsync();       // preload TTS voices (async)
    this.setupContextWatcher();
    this._setupTabTracking();
    this._initAgentLoop();

    this._updateLockVisuals();

    // ── Pick up any pending context-menu intent (right-click "Ask SNN about…") ──
    this._checkContextMenuIntent();
  }

  // ── Event Listeners ─────────────────────────────────────────────
  setupListeners() {
    this.els.sendBtn.addEventListener('click', () => {
      if (this.isLoading) {
        this._stopGeneration();
      } else {
        this.sendMessage();
      }
    });
    this.els.userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
    });
    this.els.userInput.addEventListener('input', () => this.autoResize());

    this.el('model-settings-btn').addEventListener('click', () => this.openSettings());

    this.el('new-chat-btn').addEventListener('click', () => this.newSession());
    this.el('history-btn').addEventListener('click', () => this.openHistory());

    this.el('close-settings').addEventListener('click', () => this.closeSettings());
    this.el('close-history').addEventListener('click', () => this.closeHistory());
    this.els.dismissInputContext.addEventListener('click', () => this.dismissInputContext());

    // Session Lock button (header lock icon)
    this.els.chatLockBtn.addEventListener('click', () => this._toggleChatLock());

    // File attachments: button, file picker, paste, drag/drop
    this._setupAttachmentHandlers();

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
        // Cancel in-flight generation (agent loop or plain chat)
        if (this.isLoading) {
          this._stopGeneration();
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
          D.log('Page context updated', { title: (ctx?.title || '').substring(0, 60), wordCount: ctx?.wordCount, tabId: ctx?.tabId, isPdf: ctx?.isPdf });
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
        needsRefresh = true;
      }
      // ── Context-menu intent from background (right-click "Ask SNN about…") ──
      if (changes.snn_context_menu_intent && changes.snn_context_menu_intent.newValue) {
        // Process immediately — no debounce (user explicitly invoked)
        this._checkContextMenuIntent();
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

  // ── Context-Menu Intent Handler ────────────────────────────────
  // Picks up right-click "Ask SNN about…" intents stored by the
  // background service worker. Rather than auto-sending a canned prompt,
  // it opens the chat with the relevant context ATTACHED (page/selection)
  // or a suggestion PREFILLED (image/link) and leaves the cursor in the
  // input so the user types/confirms their actual question before sending.
  async _checkContextMenuIntent() {
    // Re-entry guard: prevent concurrent processing (e.g. storage
    // listener fires while we're still waiting for page context).
    if (this._ctxMenuInProgress) return;

    try {
      // Don't interrupt an in-flight message — the intent stays in
      // storage and will be picked up at the end of sendMessage().
      if (this.isLoading) return;

      // ── Retry loop: the background stores the intent right after
      //     calling sidePanel.open(), so there's a tiny race window
      //     where storage hasn't landed yet.  Poll a few times.
      let data = await chrome.storage.session.get('snn_context_menu_intent');
      let entry = data.snn_context_menu_intent;
      let retries = 0;
      while ((!entry || !entry.type) && retries < 5) {
        await new Promise(r => setTimeout(r, 100));
        data = await chrome.storage.session.get('snn_context_menu_intent');
        entry = data.snn_context_menu_intent;
        retries++;
      }

      if (!entry || !entry.type) return; // nothing to do

      // Only process intents for the current tab (guard cross-tab leakage).
      // If we haven't resolved currentTabId yet, accept anyway.
      if (this.currentTabId != null && entry.tabId != null && entry.tabId !== this.currentTabId) {
        D.warn('Context-menu intent for tab', entry.tabId, 'but we are on tab', this.currentTabId, '— skipping');
        // Clear stale intent so it doesn't stick around forever
        await chrome.storage.session.remove('snn_context_menu_intent');
        return;
      }

      // Consume immediately so it never fires twice
      await chrome.storage.session.remove('snn_context_menu_intent');

      this._ctxMenuInProgress = true;

      // ── UX: Flash the input area to draw user attention ────────
      this._flashInputArea();

      let toastMsg = '';

      switch (entry.type) {
        case 'selection': {
          // Attach the highlighted text as the active context. Use the text
          // carried in the intent (most reliable) and fall back to any
          // selection already synced from the content script.
          const text = (entry.selectionText || this.selection?.text || '').trim();
          if (text) {
            this.selection = { text, tabId: entry.tabId, timestamp: entry.timestamp || Date.now() };
            // Persist so a debounced storage refresh doesn't clobber it.
            chrome.storage.session.set({ snn_selection: this.selection }).catch(() => {});
          }
          this.refreshActiveContext();
          toastMsg = 'Selection attached — ask your question';
          break;
        }

        case 'page': {
          // Attach the page as the active context. Force re-attach even if a
          // previous context was already consumed this session — the user
          // explicitly asked about the page.
          if (!this.pageContext?.content) {
            let waited = 0;
            while (waited < 2000 && !this.pageContext?.content) {
              await new Promise(r => setTimeout(r, 200));
              waited += 200;
            }
          }
          this._contextConsumedInSession = false;
          this.refreshActiveContext();
          toastMsg = 'Page attached — ask your question';
          break;
        }

        case 'image':
        case 'link': {
          // Prefill an editable suggestion; the user confirms or edits it.
          if (entry.suggestedPrompt) {
            this.els.userInput.value = entry.suggestedPrompt;
            this.autoResize();
          }
          toastMsg = 'Edit or confirm, then send';
          break;
        }

        default:
          return;
      }

      // Focus the input so the user can start typing immediately.
      // Place the cursor at the end of any prefilled text.
      this.els.userInput.focus();
      const val = this.els.userInput.value;
      if (val) this.els.userInput.setSelectionRange(val.length, val.length);

      if (toastMsg) this.showToast(toastMsg, '');
    } catch (e) {
      D.warn('Context-menu intent check failed:', e.message);
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
      const label = this.activeContext.type === 'selection' ? 'Selected:' : 'Page:';
      this.els.inputContextIndicator.querySelector('.sp-input-context-icon').textContent = label;
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
    D.log('_onTabSwitched', { fromTabId: this.currentTabId, toTabId: tabId, domain, chatLock: this._chatLockEnabled });

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
      this.els.inputContextIndicator.style.display = 'none';

      // Update domain indicator and request fresh page context
      this._updateLockVisuals();
      chrome.runtime.sendMessage({ action: 'requestPageContent' }).catch(() => {});
      this.refreshActiveContext();

      // ── Check for pending context-menu intents targeting this tab ──
      this._checkContextMenuIntent();

      this.showToast(`Tab: ${this.escapeHtml(this.currentDomain || 'new tab')} <i class="fas fa-lock"></i> session locked`);
      return;
    }

    // ── Don't cancel if the agent itself caused this navigation ──
    if (this._agentLoop && this._agentLoop._expectNavigation) {
      D.log('_onTabSwitched: agent-initiated navigation, skipping cancel');
      // Update tab reference so subsequent actions target the new page
      this.currentTabId = tabId;
      this.currentDomain = domain || '';
      chrome.runtime.sendMessage({ action: 'requestPageContent' }).catch(() => {});
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
    this.totalCost = 0;
    this.activeContext = null;
    this.pageContext = null;
    this.selection = null;
    this._sessionModel = null;                // reset per-session model override
    this._modelLocked = false;                // allow model selection in new session

    // Clear UI
    this._clearChatMessages();
    this.els.welcomeScreen.style.display = '';
    this.els.tokenCounter.style.display = 'none';
    this.els.inputContextIndicator.style.display = 'none';

    // Update domain indicator immediately
    this._updateTabIndicator();

    // Request fresh page content extraction from the new tab
    chrome.runtime.sendMessage({ action: 'requestPageContent' }).catch(() => {});

    // Load existing session for this tab (if any).
    // restoreChat() will correctly set _contextConsumedInSession
    // based on whether the restored history already used context.
    await this.loadMostRecentSession();

    // Refresh context and model UI for the new tab
    this._updateLockVisuals();
    this.refreshActiveContext();
    await this.renderModelQuickSwitch();

    // If no session was restored, ensure context can attach fresh
    if (this.chatHistory.length === 0) {
      this._contextConsumedInSession = false;
    }

    // ── Check for pending context-menu intents targeting this tab ──
    this._checkContextMenuIntent();

    // Show a subtle toast
    this.showToast(`Switched to ${this.currentDomain || 'new tab'}`);
  }

  // Show current tab domain in the header
  _updateTabIndicator() {
    if (this.els.tabDomain && this.currentDomain) {
      this.els.tabDomain.textContent = this.currentDomain;
      this.els.tabDomain.title = (this._chatLockEnabled ? '[Locked] ' : '') + 'Active tab: ' + this.currentDomain;
    }
  }

  /**
   * Update all UI elements that reflect Session Lock state:
   * domain indicator, input area styling.
   */
  _updateLockVisuals() {
    this._updateTabIndicator();
    // Update the lock icon button in the header
    if (this.els.chatLockBtn) {
      this.els.chatLockBtn.innerHTML = this._chatLockEnabled
        ? '<i class="fas fa-lock"></i>'
        : '<i class="fas fa-lock-open"></i>';
      this.els.chatLockBtn.classList.toggle('locked', this._chatLockEnabled);
      this.els.chatLockBtn.title = this._chatLockEnabled
        ? 'Session Locked — one session across all tabs. Click to unlock.'
        : 'Session Lock: When enabled, your chat session is shared across all tabs. Click to toggle.';
    }
    const footer = document.querySelector('.sp-input-area');
    if (footer) {
      footer.classList.toggle('sp-locked', this._chatLockEnabled);
    }
  }

  clearSelection() {
    this.selection = null;
    chrome.runtime.sendMessage({ action: 'clearSelection' }).catch(() => {});
    this.refreshActiveContext();
  }

  // ── Chat ────────────────────────────────────────────────────────
  async sendMessage() {
    const message = this.els.userInput.value.trim();
    const attachments = [...(this._pendingAttachments || [])];
    if ((!message && attachments.length === 0) || this.isLoading) return;

    // A busy agent must not fall through to the plain-chat path unannounced —
    // that path has no tools, so the model answers as if it had acted and the
    // user is given no reason why. Checked HERE, before the input is consumed
    // and the turn is pushed to history, so nothing is left orphaned.
    // (isLoading normally covers this; the gap is the brief window where a
    // cancelled run is still unwinding after _resetLoadingState.)
    if (this._agentLoop?.isBusy) {
      this.showToast('Agent is still working — press Escape to cancel it first', 'warning');
      return;
    }

    // ── Lock model choice for this session (first message wins) ──
    if (!this._modelLocked) {
      this._modelLocked = true;
      this._persistSessionModel();
      this.renderModelQuickSwitch(); // update button to locked state
    }

    // Stop any active TTS when user sends a new message
    this._stopTTS();

    // Remembered so the error card's Retry button can re-send it.
    this._lastSentUserText = message;

    // ── Snapshot the context that will be attached to THIS message ──
    const contextSnapshot = this.activeContext ? { ...this.activeContext } : null;
    // ── Snapshot tab so we can detect a tab switch mid-request ──
    const sendTabId = this.currentTabId;
    // ── Snapshot the session this turn belongs to ──────────────
    // A tab switch swaps out chatHistory and _historyKey. The reply still
    // has to land in the session that asked for it, so every write below
    // goes through this ref rather than through live state.
    const sendRef = this.sessionRef();
    this._streamPartial = '';

    D.log('sendMessage', { msgLen: message.length, msgPreview: message.substring(0, 80), contextType: contextSnapshot?.type, attachmentCount: attachments.length, tabId: sendTabId, chatLock: this._chatLockEnabled });

    // ── Create abort controller so we can cancel in-flight fetch on tab switch ──
    this._activeAbortController = new AbortController();
    const signal = this._activeAbortController.signal;

    this.isLoading = true;
    this._setSendBtnToStop();
    this.els.userInput.value = '';
    this.autoResize();
    this.els.welcomeScreen.style.display = 'none';

    // Consume attachments from the composer
    this._pendingAttachments = [];
    this._renderAttachmentBar();

    // Mark context as consumed so page context won't re-attach automatically
    if (contextSnapshot) {
      this._contextConsumedInSession = true;
    }

    const displayMessage = message || (attachments.length
      ? `[Attached ${attachments.length} file${attachments.length > 1 ? 's' : ''}]`
      : '');

    // Render user message with context chip + attachments
    this.addMessage('user', displayMessage, null, contextSnapshot, attachments);

    // ── Push user message to chatHistory NOW so it survives tab switches ──
    // Store lightweight attachment metadata (not huge binary blobs for text files)
    const historyAttachments = attachments.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      mime: a.mime,
      size: a.size,
      // Keep data URLs for re-sends (image, audio, video); keep text content for text/pdf files
      dataUrl: (a.type === 'image' || a.type === 'audio' || a.type === 'video') ? a.dataUrl : undefined,
      text: (a.type === 'text' || a.type === 'pdf' || a.type === 'file') ? a.text : undefined
    }));
    sendRef.messages.push({
      role: 'user', content: displayMessage,
      contextType: contextSnapshot?.type || 'none',
      context: contextSnapshot,
      attachments: historyAttachments
    });
    await this.saveChatHistory(sendRef);

    // ── UNIFIED AGENT PATH ─────────────────────────────────────
    // ALL messages go through the agent loop. The LLM itself decides
    // whether to use tools (click, type, navigate, etc.) or just respond
    // with text. No regex gate that can misroute action requests into
    // a tool-less plain-chat path where the model hallucinates actions.
    //
    // Attachments with multimodal files (images, audio, video) still use
    // the plain chat path because the agent loop doesn't handle them yet.
    const hasMultimodalAttachments = attachments.some(a => a.type === 'image' || a.type === 'audio' || a.type === 'video');

    if (this._agentLoop && !this._agentLoop.isBusy && !hasMultimodalAttachments) {
      try {
        const agentResult = await this._agentLoop.run(message || displayMessage, contextSnapshot, this.currentTabId);

        // ── Cancelled: stop here. Do NOT fall through. ───────────
        // Falling through to the plain-chat path fired a brand-new LLM
        // request for the exact message the user had just stopped — so Stop
        // cost money and produced the answer anyway. The history marker
        // matters just as much: without it the next turn sees an instruction
        // that looks unfinished and the model re-runs the whole thing.
        if (agentResult?.type === 'cancelled') {
          D.log('agent run cancelled — not falling through to plain chat', { reason: agentResult.reason });
          sendRef.messages.push({
            role: 'assistant',
            content: '[Task stopped by the user before completion.]',
            cancelled: true
          });
          await this.saveChatHistory(sendRef);
          this._resetLoadingState();
          return;
        }

        // Tab-switch guard. Stale means "don't draw this into the tab the
        // user is looking at now" — NOT "throw the answer away". The reply
        // was requested and paid for, so it is still written to the session
        // that asked for it; only the rendering is skipped.
        const stale = this._isStaleTurn(sendTabId);

        if (agentResult && agentResult.type === 'action') {
          // ── Handle capability queries ────────────────────
          if (agentResult.subtype === 'capabilities' && agentResult.results?.length > 0) {
            const capData = agentResult.results[0].result;
            if (!stale) this._renderCapabilitiesInChat(capData);
            sendRef.messages.push(
              { role: 'assistant', content: this._formatCapabilitiesForHistory(capData) }
            );
            await this.saveChatHistory(sendRef);
          }
          // ── Render LLM's synthesized response if present ──
          if (agentResult.llmResponse) {
            if (!stale) await this.streamRenderMessage(agentResult.llmResponse);
            sendRef.messages.push(
              { role: 'assistant', content: agentResult.llmResponse, tokenUsage: this.lastTokenUsage }
            );
            await this.saveChatHistory(sendRef);
          }
          if (stale) { this._resetLoadingState(); return; }
          this._finishSendMessage();
          return;
        }

        // ── Agent returned { type:'chat', content } — stream it ──
        if (agentResult && agentResult.type === 'chat' && agentResult.content) {
          if (!stale) await this.streamRenderMessage(agentResult.content);
          sendRef.messages.push(
            { role: 'assistant', content: agentResult.content, tokenUsage: this.lastTokenUsage }
          );
          await this.saveChatHistory(sendRef);
          if (stale) { this._resetLoadingState(); return; }
          this._finishSendMessage();
          return;
        }

        // agentResult null or type:'chat' without content (e.g. no API key) →
        // fall through to plain chat so the user gets a proper error message.
      } catch (agentErr) {
        // Agent loop threw an unhandled error — surfaced via onError callback.
        // Fall through to plain chat as last resort so the user isn't left hanging.
        D.warn('Agent loop failed, falling back to plain chat:', agentErr.message);
      }
    }

    // ── PLAIN CHAT FALLBACK ─────────────────────────────────────
    // Only reached when: agent is unavailable, agent is busy,
    // multimodal attachments are present, or agent errored out.
    try {
      const settings = await this.getSettings();
      let context = '';
      let contextType = 'none';

      if (contextSnapshot) {
        context = contextSnapshot.detail || '';
        contextType = contextSnapshot.type;
      }

      // Merge text/PDF attachment content into context for the model
      const fileText = this._buildAttachmentTextContext(attachments);
      if (fileText) {
        context = context
          ? `${context}\n\n=== ATTACHED FILES ===\n${fileText}`
          : `=== ATTACHED FILES ===\n${fileText}`;
        if (contextType === 'none') contextType = 'files';
      }

      // Stash multimodal attachments for injection in callAPI/streamResponse
      this._pendingImageAttachments = attachments.filter(a => a.type === 'image' && a.dataUrl);
      this._pendingAudioAttachments = attachments.filter(a => a.type === 'audio' && a.dataUrl);
      this._pendingVideoAttachments = attachments.filter(a => a.type === 'video' && a.dataUrl);

      let response;
      if (settings.enableStreaming !== false) {
        response = await this.streamResponse(message || displayMessage, context, contextType, signal);
      } else {
        this.addLoadingMsg();
        response = await this.callAPI(message || displayMessage, context, contextType, signal);
        this.removeLoadingMsg();
      }
      this._pendingImageAttachments = null;
      this._pendingAudioAttachments = null;
      this._pendingVideoAttachments = null;

      // ── Tab-switch guard: skip rendering, but still persist the reply ──
      const stale = this._isStaleTurn(sendTabId);

      // Non-streaming needs an explicit render; streaming already painted
      // into the DOM as it arrived.
      if (settings.enableStreaming === false && !stale) {
        this.addMessage('ai', response, this.lastTokenUsage);
      }
      sendRef.messages.push(
        { role: 'assistant', content: response, tokenUsage: this.lastTokenUsage }
      );
      await this.saveChatHistory(sendRef);

      if (stale) { this._resetLoadingState(); return; }
    } catch (error) {
      const stale = this._isStaleTurn(sendTabId);
      // An abort is intentional (tab switch / stop button), but whatever
      // streamed before it is real text the user already saw. Keep it,
      // flagged as partial, instead of dropping it on the floor.
      if (error.name === 'AbortError') {
        await this._persistPartialReply(sendRef);
        this._resetLoadingState();
        return;
      }
      if (stale) { this._resetLoadingState(); return; }
      this.removeLoadingMsg();
      // Same card the agent path uses — a chat failure should never look
      // like an assistant reply (it used to render as a plain 'ai' bubble
      // and even got run through the Markdown parser).
      this.showErrorCard(error);
    }

    this._finishSendMessage();
  }

  // ═══════════════════════════════════════════════════════════════
  // SHARED OPENROUTER REQUEST PLUMBING
  // Used by callAPI(), streamResponse(), and SNNAgentLoop._callLLMWithTools()
  // so headers, error parsing, and the Gemini "corrupted thought
  // signature" retry only need to be maintained in one place.
  // ═══════════════════════════════════════════════════════════════
  /**
   * Turn an API/network exception into the same {code, source, message,
   * detail, suggestion, retryable} shape the page actor produces, so both
   * paths can render through one error card.
   *
   * The point of the `source` field is blame clarity: a rejected key or an
   * empty account is the user's to fix, a 5xx is the provider's, and only
   * the fallthrough is ours. Without this every one of them rendered as an
   * identical generic string and read like an extension bug.
   */
  categorizeApiError(err) {
    const raw = err?.message || String(err || 'Unknown error');
    const status = err?.status;
    const base = { detail: raw, retryable: true };

    if (err?.name === 'AbortError')
      return { ...base, code: 'CANCELLED', source: 'user', message: 'Request cancelled.', retryable: false, suggestion: '' };

    if (status === 401 || status === 403)
      return { ...base, code: 'AUTH_FAILED', source: 'user', message: 'Your API key was rejected.', retryable: false, suggestion: 'Open Settings and check that your OpenRouter key is correct and still active.' };

    if (status === 402)
      return { ...base, code: 'NO_CREDIT', source: 'user', message: 'Your OpenRouter account is out of credit.', retryable: false, suggestion: 'Add credit at openrouter.ai, or switch to a free model.' };

    if (status === 429)
      return { ...base, code: 'RATE_LIMITED', source: 'provider', message: 'The provider is rate-limiting your requests.', suggestion: 'Wait a moment and retry, or switch to a different model.' };

    if (status === 404)
      return { ...base, code: 'MODEL_UNAVAILABLE', source: 'provider', message: 'That model is not available.', retryable: false, suggestion: 'The model may have been renamed or retired. Pick another one in Settings.' };

    if (status === 413 || /context length|too large|maximum context/i.test(raw))
      return { ...base, code: 'CONTEXT_TOO_LARGE', source: 'user', message: 'This conversation is too long for the model.', retryable: false, suggestion: 'Start a new chat, or switch to a model with a larger context window.' };

    if (status >= 500)
      return { ...base, code: 'PROVIDER_DOWN', source: 'provider', message: `The model provider returned an error (${status}).`, suggestion: 'This is on the provider\'s side, not SNN. Wait and retry, or try another model.' };

    if (/API key not set|key not set/i.test(raw))
      return { ...base, code: 'NO_API_KEY', source: 'user', message: 'No OpenRouter API key is set.', retryable: false, suggestion: 'Add your key in Settings to start chatting.' };

    if (err?.name === 'TypeError' && /fetch|network/i.test(raw))
      return { ...base, code: 'NETWORK_ERROR', source: 'network', message: 'Could not reach OpenRouter.', suggestion: 'Check your internet connection, VPN, or firewall and try again.' };

    if (status)
      return { ...base, code: `HTTP_${status}`, source: 'provider', message: `The API returned an error (${status}).`, suggestion: 'Retry, or switch models if it persists.' };

    return { ...base, code: 'UNHANDLED', source: 'extension', message: 'Something went wrong inside SNN.', suggestion: 'This looks like a bug on our side — copy the details and report it.' };
  }

  _openRouterHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/sinanisler/SNN-Chat',
      'X-Title': 'SNN Chat'
    };
  }

  /**
   * POST to OpenRouter's chat/completions endpoint. Returns the raw
   * Response on success — callers decide how to consume the body
   * (parsed JSON for normal calls, a stream reader for streaming calls).
   * On a 400 "Corrupted thought signature" error (a known Gemini quirk
   * triggered by image content), retries once with images stripped.
   */
  async _fetchOpenRouter(apiKey, body, signal, _retriedCorrupted = false) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: this._openRouterHeaders(apiKey),
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');

      if (res.status === 400 && errText.includes('Corrupted thought signature') && !_retriedCorrupted && Array.isArray(body.messages)) {
        D.warn('_fetchOpenRouter CORRUPTED SIG — retrying with text-only payload');
        const stripped = body.messages.map(m => {
          if (m.role === 'user' && Array.isArray(m.content)) {
            return { role: 'user', content: m.content.filter(p => p.type === 'text') };
          }
          return m;
        });
        return this._fetchOpenRouter(apiKey, { ...body, messages: stripped }, signal, true);
      }

      let message = `API error ${res.status}`;
      try {
        const d = JSON.parse(errText);
        if (d.error?.message) message = d.error.message;
      } catch (e) {
        if (errText) message = errText.substring(0, 200);
      }
      D.error('_fetchOpenRouter FAILED', { status: res.status, message });
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }

    return res;
  }

  async callAPI(message, context, contextType, signal) {
    const settings = await this.getSettings();
    const apiKey = settings.openrouterKey;
    if (!apiKey) throw new Error('OpenRouter API key not set. Add it in Settings.');

    const model = await this._getEffectiveModel();
    D.log('callAPI', { model, msgLen: message.length, contextType, contextLen: (context || '').length, hasSignal: !!signal });
    let systemPrompt = settings.systemPrompt || 'You are a helpful AI assistant. Be concise and accurate.';
    systemPrompt = this._getAugmentedSystemPrompt(systemPrompt);

    const { messages, userMessage } =
      this._buildChatMessages(systemPrompt, context, contextType, message, model);

    // ── Inject multimodal content (images, audio, video) if model supports it ──
    this._injectMultimodalContent(messages, userMessage, model);

    const body = {
      model,
      messages,
      max_tokens: settings.maxTokens || 16000,
      temperature: settings.temperature ?? 0.7
    };
    if (settings.topP !== undefined) body.top_p = settings.topP;

    const res = await this._fetchOpenRouter(apiKey, body, signal);

    const data = await res.json();
    const cache = this._readCacheUsage(data.usage);
    this.lastTokenUsage = {
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
      total_tokens: data.usage?.total_tokens || 0,
      cached_tokens: cache.cached,
      cache_write_tokens: cache.written
    };
    D.log('callAPI OK', { tokens: this.lastTokenUsage, cacheHit: this._cacheHitRate(this.lastTokenUsage), contentLen: (data.choices?.[0]?.message?.content || '').length });
    return data.choices[0]?.message?.content || '';
  }

  async streamResponse(message, context, contextType, signal) {
    const settings = await this.getSettings();
    const apiKey = settings.openrouterKey;
    if (!apiKey) throw new Error('OpenRouter API key not set.');

    const model = await this._getEffectiveModel();
    D.log('streamResponse', { model, msgLen: message.length, contextLen: (context || '').length, contextType });
    let systemPrompt = settings.systemPrompt || 'You are a helpful AI assistant.';
    systemPrompt = this._getAugmentedSystemPrompt(systemPrompt);
    const { messages, userMessage } =
      this._buildChatMessages(systemPrompt, context, contextType, message, model);

    // ── Inject multimodal content (images, audio, video) if model supports it ──
    this._injectMultimodalContent(messages, userMessage, model);

    const body = {
      model, messages, stream: true,
      // Without this OpenRouter emits no usage chunk on a stream at all, so
      // cache hit rates would be invisible on the most-used code path.
      usage: { include: true },
      max_tokens: settings.maxTokens || 16000,
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

    let res;
    try {
      res = await this._fetchOpenRouter(apiKey, body, signal);
    } catch (err) {
      msgDiv.remove();
      throw err;
    }

    D.log('streamResponse streaming...');

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
            // Mirrored so an abort (which throws out of reader.read() and
            // loses fullResponse) can still persist what already arrived.
            this._streamPartial = fullResponse;
            contentDiv.innerHTML = this.parseMarkdown(fullResponse) + '<span class="sp-cursor">|</span>';
            this.smartScrollToBottom();
          }
          if (parsed.usage) {
            const cache = this._readCacheUsage(parsed.usage);
            this.lastTokenUsage = {
              prompt_tokens: parsed.usage.prompt_tokens || 0,
              completion_tokens: parsed.usage.completion_tokens || 0,
              total_tokens: parsed.usage.total_tokens || 0,
              cached_tokens: cache.cached,
              cache_write_tokens: cache.written
            };
            D.log('stream usage', { tokens: this.lastTokenUsage, cacheHit: this._cacheHitRate(this.lastTokenUsage) });
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
    this.addTokenInfo(msgDiv, this.lastTokenUsage);
    this.smartScrollToBottom();

    return fullResponse;
  }

  // ── Message Rendering ──────────────────────────────────────────
  addMessage(role, content, tokenUsage, contextSnapshot, attachments = null) {
    this.els.welcomeScreen.style.display = 'none';

    // ── Context chip: rendered BEFORE the user bubble ──
    if (role === 'user' && contextSnapshot) {
      this.renderContextChip(contextSnapshot);
    }

    const div = document.createElement('div');
    div.className = `sp-msg sp-msg-${role}`;

    if (role === 'ai') {
      div.innerHTML = this.parseMarkdown(content);
    } else {
      let html = this.escapeHtml(content || '');
      if (attachments?.length) {
        html += this._renderMessageAttachmentsHtml(attachments);
      }
      div.innerHTML = html;
    }
    this.els.chatMessages.appendChild(div);

    if (role === 'ai') {
      this.renderMermaid(div);
      this.addMsgActions(div, content);
      if (tokenUsage) this.addTokenInfo(div, tokenUsage);
    }

    this.smartScrollToBottom();
  }

  _renderMessageAttachmentsHtml(attachments) {
    const iconMap = {
      image: '🖼', audio: '🎵', video: '🎬',
      pdf: '📄', text: '📝', file: '📎'
    };
    let html = '<div class="sp-msg-attachments">';
    for (const a of attachments) {
      if (a.type === 'image' && a.dataUrl) {
        html += `<div class="sp-msg-attach-item sp-msg-attach-image"><img src="${a.dataUrl}" alt="${this.escapeHtml(a.name || 'image')}" title="${this.escapeHtml(a.name || '')}"></div>`;
      } else {
        const icon = iconMap[a.type] || '📎';
        const badge = a.type === 'pdf' ? 'PDF' : a.type === 'audio' ? 'AUDIO' : a.type === 'video' ? 'VIDEO' : 'FILE';
        const size = a.size ? ` · ${this._formatBytes(a.size)}` : '';
        html += `<div class="sp-msg-attach-item sp-msg-attach-file"><span class="sp-msg-attach-badge">${icon} ${badge}</span><span>${this.escapeHtml(a.name || 'file')}${size}</span></div>`;
      }
    }
    html += '</div>';
    return html;
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
          this.addTokenInfo(div, this.lastTokenUsage);
          this.smartScrollToBottom();
          resolve();
          return;
        }

        const chunk = content.substring(0, pos + CHUNK_SIZE);
        pos += CHUNK_SIZE;

        // Use text rendering for speed during streaming, 
        // then final markdown parse at the end
        contentDiv.innerHTML = this.escapeHtml(chunk).replace(/\n/g, '<br>') + '<span class="sp-cursor">|</span>';
        this.smartScrollToBottom();

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
    this.smartScrollToBottom();
  }

  removeLoadingMsg() {
    if (this.loadingDiv) { this.loadingDiv.remove(); this.loadingDiv = null; }
  }

  /**
   * Auto-scroll to bottom ONLY if the user is already near the bottom.
   * If the user scrolled up to read earlier messages, don't yank them back.
   * @param {number} threshold - px from bottom to consider "at bottom" (default 80)
   */
  smartScrollToBottom(threshold = 80) {
    const el = this.els.chatMessages;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= threshold) {
      el.scrollTop = el.scrollHeight;
    }
  }

  addMsgActions(msgDiv, content) {
    // Check if a meta row already exists (e.g. created by addTokenInfo first)
    let meta = msgDiv.querySelector('.sp-msg-meta');
    if (!meta) {
      meta = document.createElement('div');
      meta.className = 'sp-msg-meta';
      msgDiv.appendChild(meta);
    }

    // Remove any stale actions div
    const oldActions = meta.querySelector('.sp-msg-actions');
    if (oldActions) oldActions.remove();

    const actions = document.createElement('div');
    actions.className = 'sp-msg-actions';
    actions.innerHTML = `
      <button class="sp-msg-action copy" title="Copy">Copy</button>
      <button class="sp-msg-action speak" title="Read aloud">▶ Read</button>
    `;

    actions.querySelector('.copy').addEventListener('click', () => {
      navigator.clipboard.writeText(content);
      this.showToast('Copied!', 'success');
    });

    const speakBtn = actions.querySelector('.speak');

    speakBtn.addEventListener('click', () => {
      // If already speaking THIS message → stop
      if (this._ttsSpeakingMsgEl === msgDiv) {
        this._stopTTS();
        return;
      }
      // If speaking a different message → cancel it first
      if (this._ttsSpeakingMsgEl) {
        this._stopTTS();
      }

      // ── Start speaking from beginning ──
      const cleanText = this._stripMarkdownForTTS(content);
      if (!cleanText.trim()) {
        this.showToast('Nothing to read.', 'warning');
        return;
      }

      this._ttsSpeak(cleanText, msgDiv, speakBtn);
    });

    // Insert actions at the beginning (left side)
    meta.insertBefore(actions, meta.firstChild);
  }

  // ── TTS (Text-to-Speech) ──────────────────────────────────────

  /** Strip markdown/code from text so TTS reads clean prose. */
  _stripMarkdownForTTS(mdText) {
    if (!mdText) return '';
    // Remove mermaid/code blocks entirely (unreadable as speech)
    const noCode = mdText.replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1'); // inline code: keep content, drop backticks
    // Parse remaining markdown to HTML, then extract textContent
    const temp = document.createElement('div');
    if (typeof marked !== 'undefined') {
      try { temp.innerHTML = marked.parse(noCode); } catch (e) { temp.textContent = noCode; }
    } else {
      temp.textContent = noCode;
    }
    // Collapse whitespace, trim
    return (temp.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** Preload available TTS voices (they load asynchronously in Chrome). */
  _loadVoicesAsync() {
    this._ttsVoices = speechSynthesis.getVoices();
    if (this._ttsVoices.length > 0) {
      D.log('TTS voices loaded (sync)', this._ttsVoices.length);
      return;
    }
    // Voices haven't populated yet — wait for the event
    speechSynthesis.addEventListener('voiceschanged', () => {
      this._ttsVoices = speechSynthesis.getVoices();
      D.log('TTS voices loaded (async)', this._ttsVoices.length);
    }, { once: true });
  }

  /** Detect language using Chrome's built-in CLD (Compact Language Detector). */
  _ttsDetectLanguage(text) {
    return new Promise((resolve) => {
      if (!chrome.i18n || !chrome.i18n.detectLanguage) {
        resolve('en'); // fallback for contexts where the API is unavailable
        return;
      }
      chrome.i18n.detectLanguage(text, (result) => {
        if (chrome.runtime.lastError || !result?.languages?.length) {
          resolve('en');
          return;
        }
        const top = result.languages[0].language; // e.g. 'en', 'tr', 'de'
        D.log('TTS lang detected', { lang: top, confidence: result.languages[0].percentage });
        resolve(top);
      });
    });
  }

  /** Find the best matching voice for a given language code (e.g. 'en' → 'en-US' voice). */
  _ttsFindVoice(langCode) {
    // Refresh cache in case voices loaded since last check
    if (this._ttsVoices.length === 0) {
      this._ttsVoices = speechSynthesis.getVoices();
    }
    const voices = this._ttsVoices;
    if (voices.length === 0) return null;

    // 1) Exact lang match (e.g. 'en-US' === 'en-US')
    let match = voices.find(v => v.lang === langCode);
    // 2) Prefix match (e.g. 'en' matches 'en-US', 'en-GB')
    if (!match) match = voices.find(v => v.lang.startsWith(langCode + '-'));
    // 3) Broader prefix match (e.g. 'zh' matches 'zh-CN')
    if (!match) match = voices.find(v => v.lang.startsWith(langCode));
    // 4) Prefer a local (premium) voice among same-language matches
    const sameLang = voices.filter(v => v.lang.startsWith(langCode));
    const premium = sameLang.find(v => v.localService);
    if (premium) match = premium;
    // 5) Any same-language voice
    if (!match && sameLang.length > 0) match = sameLang[0];

    D.log('TTS voice selected', { forLang: langCode, voice: match?.name, voiceLang: match?.lang });
    return match || null;
  }

  /** Core speak method: detect language, pick voice, start speaking, wire up UI state. */
  async _ttsSpeak(cleanText, msgDiv, speakBtn) {
    // Detect language (with settings override)
    const settings = await this.getSettings();
    let langCode;
    if (settings.ttsLanguage && settings.ttsLanguage !== 'auto') {
      langCode = settings.ttsLanguage;
    } else {
      // Only detect if we have enough text (CLD needs a few words)
      langCode = cleanText.length > 20
        ? await this._ttsDetectLanguage(cleanText)
        : 'en';
    }

    const voice = this._ttsFindVoice(langCode);

    const u = new SpeechSynthesisUtterance(cleanText);
    u.lang = langCode;
    if (voice) u.voice = voice;

    // ── Wire up UI state ──
    this._ttsSpeakingMsgEl = msgDiv;
    this._ttsActiveUtterance = u;
    msgDiv.classList.add('speaking');
    speakBtn.textContent = '⏹ Stop';
    speakBtn.classList.add('active-speak');

    u.onend = () => this._stopTTS();
    u.onerror = (e) => {
      D.warn('TTS utterance error', e.error);
      // 'interrupted' is normal when user clicks Stop — don't show toast
      if (e.error !== 'interrupted') {
        this.showToast('Speech error: ' + (e.error || 'unknown'), 'error');
      }
      this._stopTTS();
    };

    D.log('TTS speaking', { lang: langCode, voice: voice?.name, chars: cleanText.length });
    window.speechSynthesis.speak(u);
  }

  /** Stop all TTS and reset UI state. */
  _stopTTS() {
    window.speechSynthesis.cancel();
    if (this._ttsSpeakingMsgEl) {
      this._ttsSpeakingMsgEl.classList.remove('speaking');
      const btn = this._ttsSpeakingMsgEl.querySelector('.speak');
      if (btn) {
        btn.textContent = '▶ Read';
        btn.classList.remove('active-speak');
      }
      this._ttsSpeakingMsgEl = null;
    }
    this._ttsActiveUtterance = null;
  }

  _calcMessageCost(tokenUsage) {
    const p = this._selectedModelInfo?.pricing;
    if (!p || !tokenUsage) return null;
    const promptPrice = parseFloat(p.prompt);
    const completionPrice = parseFloat(p.completion);
    if (Number.isNaN(promptPrice) && Number.isNaN(completionPrice)) return null;
    const cost = (tokenUsage.prompt_tokens || 0) * promptPrice + (tokenUsage.completion_tokens || 0) * completionPrice;
    return isNaN(cost) ? null : cost;
  }

  _formatCost(cost) {
    if (cost === null || cost === undefined) return '';
    if (cost < 0.0001) return `$${cost.toFixed(6)}`;
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
  }

  addTokenInfo(msgDiv, tokenUsage) {
    const total = (tokenUsage?.prompt_tokens || 0) + (tokenUsage?.completion_tokens || 0);
    if (total > 0) {
      // Find or create the shared meta row
      let meta = msgDiv.querySelector('.sp-msg-meta');
      if (!meta) {
        meta = document.createElement('div');
        meta.className = 'sp-msg-meta';
        msgDiv.appendChild(meta);
      }

      // Remove stale tokens div
      const oldInfo = meta.querySelector('.sp-msg-tokens');
      if (oldInfo) oldInfo.remove();

      const info = document.createElement('div');
      info.className = 'sp-msg-tokens';
      const cost = this._calcMessageCost(tokenUsage);
      let text = `${total.toLocaleString()} tokens`;
      let title = `Prompt: ${tokenUsage.prompt_tokens || 0}, Completion: ${tokenUsage.completion_tokens || 0}`;
      const hitRate = this._cacheHitRate(tokenUsage);
      if (hitRate !== null) {
        title += `\nCached: ${(tokenUsage.cached_tokens || 0).toLocaleString()} (${hitRate} of prompt)`;
        if (tokenUsage.cache_write_tokens) {
          title += `\nCache writes: ${tokenUsage.cache_write_tokens.toLocaleString()}`;
        }
      }
      if (cost !== null) {
        text += ` · ${this._formatCost(cost)}`;
        title += `\nCost: ${this._formatCost(cost)}`;
      }
      info.textContent = text;
      info.title = title;
      meta.appendChild(info); // goes to right (after actions)

      this.totalTokensUsed += total;
      if (cost !== null) this.totalCost += cost;
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

  /**
   * Load + initialize mermaid on first use, and only then.
   *
   * The bundle is 3.5MB — 68% of assets/lib — and used by a small minority of
   * messages, so it used to be a blocking parse on every panel open. It is a
   * classic script that assigns globalThis.mermaid (NOT an ES module), so
   * dynamic import() cannot load it; a script tag is the supported path. The
   * src is extension-local, so this satisfies MV3's script-src 'self'.
   *
   * The promise is cached, so concurrent callers share one in-flight load and
   * later callers resolve immediately. On failure the cache is cleared so a
   * subsequent diagram can retry rather than being permanently poisoned.
   */
  _loadMermaid() {
    if (this._mermaidPromise) return this._mermaidPromise;

    this._mermaidPromise = new Promise((resolve, reject) => {
      const t0 = performance.now();
      const script = document.createElement('script');
      script.src = '../assets/lib/mermaid.min.js';
      script.onload = () => {
        if (typeof mermaid === 'undefined') {
          reject(new Error('mermaid.min.js loaded but global is undefined'));
          return;
        }
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
        D.log('Mermaid loaded on demand', { ms: Math.round(performance.now() - t0) });
        resolve(mermaid);
      };
      script.onerror = () => reject(new Error('Failed to load mermaid.min.js'));
      document.head.appendChild(script);
    });

    this._mermaidPromise.catch(() => { this._mermaidPromise = null; });
    return this._mermaidPromise;
  }

  async renderMermaid(container) {
    // Check for blocks BEFORE loading — this is the whole point of the lazy
    // path. A message with no diagram must not trigger the 3.5MB fetch.
    const blocks = container.querySelectorAll('pre.mermaid');
    if (blocks.length === 0) return;
    try {
      await this._loadMermaid();
      // mermaid.run() finds and renders all .mermaid elements
      await mermaid.run({ nodes: Array.from(blocks) });
      for (const pre of blocks) this._makeDiagramInteractive(pre);
    } catch (e) {
      D.warn('Mermaid render failed:', e.message);
    }
  }

  // ── Diagram pan / zoom ─────────────────────────────────────────
  // Mermaid v11 ships no pan/zoom of its own, and its SVG carries an intrinsic
  // width (typically 700-800px) that CSS then squashed into a ~330px panel —
  // legible on a desktop page, ~5px text here. So we drop the intrinsic size,
  // put the SVG in a fixed-height viewport, and drive it with a transform.

  _MERMAID_MIN_SCALE = 0.2;
  _MERMAID_MAX_SCALE = 8;
  // Below this, node text stops being readable in the panel. We would rather
  // open a wide diagram cropped-but-legible (the user can drag or hit Fit)
  // than shrink-to-fit into something nobody can read.
  _MERMAID_MIN_LEGIBLE = 0.85;

  _makeDiagramInteractive(pre) {
    if (pre.dataset.snnZoom) return;          // already enhanced
    const svg = pre.querySelector('svg');
    if (!svg) return;
    pre.dataset.snnZoom = '1';

    // Natural size: prefer the viewBox, which mermaid always emits and which
    // survives us stripping the width/height attributes below.
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const natW = vb.length === 4 && vb[2] > 0 ? vb[2] : svg.clientWidth || 800;
    const natH = vb.length === 4 && vb[3] > 0 ? vb[3] : svg.clientHeight || 600;

    // Hand sizing to us, not to mermaid's inline attributes / max-width rule.
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = natW + 'px';
    svg.style.height = natH + 'px';
    svg.style.maxWidth = 'none';
    svg.style.transformOrigin = '0 0';

    const wrap = document.createElement('div');
    wrap.className = 'sp-diagram';
    const viewport = document.createElement('div');
    viewport.className = 'sp-diagram-viewport';
    pre.parentNode.insertBefore(wrap, pre);
    viewport.appendChild(svg);
    wrap.appendChild(viewport);
    wrap.appendChild(this._buildDiagramControls());
    pre.remove();                              // the <pre> was only a mount point

    this._installDiagramPanZoom(wrap, viewport, svg, natW, natH);
  }

  _buildDiagramControls() {
    const bar = document.createElement('div');
    bar.className = 'sp-diagram-ctrls';
    const btns = [
      ['zoomout', '−', 'Zoom out'],
      ['zoomin',  '+',      'Zoom in'],
      ['fit',     '⤢', 'Fit to width'],
      ['full',    '⛶', 'Expand'],
    ];
    for (const [act, glyph, title] of btns) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-diagram-btn';
      b.dataset.act = act;
      b.title = title;
      b.textContent = glyph;
      bar.appendChild(b);
    }
    return bar;
  }

  /**
   * Wire pan/zoom onto one diagram. Returns nothing; all state lives in the
   * closure so a fullscreen clone can run an independent instance.
   */
  _installDiagramPanZoom(wrap, viewport, svg, natW, natH) {
    const state = { k: 1, x: 0, y: 0 };
    const clamp = (v) => Math.min(this._MERMAID_MAX_SCALE, Math.max(this._MERMAID_MIN_SCALE, v));

    const apply = () => {
      svg.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.k})`;
      // Only advertise dragging when there is actually something off-screen.
      const pannable = natW * state.k > viewport.clientWidth + 1 ||
                       natH * state.k > viewport.clientHeight + 1;
      viewport.classList.toggle('is-pannable', pannable);
    };

    const fit = () => {
      const vw = viewport.clientWidth || natW;
      const vh = viewport.clientHeight || natH;
      state.k = clamp(Math.min(vw / natW, vh / natH, 1));
      // Centre horizontally; pin to the top so a tall diagram starts at its root.
      state.x = Math.max(0, (vw - natW * state.k) / 2);
      state.y = Math.max(0, (vh - natH * state.k) / 2);
      apply();
    };

    // Opening view: fit, unless fitting would make the text unreadable — then
    // stay at the legibility floor, anchored top-left, and let the user pan.
    const initial = () => {
      const vw = viewport.clientWidth || natW;
      const fitK = Math.min(vw / natW, 1);
      if (fitK >= this._MERMAID_MIN_LEGIBLE) { fit(); return; }
      state.k = this._MERMAID_MIN_LEGIBLE;
      state.x = 0;
      state.y = 0;
      apply();
    };

    // Zoom about the viewport centre so button-zoom keeps your place.
    const zoomBy = (factor) => {
      const cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2;
      const k2 = clamp(state.k * factor);
      const r = k2 / state.k;
      state.x = cx - (cx - state.x) * r;
      state.y = cy - (cy - state.y) * r;
      state.k = k2;
      apply();
    };

    wrap.querySelector('.sp-diagram-ctrls').addEventListener('click', (e) => {
      const act = e.target.closest('.sp-diagram-btn')?.dataset.act;
      if (!act) return;
      e.preventDefault();
      if (act === 'zoomin')  zoomBy(1.25);
      if (act === 'zoomout') zoomBy(1 / 1.25);
      if (act === 'fit')     fit();
      if (act === 'full')    this._openDiagramFullscreen(svg, natW, natH);
    });

    // ── Wheel: ctrl/⌘ + wheel zooms, plain wheel scrolls the chat ──
    // Hijacking plain wheel would trap the page scroll every time the pointer
    // crossed a diagram, which is worse than making zoom explicit.
    viewport.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const k2 = clamp(state.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      const r = k2 / state.k;
      state.x = px - (px - state.x) * r;   // zoom toward the cursor
      state.y = py - (py - state.y) * r;
      state.k = k2;
      apply();
    }, { passive: false });

    // ── Drag to pan ──
    let drag = null;
    viewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { px: e.clientX, py: e.clientY, ox: state.x, oy: state.y };
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add('is-dragging');
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!drag) return;
      state.x = drag.ox + (e.clientX - drag.px);
      state.y = drag.oy + (e.clientY - drag.py);
      apply();
    });
    const endDrag = (e) => {
      if (!drag) return;
      drag = null;
      try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
      viewport.classList.remove('is-dragging');
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('dblclick', () => fit());

    // clientWidth is 0 until layout runs, so defer the first measurement.
    requestAnimationFrame(initial);
  }

  /**
   * Expand a diagram to a full-panel overlay. In a ~330px side panel this is
   * the only way some diagrams are genuinely readable, so it is the primary
   * affordance rather than a nicety. Works on a clone so the inline diagram
   * keeps its own independent pan/zoom state.
   */
  _openDiagramFullscreen(svg, natW, natH) {
    const overlay = document.createElement('div');
    overlay.className = 'sp-diagram-full';

    const wrap = document.createElement('div');
    wrap.className = 'sp-diagram sp-diagram-full-inner';
    const viewport = document.createElement('div');
    viewport.className = 'sp-diagram-viewport';

    const clone = svg.cloneNode(true);
    clone.style.transform = '';
    viewport.appendChild(clone);
    wrap.appendChild(viewport);

    const ctrls = this._buildDiagramControls();
    ctrls.querySelector('[data-act="full"]')?.remove();   // already expanded
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sp-diagram-btn';
    close.title = 'Close';
    close.textContent = '✕';
    ctrls.appendChild(close);
    wrap.appendChild(ctrls);
    overlay.appendChild(wrap);
    document.body.appendChild(overlay);

    const dismiss = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKey);
    close.addEventListener('click', dismiss);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) dismiss(); });

    this._installDiagramPanZoom(wrap, viewport, clone, natW, natH);
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
      let text = `${this.totalTokensUsed.toLocaleString()} tokens`;
      if (this.totalCost > 0) {
        text += ` · ${this._formatCost(this.totalCost)}`;
      }
      this.els.tokenCounter.textContent = text;
    } else {
      this.els.tokenCounter.style.display = 'none';
    }
  }

  // ── Input ──────────────────────────────────────────────────────
  autoResize() {
    const ta = this.els.userInput;
    if (!ta) return;
    // Reset to auto so the browser computes natural scrollHeight.
    // Force a synchronous layout read to ensure the reflow happens.
    ta.style.height = 'auto';
    const natural = ta.scrollHeight;
    // Clamp between CSS min-height (46px) and max-height (130px).
    // Never let it go below 46px — an empty textarea must stay usable.
    ta.style.height = Math.max(46, Math.min(natural, 130)) + 'px';
  }

  // ── Quick Actions ──────────────────────────────────────────────
  async renderQuickActions() {
    const settings = await this.getSettings();
    const actions = settings.quickActions || this.getDefaultQuickActions();

    // Populate the dropdown list
    this.els.qaList.innerHTML = actions.map((a) => `
      <button class="sp-qa-option" data-prompt="${this.escapeHtml(a.prompt)}" title="${this.escapeHtml(a.prompt)}">
        ${a.text}
      </button>
    `).join('');

    // Click handler for each option: fill input, send, close popover
    this.els.qaList.querySelectorAll('.sp-qa-option').forEach(opt => {
      opt.addEventListener('click', () => {
        this.els.userInput.value = opt.dataset.prompt;
        this.autoResize();
        this.els.userInput.focus();
        this._closeQAPopover();
        this.sendMessage();
      });
    });

    // Toggle popover on trigger click
    this.els.qaTrigger.onclick = (e) => {
      e.stopPropagation();
      this._toggleQAPopover();
    };

    // Close popover on outside click
    if (!this._qaOutsideBound) {
      this._qaOutsideBound = true;
      document.addEventListener('click', (e) => {
        if (!this.els.qaTrigger?.contains(e.target) && !this.els.qaPopover?.contains(e.target)) {
          this._closeQAPopover();
        }
      });
    }
  }

  _toggleQAPopover() {
    const popover = this.els.qaPopover;
    const trigger = this.els.qaTrigger;
    if (!popover || !trigger) return;
    const isOpen = popover.style.display === 'block';
    if (isOpen) {
      this._closeQAPopover();
    } else {
      popover.style.display = 'block';
      trigger.classList.add('open');
    }
  }

  _closeQAPopover() {
    if (this.els.qaPopover) this.els.qaPopover.style.display = 'none';
    if (this.els.qaTrigger) this.els.qaTrigger.classList.remove('open');
  }

  getDefaultQuickActions() {
    return [
      { text: 'Summarize', prompt: 'Summarize this concisely.' },
      { text: 'Key points', prompt: 'Extract the key points as a short bulleted list.' },
      { text: 'Explain simply', prompt: 'Explain this in simple terms, as if to someone new to the topic.' },
      { text: 'Translate', prompt: 'Translate this into English.' },
      { text: 'Improve writing', prompt: 'Rewrite this to be clearer and more polished, keeping the original meaning and tone.' },
      { text: 'Draft a reply', prompt: 'Draft a reply to this, in a professional and concise tone.' },
      { text: 'Fact-check', prompt: 'Fact-check this. Identify the key factual claims, then search for and check at least two independent sources to verify each one before giving me your verdict — do not rely on this page alone.' },
      { text: 'Pros & cons', prompt: "List the pros and cons of what's described here." }
    ];
  }

  // ── Model Quick Switch ──────────────────────────────────────────
  // Returns the effective model for this session: session override
  // if set, otherwise the global default from settings.
  async _getEffectiveModel() {
    if (this._sessionModel) return this._sessionModel;
    const settings = await this.getSettings();
    return settings.openrouterModel || 'deepseek/deepseek-v4-flash';
  }

  async renderModelQuickSwitch() {
    const settings = await this.getSettings();
    const effectiveModel = this._sessionModel || settings.openrouterModel || 'deepseek/deepseek-v4-flash';
    const shortName = effectiveModel.includes('/')
      ? effectiveModel.split('/').pop()
      : effectiveModel;

    // ── Update trigger button ────────────────────────────────
    this.els.mqsCurrentModel.textContent = shortName;
    this.els.mqsTrigger.title = this._sessionModel
      ? `Session model: ${effectiveModel}`
      : `Default model: ${effectiveModel}`;

    // ── Locked state (after first message) ───────────────────
    if (this._modelLocked) {
      this.els.mqsTrigger.classList.add('locked');
    } else {
      this.els.mqsTrigger.classList.remove('locked');
    }

    // ── Populate dropdown list ──────────────────────────────
    const models = Object.values(this._modelsData || {});
    this._renderMqsDropdown(models, effectiveModel, '');

    // ── Search handler ──────────────────────────────────────
    this.els.mqsSearch.oninput = () => {
      this._renderMqsDropdown(models, effectiveModel, this.els.mqsSearch.value.trim());
    };

    // ── Trigger click: load models if needed, then toggle ────
    this.els.mqsTrigger.onclick = (e) => {
      e.stopPropagation();
      if (this._modelLocked) return; // locked — no-op
      if (!Object.keys(this._modelsData || {}).length) {
        const apiKey = settings.openrouterKey;
        if (apiKey?.length > 10) {
          this.showToast('Loading models…');
          this.loadModels(apiKey).then(() => {
            const updated = Object.values(this._modelsData || {});
            this._renderMqsDropdown(updated, effectiveModel, this.els.mqsSearch.value.trim());
            this._openMqsPopover();
          }).catch(() => {
            this.showToast('Failed to load models', 'warning');
          });
        } else {
          this.showToast('Set API key in Settings first', 'warning');
        }
        return;
      }
      this._toggleMqsPopover();
    };

    // ── Close on outside click ──────────────────────────────
    if (!this._mqsOutsideBound) {
      this._mqsOutsideBound = true;
      document.addEventListener('click', (ev) => {
        if (!this.els.mqsTrigger?.contains(ev.target) &&
            !this.els.mqsPopover?.contains(ev.target)) {
          this._closeMqsPopover();
        }
      });
    }

    // ── Close on Escape ─────────────────────────────────────
    this.els.mqsSearch.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this._closeMqsPopover();
    });
  }

  _renderMqsDropdown(models, selectedId, filterText) {
    const list = this.els.mqsList;
    if (!list) return;

    if (!models.length) {
      list.innerHTML = '<div class="sp-mqs-option muted">No models loaded. Add API key in Settings.</div>';
      return;
    }

    const q = (filterText || '').toLowerCase().trim();
    let filtered = models;
    if (q) {
      filtered = models.filter(m =>
        (m.id || '').toLowerCase().includes(q) ||
        (m.name || '').toLowerCase().includes(q)
      );
    }

    // Sort: selected first, then alpha by name
    filtered = filtered.slice().sort((a, b) => {
      if (a.id === selectedId) return -1;
      if (b.id === selectedId) return 1;
      return (a.name || a.id).localeCompare(b.name || b.id);
    }).slice(0, 80);

    if (!filtered.length) {
      list.innerHTML = '<div class="sp-mqs-option muted">No models match.</div>';
      return;
    }

    list.innerHTML = filtered.map(m => {
      const vision = this._modelHasVision(m);
      const ctx = m.top_provider?.context_length || m.context_length || m.endpoints?.[0]?.context_length;
      const ctxLabel = ctx ? `${Math.round(ctx / 1024)}K context` : '';
      const price = this._formatModelPrice(m);
      const badges = [
        vision ? '<span class="sp-model-badge vision">Vision</span>' : '',
        ctxLabel ? `<span class="sp-model-badge ctx">${ctxLabel}</span>` : '',
        price ? `<span class="sp-model-badge price">${this.escapeHtml(price)}</span>` : ''
      ].filter(Boolean).join('');
      const isSelected = m.id === selectedId;

      return `<button type="button" class="sp-mqs-option${isSelected ? ' selected' : ''}" data-id="${this.escapeHtml(m.id)}">
        <div class="sp-mqs-option-name">${this.escapeHtml(m.name || m.id)}</div>
        <div class="sp-mqs-option-id">${this.escapeHtml(m.id)}</div>
        <div class="sp-mqs-option-badges">${badges}</div>
      </button>`;
    }).join('');

    // ── Click handler for each option ────────────────────────
    list.querySelectorAll('.sp-mqs-option[data-id]').forEach(btn => {
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const id = btn.dataset.id;
        // Set session model override
        this._sessionModel = id;
        this._selectedModelInfo = this._modelsData?.[id] || null;
        this._closeMqsPopover();
        // Refresh display + capabilities
        this.els.mqsCurrentModel.textContent = id.includes('/') ? id.split('/').pop() : id;
        this.els.mqsTrigger.title = `Session model: ${id}`;
        this._updateModelCapabilities(id);
        this._renderMqsDropdown(models, id, this.els.mqsSearch.value.trim());
        this.showToast(`Model: ${id.includes('/') ? id.split('/').pop() : id}`);
        // Persist the model choice in the session data
        this._persistSessionModel();
      });
    });
  }

  _toggleMqsPopover() {
    const popover = this.els.mqsPopover;
    const trigger = this.els.mqsTrigger;
    if (!popover || !trigger) return;
    const isOpen = popover.style.display === 'block';
    if (isOpen) {
      this._closeMqsPopover();
    } else {
      // Focus search input when opening
      popover.style.display = 'block';
      trigger.classList.add('open');
      setTimeout(() => this.els.mqsSearch?.focus(), 50);
    }
  }

  _openMqsPopover() {
    if (this.els.mqsPopover) this.els.mqsPopover.style.display = 'block';
    if (this.els.mqsTrigger) this.els.mqsTrigger.classList.add('open');
    setTimeout(() => this.els.mqsSearch?.focus(), 50);
  }

  _closeMqsPopover() {
    if (this.els.mqsPopover) this.els.mqsPopover.style.display = 'none';
    if (this.els.mqsTrigger) this.els.mqsTrigger.classList.remove('open');
  }

  /**
   * Persist the current _sessionModel into the session's storage record
   * so it survives sidebar close/reopen. Called after model selection.
   */
  async _persistSessionModel() {
    const key = this._chatLockEnabled ? this._chatLockKey : this.historyKey;
    if (!key) return;
    const data = await chrome.storage.local.get([key]);
    const session = data[key] || {};
    session.sessionModel = this._sessionModel || null;
    await chrome.storage.local.set({ [key]: session });
  }

  // ── Settings ────────────────────────────────────────────────────
  async getSettings() {
    try {
      return new Promise((resolve) => {
        chrome.storage.local.get(['settings'], (result) => {
          const s = result.settings || {};
          if (s.openrouterModel === undefined) s.openrouterModel = '';
          if (s.enableStreaming === undefined) s.enableStreaming = true;
          if (s.debugLogging === undefined) s.debugLogging = false;
          if (s.ttsLanguage === undefined) s.ttsLanguage = 'auto';
          if (!s.quickActions?.length) s.quickActions = this.getDefaultQuickActions();
          resolve(s);
        });
      });
    } catch (e) {
      return { enableStreaming: true, quickActions: this.getDefaultQuickActions() };
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
    // Apply debug logging toggle to shared SNN_D (also covers agent-loop.js)
    SNN_D.enabled = settings.debugLogging === true;

    // Prefetch model catalog so vision badges / checks use real OpenRouter metadata
    if (settings.openrouterKey?.length > 10 && !Object.keys(this._modelsData || {}).length) {
      this.loadModels(settings.openrouterKey).catch(() => {});
    } else {
      this._updateHeaderVisionBadge(settings.openrouterModel || '');
    }

    // ── Dynamic dark-mode indicator class on body ───────────────
    this._updateDarkModeClass(theme);
    this._watchSystemColorScheme(theme);
  }

  // ── Dark-mode class helper ──────────────────────────────────────
  // Adds/removes `is-dark-mode` on body so CSS can target dark palette
  // without duplicating variable blocks. Also useful for JS guards.
  _updateDarkModeClass(theme) {
    const isDark =
      theme === 'dark' ||
      (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('is-dark-mode', !!isDark);
  }

  // ── Watch system color-scheme changes (only when theme=auto) ────
  _watchSystemColorScheme(theme) {
    // Remove any previous listener
    if (this._darkModeQuery) {
      this._darkModeQuery.removeEventListener('change', this._darkModeQueryHandler);
      this._darkModeQuery = null;
      this._darkModeQueryHandler = null;
    }
    if (theme === 'auto') {
      this._darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this._darkModeQueryHandler = () => this._updateDarkModeClass('auto');
      this._darkModeQuery.addEventListener('change', this._darkModeQueryHandler);
    }
  }

  updateModelDisplay(settings) {
    const model = this._sessionModel || settings.openrouterModel || 'deepseek/deepseek-v4-flash';
    const name = model.includes('/') ? model.split('/').pop() : model;
    this.els.modelName.textContent = name;
    // Keep selected model info for vision checks
    if (this._modelsData?.[model]) this._selectedModelInfo = this._modelsData[model];
    this._updateHeaderVisionBadge(model);
  }

  _updateModelCapabilities(modelId) {
    const el = this.els.modelName;
    if (!el) return;

    // ── Update the displayed model name on the welcome screen ──
    const id = modelId
      || this._selectedModelInfo?.id
      || Object.keys(this._modelsData || {}).find(k => (this.els.modelName.textContent || '') && k.endsWith(this.els.modelName.textContent))
      || '';
    const shortName = id.includes('/') ? id.split('/').pop() : id;
    if (shortName) el.textContent = shortName;
    // Resolve full model id from settings cache when only short name is shown
    let fullId = id;
    if (!fullId || !this._modelsData?.[fullId]) {
      const short = (this.els.modelName.textContent || '').toLowerCase();
      const match = Object.keys(this._modelsData || {}).find(k => k.toLowerCase().endsWith('/' + short) || k.toLowerCase() === short);
      if (match) fullId = match;
    }
    if (fullId && this._modelsData?.[fullId]) this._selectedModelInfo = this._modelsData[fullId];
    const resolvedId = fullId || this._selectedModelInfo?.id;
    const mods = this._getModelInputModalities(resolvedId);

    // Update model name tooltip
    const capabilities = [];
    if (mods.has('image')) capabilities.push('vision');
    if (mods.has('audio')) capabilities.push('audio');
    if (mods.has('video')) capabilities.push('video');
    if (mods.has('file'))  capabilities.push('file');
    el.title = capabilities.length > 0
      ? `Capabilities: ${capabilities.join(', ')}`
      : 'Text-only model (no multimodal input)';

    // Populate model capability tags under the welcome screen
    this._renderModelInfoTags(resolvedId);

    // Refresh the attach button & file input accept based on modalities
    this._refreshAttachButton(resolvedId);
  }

  // Backward-compat alias
  _updateHeaderVisionBadge(modelId) { this._updateModelCapabilities(modelId); }

  /**
   * Render capability tags below the welcome-screen model name.
   * Reads input_modalities from the cached OpenRouter model data.
   */
  _renderModelInfoTags(modelId) {
    const container = document.getElementById('model-info-tags');
    if (!container) return;

    const data = modelId ? (this._modelsData?.[modelId] || this._selectedModelInfo) : this._selectedModelInfo;
    const modalities = data?.architecture?.input_modalities;

    if (!Array.isArray(modalities) || modalities.length === 0) {
      container.innerHTML = '<span class="sp-model-tag">text</span>';
      return;
    }

    // Normalise modality names and deduplicate
    const seen = new Set();
    const tags = [];
    for (const mod of modalities) {
      const raw = String(mod).toLowerCase().trim();
      let label = null;
      if (/text|language/i.test(raw)) label = 'text';
      else if (/image|vision/i.test(raw)) label = 'image';
      else if (/video/i.test(raw)) label = 'video';
      else if (/file|pdf|document/i.test(raw)) label = 'file';
      else if (/audio/i.test(raw)) label = 'audio';
      if (label && !seen.has(label)) {
        seen.add(label);
        tags.push(label);
      }
    }

    if (tags.length === 0) tags.push('text');

    container.innerHTML = tags.map(t =>
      `<span class="sp-model-tag">${t}</span>`
    ).join('');
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
        <button class="sp-tab" data-tab="quickactions">Quick Actions</button>
        <button class="sp-tab" data-tab="appearance">Appearance</button>
      </div>

      <div class="sp-tab-content active" data-tab-content="api">
        <div class="sp-section">
          <h4>OpenRouter API</h4>
          
          <div class="sp-field">
            <label>API Key</label>
            <input type="password" id="s-openrouter-key" value="${this.escapeHtml(s.openrouterKey || '')}" placeholder="sk-or-...">
            <p>New to APIs? Register <a  href="https://openrouter.ai/workspaces/" target="_blank" rel="noopener">openrouter.ai</a>, create a workspace, generate an API key, and paste it here.</p>
          </div>
          <div class="sp-field">
            <label>Model</label>
            <div class="sp-model-picker" id="s-model-picker">
              <input type="text" id="s-openrouter-model" value="${this.escapeHtml(s.openrouterModel || '')}" placeholder="Search models..." autocomplete="off">
              <div class="sp-model-dropdown" id="s-model-dropdown" style="display:none"></div>
            </div>
            <small>Search by name. Vision-capable models show a Vision badge.</small>
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
            <input type="number" id="s-max-tokens" value="${s.maxTokens || 16000}" min="256" max="131072">
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
          <h4>Page Content Limit (characters)</h4>
          <div class="sp-field">
            <input type="number" id="s-content-limit" value="${s.contentLimit || 200000}" min="500" max="2000000">
            <small>How much page text to hand the model. Large context windows are cheap — raise it freely. Pages the agent reads with its own tools are never cut by this.</small>
          </div>
        </div>
        <div class="sp-section">
          <h4>Features</h4>
          ${this.toggleHtml('s-enable-streaming', 'Streaming Responses', 'See AI responses in real-time', s.enableStreaming !== false)}
          ${this.toggleHtml('s-debug-logging', 'Debug Logging', 'Show detailed [SNN:*] console logs for troubleshooting', s.debugLogging === true)}
        </div>
        <div class="sp-section">
          <h4>Text-to-Speech</h4>
          <div class="sp-field">
            <label>TTS Language</label>
            <select id="s-tts-lang">
              <option value="auto" ${(s.ttsLanguage || 'auto') === 'auto' ? 'selected' : ''}>Auto-detect</option>
              <option value="en" ${s.ttsLanguage === 'en' ? 'selected' : ''}>English</option>
              <option value="tr" ${s.ttsLanguage === 'tr' ? 'selected' : ''}>Türkçe</option>
              <option value="de" ${s.ttsLanguage === 'de' ? 'selected' : ''}>Deutsch</option>
              <option value="fr" ${s.ttsLanguage === 'fr' ? 'selected' : ''}>Français</option>
              <option value="es" ${s.ttsLanguage === 'es' ? 'selected' : ''}>Español</option>
              <option value="ru" ${s.ttsLanguage === 'ru' ? 'selected' : ''}>Русский</option>
              <option value="zh" ${s.ttsLanguage === 'zh' ? 'selected' : ''}>中文</option>
              <option value="ja" ${s.ttsLanguage === 'ja' ? 'selected' : ''}>日本語</option>
              <option value="ko" ${s.ttsLanguage === 'ko' ? 'selected' : ''}>한국어</option>
              <option value="ar" ${s.ttsLanguage === 'ar' ? 'selected' : ''}>العربية</option>
              <option value="pt" ${s.ttsLanguage === 'pt' ? 'selected' : ''}>Português</option>
              <option value="it" ${s.ttsLanguage === 'it' ? 'selected' : ''}>Italiano</option>
            </select>
            <small>Auto-detect uses Chrome's language detector. Override to force a specific voice when reading.</small>
          </div>
        </div>
        <div class="sp-section">
          <h4>Data</h4>
          <button class="sp-btn sp-btn-secondary" id="s-export-history">Export Chat History</button>
          <button class="sp-btn sp-btn-danger" id="s-clear-history" style="margin-left:8px">Clear All History</button>
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

    // Export / Clear
    this.els.settingsBody.querySelector('#s-export-history').addEventListener('click', () => this.exportHistory());
    this.els.settingsBody.querySelector('#s-clear-history').addEventListener('click', () => this.clearAllHistory());

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

    // Rich model picker
    this._setupModelPicker(s.openrouterModel || '');
    if (s.openrouterModel) this.fetchModelInfo();
  }

  _setupModelPicker(selectedId) {
    const modelInput = this.els.settingsBody.querySelector('#s-openrouter-model');
    const dropdown = this.els.settingsBody.querySelector('#s-model-dropdown');
    if (!modelInput || !dropdown) return;

    const closeDropdown = () => { dropdown.style.display = 'none'; };
    const openDropdown = () => {
      this._renderModelDropdown(modelInput.value.trim());
      dropdown.style.display = 'block';
    };

    modelInput.addEventListener('focus', openDropdown);
    modelInput.addEventListener('input', () => {
      this._renderModelDropdown(modelInput.value.trim());
      dropdown.style.display = 'block';
    });
    modelInput.addEventListener('change', () => this.fetchModelInfo());
    modelInput.addEventListener('blur', () => {
      // Delay so option click can register
      setTimeout(() => {
        closeDropdown();
        this.fetchModelInfo();
      }, 180);
    });
    modelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDropdown();
      if (e.key === 'Enter') {
        // Keep typed freeform model id
        closeDropdown();
        this.fetchModelInfo();
      }
    });

    // Re-render if models already cached
    if (Object.keys(this._modelsData || {}).length) {
      this._renderModelDropdown(selectedId || '');
    }
  }

  _modelHasVision(modelData) {
    if (!modelData) return false;
    const mods = modelData.architecture?.input_modalities;
    if (Array.isArray(mods) && mods.some(m => /image|vision/i.test(String(m)))) return true;
    const modality = modelData.architecture?.modality;
    if (typeof modality === 'string' && /image|vision/i.test(modality)) return true;
    return false;
  }

  _formatModelPrice(modelData) {
    // OpenRouter pricing is typically per-token strings on model.pricing
    const p = modelData?.pricing;
    if (!p) return null;
    const prompt = parseFloat(p.prompt);
    const completion = parseFloat(p.completion);
    if (Number.isNaN(prompt) && Number.isNaN(completion)) return null;
    // Convert to $ / 1M tokens when values look like per-token
    const fmt = (v) => {
      if (Number.isNaN(v)) return '?';
      const perM = v < 0.01 ? v * 1_000_000 : v;
      if (perM < 0.01) return `$${perM.toFixed(4)}`;
      if (perM < 1) return `$${perM.toFixed(3)}`;
      return `$${perM.toFixed(2)}`;
    };
    return `${fmt(prompt)} / ${fmt(completion)} per 1M`;
  }

  _renderModelDropdown(filterText = '') {
    const dropdown = this.els.settingsBody?.querySelector('#s-model-dropdown');
    if (!dropdown) return;

    const models = Object.values(this._modelsData || {});
    if (!models.length) {
      dropdown.innerHTML = '<div class="sp-model-option muted">Load API key to fetch models…</div>';
      return;
    }

    const q = (filterText || '').toLowerCase();
    let list = models;
    if (q) {
      list = models.filter(m =>
        (m.id || '').toLowerCase().includes(q) ||
        (m.name || '').toLowerCase().includes(q)
      );
    }

    // Prefer popular / free-ish first when no filter, otherwise alpha by name
    list = list.slice().sort((a, b) => {
      const av = this._modelHasVision(a) ? 1 : 0;
      const bv = this._modelHasVision(b) ? 1 : 0;
      if (q) return (a.name || a.id).localeCompare(b.name || b.id);
      // mild boost for vision models when browsing
      if (bv !== av) return bv - av;
      return (a.name || a.id).localeCompare(b.name || b.id);
    }).slice(0, 80);

    if (!list.length) {
      dropdown.innerHTML = '<div class="sp-model-option muted">No models match.</div>';
      return;
    }

    dropdown.innerHTML = list.map(m => {
      const vision = this._modelHasVision(m);
      const ctx = m.top_provider?.context_length || m.context_length || m.endpoints?.[0]?.context_length;
      const ctxLabel = ctx ? `${Math.round(ctx / 1024)}K ctx` : '';
      const price = this._formatModelPrice(m);
      const badges = [
        vision ? '<span class="sp-model-badge vision">Vision</span>' : '',
        ctxLabel ? `<span class="sp-model-badge ctx">${ctxLabel}</span>` : '',
        price ? `<span class="sp-model-badge price">${this.escapeHtml(price)}</span>` : ''
      ].filter(Boolean).join('');

      return `<button type="button" class="sp-model-option" data-id="${this.escapeHtml(m.id)}">
        <div class="sp-model-option-main">
          <span class="sp-model-option-name">${this.escapeHtml(m.name || m.id)}</span>
          <span class="sp-model-option-id">${this.escapeHtml(m.id)}</span>
        </div>
        <div class="sp-model-option-badges">${badges}</div>
      </button>`;
    }).join('');

    dropdown.querySelectorAll('.sp-model-option[data-id]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus handling predictable
        const id = btn.dataset.id;
        const input = this.els.settingsBody.querySelector('#s-openrouter-model');
        if (input) input.value = id;
        this._selectedModelInfo = this._modelsData?.[id] || null;
        dropdown.style.display = 'none';
        this.fetchModelInfo();
        this._updateHeaderVisionBadge();
      });
    });
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
      // Cache model data for picker + vision checks
      this._modelsData = {};
      (data.data || []).forEach(m => { this._modelsData[m.id] = m; });

      // Keep selected model info in sync
      const selectedId = this.els.settingsBody?.querySelector('#s-openrouter-model')?.value.trim();
      if (selectedId && this._modelsData[selectedId]) {
        this._selectedModelInfo = this._modelsData[selectedId];
      }

      // Refresh rich picker dropdown if open/settings visible
      if (this.els.settingsBody?.querySelector('#s-model-dropdown')) {
        this._renderModelDropdown(selectedId || '');
      }
      if (selectedId) this.fetchModelInfo();
      this._updateHeaderVisionBadge();
    } catch (e) {
      D.error('Failed to load models:', e);
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

    try {
      const apiKey = this.els.settingsBody.querySelector('#s-openrouter-key')?.value.trim();
      if (!apiKey) {
        infoDiv.innerHTML = '<div class="sp-model-info-error">Enter API key to see model details.</div>';
        return;
      }

      // Look up from cached models list — no separate API call needed
      const data = this._modelsData?.[modelId];
      if (!data) {
        // Fallback: try a direct API call if model not in cache
        infoDiv.innerHTML = '<div class="sp-model-info-loading">Loading model info...</div>';
        const res = await fetch(`https://openrouter.ai/api/v1/models/${encodeURI(modelId)}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const fetched = json.data;
        if (!fetched) throw new Error('No model data');
        this._renderModelInfo(infoDiv, fetched);
        return;
      }

      this._renderModelInfo(infoDiv, data);
    } catch (e) {
      infoDiv.innerHTML = `<div class="sp-model-info-error">Could not load model info: ${this.escapeHtml(e.message)}</div>`;
    }
  }

  _renderModelInfo(infoDiv, data) {
    this._selectedModelInfo = data;
    let html = '';

    // Vision capability banner
    const hasVision = this._modelHasVision(data);
    html += `<div class="sp-model-info-banner ${hasVision ? 'vision' : 'text-only'}">
      <strong>${hasVision ? 'Vision supported' : 'Text only'}</strong>
      <span>${hasVision ? 'Images & screenshots can be sent to this model.' : 'Images will not be sent (text-only model).'}</span>
    </div>`;

    // Description
    if (data.description) {
      html += `<div class="sp-model-info-desc">${this.escapeHtml(data.description.substring(0, 400))}${data.description.length > 400 ? '...' : ''}</div>`;
    }

    // Architecture / modalities
    const arch = data.architecture;
    if (arch) {
      if (arch.input_modalities && arch.input_modalities.length > 0) {
        html += '<div class="sp-model-info-row"><span class="sp-model-info-label">Input:</span><div class="sp-model-info-tags">';
        for (const mod of arch.input_modalities) {
          const isVision = /image|vision/i.test(String(mod));
          html += `<span class="sp-model-tag sp-model-tag-input${isVision ? ' vision' : ''}">${this.escapeHtml(mod)}</span>`;
        }
        html += '</div></div>';
      }
      if (arch.output_modalities && arch.output_modalities.length > 0) {
        html += '<div class="sp-model-info-row"><span class="sp-model-info-label">Output:</span><div class="sp-model-info-tags">';
        for (const mod of arch.output_modalities) {
          html += `<span class="sp-model-tag sp-model-tag-output">${this.escapeHtml(mod)}</span>`;
        }
        html += '</div></div>';
      }
    }

    // Supported parameters — from model level (list format) or endpoints[0] (single format)
    const supportedParams = data.supported_parameters || data.endpoints?.[0]?.supported_parameters;
    if (supportedParams && supportedParams.length > 0) {
      html += '<div class="sp-model-info-row"><span class="sp-model-info-label">Params:</span><div class="sp-model-info-tags">';
      for (const param of supportedParams) {
        html += `<span class="sp-model-tag sp-model-tag-param">${this.escapeHtml(param)}</span>`;
      }
      html += '</div></div>';
    }

    // Context length — from top_provider (list format) or endpoints[0] (single format)
    const ctxLen = data.top_provider?.context_length || data.context_length || data.endpoints?.[0]?.context_length;
    if (ctxLen) {
      html += `<div class="sp-model-info-row"><span class="sp-model-info-label">Context:</span><span class="sp-model-info-value">${(ctxLen / 1024).toFixed(0)}K tokens</span></div>`;
    }

    // Pricing
    const price = this._formatModelPrice(data);
    if (price) {
      html += `<div class="sp-model-info-row"><span class="sp-model-info-label">Price:</span><span class="sp-model-info-value">${this.escapeHtml(price)}</span></div>`;
    }

    // Max completion tokens
    const maxOut = data.top_provider?.max_completion_tokens || data.endpoints?.[0]?.max_completion_tokens;
    if (maxOut) {
      html += `<div class="sp-model-info-row"><span class="sp-model-info-label">Max output:</span><span class="sp-model-info-value">${maxOut.toLocaleString()} tokens</span></div>`;
    }

    infoDiv.innerHTML = html || '<div class="sp-model-info-empty">No detailed info available for this model.</div>';
    this._updateHeaderVisionBadge();
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
   * Returns the default agent system prompt that tells the LLM what SNN can do.
   */
  _getDefaultAgentPrompt() {
    // Minimal identity stamp — the heavy behavioral instructions live in agent-loop.js.
    // Users can customize via Settings → Custom Instruction to add a personal touch.
    return 'You are SNN Chat, a browser agent that can interact with web pages in real-time. Be concise and helpful.';
  }

  async saveSettings() {
    const s = this.els.settingsBody;
    const getVal = (id) => s.querySelector(`#${id}`)?.value || '';
    const getChecked = (id) => s.querySelector(`#${id}`)?.checked;

    const settings = {
      openrouterKey: getVal('s-openrouter-key'),
      openrouterModel: getVal('s-openrouter-model'),
      maxTokens: parseInt(getVal('s-max-tokens')) || 16000,
      temperature: parseFloat(getVal('s-temperature')) || 0.7,
      topP: parseFloat(getVal('s-top-p')) || 0.9,
      contentLimit: parseInt(getVal('s-content-limit')) || 200000,
      systemPrompt: getVal('s-system-prompt'),
      theme: getVal('s-theme'),
      fontSize: parseInt(getVal('s-font-size')) || 16,
      enableStreaming: getChecked('s-enable-streaming'),
      debugLogging: getChecked('s-debug-logging'),
      ttsLanguage: getVal('s-tts-lang') || 'auto',
      quickActions: this.getQuickActionsFromEditor()
    };

    if (!settings.openrouterKey) {
      this.showToast('No API key set — chat will not work until you add one.', 'warning');
    }

    await chrome.storage.local.set({ settings });
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
    this._historyCache = histories;

    if (histories.length === 0) {
      this.els.historyBody.innerHTML = '<div class="sp-empty-state">No chat history yet.<br><small>Start chatting to build history.</small></div>';
      return;
    }

    let html = `
      <div class="sp-history-toolbar">
        <input type="text" class="sp-history-search" id="history-search" placeholder="Search all sessions...">
      </div>
      <div id="history-list"></div>`;

    this.els.historyBody.innerHTML = html;
    this._renderHistoryList(histories, '');

    const searchInput = this.els.historyBody.querySelector('#history-search');
    searchInput?.addEventListener('input', () => {
      const q = (searchInput?.value || '').trim().toLowerCase();
      this._renderHistoryList(histories, q);
    });
  }

  /**
   * Render all history items — always one unified flat list across ALL domains.
   * No sections, no toggles. Search scans domain name, preview, and full message content.
   */
  _renderHistoryList(allHistories, query) {
    const list = this.els.historyBody.querySelector('#history-list');
    if (!list) return;

    let filtered = allHistories;
    if (query) {
      const q = query;
      filtered = allHistories.filter(h => {
        const meta = `${h.domain || ''} ${h.lastMessage || ''}`.toLowerCase();
        if (meta.includes(q)) return true;
        if (h.searchText && h.searchText.includes(q)) return true;
        return false;
      });
    }

    if (!filtered.length) {
      list.innerHTML = '<div class="sp-empty-state">No matching sessions.</div>';
      return;
    }

    let html = '';
    for (const h of filtered) {
      const msgCount = Math.floor(h.messageCount / 2);
      const date = new Date(h.lastUpdated).toLocaleDateString();
      const preview = h.lastMessage || '';
      const previewShort = preview.length > 60 ? preview.substring(0, 60) + '...' : preview;
      const isCurrent = (this.historyKey === h.key) || (this._historyKey === h.key);
      html += `
          <div class="sp-history-item${isCurrent ? ' current' : ''}" data-key="${this.escapeHtml(h.key)}" data-domain="${this.escapeHtml(h.domain || '')}">
            <div class="sp-history-title">${this.escapeHtml(h.domain || 'session')}</div>
            <div class="sp-history-meta">${date} \u00b7 ${msgCount} msgs</div>
            ${previewShort ? `<div class="sp-history-preview">\u201c${this.escapeHtml(previewShort)}\u201d</div>` : ''}
            <button class="sp-history-delete" data-key="${this.escapeHtml(h.key)}">\u00d7</button>
          </div>`;
    }
    list.innerHTML = html;

    list.querySelectorAll('.sp-history-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('sp-history-delete')) return;
        this.switchSession(item.dataset.key, item.dataset.domain);
      });
    });
    list.querySelectorAll('.sp-history-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSession(btn.dataset.key);
      });
    });
  }

  async loadAllHistories() {
    const all = await chrome.storage.local.get(null);
    const histories = [];
    for (const key in all) {
      if (!key.startsWith('snn_chat_history_') || !all[key].messages?.length) continue;

      const data = all[key];
      // Build searchable text once (for global search)
      const searchText = (data.messages || [])
        .map(m => (typeof m.content === 'string' ? m.content : ''))
        .join('\n')
        .toLowerCase()
        .substring(0, 50000);

      // ── Session Lock: special display for global locked session ──
      if (key === this._chatLockKey) {
        const lastUser = [...data.messages].reverse().find(m => m.role === 'user');
        histories.push({
          key,
          domain: 'Global Session',
          sessionId: '__locked__',
          tabId: null,
          isLocked: true,
          lastUpdated: data.lastUpdated || 0,
          messageCount: data.messages.length,
          lastMessage: lastUser?.content || '',
          searchText
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
        lastMessage: lastUser?.content || '',
        searchText
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

        this.totalTokensUsed = 0;
        this._contextConsumedInSession = false;
        this.activeContext = null;
        await this._saveChatLockState();
        this._updateLockVisuals();
        this.restoreChat();
        this.closeHistory();
        this.showToast('<i class="fas fa-lock"></i> Global session loaded');
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
      this._sessionModel = session.sessionModel || null;
      this._modelLocked = (session.messages || []).length > 0;
      this.restoreChat();
      this.closeHistory();
      this.renderModelQuickSwitch();
      this.showToast('Session loaded');
    }
  }

  async deleteSession(key) {
    if (!confirm('Delete this chat session?')) return;
    await chrome.storage.local.remove([key]);
    if (this.historyKey === key) {
      this.chatHistory = [];
      this._clearChatMessages();
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
    this._clearChatMessages();
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

  /**
   * Clear the chat messages container while preserving the welcome screen.
   * Using innerHTML = '' detaches the welcome screen from the DOM, so we
   * must re-attach it afterwards.
   */
  _clearChatMessages() {
    this.els.chatMessages.innerHTML = '';
    if (this.els.welcomeScreen) {
      this.els.chatMessages.appendChild(this.els.welcomeScreen);
      this.els.welcomeScreen.style.display = '';
    }
  }

  async restoreChat() {
    this._clearChatMessages();
    this.totalTokensUsed = 0;
    this.els.welcomeScreen.style.display = this.chatHistory.length === 0 ? '' : 'none';

    // Track if any message in this session already used context
    let hasContextMessage = false;

    // ── Grouping state for action group restoration ──────────
    // We accumulate agent-status + agent-action entries between
    // user/assistant messages and wrap them in collapsible groups.
    let groupState = null;        // null | 'building'
    let groupEntries = [];        // { type: 'status'|'action', msg }
    let groupFinalState = null;   // 'IDLE' | 'FAILED' | 'CANCELLED' | null

    const flushGroup = () => {
      if (groupEntries.length === 0) return;
      this._buildRestoredGroup(groupState, groupFinalState, groupEntries);
      groupState = null;
      groupEntries = [];
      groupFinalState = null;
    };

    for (let i = 0; i < this.chatHistory.length; i++) {
      const msg = this.chatHistory[i];

      if (msg.role === 'user') {
        flushGroup();
        this.addMessage('user', msg.content, null, msg.context || null, msg.attachments || null);
        if (msg.context) hasContextMessage = true;
      } else if (msg.role === 'assistant') {
        flushGroup();
        // Cancellation markers exist purely so the NEXT turn's LLM history
        // shows the instruction was deliberately abandoned (otherwise the
        // model re-runs the whole task). The user already sees the
        // "Interrupted" status chip — don't render a second bubble saying so.
        if (msg.cancelled) continue;
        this.addMessage('ai', msg.content, msg.tokenUsage);
      } else if (msg.role === 'agent-action') {
        // If no group is building yet, implicitly start one.
        // This handles edge cases where an action entry was saved
        // before the EXECUTING status entry (e.g. from older sessions).
        if (groupState !== 'building') {
          flushGroup();
          groupState = 'building';
        }
        groupEntries.push({ type: 'action', msg });
      } else if (msg.role === 'agent-reasoning') {
        // Same implicit-group handling as agent-action entries above.
        if (groupState !== 'building') {
          flushGroup();
          groupState = 'building';
        }
        groupEntries.push({ type: 'reasoning', msg });
      } else if (msg.role === 'agent-status') {
        const s = msg.state;

        // PARSING always renders outside (brief intro) — flush any prior group first
        if (s === 'PARSING' || s === 'PLANNING') {
          flushGroup();
          this._renderPersistedStatusEntry(msg);
          continue;
        }

        // EXECUTING starts a new group if not already building
        if (s === 'EXECUTING') {
          if (groupState !== 'building') {
            flushGroup();
            groupState = 'building';
          }
          groupEntries.push({ type: 'status', msg });
          continue;
        }

        // Intermediate states that go inside the group
        if (s === 'OBSERVING' || s === 'RETRYING' || s === 'REPORTING' || s === 'WAITING') {
          groupEntries.push({ type: 'status', msg });
          continue;
        }

        // Terminal states: IDLE closes group; FAILED/CANCELLED/BLOCKED close group
        // and ALSO render outside so the error is visible.
        if (s === 'IDLE') {
          groupEntries.push({ type: 'status', msg });
          groupFinalState = 'IDLE';
          flushGroup();
          continue;
        }
        if (s === 'FAILED' || s === 'CANCELLED' || s === 'BLOCKED') {
          flushGroup();  // close any existing group first
          this._renderPersistedStatusEntry(msg); // show error outside
          continue;
        }

        // Fallback — any unknown state renders outside
        flushGroup();
        this._renderPersistedStatusEntry(msg);
      }
    }

    // Flush any remaining group at end of history
    flushGroup();

    // If any message already consumed context, mark session accordingly
    this._contextConsumedInSession = hasContextMessage;
    this.refreshActiveContext();
  }

  /**
   * Build a restored action group container from collected entries.
   * @param {string|null} groupState - 'building' or null
   * @param {string|null} finalState - 'IDLE', 'FAILED', 'CANCELLED', or null
   * @param {Array} entries - [{ type:'status'|'action', msg }]
   */
  _buildRestoredGroup(groupState, finalState, entries) {
    if (!entries || entries.length === 0) return;

    const group = document.createElement('div');
    group.className = 'snn-action-group';

    // Determine header appearance
    let iconHtml, headerText;
    const actionCount = entries.filter(e => e.type === 'action' &&
      (e.msg.status === 'ok' || e.msg.status === 'fail')).length;
    const countLabel = actionCount > 0 ? ` · ${actionCount} action${actionCount !== 1 ? 's' : ''}` : '';

    if (finalState === 'IDLE') {
      iconHtml = '<i class="fas fa-circle-check"></i>';
      headerText = `Completed${countLabel}`;
    } else if (finalState === 'FAILED') {
      iconHtml = '<i class="fas fa-triangle-exclamation"></i>';
      headerText = `Failed${countLabel}`;
    } else if (finalState === 'CANCELLED' || groupState === 'building') {
      iconHtml = '<i class="fas fa-xmark"></i>';
      headerText = 'Interrupted';
    } else {
      iconHtml = '<i class="fas fa-circle-check"></i>';
      headerText = `Completed${countLabel}`;
    }

    group.innerHTML = `
      <div class="snn-action-group-header">
        <span class="snn-action-group-chevron">▶</span>
        <span class="snn-action-group-header-icon">${iconHtml}</span>
        <span class="snn-action-group-header-text">${headerText}</span>
      </div>
      <div class="snn-action-group-body"></div>
    `;

    const header = group.querySelector('.snn-action-group-header');
    header.addEventListener('click', () => group.classList.toggle('expanded'));

    const body = group.querySelector('.snn-action-group-body');

    for (const entry of entries) {
      if (entry.type === 'action') {
        this._renderPersistedActionEntry(entry.msg, body);
      } else if (entry.type === 'reasoning') {
        this._renderPersistedReasoningEntry(entry.msg, body);
      } else {
        this._renderPersistedStatusEntry(entry.msg, body);
      }
    }

    this.els.chatMessages.appendChild(group);
  }

  /**
   * Render a persisted agent-action entry (survives tab switches).
   * @param {object} msg - the persisted action entry
   * @param {HTMLElement} [target] - optional container to append to (defaults to chatMessages)
   */
  _renderPersistedActionEntry(msg, target) {
    const container = target || this.els.chatMessages;
    const entry = document.createElement('div');
    entry.className = `snn-action-entry snn-action-${msg.status || 'info'}`;
    const icons = { start: '<i class="fas fa-play"></i>', ok: '<i class="fas fa-circle-check"></i>', fail: '<i class="fas fa-circle-xmark"></i>', info: '<i class="fas fa-circle-info"></i>', cancelled: '<i class="fas fa-arrow-left"></i>' };
    const icon = icons[msg.status] || '<i class="fas fa-circle"></i>';
    entry.innerHTML = `
      <span class="snn-action-entry-icon">${icon}</span>
      <span class="snn-action-entry-text">${this.escapeHtml(msg.description || '')}</span>
      ${msg.detail ? `<span class="snn-action-entry-detail">${this.escapeHtml(msg.detail)}</span>` : ''}
    `;
    container.appendChild(entry);
  }

  /**
   * Render a persisted agent-reasoning entry (survives tab switches).
   * Mirrors the collapsible "Thinking..." block from agent-ui.js addReasoningEntry.
   * @param {object} msg - the persisted reasoning entry
   * @param {HTMLElement} [target] - optional container to append to (defaults to chatMessages)
   */
  _renderPersistedReasoningEntry(msg, target) {
    const container = target || this.els.chatMessages;
    const entry = document.createElement('div');
    entry.className = 'snn-reasoning-entry';
    entry.innerHTML = `
      <details class="snn-reasoning-details" open>
        <summary class="snn-reasoning-summary">
          <span class="snn-reasoning-label">Thinking...</span>
        </summary>
        <div class="snn-reasoning-content">${this.escapeHtml(msg.text || '')}</div>
      </details>
    `;
    container.appendChild(entry);
  }

  /**
   * Render a persisted agent-status entry (survives tab switches).
   * Shows state transitions like "Analyzing your request..." in chat.
   * @param {object} msg - the persisted status entry
   * @param {HTMLElement} [target] - optional container to append to (defaults to chatMessages)
   */
  _renderPersistedStatusEntry(msg, target) {
    const container = target || this.els.chatMessages;
    // Inline status config — mirrors agent-ui.js _statusEntryConfig
    const configMap = {
      PARSING:   { icon: 'fa-magnifying-glass', cls: 'snn-status-parsing',   label: 'Analyzing your request...' },
      PLANNING:  { icon: 'fa-list-check',        cls: 'snn-status-planning',  label: 'Building action plan...' },
      EXECUTING: { icon: 'fa-bolt',              cls: 'snn-status-executing', label: 'Working...' },
      WAITING:   { icon: 'fa-hourglass-half',    cls: 'snn-status-waiting',   label: 'Waiting for page...' },
      OBSERVING: { icon: 'fa-eye',               cls: 'snn-status-observing', label: 'Checking result...' },
      RETRYING:  { icon: 'fa-arrows-rotate',     cls: 'snn-status-retrying',  label: 'Retrying...' },
      REPORTING: { icon: 'fa-chart-simple',       cls: 'snn-status-reporting', label: 'Compiling results...' },
      FAILED:    { icon: 'fa-triangle-exclamation', cls: 'snn-status-failed', label: 'Failed' },
      BLOCKED:   { icon: 'fa-lock',              cls: 'snn-status-blocked',   label: 'Waiting for permission...' },
      CANCELLED: { icon: 'fa-xmark',             cls: 'snn-status-cancelled', label: 'Cancelled' },
      IDLE:      { icon: 'fa-circle-check',      cls: 'snn-status-idle',      label: 'Done' }
    };
    const config = configMap[msg.state];

    if (!config) {
      // Fallback — render a generic status entry
      const entry = document.createElement('div');
      entry.className = 'snn-status-entry snn-status-info';
      entry.innerHTML = `
        <span class="snn-status-entry-icon"><i class="fas fa-circle-info"></i></span>
        <span class="snn-status-entry-text">${this.escapeHtml(msg.label || msg.state || '')}</span>
      `;
      container.appendChild(entry);
      return;
    }

    const entry = document.createElement('div');
    entry.className = `snn-status-entry ${config.cls}`;
    entry.innerHTML = `
      <span class="snn-status-entry-icon"><i class="fas ${config.icon}"></i></span>
      <span class="snn-status-entry-text">${this.escapeHtml(msg.label || config.label)}</span>
    `;
    container.appendChild(entry);
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
        const session = data[this._chatLockKey];
        this._historyKey = this._chatLockKey;
        this.currentSessionId = '__locked__';
        this.chatHistory = session.messages;
        this._sessionModel = session.sessionModel || null;
        this._modelLocked = session.messages.length > 0;
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
    // Only trust the pointer if it belongs to THIS tab — prevents cross-tab session leakage
    if (activePtr?.key && activePtr.tabId === this.currentTabId) {
      const sessionData = await chrome.storage.local.get([activePtr.key]);
      const session = sessionData[activePtr.key];
      // Accept the session even if empty (newSession creates empty sessions)
      if (session) {
        this._historyKey = activePtr.key;
        this.currentSessionId = this._extractSessionIdFromKey(activePtr.key);
        this.chatHistory = session.messages || [];
        this._sessionModel = session.sessionModel || null;
        this._modelLocked = (session.messages || []).length > 0;
        this.restoreChat();
        return;
      }
      // Pointer exists but session record is missing entirely — clear the
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
      // Restore per-session model if saved
      this._sessionModel = null; this._modelLocked = false;
      const fullSession = all[recent.key];
      if (fullSession) {
        this._sessionModel = fullSession.sessionModel || null;
        this._modelLocked = (fullSession.messages || []).length > 0;
      }
      this.restoreChat();
      // Also write the pointer so future loads pick this session
      await this._saveActiveSessionPtr();
    }
  }

  /**
   * Persist a pointer to the currently-active session so it survives
   * sidebar close/reopen. Called after newSession and saveChatHistory
   * so the pointer always reflects reality.
   */
  async _saveActiveSessionPtr() {
    const key = this._chatLockEnabled ? this._chatLockKey : this.historyKey;
    await chrome.storage.local.set({
      [SNNSidePanel.ACTIVE_SESSION_PTR]: { key, tabId: this.currentTabId, at: Date.now() }
    });
  }

  /**
   * Snapshot of the session a write should land in.
   *
   * Capture this BEFORE any await that could straddle a tab switch.
   * _onTabSwitched reassigns _historyKey (to null) and chatHistory (to a
   * fresh array), so a save that recomputes them afterwards writes the
   * WRONG messages under the WRONG key — either burying the old tab's
   * chat under the new tab's key, or overwriting the old session with
   * the new tab's empty array. Holding the key and the array reference
   * from before the switch makes a late write land where it belongs.
   */
  sessionRef() {
    return {
      key: this._chatLockEnabled ? this._chatLockKey : this.historyKey,
      messages: this.chatHistory,
      domain: this.currentDomain,
      tabId: this._chatLockEnabled ? null : this.currentTabId
    };
  }

  /** The session currently on screen — used to tell live writes from stale ones. */
  _liveKey() {
    return this._chatLockEnabled ? this._chatLockKey : this.historyKey;
  }

  /**
   * @param {object|null} ref — a sessionRef() captured earlier. Omit to
   *                            save whatever session is live right now.
   * @returns {Promise<boolean>} whether the write actually landed.
   */
  async saveChatHistory(ref = null) {
    const key = ref?.key || this._liveKey();
    const messages = ref?.messages || this.chatHistory;
    // A stale ref must never drag the active-session pointer backwards.
    const isLive = key === this._liveKey();
    // Latch the computed key so subsequent saves target the same session.
    // Only for the live session — latching a stale ref's key would point
    // the panel back at the session the user just navigated away from.
    if (isLive && !this._chatLockEnabled && !this._historyKey) {
      this._historyKey = key;
    }

    try {
      await chrome.storage.local.set({
        [key]: {
          domain: ref ? ref.domain : this.currentDomain,
          tabId: ref ? ref.tabId : (this._chatLockEnabled ? null : this.currentTabId),
          lastUpdated: Date.now(),
          messages,
          sessionModel: this._sessionModel || null
        }
      });
      // Keep the active-session pointer in sync so reopen always
      // restores this session (survives newSession + close/reopen).
      if (isLive) await this._saveActiveSessionPtr();
      this._lastSaveError = null;
      return true;
    } catch (err) {
      this._reportSaveFailure(err, key, messages.length);
      return false;
    }
  }

  /**
   * A save that fails silently is indistinguishable from a chat that was
   * never sent — the user loses the conversation with no way to tell why.
   * Surface it once, loudly, and keep the detail for the settings panel.
   * Throttled because agent runs fire many saves per second and a storage
   * outage would otherwise bury the UI in toasts.
   */
  _reportSaveFailure(err, key, messageCount) {
    this._lastSaveError = { message: err?.message || String(err), key, at: Date.now() };
    D.error('saveChatHistory FAILED', { key, messageCount, error: err?.message || String(err) });
    const now = Date.now();
    if (!this._lastSaveToastAt || now - this._lastSaveToastAt > 10000) {
      this._lastSaveToastAt = now;
      this.showToast('Chat could not be saved — this conversation may be lost', 'error');
    }
  }

  async newSession() {
    // Session Lock: just clear chat, keep same locked session
    if (this._chatLockEnabled) {
      if (this.chatHistory.length) await this.saveChatHistory();
      this.chatHistory = [];
      this.totalTokensUsed = 0;
      this._contextConsumedInSession = false;
      this.activeContext = null;
      this._sessionModel = null;
      this._modelLocked = false;
      this._clearChatMessages();
      this.els.welcomeScreen.style.display = '';
      this.els.tokenCounter.style.display = 'none';
      this.refreshActiveContext();
      await this.renderQuickActions();
      await this.renderModelQuickSwitch();
      this.showToast('Chat cleared <i class="fas fa-lock"></i> session locked');
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
    this._sessionModel = null;
    this._modelLocked = false;
    // ── Persist the empty session record so the pointer resolves ──
    // If we don't write this, loadMostRecentSession() sees an empty/missing
    // session, deletes the pointer, and falls back to the OLD session.
    await chrome.storage.local.set({
      [this._historyKey]: {
        domain: this.currentDomain,
        tabId: this.currentTabId,
        lastUpdated: Date.now(),
        messages: [],
        sessionModel: null
      }
    });
    // ── Persist the pointer NOW so reopen picks up THIS session ──
    await this._saveActiveSessionPtr();
    // ── Clear UI ──────────────────────────────────────────────
    this._clearChatMessages();
    this.els.welcomeScreen.style.display = '';
    this.els.tokenCounter.style.display = 'none';
    this.refreshActiveContext();
    await this.renderQuickActions();
    await this.renderModelQuickSwitch();
    this.showToast('New chat started');
  }

  /**
   * True when the user moved to a different tab while this turn was
   * in flight, so its result no longer belongs on screen. Session Lock
   * spans all tabs, so nothing is ever stale there.
   */
  _isStaleTurn(sendTabId) {
    return !this._chatLockEnabled && this.currentTabId !== sendTabId;
  }

  /**
   * Save whatever text streamed in before an abort. Without this, cancelling
   * (or switching tabs) mid-stream left the session holding a question with
   * no answer, even though the partial reply was already on screen.
   */
  async _persistPartialReply(sendRef) {
    const partial = (this._streamPartial || '').trim();
    this._streamPartial = '';
    if (!partial) return;
    sendRef.messages.push({
      role: 'assistant',
      content: partial,
      tokenUsage: this.lastTokenUsage,
      partial: true
    });
    await this.saveChatHistory(sendRef);
  }

  /**
   * Reset the loading/UI state. Call this whenever an in-flight
   * sendMessage is abandoned (tab switch, cancellation, etc.) to
   * unstick the send button and input.
   */
  _resetLoadingState() {
    this.isLoading = false;
    this._setSendBtnToSend();
    this.removeLoadingMsg();
    // Abort any in-flight fetch so tokens aren't wasted
    if (this._activeAbortController) {
      this._activeAbortController.abort();
      this._activeAbortController = null;
    }
    // Flush any context-menu intent that arrived while we were busy
    this._checkContextMenuIntent();
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
    this._chatLockEnabled = !wasLocked;

    if (this._chatLockEnabled && !wasLocked) {
      // ═══ LOCKING: save current → switch to unified session ═══
      await this.saveChatHistory();

      const data = await chrome.storage.local.get([this._chatLockKey]);
      if (data[this._chatLockKey]?.messages?.length) {
        // Restore existing locked session
        const session = data[this._chatLockKey];
        this.chatHistory = session.messages;
        this._sessionModel = session.sessionModel || null;
        this._modelLocked = session.messages.length > 0;
        this.restoreChat();
      } else {
        // Start fresh in locked mode
        this.chatHistory = [];
        this._sessionModel = null;
        this._modelLocked = false;
        this._clearChatMessages();
        this.els.welcomeScreen.style.display = '';
      }

      this.currentSessionId = '__locked__';
      this._historyKey = this._chatLockKey;
      this._contextConsumedInSession = false;
      this.totalTokensUsed = 0;
      this.els.tokenCounter.style.display = 'none';
      this._updateLockVisuals();
      await this.renderModelQuickSwitch();
      this.showToast('<i class="fas fa-lock"></i> Session Locked — one session across all tabs');
    } else if (!this._chatLockEnabled && wasLocked) {
      // ═══ UNLOCKING: save locked → back to per-tab ═══
      await this.saveChatHistory();

      this.currentSessionId = this.generateId();
      this._historyKey = null;
      this.chatHistory = [];
      this._clearChatMessages();
      this.els.welcomeScreen.style.display = '';
      this.els.tokenCounter.style.display = 'none';
      this._sessionModel = null;
      this._modelLocked = false;

      // Clear the active-session pointer so we fall back to
      // per-tab timestamp discovery (not the locked session).
      await chrome.storage.local.remove([SNNSidePanel.ACTIVE_SESSION_PTR]);

      await this.loadMostRecentSession();
      this._updateLockVisuals();
      await this.renderModelQuickSwitch();
      this.showToast('<i class="fas fa-lock-open"></i> Session Unlocked — per-tab sessions restored');
    }

    await this._saveChatLockState();
  }

  /**
   * Shared cleanup after sendMessage completes (agent or plain chat path).
   * Resets loading state, clears context, re-focuses input.
   */
  /**
   * Render any thrown error as the standard error card. Falls back to a
   * plain message bubble only if the agent UI isn't up yet, so an error
   * can never be swallowed.
   */
  showErrorCard(error, step = null) {
    const data = { error: this.categorizeApiError(error), step, totalAttempts: 1 };
    if (this._agentUI) {
      this._agentUI.renderErrorCard(data);
    } else {
      this.addMessage('ai', `Error: ${error?.message || 'Unknown error'}`);
    }
  }

  _finishSendMessage() {
    // Clear active context after sending (selection consumed)
    if (this.selection) {
      this.clearSelection(); // calls refreshActiveContext() internally
    } else {
      this.activeContext = null;
      this.refreshActiveContext();
    }

    this.isLoading = false;
    this._setSendBtnToSend();
    this.els.userInput.focus();
    this._activeAbortController = null;

    // Flush any context-menu intent that arrived while we were loading
    this._checkContextMenuIntent();
  }

  // ── Send Button Toggle (Send ↔ Stop) ──────────────────────────

  /** Switch the send button to a stop button while generating. */
  _setSendBtnToStop() {
    const btn = this.els.sendBtn;
    if (!btn) return;
    btn.classList.add('sp-stop-btn');
    btn.innerHTML = '<i class="fas fa-stop"></i> Stop';
    btn.disabled = false;
  }

  /** Restore the send button after generation finishes. */
  _setSendBtnToSend() {
    const btn = this.els.sendBtn;
    if (!btn) return;
    btn.classList.remove('sp-stop-btn');
    btn.innerHTML = 'Send';
    btn.disabled = false;
  }

  /**
   * Stop/cancel the current generation or agent run immediately.
   * Called when the user clicks the stop button or presses Escape
   * while the agent or plain-chat fetch is in progress.
   */
  _stopGeneration() {
    D.log('STOP generation requested by user');

    // 1. Abort plain-chat fetch (streamResponse / callAPI)
    if (this._activeAbortController) {
      this._activeAbortController.abort();
      this._activeAbortController = null;
    }

    // 2. Cancel agent loop if running
    if (this._agentLoop && this._agentLoop.isBusy) {
      this._agentLoop.cancel('user');
    }

    // 3. Reset UI state
    this.isLoading = false;
    this._setSendBtnToSend();
    this.removeLoadingMsg();

    this.showToast('Stopped');
  }

  // ═══════════════════════════════════════════════════════════════
  // AGENT LOOP INTEGRATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Build an augmented system prompt that tells the LLM what SNN can do.
   * This prevents the LLM from saying "I can't click/interact with the page."
   */
  _getAugmentedSystemPrompt(basePrompt) {
    // Core identity + user's custom touch (if any) + base system prompt
    const identity = this._agentPromptCache || this._getDefaultAgentPrompt();
    const parts = [identity];
    // Only add base prompt if it's meaningfully different from identity
    const base = basePrompt || 'You are a helpful AI assistant. Be concise and accurate.';
    if (base !== identity) parts.push(base);
    // Appended unconditionally, NOT folded into the identity stamp: a user who
    // sets a custom instruction replaces `identity` wholesale, and the chat
    // path renders mermaid just like the agent path does — so this has to
    // survive that replacement.
    parts.push(MERMAID_PROMPT);
    return parts.join('\n\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // PROMPT CACHING
  // ═══════════════════════════════════════════════════════════════
  // Providers cache a prompt PREFIX and only re-read what changed after it.
  // That makes message ORDER load-bearing: anything that changes per turn
  // (page content, the user's question) must sit AFTER anything that doesn't
  // (system prompt, settled history). Get it backwards and the cacheable
  // prefix collapses to nothing and every call is billed in full.

  /**
   * Does this model require explicit cache_control breakpoints?
   *
   * OpenRouter splits providers into two camps. OpenAI, DeepSeek, Grok and
   * Groq cache automatically and ignore cache_control entirely. Anthropic,
   * Qwen and Gemini cache ONLY where a breakpoint is placed — with no
   * breakpoint they re-read the whole prompt at full price on every call.
   */
  _modelNeedsCacheBreakpoints(modelId) {
    return /anthropic|claude|gemini|qwen|alibaba/i.test(modelId || '');
  }

  /**
   * Smallest prefix worth spending a breakpoint on, in characters.
   *
   * Below the provider's minimum the breakpoint is silently ignored — no
   * error, just no cache — while still counting against Anthropic's cap of
   * four. So gate on it rather than marking every block hopefully.
   */
  _cacheMinChars(modelId) {
    const id = (modelId || '').toLowerCase();
    let minTokens = 1024;
    if (/opus/.test(id)) minTokens = 4096;
    else if (/haiku-3/.test(id)) minTokens = 2048;
    else if (/gemini/.test(id) && !/flash/.test(id)) minTokens = 4096;
    return minTokens * 3.5; // rough chars-per-token
  }

  /**
   * Mark a message as the end of a cacheable prefix.
   *
   * `prefixChars` is the size of EVERYTHING up to and including this message,
   * not of the message itself — what the provider's minimum applies to is the
   * whole prefix, so a short trailing history message can still be a perfectly
   * good breakpoint. No-op for auto-caching providers, which ignore the field.
   */
  _withCacheBreakpoint(msg, modelId, prefixChars) {
    if (!this._modelNeedsCacheBreakpoints(modelId)) return msg;
    if (typeof msg.content !== 'string') return msg;
    if ((prefixChars ?? msg.content.length) < this._cacheMinChars(modelId)) return msg;
    return {
      ...msg,
      content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }]
    };
  }

  /**
   * The slice of history to send, chosen so the prefix stays byte-identical
   * across consecutive turns.
   *
   * A plain slice(-N) shifts by one message every turn once history passes N,
   * which invalidates the cached prefix on EVERY call — exactly the long
   * conversations where caching would pay the most. Here the cut point only
   * advances in whole blocks: it holds still for several turns, then jumps.
   * The window breathes between keepMin and keepMax instead of sitting at a
   * fixed N, which is the price of a stable prefix and a cheap one.
   */
  _stableHistoryWindow(history, keepMax = 16, keepMin = 8) {
    if (history.length <= keepMax) return history;
    const step = keepMax - keepMin;
    const start = Math.ceil((history.length - keepMax) / step) * step;
    return history.slice(start);
  }

  /**
   * Build the message array for a plain (non-agent) chat turn.
   *
   * Shared by callAPI and streamResponse, which had drifted into two near
   * copies of the same logic. Page content used to be concatenated onto the
   * system prompt itself — which made the system prompt volatile and left
   * nothing at all cacheable.
   */
  _buildChatMessages(systemPrompt, context, contextType, message, model) {
    let userMessage = message;
    if (context && contextType === 'selection') {
      systemPrompt += '\nFocus on the user\'s selected text.';
    }

    const messages = [
      this._withCacheBreakpoint({ role: 'system', content: systemPrompt }, model, systemPrompt.length)
    ];

    const history = this._stableHistoryWindow(
      this.chatHistory.filter(m => m.role === 'user' || m.role === 'assistant')
    ).map(m => ({ role: m.role, content: m.content }));

    // sendMessage pushes the current turn to chatHistory BEFORE calling us, so
    // the trailing entry is this same message — it gets re-added below with the
    // context attached. Dropping it here avoids sending the user's question
    // twice, which the old slice(-8) + append did on every context-free turn.
    const lastHist = history[history.length - 1];
    if (lastHist && lastHist.role === 'user' && lastHist.content === message) history.pop();

    for (const hm of history) messages.push(hm);

    if (messages.length > 1) {
      const prefixChars = messages.reduce((n, m) => n + this._msgChars(m), 0);
      messages[messages.length - 1] =
        this._withCacheBreakpoint(messages[messages.length - 1], model, prefixChars);
    }

    // Volatile context rides on the trailing user turn — last position, where
    // it cannot invalidate anything above it.
    if (context && contextType === 'selection') {
      userMessage = `[Selected text: "${context}"]\n\n${message}`;
    } else if (context && (contextType === 'page' || contextType === 'files')) {
      userMessage = `[Page content for reference]\n\n${context}\n\n─────────\n\n${message}`;
    }

    messages.push({ role: 'user', content: userMessage });
    return { messages, userMessage };
  }

  /**
   * Character weight of one message. Content may be a plain string, or an
   * array of blocks once a cache breakpoint or an image is attached.
   */
  _msgChars(m) {
    const c = m?.content;
    if (typeof c === 'string') return c.length;
    if (!Array.isArray(c)) return 500;
    return c.reduce((n, b) => n + (typeof b?.text === 'string' ? b.text.length : 500), 0);
  }

  /**
   * Share of the prompt served from cache, as a display string.
   * Returns null when there is nothing meaningful to show.
   */
  _cacheHitRate(usage) {
    const prompt = usage?.prompt_tokens || 0;
    if (!prompt) return null;
    const cached = usage?.cached_tokens || 0;
    return Math.round((100 * cached) / prompt) + '%';
  }

  /** Normalize the cache fields OpenRouter reports across provider shapes. */
  _readCacheUsage(usage) {
    if (!usage) return { cached: 0, written: 0 };
    return {
      cached: usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || 0,
      written: usage.cache_creation_input_tokens
        || usage.prompt_tokens_details?.cache_write_tokens || 0
    };
  }

  /**
   * Return a Set of supported input modalities for the given model.
   * Reads architecture.input_modalities from cached OpenRouter model data.
   * Falls back to name-based heuristics for uncached models.
   * @returns {Set<string>} e.g. Set { 'text', 'image', 'audio', 'video', 'file' }
   */
  _getModelInputModalities(modelId) {
    const result = new Set(['text']); // text is always supported
    if (!modelId) return result;

    // 1) Authoritative: cached OpenRouter model data
    const cached = this._modelsData?.[modelId] || this._selectedModelInfo;
    const modalities = cached?.architecture?.input_modalities || null;
    if (Array.isArray(modalities) && modalities.length > 0) {
      for (const mod of modalities) {
        const raw = String(mod).toLowerCase().trim();
        if (/image|vision/i.test(raw)) result.add('image');
        else if (/audio/i.test(raw)) result.add('audio');
        else if (/video/i.test(raw)) result.add('video');
        else if (/file|pdf|document/i.test(raw)) result.add('file');
      }
      return result;
    }

    // 2) Fallback heuristic for uncached models
    const m = modelId.toLowerCase();
    // Vision-capable models
    if (/gemini|gpt-4o|gpt-4\.1|gpt-4-vision|gpt-4-turbo|claude-3|claude-4|claude-sonnet|claude-opus|llava|pixtral|vision|multimodal|qwen.*vl|grok-2-vision/i.test(m)) {
      result.add('image');
      result.add('file');
    }
    // Audio-capable models (GPT-4o-audio, Gemini with audio)
    if (/gpt-4o-audio|gemini|gpt-4o/i.test(m)) result.add('audio');
    // Video-capable models (Gemini)
    if (/gemini/i.test(m)) result.add('video');
    return result;
  }

  /**
   * Check if a model supports image/vision input.
   * Delegates to _getModelInputModalities. Kept for backward compat with agent-loop.
   */
  _modelSupportsVision(modelId) {
    return this._getModelInputModalities(modelId).has('image');
  }

  // ── Limit helpers ──────────────────────────────────────────────
  /** Get per-type max bytes; falls back to generic 'file' limit. */
  _getMaxBytesForType(type) {
    return this._FILE_LIMITS[type] || this._FILE_LIMITS.file || 8 * 1024 * 1024;
  }

  /** Get max count of attachments per type. */
  _getMaxCountForType(type) {
    if (type === 'video') return this._MAX_ATTACHMENTS_VIDEO || 1;
    return this._MAX_ATTACHMENTS_TOTAL || 6;
  }

  // ── Dynamic attach button ──────────────────────────────────────
  /**
   * Update the attach button title, visibility, and file input accept
   * based on the currently selected model's input modalities.
   */
  _refreshAttachButton(modelId) {
    const btn = this.els.attachBtn;
    const input = this.els.attachInput;
    if (!btn || !input) return;

    const mods = this._getModelInputModalities(modelId);
    const hasImage = mods.has('image');
    const hasAudio = mods.has('audio');
    const hasVideo = mods.has('video');
    const hasFile  = mods.has('file');

    // Build accept string
    const acceptParts = [];
    if (hasImage) acceptParts.push('image/*');
    if (hasAudio) acceptParts.push('audio/*');
    if (hasVideo) acceptParts.push('video/*');
    if (hasFile || hasImage) {
      acceptParts.push('.pdf');
    }
    // Always allow text files
    acceptParts.push('.txt,.md,.csv,.json,.log,.html,.htm,.xml,.js,.ts,.css,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.yml,.yaml');

    input.setAttribute('accept', acceptParts.join(','));

    // Only hide for text-only models (no image, audio, video, or file)
    const hasAnyAttachment = hasImage || hasAudio || hasVideo || hasFile;
    btn.style.display = hasAnyAttachment ? '' : 'none';

    // Build descriptive title
    const supported = [];
    if (hasImage) supported.push('image');
    if (hasAudio) supported.push('audio');
    if (hasVideo) supported.push('video');
    if (hasFile)  supported.push('PDF');
    supported.push('text');
    btn.title = `Attach ${supported.join(', ')} or text file`;
  }

  /**
   * Inject multimodal content (images, audio, video) into the last user message
   * based on what the selected model supports.
   */
  _injectMultimodalContent(messages, userMessage, model) {
    const mods = this._getModelInputModalities(model);
    const parts = [{ type: 'text', text: userMessage || 'Please analyze the attached file(s).' }];
    let anyInjected = false;

    // ── Images ──
    const images = [];
    const pendingImg = this._pendingImageAttachments || [];
    for (const a of pendingImg) {
      if (a?.dataUrl) images.push(a.dataUrl);
    }
    if (this._lastScreenshot) {
      images.push(this._lastScreenshot);
      this._lastScreenshot = null;
    }
    if (images.length && mods.has('image')) {
      for (const url of images) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
      anyInjected = true;
    } else if (images.length && !mods.has('image')) {
      this.showToast('Current model does not support vision — images not sent to the model.', 'warning');
    }

    // ── Audio ──
    const pendingAudio = this._pendingAudioAttachments || [];
    if (pendingAudio.length && mods.has('audio')) {
      for (const a of pendingAudio) {
        if (a?.dataUrl) {
          // Extract format from mime e.g. 'audio/mp3' → 'mp3'
          const fmt = (a.mime || 'audio/wav').split('/')[1] || 'wav';
          parts.push({
            type: 'input_audio',
            input_audio: { data: a.dataUrl, format: fmt }
          });
        }
      }
      anyInjected = true;
    } else if (pendingAudio.length && !mods.has('audio')) {
      this.showToast('Current model does not support audio input — audio not sent.', 'warning');
    }

    // ── Video ──
    const pendingVideo = this._pendingVideoAttachments || [];
    if (pendingVideo.length && mods.has('video')) {
      for (const v of pendingVideo) {
        if (v?.dataUrl) {
          const fmt = (v.mime || 'video/mp4').split('/')[1] || 'mp4';
          parts.push({
            type: 'input_video',
            input_video: { data: v.dataUrl, format: fmt }
          });
        }
      }
      anyInjected = true;
    } else if (pendingVideo.length && !mods.has('video')) {
      // Append as text note instead so the model at least knows about the file
      const names = pendingVideo.map(v => v.name).join(', ');
      this.showToast('Current model does not support video input — video info sent as text reference.', 'warning');
      parts.push({ type: 'text', text: `[Video file(s) attached but current model cannot process video: ${names}]` });
      anyInjected = true;
    }

    if (anyInjected) {
      messages[messages.length - 1] = { role: 'user', content: parts };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FILE ATTACHMENTS — pick / paste / drop images, PDFs, text files
  // ═══════════════════════════════════════════════════════════════
  _setupAttachmentHandlers() {
    if (!this.els.attachBtn || !this.els.attachInput) return;

    this.els.attachBtn.addEventListener('click', () => this.els.attachInput.click());
    this.els.attachInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) await this._addAttachmentFile(f);
      this.els.attachInput.value = '';
    });

    // Paste images / files into the chat input
    this.els.userInput.addEventListener('paste', async (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const files = items
        .filter(i => i.kind === 'file')
        .map(i => i.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) await this._addAttachmentFile(f);
    });

    // Drag & drop onto the input area
    const dropZone = document.querySelector('.sp-input-area') || this.els.userInput;
    ['dragenter', 'dragover'].forEach(evt => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('sp-drop-active');
      });
    });
    ['dragleave', 'drop'].forEach(evt => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('sp-drop-active');
      });
    });
    dropZone.addEventListener('drop', async (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      for (const f of files) await this._addAttachmentFile(f);
    });
  }

  async _addAttachmentFile(file) {
    if (!file) return;
    const mime = file.type || '';
    const name = file.name || 'file';
    const lower = name.toLowerCase();

    // ── Classify file type ─────────────────────────────────────
    let type = 'file';
    if (mime.startsWith('image/') || /\\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lower)) type = 'image';
    else if (mime.startsWith('audio/') || /\\.(mp3|wav|ogg|flac|m4a|aac|opus|weba|wma)$/i.test(lower)) type = 'audio';
    else if (mime.startsWith('video/') || /\\.(mp4|webm|mkv|avi|mov|wmv|flv|m4v|ogv|3gp)$/i.test(lower)) type = 'video';
    else if (mime === 'application/pdf' || lower.endsWith('.pdf')) type = 'pdf';
    else if (
      mime.startsWith('text/') ||
      /json|xml|javascript|typescript|csv/.test(mime) ||
      /\\.(txt|md|csv|json|log|html?|xml|js|ts|css|py|rb|go|rs|java|c|cpp|h|yml|yaml)$/i.test(lower)
    ) type = 'text';

    // ── Size check (per-type limits) ───────────────────────────
    const maxBytes = this._getMaxBytesForType(type);
    if (file.size > maxBytes) {
      const maxMB = (maxBytes / 1024 / 1024).toFixed(1);
      this.showToast(`"${name}" is too large for ${type} (max ${maxMB} MB).`, 'error');
      return;
    }

    // ── Count check (per-type & total) ────────────────────────
    const pending = this._pendingAttachments || [];
    const totalMax = this._MAX_ATTACHMENTS_TOTAL || 6;
    if (pending.length >= totalMax) {
      this.showToast(`Maximum ${totalMax} attachments per message.`, 'warning');
      return;
    }
    const typeMax = this._getMaxCountForType(type);
    const typeCount = pending.filter(a => a.type === type).length;
    if (typeCount >= typeMax) {
      this.showToast(`Maximum ${typeMax} ${type} file${typeMax > 1 ? 's' : ''} per message.`, 'warning');
      return;
    }

    // ── Read file and store ────────────────────────────────────
    try {
      if (type === 'image') {
        const dataUrl = await this._readFileAsDataURL(file);
        pending.push({
          id: this.generateId(),
          name, type, mime: mime || 'image/*', size: file.size, dataUrl
        });
      } else if (type === 'audio') {
        // Audio: read as base64 data URL for models that accept inline audio
        const dataUrl = await this._readFileAsDataURL(file);
        pending.push({
          id: this.generateId(),
          name, type, mime: mime || 'audio/*', size: file.size, dataUrl,
          text: `[Audio file attached: ${name} (${this._formatBytes(file.size)})]`
        });
      } else if (type === 'video') {
        // Video: read as base64 data URL (size-limited, expensive in tokens)
        const dataUrl = await this._readFileAsDataURL(file);
        pending.push({
          id: this.generateId(),
          name, type, mime: mime || 'video/*', size: file.size, dataUrl,
          text: `[Video file attached: ${name} (${this._formatBytes(file.size)}). Video processing is limited — describe what you want analyzed.]`
        });
        // Warn about high token cost for video
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        this.showToast(`Video attached (${sizeMB} MB). Large videos incur high token costs.`, 'warning');
      } else if (type === 'text') {
        const text = await this._readFileAsText(file);
        pending.push({
          id: this.generateId(),
          name, type, mime: mime || 'text/plain', size: file.size,
          text: text.substring(0, 200000)
        });
      } else if (type === 'pdf') {
        // Best-effort: extract text via offscreen PDF.js if available; else note binary attach
        const text = await this._extractPdfAttachmentText(file);
        pending.push({
          id: this.generateId(),
          name, type, mime: 'application/pdf', size: file.size,
          text: text || `[PDF file attached: ${name} — text extraction unavailable]`
        });
      } else {
        // Unknown binary: store name only
        pending.push({
          id: this.generateId(),
          name, type: 'file', mime: mime || 'application/octet-stream', size: file.size,
          text: `[Binary file attached: ${name}]`
        });
      }
      this._renderAttachmentBar();
    } catch (err) {
      this.showToast(`Failed to attach ${name}: ${err.message}`, 'error');
    }
  }

  _renderAttachmentBar() {
    const bar = this.els.attachBar;
    if (!bar) return;
    const list = this._pendingAttachments || [];
    if (!list.length) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    bar.style.display = 'flex';

    const badgeMap = {
      image: 'IMG', audio: 'AUD', video: 'VID',
      pdf: 'PDF', text: 'TXT', file: 'FILE'
    };
    const iconMap = {
      image: '🖼', audio: '🎵', video: '🎬',
      pdf: '📄', text: '📝', file: '📎'
    };

    bar.innerHTML = list.map(a => {
      if (a.type === 'image' && a.dataUrl) {
        return `<div class="sp-attach-chip" data-id="${a.id}">
          <img src="${a.dataUrl}" alt="">
          <span class="sp-attach-chip-name" title="${this.escapeHtml(a.name)}">${this.escapeHtml(a.name)}</span>
          <button class="sp-attach-chip-remove" data-id="${a.id}" title="Remove">×</button>
        </div>`;
      }
      const badge = badgeMap[a.type] || 'FILE';
      const icon = iconMap[a.type] || '📎';
      return `<div class="sp-attach-chip" data-id="${a.id}">
        <span class="sp-attach-chip-badge" data-type="${a.type}">${icon} ${badge}</span>
        <span class="sp-attach-chip-name" title="${this.escapeHtml(a.name)}">${this.escapeHtml(a.name)}</span>
        <button class="sp-attach-chip-remove" data-id="${a.id}" title="Remove">×</button>
      </div>`;
    }).join('');

    bar.querySelectorAll('.sp-attach-chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        this._pendingAttachments = (this._pendingAttachments || []).filter(a => a.id !== id);
        this._renderAttachmentBar();
      });
    });
  }

  _buildAttachmentTextContext(attachments) {
    if (!attachments?.length) return '';
    const parts = [];
    for (const a of attachments) {
      // Images/video/audio are sent via content parts, skip them in text context
      if (a.type === 'image') continue;
      if (a.text) {
        parts.push(`--- ${a.name} ---\n${a.text}`);
      } else {
        parts.push(`--- ${a.name} --- (no extractable text)`);
      }
    }
    return parts.join('\n\n');
  }

  _readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  _readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsText(file);
    });
  }

  async _extractPdfAttachmentText(file) {
    try {
      const buffer = await file.arrayBuffer();
      // Reuse background offscreen PDF pipeline when available
      const response = await chrome.runtime.sendMessage({
        action: 'extractPdfText',
        url: file.name,
        title: file.name,
        pdfData: Array.from(new Uint8Array(buffer)),
        forAttachment: true
      });
      // Background may store as page context; also accept direct text if returned
      if (response?.text) return String(response.text).substring(0, 200000);
      if (response?.content) return String(response.content).substring(0, 200000);

      // Fallback: wait briefly for session storage update
      await new Promise(r => setTimeout(r, 400));
      const { snn_page_context } = await chrome.storage.session.get('snn_page_context');
      if (snn_page_context?.content && /pdf/i.test(snn_page_context.title || file.name)) {
        return String(snn_page_context.content).substring(0, 200000);
      }
      return null;
    } catch (e) {
      D.warn('PDF attachment extract failed:', e.message);
      return null;
    }
  }

  _formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
        <span class="snn-result-card-icon"><i class="fas fa-robot"></i></span>
        <span class="snn-result-card-title">${this.escapeHtml(capData.description || 'Here\'s what I can do:')}</span>
      </div>
      <div class="snn-result-card-body">
        ${actionsHtml}
        <p style="margin-top:12px;font-size:14px;">Try saying: <em>"click the login button"</em>, <em>"scroll down"</em>, <em>"highlight all links"</em>, <em>"fill this form"</em>, or <em>"screenshot this page"</em>.</p>
      </div>
    `;

    this.els.chatMessages.appendChild(div);
    this.smartScrollToBottom();
  }

  _formatCapabilitiesForHistory(capData) {
    if (!capData) return 'SNN Chat capabilities listed.';
    const count = (capData.pageActions?.length || 0) + (capData.browserActions?.length || 0);
    return `[SNN Capabilities — ${count} actions available]\n\n${capData.description || ''}\n\nTry: "click the login button", "scroll down", "highlight all links", "fill this form", or "screenshot this page".`;
  }

  _initAgentLoop() {
    if (typeof SNNAgentLoop === 'undefined' || typeof SNNAgentUI === 'undefined') {
      D.warn('Agent loop classes not loaded.');
      return;
    }

    D.log('Agent loop INIT');
    this._agentLoop = new SNNAgentLoop(this);
    this._agentUI = new SNNAgentUI(this);

    // ── State change callback ──────────────────────────────────
    this._agentLoop.onStateChange = (newState, prevState, detail) => {
      // ── Tab-switch cancellations: skip the visual flash ──────
      if (newState === 'CANCELLED' && detail?.reason?.startsWith('Tab switched')) {
        if (this._agentUI) {
          this._agentUI.hideProgress();
          this._agentUI.hideStatusBar();
        }
        return;
      }

      // ── Persistent status entry in chat history ─────────────
      // Every active state gets a chat entry so the user can
      // see the full agent workflow as a scrollable history.
      if (newState !== 'IDLE' && newState !== 'CANCELLED') {
        if (this._agentUI) this._agentUI.addStatusEntry(newState, detail);
      }

      // Terminal states — add a closing entry so the run is clearly bookended
      if ((newState === 'IDLE' && prevState !== 'IDLE') ||
          (newState === 'CANCELLED' && prevState !== 'CANCELLED')) {
        if (this._agentUI) this._agentUI.addStatusEntry(newState, detail);
      }

      // Cleanup on terminal states
      if (newState === 'IDLE' || newState === 'CANCELLED') {
        if (this._agentUI) {
          this._agentUI.hideProgress();
          this._agentUI.hideStatusBar();
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
        // The final LLM response (saved by sendMessage) already
        // summarizes the actions in proper Markdown.  Don't push a
        // redundant [Agent Actions] placeholder — it fragments the
        // collapsible group and creates duplicate content on restore.
      }
      if (resultData.type === 'capabilities') {
        const ref = this.sessionRef();
        ref.messages.push(
          { role: 'assistant', content: this._formatCapabilitiesForHistory(resultData.data), tokenUsage: null }
        );
        this.saveChatHistory(ref).catch((err) => {
          D.error('capabilities save failed', err?.message || String(err));
        });
      }
    };

    // ── Reasoning callback ─────────────────────────────────────
    this._agentLoop.onReasoning = (text, iteration) => {
      if (this._agentUI) {
        this._agentUI.addReasoningEntry(text, iteration);
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
    // Re-send the last user message verbatim. Previously this only showed
    // a toast and did nothing, which is exactly the silent-failure the
    // error card exists to prevent.
    this._onErrorRetry = () => {
      const last = this._lastSentUserText;
      if (this.isLoading || this._agentLoop?.isBusy) {
        this.showToast('Still working — wait for the current task to finish', 'warning');
        return;
      }
      if (!last) {
        this.showToast('Nothing to retry', 'warning');
        return;
      }
      this.els.userInput.value = last;
      this.sendMessage();
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
      // Don't trigger voice when ANY text input/textarea/select/contentEditable is focused
      const activeEl = document.activeElement;
      const isEditing = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.isContentEditable
      );
      if (e.code === 'Space' && !isEditing && !spaceDown) {
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
              D.warn('Voice error:', message.error);
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
    toast.innerHTML = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2500);
  }
}

// ── Start ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  new SNNSidePanel();
});
