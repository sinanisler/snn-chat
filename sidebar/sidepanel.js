// SNN Chat — Side Panel Script
// Full chat UI running in Chrome's native side panel (chrome.sidePanel API).
// Communicates with content script & background via chrome.storage.session + runtime messages.

class SNNSidePanel {
  constructor() {
    this.chatHistory = [];
    this.isLoading = false;
    this.totalTokensUsed = 0;
    this.currentDomain = '';
    this.currentSessionId = this.generateId();
    this.pageContext = null;
    this.selection = null;

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
      contextBar: this.el('page-context-bar'),
      contextText: this.el('context-text'),
      contextWords: this.el('context-words'),
      selectionBar: this.el('selection-bar'),
      selectionText: this.el('selection-text'),
      welcomeScreen: this.el('welcome-screen'),
      tokenCounter: this.el('token-counter'),
      smartPrompts: this.el('smart-prompts'),
      promptsGrid: this.el('prompts-grid'),
      settingsOverlay: this.el('settings-overlay'),
      settingsBody: this.el('settings-body'),
      historyOverlay: this.el('history-overlay'),
      historyBody: this.el('history-body')
    };
  }

  // ── Init ────────────────────────────────────────────────────────
  async init() {
    await this.applySettings();
    await this.loadContext();
    await this.loadMostRecentSession();
    this.renderQuickActions();
    this.setupVoice();
    this.setupContextWatcher();

    // Show welcome or quick actions
    if (this.chatHistory.length === 0) {
      this.els.smartPrompts.style.display = 'block';
    }
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
      this.pageContext = snn_page_context;
      this.currentDomain = snn_page_context.domain;
      this.updateContextBar();
    }
  }

  setupContextWatcher() {
    chrome.storage.session.onChanged.addListener((changes) => {
      if (changes.snn_page_context) {
        this.pageContext = changes.snn_page_context.newValue;
        if (this.pageContext) {
          this.currentDomain = this.pageContext.domain;
          this.updateContextBar();
        }
      }
      if (changes.snn_selection) {
        this.selection = changes.snn_selection.newValue;
        if (this.selection) {
          this.updateSelectionBar();
        } else {
          this.els.selectionBar.style.display = 'none';
        }
      }
    });
  }

  updateContextBar() {
    if (!this.pageContext) return;
    this.els.contextBar.style.display = 'flex';
    const title = this.pageContext.title || 'Unknown page';
    const truncated = title.length > 50 ? title.substring(0, 50) + '...' : title;
    this.els.contextText.textContent = truncated;
    this.els.contextText.title = title;
    const wc = this.pageContext.wordCount || 0;
    this.els.contextWords.textContent = wc ? `${wc.toLocaleString()} words` : '';
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
  }

  // ── Chat ────────────────────────────────────────────────────────
  async sendMessage() {
    const message = this.els.userInput.value.trim();
    if (!message || this.isLoading) return;

    this.isLoading = true;
    this.els.sendBtn.disabled = true;
    this.els.userInput.value = '';
    this.autoResize();
    this.els.smartPrompts.style.display = 'none';
    this.els.welcomeScreen.style.display = 'none';

    this.addMessage('user', message);
    await this.saveChatHistory();

    try {
      const settings = await this.getSettings();
      let context = this.pageContext?.content || '';
      let contextType = 'page';

      // If user has selected text, prioritize that
      if (this.selection?.text) {
        context = this.selection.text;
        contextType = 'selection';
      }

      if (settings.enableStreaming !== false) {
        const response = await this.streamResponse(message, context, contextType);
        this.chatHistory.push(
          { role: 'user', content: message, contextType },
          { role: 'assistant', content: response, tokenUsage: this.lastTokenUsage }
        );
      } else {
        this.addLoadingMsg();
        const response = await this.callAPI(message, context, contextType);
        this.removeLoadingMsg();
        this.addMessage('ai', response, this.lastTokenUsage);
        this.chatHistory.push(
          { role: 'user', content: message, contextType },
          { role: 'assistant', content: response, tokenUsage: this.lastTokenUsage }
        );
      }

      await this.saveChatHistory();
    } catch (error) {
      this.removeLoadingMsg();
      this.addMessage('ai', `Error: ${error.message}`);
    }

    this.isLoading = false;
    this.els.sendBtn.disabled = false;
    this.els.userInput.focus();
  }

  async callAPI(message, context, contextType) {
    const settings = await this.getSettings();
    const apiKey = settings.openrouterKey;
    if (!apiKey) throw new Error('OpenRouter API key not set. Add it in Settings.');

    const model = settings.openrouterModel || 'deepseek/deepseek-v4-flash';
    let systemPrompt = settings.systemPrompt || 'You are a helpful AI assistant. Be concise and accurate.';

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
      body: JSON.stringify(body)
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

  async streamResponse(message, context, contextType) {
    const settings = await this.getSettings();
    const apiKey = settings.openrouterKey;
    if (!apiKey) throw new Error('OpenRouter API key not set.');

    const model = settings.openrouterModel || 'deepseek/deepseek-v4-flash';
    let systemPrompt = settings.systemPrompt || 'You are a helpful AI assistant.';
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
      body: JSON.stringify(body)
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
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          fullResponse += content;
          contentDiv.innerHTML = this.parseMarkdown(fullResponse) + '<span class="sp-cursor">|</span>';
          this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
          if (parsed.usage) {
            this.lastTokenUsage = {
              prompt_tokens: parsed.usage.prompt_tokens || 0,
              completion_tokens: parsed.usage.completion_tokens || 0,
              total_tokens: parsed.usage.total_tokens || 0
            };
          }
        } catch (e) { /* skip malformed */ }
      }
    }

    contentDiv.innerHTML = this.parseMarkdown(fullResponse);
    this.addMsgActions(msgDiv, fullResponse);
    this.addTokenInfo(msgDiv);
    this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;

    return fullResponse;
  }

  // ── Message Rendering ──────────────────────────────────────────
  addMessage(role, content, tokenUsage) {
    this.els.welcomeScreen.style.display = 'none';
    const div = document.createElement('div');
    div.className = `sp-msg sp-msg-${role}`;
    div.innerHTML = role === 'ai' ? this.parseMarkdown(content) : this.escapeHtml(content);
    this.els.chatMessages.appendChild(div);

    if (role === 'ai') {
      this.addMsgActions(div, content);
      if (tokenUsage) this.addTokenInfo(div, tokenUsage);
    }

    this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
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

  // ── Markdown ────────────────────────────────────────────────────
  parseMarkdown(text) {
    const escape = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    let html = escape(text);
    html = html
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>')
      .replace(/^- (.*$)/gm, '<li>$1</li>')
      .replace(/\n/g, '<br>');
    return html;
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
    this.els.promptsGrid.innerHTML = actions.map((a, i) => `
      <button class="sp-prompt-chip" data-prompt="${this.escapeHtml(a.prompt)}">
        ${a.icon ? `<span class="sp-prompt-icon">${a.icon}</span>` : ''}
        <span>${a.text}</span>
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
      { icon: '', text: 'Summarize', prompt: 'Summarize this page concisely.' },
      { icon: '', text: 'Key points', prompt: 'Extract the key points from this page.' },
      { icon: '', text: 'Explain simply', prompt: 'Explain this page in simple terms.' },
      { icon: '', text: 'Bullet list', prompt: 'Summarize this page as bullet points.' },
      { icon: '', text: 'Translate', prompt: 'Translate the main content of this page to Spanish.' },
      { icon: '', text: 'What is this?', prompt: 'What is this page about? Give a brief overview.' }
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
        <button class="sp-tab" data-tab="features">Features</button>
        <button class="sp-tab" data-tab="quickactions">Quick Actions</button>
        <button class="sp-tab" data-tab="appearance">Appearance</button>
        <button class="sp-tab" data-tab="advanced">Advanced</button>
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
      </div>

      <div class="sp-tab-content" data-tab-content="features">
        <div class="sp-section">
          <h4>Features</h4>
          ${this.toggleHtml('s-enable-streaming', 'Streaming Responses', 'See AI responses in real-time', s.enableStreaming !== false)}
          ${this.toggleHtml('s-enable-quick-actions', 'Quick Actions', 'Show prompt suggestions for new chats', s.enableQuickActions !== false)}
          ${this.toggleHtml('s-enable-voice-input', 'Voice Input', 'Click mic button or hold Space to dictate', s.enableVoiceInput !== false)}
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

      <div class="sp-tab-content" data-tab-content="advanced">
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
    list.innerHTML = actions.map(a => `
      <div class="sp-qa-item">
        <input type="text" value="${this.escapeHtml(a.icon)}" placeholder="" maxlength="2">
        <input type="text" value="${this.escapeHtml(a.text)}" placeholder="Name">
        <input type="text" value="${this.escapeHtml(a.prompt)}" placeholder="Prompt">
        <button class="sp-qa-remove">×</button>
      </div>
    `).join('');
    list.querySelectorAll('.sp-qa-remove').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.sp-qa-item').remove());
    });
  }

  addQuickActionRow() {
    const list = this.els.settingsBody.querySelector('#s-qa-list');
    const row = document.createElement('div');
    row.className = 'sp-qa-item';
    row.innerHTML = `
      <input type="text" value="" placeholder="" maxlength="2">
      <input type="text" placeholder="Name">
      <input type="text" placeholder="Prompt">
      <button class="sp-qa-remove">×</button>
    `;
    row.querySelector('.sp-qa-remove').addEventListener('click', () => row.remove());
    list.appendChild(row);
    row.querySelectorAll('input')[1].focus();
  }

  getQuickActionsFromEditor() {
    const items = this.els.settingsBody.querySelectorAll('#s-qa-list .sp-qa-item');
    const actions = [];
    items.forEach(item => {
      const inputs = item.querySelectorAll('input');
      const icon = inputs[0].value.trim();
      const text = inputs[1].value.trim();
      const prompt = inputs[2].value.trim();
      if (text && prompt) actions.push({ icon: icon || '', text, prompt });
    });
    return actions.length ? actions : this.getDefaultQuickActions();
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
      quickActions: this.getQuickActionsFromEditor()
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
      if (key.startsWith('snn_chat_history_') && all[key].messages?.length) {
        const data = all[key];
        const parts = key.replace('snn_chat_history_', '').split('_');
        const sessionId = parts.pop();
        const domain = parts.join('_');
        const lastUser = [...data.messages].reverse().find(m => m.role === 'user');
        histories.push({
          key, domain, sessionId,
          lastUpdated: data.lastUpdated || 0,
          messageCount: data.messages.length,
          lastMessage: lastUser?.content || ''
        });
      }
    }
    histories.sort((a, b) => b.lastUpdated - a.lastUpdated);
    return histories;
  }

  async switchSession(key, domain) {
    await this.saveChatHistory();
    const data = await chrome.storage.local.get([key]);
    if (data[key]) {
      this.chatHistory = data[key].messages || [];
      this.currentDomain = domain;
      this.currentSessionId = key.split('_').pop();
      this.historyKey = key;
      this.totalTokensUsed = 0;
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
      const domain = key.replace('snn_chat_history_', '').split('_').slice(0, -1).join('_');
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

    for (let i = 0; i < this.chatHistory.length; i++) {
      const msg = this.chatHistory[i];
      if (msg.role === 'user') {
        this.addMessage('user', msg.content);
      } else if (msg.role === 'assistant') {
        this.addMessage('ai', msg.content, msg.tokenUsage);
      }
    }
  }

  // ── Session Management ─────────────────────────────────────────
  get historyKey() {
    return this._historyKey || `snn_chat_history_${this.currentDomain}_${this.currentSessionId}`;
  }
  set historyKey(v) { this._historyKey = v; }

  async loadMostRecentSession() {
    const all = await chrome.storage.local.get(null);
    const domainSessions = [];
    for (const key in all) {
      if (key.startsWith(`snn_chat_history_${this.currentDomain}_`) && all[key].messages?.length) {
        domainSessions.push({ key, lastUpdated: all[key].lastUpdated || 0, messages: all[key].messages });
      }
    }
    if (domainSessions.length) {
      domainSessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
      const recent = domainSessions[0];
      this._historyKey = recent.key;
      this.currentSessionId = recent.key.split('_').pop();
      this.chatHistory = recent.messages;
      this.restoreChat();
    }
  }

  async saveChatHistory() {
    if (!this.chatHistory.length) return;
    await chrome.storage.local.set({
      [this.historyKey]: {
        domain: this.currentDomain,
        lastUpdated: Date.now(),
        messages: this.chatHistory
      }
    });
  }

  async newSession() {
    if (this.chatHistory.length) await this.saveChatHistory();
    this.currentSessionId = this.generateId();
    this._historyKey = `snn_chat_history_${this.currentDomain}_${this.currentSessionId}`;
    this.chatHistory = [];
    this.totalTokensUsed = 0;
    this.els.chatMessages.innerHTML = '';
    this.els.welcomeScreen.style.display = '';
    this.els.smartPrompts.style.display = 'block';
    this.els.tokenCounter.style.display = 'none';
    await this.renderQuickActions();
    this.showToast('New chat started');
  }

  clearChat() {
    if (this.chatHistory.length) this.saveChatHistory();
    this.chatHistory = [];
    this.totalTokensUsed = 0;
    this.els.chatMessages.innerHTML = '';
    this.els.welcomeScreen.style.display = '';
    this.els.smartPrompts.style.display = 'block';
    this.els.tokenCounter.style.display = 'none';
    this.renderQuickActions();
  }

  generateId() {
    return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
  }

  // ── Voice Input ─────────────────────────────────────────────────
  setupVoice() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      this.els.voiceBtn.style.display = 'none';
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = navigator.language || 'en-US';

    this.recognition.onresult = (e) => {
      let final = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript + ' ';
        else interim += e.results[i][0].transcript;
      }
      if (final) this.els.userInput.value += final;
      if (interim) {
        this.els.userInput.placeholder = interim;
      } else {
        this.els.userInput.placeholder = 'Ask anything...';
      }
      this.autoResize();
    };

    this.recognition.onend = () => {
      this.els.voiceBtn.classList.remove('listening');
      this.els.userInput.placeholder = 'Ask anything...';
    };

    this.recognition.onerror = (e) => {
      this.els.voiceBtn.classList.remove('listening');
      if (e.error === 'not-allowed') this.showToast('Microphone access denied', 'error');
    };

    this.els.voiceBtn.addEventListener('click', () => {
      if (this.els.voiceBtn.classList.contains('listening')) {
        this.recognition.stop();
      } else {
        this.recognition.start();
        this.els.voiceBtn.classList.add('listening');
      }
    });

    // Space to talk (when input not focused)
    let spaceDown = false;
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && document.activeElement !== this.els.userInput && !spaceDown) {
        spaceDown = true;
        e.preventDefault();
        this.recognition?.start();
        this.els.voiceBtn.classList.add('listening');
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && spaceDown) {
        spaceDown = false;
        this.recognition?.stop();
        if (this.els.userInput.value.trim()) setTimeout(() => this.sendMessage(), 100);
      }
    });
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
