class SNNChat {
  constructor() {
    this.sidebar = null;
    this.isVisible = false;
    this.selectedText = '';
    this.preservedSelection = '';
    this.pageContent = '';
    this.chatHistory = [];
    this.isLoading = false;
    this.currentDomain = window.location.hostname;
    this.historyKey = `snn_chat_history_${this.currentDomain}`;
    this.allHistoryKeys = [];
    
    this.init();
  }

  async init() {
    await this.injectSidebar();
    this.setupEventListeners();
    this.setupSelectionMonitoring();
    this.setupPageNavigationDetection();
    this.extractPageContent();
    await this.loadChatHistory();
    await this.applySettings();
  }
  
  setupPageNavigationDetection() {
    // Detect page changes for SPAs and navigation
    let lastUrl = window.location.href;
    let lastTitle = document.title;
    
    const checkForChanges = () => {
      const currentUrl = window.location.href;
      const currentTitle = document.title;
      
      if (currentUrl !== lastUrl || currentTitle !== lastTitle) {
        lastUrl = currentUrl;
        lastTitle = currentTitle;
        
        // Page has changed, update context
        this.extractPageContent();
        
        // Add a subtle notification in chat if sidebar is visible
        if (this.isVisible && this.currentPageTitle) {
          this.addPageChangeNotification();
        }
      }
    };
    
    // Check for changes periodically
    setInterval(checkForChanges, 2000);
    
    // Also listen for common navigation events
    window.addEventListener('popstate', () => {
      setTimeout(checkForChanges, 100);
    });
    
    // Listen for pushstate/replacestate (for SPAs)
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    
    history.pushState = function(...args) {
      originalPushState.apply(history, args);
      setTimeout(checkForChanges, 100);
    };
    
    history.replaceState = function(...args) {
      originalReplaceState.apply(history, args);
      setTimeout(checkForChanges, 100);
    };
  }
  
  addPageChangeNotification() {
    if (!this.chatMessages) return;
    
    const notificationDiv = document.createElement('div');
    notificationDiv.className = 'page-change-notification';
    
    const truncatedTitle = this.currentPageTitle.length > 60 ? 
      this.currentPageTitle.substring(0, 60) + '...' : 
      this.currentPageTitle;
    
    notificationDiv.innerHTML = `
      <span class="nav-icon">🧭</span> 
      <span class="nav-text">Now on: ${truncatedTitle}</span>
    `;
    
    this.chatMessages.appendChild(notificationDiv);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    
    // Auto-remove after 3 seconds
    setTimeout(() => {
      if (notificationDiv.parentNode) {
        notificationDiv.parentNode.removeChild(notificationDiv);
      }
    }, 3000);
  }

  async injectSidebar() {
    if (document.getElementById('ai-sidebar')) return;

    try {
      const sidebarHTML = await fetch(chrome.runtime.getURL('sidebar/sidebar.html'));
      const htmlContent = await sidebarHTML.text();
      
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = htmlContent;
      
      this.sidebar = tempDiv.firstElementChild;
      document.body.appendChild(this.sidebar);
      
      this.chatMessages = this.sidebar.querySelector('#chat-messages');
      this.userInput = this.sidebar.querySelector('#user-input');
      this.sendBtn = this.sidebar.querySelector('#send-btn');
      this.selectionPreview = this.sidebar.querySelector('#selection-preview');
      this.previewText = this.sidebar.querySelector('#preview-text');
      this.clearSelectionBtn = this.sidebar.querySelector('#clear-selection');
      this.modelIndicator = this.sidebar.querySelector('#model-indicator');
      this.currentModelSpan = this.sidebar.querySelector('#current-model');
      this.modelSettingsBtn = this.sidebar.querySelector('#model-settings-btn');
      this.pageContextIndicator = this.sidebar.querySelector('#page-context-indicator');
      
      // Overlay elements
      this.historyOverlay = this.sidebar.querySelector('#history-overlay');
      this.settingsOverlay = this.sidebar.querySelector('#settings-overlay');
      this.historyList = this.sidebar.querySelector('#history-list');
      
    } catch (error) {
      console.error('Failed to inject sidebar:', error);
    }
  }

  setupEventListeners() {
    if (!this.sidebar) return;

    const closeBtn = this.sidebar.querySelector('#close-sidebar');
    const clearBtn = this.sidebar.querySelector('#clear-context');
    const settingsBtn = this.sidebar.querySelector('#settings-btn');
    const historyBtn = this.sidebar.querySelector('#history-btn');

    closeBtn?.addEventListener('click', () => this.hideSidebar());
    clearBtn?.addEventListener('click', () => this.clearChat());
    settingsBtn?.addEventListener('click', () => this.openSettingsOverlay());
    historyBtn?.addEventListener('click', () => this.openHistoryOverlay());
    this.clearSelectionBtn?.addEventListener('click', () => this.clearSelection());
    this.modelSettingsBtn?.addEventListener('click', () => this.openSettingsOverlay());
    
    // Overlay event listeners
    this.setupOverlayEventListeners();
    
    this.sendBtn?.addEventListener('click', () => this.sendMessage());
    
    this.userInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
      // Shift+Enter allows new lines (default textarea behavior)
    });

    this.userInput?.addEventListener('input', () => {
      this.adjustTextareaHeight();
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'toggleSidebar') {
        this.toggleSidebar();
      } else if (message.action === 'settingsUpdated') {
        this.applySettings();
      }
    });
  }

  setupSelectionMonitoring() {
    let selectionTimeout;
    
    document.addEventListener('mouseup', (e) => {
      if (this.sidebar && this.sidebar.contains(e.target)) {
        return;
      }
      
      clearTimeout(selectionTimeout);
      selectionTimeout = setTimeout(() => {
        this.handleTextSelection();
      }, 100);
    });

    document.addEventListener('keyup', (e) => {
      if (this.sidebar && this.sidebar.contains(e.target)) {
        return;
      }
      
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || 
          e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        clearTimeout(selectionTimeout);
        selectionTimeout = setTimeout(() => {
          this.handleTextSelection();
        }, 100);
      }
    });
  }

  handleTextSelection() {
    const selection = window.getSelection();
    const text = selection.toString().trim();
    
    if (text && text.length > 0) {
      this.selectedText = text;
      this.preservedSelection = text;
      this.showSelectionPreview(text);
      this.hidePageContextIndicator();
    } else if (!this.preservedSelection) {
      this.selectedText = '';
      this.hideSelectionPreview();
      this.showPageContextIndicator();
    }
  }

  showSelectionPreview(text) {
    if (!this.selectionPreview || !this.previewText) return;
    
    const truncatedText = text.length > 200 ? text.substring(0, 200) + '...' : text;
    this.previewText.textContent = `Selected: "${truncatedText}"`;
    this.selectionPreview.classList.add('visible');
  }

  hideSelectionPreview() {
    if (!this.selectionPreview) return;
    this.selectionPreview.classList.remove('visible');
  }

  clearSelection() {
    this.selectedText = '';
    this.preservedSelection = '';
    this.hideSelectionPreview();
    this.showPageContextIndicator();
    
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }
  }
  
  showPageContextIndicator() {
    if (!this.pageContextIndicator) return;
    this.pageContextIndicator.classList.remove('hidden');
  }
  
  hidePageContextIndicator() {
    if (!this.pageContextIndicator) return;
    this.pageContextIndicator.classList.add('hidden');
  }

  extractPageContent() {
    const title = document.title;
    const url = window.location.href;
    
    const textElements = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, span, div');
    const textContent = Array.from(textElements)
      .map(el => el.textContent?.trim())
      .filter(text => text && text.length > 10)
      .join(' ')
      .substring(0, 3000);
    
    this.pageContent = `Page: ${title}\nURL: ${url}\nContent: ${textContent}`;
    this.currentPageTitle = title;
    this.currentPageUrl = url;
    
    // Update the page context indicator with the current page title
    this.updatePageContextIndicator();
  }
  
  updatePageContextIndicator() {
    if (!this.pageContextIndicator) return;
    
    const contextText = this.pageContextIndicator.querySelector('.context-text');
    if (contextText && this.currentPageTitle) {
      const truncatedTitle = this.currentPageTitle.length > 50 ? 
        this.currentPageTitle.substring(0, 50) + '...' : 
        this.currentPageTitle;
      contextText.textContent = `Reading: ${truncatedTitle}`;
    }
  }

  toggleSidebar() {
    if (this.isVisible) {
      this.hideSidebar();
    } else {
      this.showSidebar();
    }
  }

  showSidebar() {
    if (!this.sidebar) return;
    
    this.sidebar.classList.add('visible');
    this.isVisible = true;
    
    setTimeout(() => {
      this.userInput?.focus();
    }, 300);
  }

  hideSidebar() {
    if (!this.sidebar) return;
    
    this.sidebar.classList.remove('visible');
    this.isVisible = false;
  }

  adjustTextareaHeight() {
    if (!this.userInput) return;
    
    this.userInput.style.height = 'auto';
    const newHeight = Math.min(this.userInput.scrollHeight, 120);
    this.userInput.style.height = newHeight + 'px';
  }

  async sendMessage() {
    const message = this.userInput?.value.trim();
    if (!message || this.isLoading) return;

    this.isLoading = true;
    this.sendBtn.disabled = true;
    this.userInput.value = '';
    this.adjustTextareaHeight();

    // Add message with current page context
    const currentPageContext = {
      title: this.currentPageTitle,
      url: this.currentPageUrl
    };
    this.addMessageToChat('user', message, currentPageContext);
    this.addLoadingMessage();

    try {
      const context = this.preservedSelection || this.pageContent;
      const response = await this.callAPI(message, context);
      
      this.removeLoadingMessage();
      this.addMessageToChat('ai', response);
      
      // Store page context with user message in history
      this.chatHistory.push(
        { 
          role: 'user', 
          content: message,
          pageContext: currentPageContext
        },
        { role: 'assistant', content: response }
      );
      
      await this.saveChatHistory();
      
    } catch (error) {
      this.removeLoadingMessage();
      this.addMessageToChat('ai', 'Sorry, I encountered an error. Please check your API key in settings.');
      console.error('API Error:', error);
    }

    this.isLoading = false;
    this.sendBtn.disabled = false;
    this.userInput?.focus();
  }

  async callAPI(message, context) {
    const settings = await this.getSettings();
    const provider = settings.provider || 'openai';
    
    const apiKey = provider === 'openai' ? settings.openaiKey : settings.openrouterKey;
    if (!apiKey) {
      throw new Error(`${provider} API key not configured`);
    }

    const model = provider === 'openai' ? 
      (settings.openaiModel || 'gpt-4o-mini') : 
      (settings.openrouterModel || 'openai/gpt-4o-mini');

    // Build system prompt
    let systemPrompt = settings.systemPrompt || 'You are a helpful AI assistant.';
    if (context) {
      systemPrompt += ` The user is viewing a webpage. Here's the context:\n\n${context}`;
    }

    const messages = [
      {
        role: 'system',
        content: systemPrompt
      },
      ...this.chatHistory.slice(-8),
      { role: 'user', content: message }
    ];

    const apiUrl = provider === 'openai' ? 
      'https://api.openai.com/v1/chat/completions' : 
      'https://openrouter.ai/api/v1/chat/completions';

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };

    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = window.location.origin;
      headers['X-Title'] = 'AI Chat Sidebar';
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: settings.maxTokens || 2000,
        temperature: settings.temperature || 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || 'No response received';
  }

  async getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['settings'], (result) => {
        resolve(result.settings || {});
      });
    });
  }

  addMessageToChat(sender, content, pageContext = null) {
    if (!this.chatMessages) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;
    
    // Add page context indicator for user messages if page context exists
    if (sender === 'user' && (pageContext || this.currentPageTitle)) {
      const contextIndicator = document.createElement('div');
      contextIndicator.className = 'message-context';
      const pageTitle = pageContext?.title || this.currentPageTitle || 'Unknown Page';
      const pageUrl = pageContext?.url || this.currentPageUrl || '';
      
      // Extract domain from URL for cleaner display
      let domain = '';
      try {
        domain = new URL(pageUrl).hostname;
      } catch (e) {
        domain = pageUrl;
      }
      
      const truncatedTitle = pageTitle.length > 40 ? 
        pageTitle.substring(0, 40) + '...' : 
        pageTitle;
      
      contextIndicator.innerHTML = `<span class="context-icon">📄</span> ${truncatedTitle} <span class="context-domain">(${domain})</span>`;
      messageDiv.appendChild(contextIndicator);
    }
    
    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';
    
    if (sender === 'ai') {
      messageContent.innerHTML = this.parseMarkdown(content);
    } else {
      messageContent.textContent = content;
    }
    
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy message';
    copyBtn.addEventListener('click', () => this.copyToClipboard(content));
    
    messageDiv.appendChild(messageContent);
    messageDiv.appendChild(copyBtn);
    
    this.chatMessages.appendChild(messageDiv);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  parseMarkdown(text) {
    // First escape any HTML to prevent injection
    const escapeHtml = (unsafe) => {
      return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };
    
    // Escape HTML first
    let escapedText = escapeHtml(text);
    
    // Then apply markdown parsing
    return escapedText
      // Headers
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      // Bold
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.*?)__/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/_(.*?)_/g, '<em>$1</em>')
      // Code blocks (preserve content as-is)
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      // Inline code
      .replace(/`(.*?)`/g, '<code>$1</code>')
      // Line breaks
      .replace(/\n/g, '<br>');
  }

  copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      this.showToast('Copied to clipboard!');
    }).catch(err => {
      console.error('Failed to copy:', err);
      this.showToast('Failed to copy');
    });
  }

  showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('show');
    }, 100);
    
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        document.body.removeChild(toast);
      }, 300);
    }, 2000);
  }

  addLoadingMessage() {
    if (!this.chatMessages) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message loading';
    messageDiv.innerHTML = 'Thinking<span class="loading-dots"></span>';
    messageDiv.id = 'loading-message';
    
    this.chatMessages.appendChild(messageDiv);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  removeLoadingMessage() {
    const loadingMessage = document.getElementById('loading-message');
    if (loadingMessage) {
      loadingMessage.remove();
    }
  }

  async clearChat() {
    if (!this.chatMessages) return;
    
    // Save current chat as history before clearing if there are messages
    if (this.chatHistory.length > 0) {
      await this.saveChatHistory();
      this.showToast(`Chat saved to ${this.currentDomain} history`);
    }
    
    this.chatMessages.innerHTML = '';
    this.chatHistory = [];
    this.hideSelectionPreview();
    
    // Clear the current history but keep the saved one
    // This allows starting fresh while preserving the old conversation
  }

  async applySettings() {
    if (!this.sidebar) return;
    
    const settings = await this.getSettings();
    
    // Apply theme
    const theme = settings.theme || 'auto';
    this.sidebar.classList.remove('theme-light', 'theme-dark', 'theme-auto');
    this.sidebar.classList.add(`theme-${theme}`);
    
    // Apply font size
    const fontSize = settings.fontSize || 15;
    this.sidebar.style.setProperty('--chat-font-size', `${fontSize}px`);
    
    // Apply sidebar width
    const sidebarWidth = settings.sidebarWidth || 400;
    this.sidebar.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    
    // Update model indicator
    this.updateModelIndicator(settings);
  }
  
  updateModelIndicator(settings) {
    if (!this.currentModelSpan) return;
    
    const provider = settings.provider || 'openai';
    const model = provider === 'openai' ? 
      (settings.openaiModel || 'gpt-4o-mini') : 
      (settings.openrouterModel || 'openai/gpt-4o-mini');
    
    // Format model name for display
    let displayName = model;
    if (model.includes('/')) {
      displayName = model.split('/').pop(); // Get part after last slash
    }
    
    this.currentModelSpan.textContent = displayName;
  }

  async loadChatHistory() {
    try {
      const result = await chrome.storage.local.get([this.historyKey]);
      const history = result[this.historyKey];
      
      if (history && history.messages) {
        this.chatHistory = history.messages;
        this.restoreChatMessages();
      }
    } catch (error) {
      console.error('Failed to load chat history:', error);
    }
  }

  async saveChatHistory() {
    try {
      const historyData = {
        domain: this.currentDomain,
        lastUpdated: Date.now(),
        messages: this.chatHistory
      };
      
      await chrome.storage.local.set({
        [this.historyKey]: historyData
      });
    } catch (error) {
      console.error('Failed to save chat history:', error);
    }
  }

  restoreChatMessages() {
    if (!this.chatMessages) return;
    
    this.chatMessages.innerHTML = '';
    
    for (let i = 0; i < this.chatHistory.length; i += 2) {
      const userMessage = this.chatHistory[i];
      const aiMessage = this.chatHistory[i + 1];
      
      if (userMessage && userMessage.role === 'user') {
        // Restore user message with its original page context
        this.addMessageToChat('user', userMessage.content, userMessage.pageContext);
      }
      
      if (aiMessage && aiMessage.role === 'assistant') {
        this.addMessageToChat('ai', aiMessage.content);
      }
    }
  }


  setupOverlayEventListeners() {
    // History overlay events
    const closeHistoryBtn = this.sidebar.querySelector('#close-history-overlay');
    const clearAllHistoryBtn = this.sidebar.querySelector('#clear-all-history');
    
    closeHistoryBtn?.addEventListener('click', () => this.closeHistoryOverlay());
    clearAllHistoryBtn?.addEventListener('click', () => this.clearAllHistory());
    
    // Settings overlay events
    const closeSettingsBtn = this.sidebar.querySelector('#close-settings-overlay');
    const saveSettingsBtn = this.sidebar.querySelector('#save-settings');
    const temperatureSlider = this.sidebar.querySelector('#temperature');
    const fontSizeSlider = this.sidebar.querySelector('#font-size');
    const sidebarWidthSlider = this.sidebar.querySelector('#sidebar-width');
    const clearAllHistorySettingsBtn = this.sidebar.querySelector('#clear-all-history-settings');
    const providerRadios = this.sidebar.querySelectorAll('input[name="provider"]');
    const openaiKeyInput = this.sidebar.querySelector('#openai-key');
    const openrouterKeyInput = this.sidebar.querySelector('#openrouter-key');
    const testOpenaiBtn = this.sidebar.querySelector('#test-openai');
    const testOpenrouterBtn = this.sidebar.querySelector('#test-openrouter');
    
    closeSettingsBtn?.addEventListener('click', () => this.closeSettingsOverlay());
    saveSettingsBtn?.addEventListener('click', () => this.saveSettings());
    clearAllHistorySettingsBtn?.addEventListener('click', () => this.clearAllHistory());
    
    // Provider radio button changes
    providerRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        this.updateProviderVisibility();
      });
    });
    
    // API key changes trigger model loading with debounce
    let openaiTimeout, openrouterTimeout;
    
    openaiKeyInput?.addEventListener('input', () => {
      clearTimeout(openaiTimeout);
      const apiKey = openaiKeyInput.value.trim();
      if (apiKey && apiKey.length > 10) { // Only try if key looks reasonable
        openaiTimeout = setTimeout(() => {
          this.loadModels('openai').catch(() => {}); // Silent fail
        }, 1500); // 1.5 second debounce for less aggressive requests
      } else {
        this.clearModelSelect('openai');
      }
    });
    
    openrouterKeyInput?.addEventListener('input', () => {
      clearTimeout(openrouterTimeout);
      const apiKey = openrouterKeyInput.value.trim();
      if (apiKey && apiKey.length > 10) { // Only try if key looks reasonable
        openrouterTimeout = setTimeout(() => {
          this.loadModels('openrouter').catch(() => {}); // Silent fail
        }, 1500); // 1.5 second debounce for less aggressive requests
      } else {
        this.clearModelSelect('openrouter');
      }
    });
    
    // Test connection buttons
    testOpenaiBtn?.addEventListener('click', () => this.testConnection('openai'));
    testOpenrouterBtn?.addEventListener('click', () => this.testConnection('openrouter'));
    
    // Update value displays for sliders
    temperatureSlider?.addEventListener('input', (e) => {
      const valueSpan = this.sidebar.querySelector('#temperature-value');
      if (valueSpan) valueSpan.textContent = e.target.value;
    });
    
    fontSizeSlider?.addEventListener('input', (e) => {
      const valueSpan = this.sidebar.querySelector('#font-size-value');
      if (valueSpan) valueSpan.textContent = e.target.value + 'px';
    });
    
    sidebarWidthSlider?.addEventListener('input', (e) => {
      const valueSpan = this.sidebar.querySelector('#sidebar-width-value');
      if (valueSpan) valueSpan.textContent = e.target.value + 'px';
    });
    
    // Close overlays when clicking outside
    this.historyOverlay?.addEventListener('click', (e) => {
      if (e.target === this.historyOverlay) {
        this.closeHistoryOverlay();
      }
    });
    
    this.settingsOverlay?.addEventListener('click', (e) => {
      if (e.target === this.settingsOverlay) {
        this.closeSettingsOverlay();
      }
    });
    
    // Keyboard shortcuts for overlays
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.settingsOverlay?.classList.contains('visible')) {
          this.closeSettingsOverlay();
        } else if (this.historyOverlay?.classList.contains('visible')) {
          this.closeHistoryOverlay();
        }
      }
      
      // Ctrl+S to save settings quickly
      if (e.ctrlKey && e.key === 's' && this.settingsOverlay?.classList.contains('visible')) {
        e.preventDefault();
        this.saveSettings();
      }
    });
  }
  
  async openHistoryOverlay() {
    if (!this.historyOverlay) return;
    
    // Open overlay immediately for instant response
    this.historyOverlay.classList.add('visible');
    
    // Show loading state
    if (this.historyList) {
      this.historyList.innerHTML = '<div class="loading-history">Loading chat histories...</div>';
    }
    
    // Load histories in background
    setTimeout(async () => {
      await this.loadAllChatHistories();
      this.populateHistoryList();
    }, 50);
  }
  
  closeHistoryOverlay() {
    if (!this.historyOverlay) return;
    this.historyOverlay.classList.remove('visible');
  }
  
  async openSettingsOverlay() {
    if (!this.settingsOverlay) return;
    
    // Open overlay immediately for instant response
    this.settingsOverlay.classList.add('visible');
    
    // Load settings in background without blocking UI
    setTimeout(async () => {
      await this.loadSettingsToForm();
    }, 50);
  }
  
  closeSettingsOverlay() {
    if (!this.settingsOverlay) return;
    this.settingsOverlay.classList.remove('visible');
  }
  
  async loadAllChatHistories() {
    try {
      const result = await chrome.storage.local.get(null);
      this.allHistoryKeys = [];
      
      for (const key in result) {
        if (key.startsWith('snn_chat_history_') && result[key].messages && result[key].messages.length > 0) {
          this.allHistoryKeys.push({
            key: key,
            domain: result[key].domain || key.replace('snn_chat_history_', ''),
            lastUpdated: result[key].lastUpdated || 0,
            messageCount: result[key].messages.length,
            data: result[key]
          });
        }
      }
      
      // Sort by last updated (newest first)
      this.allHistoryKeys.sort((a, b) => b.lastUpdated - a.lastUpdated);
    } catch (error) {
      console.error('Failed to load chat histories:', error);
    }
  }
  
  populateHistoryList() {
    if (!this.historyList) return;
    
    this.historyList.innerHTML = '';
    
    if (this.allHistoryKeys.length === 0) {
      this.historyList.innerHTML = '<div class="empty-state">No chat history found<br><small>Start chatting to see your conversation history here</small></div>';
      return;
    }
    
    // Add search functionality
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search histories...';
    searchInput.className = 'history-search';
    searchInput.addEventListener('input', (e) => this.filterHistories(e.target.value));
    this.historyList.appendChild(searchInput);
    
    // Create scrollable container
    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'history-scroll-container';
    
    this.allHistoryKeys.forEach(historyItem => {
      const item = document.createElement('div');
      item.className = 'history-item';
      if (historyItem.key === this.historyKey) {
        item.classList.add('current');
      }
      
      const domain = document.createElement('div');
      domain.className = 'history-domain';
      domain.textContent = historyItem.domain;
      
      const stats = document.createElement('div');
      stats.className = 'history-stats';
      const messageCount = Math.floor(historyItem.messageCount / 2); // Divide by 2 since we store user + AI pairs
      stats.innerHTML = `<span class="message-count">${messageCount} conversations</span> • <span class="last-updated">${this.formatDate(historyItem.lastUpdated)}</span>`;
      
      // Add preview of last message and page context info
      if (historyItem.data.messages && historyItem.data.messages.length > 0) {
        const lastMessage = historyItem.data.messages[historyItem.data.messages.length - 2]; // Get user message, not AI response
        if (lastMessage && lastMessage.role === 'user') {
          const preview = document.createElement('div');
          preview.className = 'history-preview';
          const truncatedContent = lastMessage.content.length > 80 ? 
            lastMessage.content.substring(0, 80) + '...' : 
            lastMessage.content;
          preview.textContent = `"${truncatedContent}"`;
          item.appendChild(preview);
          
          // Add page context info if available
          if (lastMessage.pageContext && lastMessage.pageContext.title) {
            const pageInfo = document.createElement('div');
            pageInfo.className = 'history-page-info';
            const truncatedTitle = lastMessage.pageContext.title.length > 50 ? 
              lastMessage.pageContext.title.substring(0, 50) + '...' : 
              lastMessage.pageContext.title;
            pageInfo.innerHTML = `<span class="page-icon">📄</span> Last on: ${truncatedTitle}`;
            item.appendChild(pageInfo);
          }
        }
        
        // Show all unique pages visited in this chat
        const uniquePages = new Set();
        historyItem.data.messages
          .filter(msg => msg.role === 'user' && msg.pageContext && msg.pageContext.title)
          .forEach(msg => {
            uniquePages.add(msg.pageContext.title);
          });
        
        if (uniquePages.size > 1) {
          const pagesInfo = document.createElement('div');
          pagesInfo.className = 'history-pages-count';
          pagesInfo.textContent = `📚 ${uniquePages.size} different pages`;
          item.appendChild(pagesInfo);
        }
      }
      
      item.appendChild(domain);
      item.appendChild(stats);
      
      // Add delete button for individual history
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'history-delete-btn';
      deleteBtn.textContent = '×';
      deleteBtn.title = 'Delete this history';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteIndividualHistory(historyItem.key, historyItem.domain);
      });
      item.appendChild(deleteBtn);
      
      item.addEventListener('click', () => {
        this.switchToHistory(historyItem.key, historyItem.domain);
      });
      
      scrollContainer.appendChild(item);
    });
    
    this.historyList.appendChild(scrollContainer);
  }
  
  filterHistories(searchTerm) {
    const items = this.historyList.querySelectorAll('.history-item');
    items.forEach(item => {
      const domain = item.querySelector('.history-domain').textContent.toLowerCase();
      const preview = item.querySelector('.history-preview')?.textContent.toLowerCase() || '';
      const matches = domain.includes(searchTerm.toLowerCase()) || preview.includes(searchTerm.toLowerCase());
      item.style.display = matches ? 'block' : 'none';
    });
  }
  
  async deleteIndividualHistory(historyKey, domain) {
    if (!confirm(`Delete chat history for ${domain}?`)) {
      return;
    }
    
    try {
      await chrome.storage.local.remove([historyKey]);
      
      // If we're currently viewing this history, clear it
      if (this.historyKey === historyKey) {
        this.chatHistory = [];
        this.chatMessages.innerHTML = '';
      }
      
      // Refresh the history list
      await this.loadAllChatHistories();
      this.populateHistoryList();
      
      this.showToast(`Deleted ${domain} chat history`);
    } catch (error) {
      console.error('Failed to delete history:', error);
      this.showToast('Failed to delete history');
    }
  }
  
  formatDate(timestamp) {
    if (!timestamp) return 'Unknown';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }
  
  async switchToHistory(historyKey, domain) {
    try {
      // Save current chat history
      await this.saveChatHistory();
      
      // Switch to new history
      this.currentDomain = domain;
      this.historyKey = historyKey;
      
      // Load new history
      await this.loadChatHistory();
      
      // Update page content for new domain (if available)
      this.extractPageContent();
      
      this.closeHistoryOverlay();
      this.showToast(`Switched to ${domain} chat history`);
    } catch (error) {
      console.error('Failed to switch history:', error);
      this.showToast('Failed to switch history');
    }
  }
  
  async clearAllHistory() {
    if (!confirm('Are you sure you want to clear all chat history? This cannot be undone.')) {
      return;
    }
    
    try {
      const keysToRemove = this.allHistoryKeys.map(item => item.key);
      await chrome.storage.local.remove(keysToRemove);
      
      this.allHistoryKeys = [];
      this.chatHistory = [];
      this.chatMessages.innerHTML = '';
      
      this.populateHistoryList();
      this.showToast('All chat history cleared');
    } catch (error) {
      console.error('Failed to clear all history:', error);
      this.showToast('Failed to clear history');
    }
  }
  
  async loadSettingsToForm() {
    const settings = await this.getSettings();
    
    // Load form values
    const provider = settings.provider || 'openai';
    const openaiKey = this.sidebar.querySelector('#openai-key');
    const openrouterKey = this.sidebar.querySelector('#openrouter-key');
    const maxTokens = this.sidebar.querySelector('#max-tokens');
    const temperature = this.sidebar.querySelector('#temperature');
    const temperatureValue = this.sidebar.querySelector('#temperature-value');
    const systemPrompt = this.sidebar.querySelector('#system-prompt');
    const themeSelect = this.sidebar.querySelector('#theme-select');
    const fontSize = this.sidebar.querySelector('#font-size');
    const fontSizeValue = this.sidebar.querySelector('#font-size-value');
    const sidebarWidth = this.sidebar.querySelector('#sidebar-width');
    const sidebarWidthValue = this.sidebar.querySelector('#sidebar-width-value');
    
    // Set radio button for provider
    const providerRadio = this.sidebar.querySelector(`input[name="provider"][value="${provider}"]`);
    if (providerRadio) {
      providerRadio.checked = true;
      this.updateProviderVisibility();
    }
    
    if (openaiKey) openaiKey.value = settings.openaiKey || '';
    if (openrouterKey) openrouterKey.value = settings.openrouterKey || '';
    if (maxTokens) maxTokens.value = settings.maxTokens || 2000;
    if (temperature) {
      temperature.value = settings.temperature || 0.7;
      if (temperatureValue) temperatureValue.textContent = settings.temperature || 0.7;
    }
    if (systemPrompt) systemPrompt.value = settings.systemPrompt || '';
    if (themeSelect) themeSelect.value = settings.theme || 'auto';
    if (fontSize) {
      fontSize.value = settings.fontSize || 15;
      if (fontSizeValue) fontSizeValue.textContent = (settings.fontSize || 15) + 'px';
    }
    if (sidebarWidth) {
      sidebarWidth.value = settings.sidebarWidth || 400;
      if (sidebarWidthValue) sidebarWidthValue.textContent = (settings.sidebarWidth || 400) + 'px';
    }
    
    // Store saved model selections
    this.savedOpenaiModel = settings.openaiModel;
    this.savedOpenrouterModel = settings.openrouterModel;
    
    // Load models if API keys are present
    await this.loadInitialModels();
  }
  
  async loadInitialModels() {
    const openaiKey = this.sidebar.querySelector('#openai-key')?.value.trim();
    const openrouterKey = this.sidebar.querySelector('#openrouter-key')?.value.trim();
    
    // Load models in parallel without blocking UI
    const promises = [];
    
    if (openaiKey) {
      promises.push(
        this.loadModels('openai').then(() => {
          if (this.savedOpenaiModel) {
            this.setSelectedModel('openai', this.savedOpenaiModel);
          }
        }).catch(err => console.log('OpenAI models load failed:', err))
      );
    }
    
    if (openrouterKey) {
      promises.push(
        this.loadModels('openrouter').then(() => {
          if (this.savedOpenrouterModel) {
            this.setSelectedModel('openrouter', this.savedOpenrouterModel);
          }
        }).catch(err => console.log('OpenRouter models load failed:', err))
      );
    }
    
    // Don't await - let models load in background
    if (promises.length > 0) {
      Promise.all(promises);
    }
  }
  
  async loadModels(provider) {
    const loadingEl = this.sidebar.querySelector(`#${provider}-loading`);
    const errorEl = this.sidebar.querySelector(`#${provider}-error`);
    const selectEl = this.sidebar.querySelector(`#${provider}-model`);
    
    if (!loadingEl || !errorEl || !selectEl) return;
    
    loadingEl.style.display = 'flex';
    errorEl.style.display = 'none';
    selectEl.innerHTML = '<option value="">Loading models...</option>';
    
    try {
      const apiKey = this.sidebar.querySelector(`#${provider}-key`)?.value.trim();
      if (!apiKey) {
        throw new Error('API key is required');
      }
      
      const models = await this.fetchModels(provider, apiKey);
      this.populateModelSelect(provider, models);
      
    } catch (error) {
      console.error(`Failed to load ${provider} models:`, error);
      errorEl.textContent = `Failed to load models: ${error.message}`;
      errorEl.style.display = 'block';
      selectEl.innerHTML = '<option value="">Failed to load models</option>';
    } finally {
      loadingEl.style.display = 'none';
    }
  }
  
  async fetchModels(provider, apiKey) {
    if (provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data.data
        .filter(model => model.id.includes('gpt'))
        .sort((a, b) => {
          const priority = { 'gpt-4o-mini': 0, 'gpt-4o': 1, 'gpt-4-turbo': 2, 'gpt-4': 3, 'gpt-3.5-turbo': 4 };
          return (priority[a.id] || 999) - (priority[b.id] || 999);
        });
    } else if (provider === 'openrouter') {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data.data
        .filter(model => !model.id.includes('free'))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  }
  
  populateModelSelect(provider, models) {
    const selectEl = this.sidebar.querySelector(`#${provider}-model`);
    if (!selectEl) return;
    
    selectEl.innerHTML = '';
    
    if (models.length === 0) {
      selectEl.innerHTML = '<option value="">No models available</option>';
      return;
    }
    
    // Add a default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Select a model...';
    selectEl.appendChild(defaultOption);
    
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = provider === 'openai' ? model.id : `${model.name} (${model.id})`;
      
      // Set default selection
      if (provider === 'openai' && model.id === 'gpt-4o-mini') {
        option.selected = true;
      } else if (provider === 'openrouter' && model.id === 'openai/gpt-4o-mini') {
        option.selected = true;
      }
      
      selectEl.appendChild(option);
    });
    
    // If there was a previously saved model, select it
    const savedModel = provider === 'openai' ? this.savedOpenaiModel : this.savedOpenrouterModel;
    if (savedModel) {
      this.setSelectedModel(provider, savedModel);
    }
  }
  
  setSelectedModel(provider, modelId) {
    const selectEl = this.sidebar.querySelector(`#${provider}-model`);
    if (!selectEl) return;
    
    const option = selectEl.querySelector(`option[value="${modelId}"]`);
    if (option) {
      option.selected = true;
    }
  }
  
  clearModelSelect(provider) {
    const selectEl = this.sidebar.querySelector(`#${provider}-model`);
    if (selectEl) {
      selectEl.innerHTML = '<option value="">Select a model...</option>';
    }
  }
  
  async testConnection(provider) {
    const testBtn = this.sidebar.querySelector(`#test-${provider}`);
    const statusEl = this.sidebar.querySelector(`#${provider}-status`);
    const apiKey = this.sidebar.querySelector(`#${provider}-key`)?.value.trim();
    
    if (!testBtn || !statusEl) return;
    
    if (!apiKey) {
      this.showConnectionStatus(provider, 'API key is required', 'error');
      return;
    }
    
    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    statusEl.style.display = 'none';
    
    try {
      await this.fetchModels(provider, apiKey);
      this.showConnectionStatus(provider, 'Connection successful!', 'success');
    } catch (error) {
      this.showConnectionStatus(provider, `Connection failed: ${error.message}`, 'error');
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test Connection';
    }
  }
  
  showConnectionStatus(provider, message, type) {
    const statusEl = this.sidebar.querySelector(`#${provider}-status`);
    if (!statusEl) return;
    
    statusEl.textContent = message;
    statusEl.className = `connection-status ${type}`;
    statusEl.style.display = 'block';
    
    setTimeout(() => {
      statusEl.style.display = 'none';
    }, 5000);
  }
  
  updateProviderVisibility() {
    const selectedProvider = this.sidebar.querySelector('input[name="provider"]:checked')?.value;
    const openaiSection = this.sidebar.querySelector('#openai-section');
    const openrouterSection = this.sidebar.querySelector('#openrouter-section');
    
    if (openaiSection && openrouterSection) {
      if (selectedProvider === 'openai') {
        openaiSection.classList.add('active');
        openrouterSection.classList.remove('active');
      } else if (selectedProvider === 'openrouter') {
        openaiSection.classList.remove('active');
        openrouterSection.classList.add('active');
      }
    }
  }
  
  async saveSettings() {
    try {
      const provider = this.sidebar.querySelector('input[name="provider"]:checked')?.value || 'openai';
      const openaiKey = this.sidebar.querySelector('#openai-key')?.value.trim() || '';
      const openrouterKey = this.sidebar.querySelector('#openrouter-key')?.value.trim() || '';
      
      // Validate API keys if selected provider
      if (provider === 'openai' && !openaiKey) {
        this.showToast('OpenAI API key is required');
        return;
      }
      
      if (provider === 'openrouter' && !openrouterKey) {
        this.showToast('OpenRouter API key is required');
        return;
      }
      
      // Validate API key format
      if (provider === 'openai' && openaiKey && !openaiKey.startsWith('sk-')) {
        this.showToast('Invalid OpenAI API key format. Should start with "sk-"');
        return;
      }
      
      if (provider === 'openrouter' && openrouterKey && !openrouterKey.startsWith('sk-or-')) {
        this.showToast('Invalid OpenRouter API key format. Should start with "sk-or-"');
        return;
      }
      
      const settings = {
        provider: provider,
        openaiKey: openaiKey,
        openrouterKey: openrouterKey,
        openaiModel: this.sidebar.querySelector('#openai-model')?.value || 'gpt-4o-mini',
        openrouterModel: this.sidebar.querySelector('#openrouter-model')?.value || 'openai/gpt-4o-mini',
        maxTokens: parseInt(this.sidebar.querySelector('#max-tokens')?.value) || 2000,
        temperature: parseFloat(this.sidebar.querySelector('#temperature')?.value) || 0.7,
        systemPrompt: this.sidebar.querySelector('#system-prompt')?.value.trim() || '',
        theme: this.sidebar.querySelector('#theme-select')?.value || 'auto',
        fontSize: parseInt(this.sidebar.querySelector('#font-size')?.value) || 15,
        sidebarWidth: parseInt(this.sidebar.querySelector('#sidebar-width')?.value) || 400
      };
      
      await chrome.storage.sync.set({ settings });
      await this.applySettings();
      
      this.closeSettingsOverlay();
      this.showToast('Settings saved successfully!');
      
      // Notify background script about settings update
      chrome.runtime.sendMessage({ action: 'settingsUpdated' });
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showToast('Failed to save settings');
    }
  }
  
  openSettings() {
    this.openSettingsOverlay();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SNNChat();
  });
} else {
  new SNNChat();
}