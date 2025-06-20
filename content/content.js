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
    
    this.init();
  }

  async init() {
    await this.injectSidebar();
    this.setupEventListeners();
    this.setupSelectionMonitoring();
    this.extractPageContent();
    await this.loadChatHistory();
    await this.applySettings();
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
      this.resizeHandle = this.sidebar.querySelector('#resize-handle');
      
    } catch (error) {
      console.error('Failed to inject sidebar:', error);
    }
  }

  setupEventListeners() {
    if (!this.sidebar) return;

    const closeBtn = this.sidebar.querySelector('#close-sidebar');
    const clearBtn = this.sidebar.querySelector('#clear-context');
    const settingsBtn = this.sidebar.querySelector('#settings-btn');

    closeBtn?.addEventListener('click', () => this.hideSidebar());
    clearBtn?.addEventListener('click', () => this.clearChat());
    settingsBtn?.addEventListener('click', () => this.openSettings());
    this.clearSelectionBtn?.addEventListener('click', () => this.clearSelection());
    
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

    this.setupResizeHandling();
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
    } else if (!this.preservedSelection) {
      this.selectedText = '';
      this.hideSelectionPreview();
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
    
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }
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

    this.addMessageToChat('user', message);
    this.addLoadingMessage();

    try {
      const context = this.preservedSelection || this.pageContent;
      const response = await this.callAPI(message, context);
      
      this.removeLoadingMessage();
      this.addMessageToChat('ai', response);
      
      this.chatHistory.push(
        { role: 'user', content: message },
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

    const messages = [
      {
        role: 'system',
        content: context ? 
          `You are a helpful AI assistant. The user is viewing a webpage. Here's the context:\n\n${context}` :
          'You are a helpful AI assistant.'
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

  addMessageToChat(sender, content) {
    if (!this.chatMessages) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;
    
    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';
    
    if (sender === 'ai') {
      messageContent.innerHTML = this.parseMarkdown(content);
    } else {
      messageContent.textContent = content;
    }
    
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.innerHTML = '📋';
    copyBtn.title = 'Copy message';
    copyBtn.addEventListener('click', () => this.copyToClipboard(content));
    
    messageDiv.appendChild(messageContent);
    messageDiv.appendChild(copyBtn);
    
    this.chatMessages.appendChild(messageDiv);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  parseMarkdown(text) {
    return text
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
      // Code blocks
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
    
    this.chatMessages.innerHTML = '';
    this.chatHistory = [];
    this.hideSelectionPreview();
    await this.saveChatHistory();
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
    this.sidebar.style.width = `${sidebarWidth}px`;
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
        this.addMessageToChat('user', userMessage.content);
      }
      
      if (aiMessage && aiMessage.role === 'assistant') {
        this.addMessageToChat('ai', aiMessage.content);
      }
    }
  }

  setupResizeHandling() {
    if (!this.resizeHandle) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    this.resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = parseInt(document.defaultView.getComputedStyle(this.sidebar).width, 10);
      
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      
      // Prevent text selection while dragging
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    const handleMouseMove = (e) => {
      if (!isResizing) return;
      
      const dx = startX - e.clientX;
      const newWidth = Math.max(300, Math.min(800, startWidth + dx));
      
      this.sidebar.style.width = `${newWidth}px`;
    };

    const handleMouseUp = () => {
      if (!isResizing) return;
      
      isResizing = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      
      // Save the new width to settings
      this.saveCurrentWidth();
    };
  }

  async saveCurrentWidth() {
    try {
      const currentWidth = parseInt(this.sidebar.style.width);
      if (currentWidth && currentWidth >= 300 && currentWidth <= 800) {
        const settings = await this.getSettings();
        settings.sidebarWidth = currentWidth;
        await chrome.storage.sync.set({ settings });
      }
    } catch (error) {
      console.error('Failed to save width:', error);
    }
  }

  openSettings() {
    chrome.runtime.sendMessage({ action: 'openOptionsPage' });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SNNChat();
  });
} else {
  new SNNChat();
}