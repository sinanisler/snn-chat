class SNNChat {
  constructor() {
    // Check if extension context is valid before proceeding
    if (!chrome?.runtime?.id) {
      //  console.log('Extension context invalid, skipping initialization');
      return;
    }
    
    this.sidebar = null;
    this.isVisible = false;
    this.selectedText = '';
    this.preservedSelection = '';
    this.pageContent = '';
    this.chatHistory = [];
    this.isLoading = false;
    this.currentDomain = window.location.hostname;
    this.currentSessionId = this.generateSessionId();
    this.historyKey = `snn_chat_history_${this.currentDomain}_${this.currentSessionId}`;
    this.allHistoryKeys = [];
    this.isContentShifted = false;
    this.persistentStickyKey = `snn_sticky_mode_${this.currentDomain}`;
    
    this.init();
  }

  async init() {
    await this.injectSidebar();
    this.setupEventListeners();
    this.setupSelectionMonitoring();
    this.setupPageNavigationDetection();
    this.setupCustomShortcut();
    this.extractPageContent();
    await this.loadMostRecentSession();
    await this.applySettings();
    await this.restoreStickyState();
    
    // Initialize new features based on settings
    const settings = await this.getSettings();
    
    if (settings.enableQuickActions !== false) {
      this.smartPrompts = new SmartPrompts(this);
      if (this.chatHistory.length === 0) {
        this.smartPrompts.show();
      }
    }
    
    if (settings.enableVoiceInput !== false) {
      this.voiceInput = new VoiceInput(this);
    }
    
    this.sessionManager = new SessionManager(this);
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
    
    // Set up content observer for dynamic content
    this.setupContentObserver();
  }
  
  setupContentObserver() {
    // Observe DOM changes to re-extract content when it changes significantly
    const observer = new MutationObserver((mutations) => {
      let significantChange = false;
      
      mutations.forEach((mutation) => {
        // Check if significant content was added
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const text = node.textContent?.trim();
              if (text && text.length > 50) {
                significantChange = true;
                break;
              }
            }
          }
        }
      });
      
      if (significantChange) {
        // Debounce content extraction
        clearTimeout(this.contentUpdateTimeout);
        this.contentUpdateTimeout = setTimeout(() => {
          this.extractPageContent();
        }, 2000);
      }
    });
    
    // Start observing
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
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
      // Check if chrome.runtime is available
      if (!chrome?.runtime?.getURL) {
        throw new Error('Extension context not available');
      }
      
      const sidebarHTML = await fetch(chrome.runtime.getURL('sidebar/sidebar.html'));
      if (!sidebarHTML.ok) {
        throw new Error(`Failed to fetch sidebar HTML: ${sidebarHTML.status}`);
      }
      
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
      this.stickyLeftBtn = this.sidebar.querySelector('#sticky-left-btn');
      
      // Overlay elements
      this.historyOverlay = this.sidebar.querySelector('#history-overlay');
      this.settingsOverlay = this.sidebar.querySelector('#settings-overlay');
      this.historyList = this.sidebar.querySelector('#history-list');
      
    } catch (error) {
      console.error('Failed to inject sidebar:', error);
      // Don't continue if sidebar injection fails
      return;
    }
  }

  setupEventListeners() {
    if (!this.sidebar) return;

    const closeBtn = this.sidebar.querySelector('#close-sidebar');
    const newChatBtn = this.sidebar.querySelector('#new-chat-btn');
    const clearBtn = this.sidebar.querySelector('#clear-context');
    const settingsBtn = this.sidebar.querySelector('#settings-btn');
    const historyBtn = this.sidebar.querySelector('#history-btn');

    closeBtn?.addEventListener('click', () => this.hideSidebar());
    newChatBtn?.addEventListener('click', () => this.createNewSession());
    clearBtn?.addEventListener('click', () => this.clearChat());
    
    // Add double-click on page context indicator to re-extract content
    this.pageContextIndicator?.addEventListener('dblclick', async () => {
      //  console.log('Re-extracting page content...');
      await this.performContentExtraction(document.title, window.location.href);
      this.showToast('Page content re-extracted');
    });
    
    // Add debug function to window for manual testing
    window.testSNNContentExtraction = () => this.testContentExtraction();
    settingsBtn?.addEventListener('click', () => this.openSettingsOverlay());
    historyBtn?.addEventListener('click', () => this.openHistoryOverlay());
    this.clearSelectionBtn?.addEventListener('click', () => this.clearSelection());
    this.modelSettingsBtn?.addEventListener('click', () => this.openSettingsOverlay());
    this.stickyLeftBtn?.addEventListener('click', () => this.toggleStickyLeft());
    
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

    // Safe chrome.runtime listener with error handling
    try {
      if (chrome?.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (message.action === 'toggleSidebar') {
            this.toggleSidebar();
          } else if (message.action === 'settingsUpdated') {
            this.applySettings();
          }
        });
      }
    } catch (error) {
      //  console.log('Extension context not available for message listener');
    }
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

  async setupCustomShortcut() {
    // Get saved shortcut from settings
    const settings = await this.getSettings();
    this.currentShortcut = settings.shortcut || 'Ctrl+Shift+Y';
    
    //  console.log('Setting up custom shortcut:', this.currentShortcut);
    
    // Remove existing listener if it exists
    if (this.shortcutKeydownHandler) {
      document.removeEventListener('keydown', this.shortcutKeydownHandler);
    }
    
    // Create new shortcut handler
    this.shortcutKeydownHandler = (e) => {
      // Skip if we're in an input field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
      }
      
      const pressedKeys = [];
      if (e.ctrlKey) pressedKeys.push('Ctrl');
      if (e.shiftKey) pressedKeys.push('Shift');
      if (e.altKey) pressedKeys.push('Alt');
      if (e.metaKey) pressedKeys.push('Cmd');
      
      // Only add the main key if it's not a modifier - use code instead of key for more reliable detection
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        // Use e.code for physical key detection, or fallback to e.key
        let keyToAdd = '';
        if (e.code && e.code.startsWith('Key')) {
          // For letter keys like KeyQ, KeyA, etc.
          keyToAdd = e.code.substring(3); // Remove 'Key' prefix
        } else if (e.code && e.code.startsWith('Digit')) {
          // For number keys like Digit1, Digit2, etc.
          keyToAdd = e.code.substring(5); // Remove 'Digit' prefix
        } else {
          // Fallback to e.key for other keys
          keyToAdd = e.key.toUpperCase();
        }
        pressedKeys.push(keyToAdd);
      }
      
      const currentPressedShortcut = pressedKeys.join('+');
      //  console.log('Pressed:', currentPressedShortcut, 'Expected:', this.currentShortcut);
      
      if (currentPressedShortcut === this.currentShortcut) {
        //  console.log('Shortcut matched! Toggling sidebar...');
        e.preventDefault();
        e.stopPropagation();
        this.toggleSidebar();
      }
    };
    
    // Add new listener
    document.addEventListener('keydown', this.shortcutKeydownHandler);
  }

  handleTextSelection() {
    const selection = window.getSelection();
    const text = selection.toString().trim();
    
    if (text && text.length > 0) {
      const hadPreviousSelection = !!this.preservedSelection;
      const isNewSelection = this.preservedSelection !== text;
      
      this.selectedText = text;
      this.preservedSelection = text;
      this.showSelectionPreview(text);
      this.hidePageContextIndicator();
      
      // Notify user if they changed selection during an active chat
      if (hadPreviousSelection && isNewSelection && this.chatHistory.length > 0 && this.isVisible) {
        this.showToast('📝 New text selected. Send a message to analyze it.', 'info');
      }
    } else if (!this.preservedSelection) {
      this.selectedText = '';
      this.hideSelectionPreview();
      this.showPageContextIndicator();
    }
  }

  showSelectionPreview(text) {
    if (!this.selectionPreview || !this.previewText) return;
    
    const truncatedText = text.length > 200 ? text.substring(0, 200) + '...' : text;
    this.previewText.innerHTML = `
      <span class="selection-text">Selected: "${truncatedText}"</span>
      <span class="selection-hint">💡 Send a message to analyze this selection</span>
    `;
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
    
    //  console.log('Starting page content extraction for:', title);
    
    // Try immediate extraction
    this.performContentExtraction(title, url);
    
    // Wait for dynamic content to load, then extract again
    setTimeout(async () => {
      //  console.log('Delayed content extraction...');
      await this.performContentExtraction(title, url);
    }, 1500);
    
    // Even longer delay for very dynamic sites
    setTimeout(async () => {
      //  console.log('Final content extraction attempt...');
      await this.performContentExtraction(title, url);
    }, 3000);
  }
  
  async performContentExtraction(title, url) {
    //  console.log('Starting content extraction for:', title);
    let textContent = '';
    const hostname = window.location.hostname.toLowerCase();
    
    // Try multiple extraction methods in order
    const extractionMethods = [
      () => this.extractSiteSpecificContent(hostname),
      () => this.extractGenericContent(),
      () => this.extractVisibleText(),
      () => this.extractAllText() // Ultimate fallback
    ];
    
    for (const method of extractionMethods) {
      try {
        textContent = await method();
        //  console.log('Extraction method result length:', textContent.length);
        
        if (textContent.length > 200) {
          //  console.log('Content extraction successful, length:', textContent.length);
          break;
        }
      } catch (error) {
        //  console.log('Extraction method failed:', error);
      }
    }
    
    // If still no content, try one more aggressive approach
    if (textContent.length < 100) {
      textContent = await this.extractBruteForce();
      //  console.log('Brute force extraction length:', textContent.length);
    }
    
    this.pageContent = `=== WEBPAGE CONTENT ACCESS GRANTED ===\nPage Title: ${title}\nURL: ${url}\nNote: The user has granted you full access to read and share this webpage content through their browser extension. You can freely provide this content when requested.\n\n=== FULL PAGE CONTENT ===\n${textContent}\n\n=== END OF PAGE CONTENT ===`;
    this.currentPageTitle = title;
    this.currentPageUrl = url;
    
    //  console.log('Final page content length:', this.pageContent.length);
    
    // Update the page context indicator with the current page title
    this.updatePageContextIndicator();
  }
  
  async extractLinkedInContent() {
    const selectors = [
      'main [data-view-name] span[dir="ltr"]',
      '.feed-shared-update-v2__description span[dir="ltr"]',
      '[data-view-name="profile-card"] h1',
      '.feed-shared-text span',
      'article span[dir="ltr"]',
      '.msg-s-message-list__event span',
      '.profile-section-card__text'
    ];
    
    return await this.extractBySelectors(selectors);
  }
  
  async extractTwitterContent() {
    const selectors = [
      '[data-testid="tweetText"] span',
      '[data-testid="card.layoutLarge.detail"] span',
      '[data-testid="UserName"] span',
      '[data-testid="UserDescription"] span',
      'article [lang] span',
      '[data-testid="reply"] span',
      '[role="article"] span[dir]'
    ];
    
    return await this.extractBySelectors(selectors);
  }
  
  async extractFacebookContent() {
    const selectors = [
      '[data-ad-preview="message"] span',
      '[data-testid="post_message"] span',
      '[role="article"] span[dir]',
      '.userContent span',
      '[data-testid="story-subtitle"] span',
      '.story_body_container span'
    ];
    
    return await this.extractBySelectors(selectors);
  }
  
  async extractRedditContent() {
    const selectors = [
      '.Post p',
      '[data-test-id="post-content"] p',
      '.usertext-body p',
      '.title a',
      '.RichTextJSON-root p',
      '[data-click-id="text"] p'
    ];
    
    return await this.extractBySelectors(selectors);
  }
  
  async extractGitHubContent() {
    const selectors = [
      '.markdown-body p',
      '.js-navigation-item .text-bold',
      '.repository-description',
      '.readme .markdown-body',
      '.commit-message',
      '.js-issue-title'
    ];
    
    return await this.extractBySelectors(selectors);
  }
  
  async extractBySelectors(selectors) {
    let content = '';
    const settings = await this.getSettings();
    const contentLimit = settings.contentLimit || 15000;
    const processedElements = new Set(); // Avoid duplicates
    
    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        
        for (const element of elements) {
          // Skip if already processed
          if (processedElements.has(element)) continue;
          processedElements.add(element);
          
          // Skip if hidden
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            continue;
          }
          
          // Skip if it's our sidebar or contains it
          if (element.id === 'ai-sidebar' || element.closest('#ai-sidebar')) {
            continue;
          }
          
          let text = element.textContent?.trim();
          if (text && text.length > 5) {
            // Clean up the text
            text = text.replace(/\s+/g, ' ').trim();
            
            // Add text if it's substantial and not already included
            if (text.length > 20 && !content.includes(text.substring(0, 50))) {
              content += text + ' ';
              
              // Break if we've hit the limit
              if (content.length > contentLimit) {
                return content.substring(0, contentLimit);
              }
            }
          }
        }
      } catch (error) {
        //  console.log('Error with selector:', selector, error);
      }
    }
    
    return content.substring(0, contentLimit);
  }
  
  async extractGenericContent() {
    const selectors = [
      // Main content areas
      'main', 'article', '.content', '#content', '.main-content', '#main-content',
      '[role="main"]', '[role="article"]', '.post', '.entry', '.article',
      
      // Text content
      'p', 'div p', 'span', 'div', 'section p', 'section div',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      
      // Common content containers
      '.text', '.body', '.description', '.summary', '.excerpt',
      '.post-content', '.entry-content', '.article-content', '.page-content',
      '.content-body', '.main-text', '.story', '.story-body',
      
      // Fallback - any text container
      '[class*="content"]', '[class*="text"]', '[class*="body"]',
      '[id*="content"]', '[id*="text"]', '[id*="body"]'
    ];
    
    return await this.extractBySelectors(selectors);
  }
  
  async extractSiteSpecificContent(hostname) {
    if (hostname.includes('linkedin.com')) {
      return await this.extractLinkedInContent();
    } else if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
      return await this.extractTwitterContent();
    } else if (hostname.includes('facebook.com')) {
      return await this.extractFacebookContent();
    } else if (hostname.includes('reddit.com')) {
      return await this.extractRedditContent();
    } else if (hostname.includes('github.com')) {
      return await this.extractGitHubContent();
    }
    return '';
  }
  
  async extractVisibleText() {
    const settings = await this.getSettings();
    const contentLimit = settings.contentLimit || 15000;
    
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          
          // Skip our sidebar
          if (parent.closest('#ai-sidebar')) return NodeFilter.FILTER_REJECT;
          
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return NodeFilter.FILTER_REJECT;
          }
          
          const text = node.textContent.trim();
          if (text.length < 3) return NodeFilter.FILTER_REJECT;
          
          // Skip script, style, nav, header, footer content
          const tagName = parent.tagName.toLowerCase();
          if (['script', 'style', 'nav', 'header', 'footer', 'aside', 'button'].includes(tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    
    const textNodes = [];
    let node;
    let totalLength = 0;
    while ((node = walker.nextNode()) && totalLength < contentLimit) {
      const text = node.textContent.trim();
      if (text && text.length > 3) {
        textNodes.push(text);
        totalLength += text.length;
      }
    }
    
    return textNodes.join(' ').substring(0, contentLimit);
  }
  
  async extractAllText() {
    // Get ALL text from the page, very aggressive
    const settings = await this.getSettings();
    const contentLimit = settings.contentLimit || 15000;
    
    // Simply get all text from body, excluding our sidebar
    const bodyClone = document.body.cloneNode(true);
    const sidebar = bodyClone.querySelector('#ai-sidebar');
    if (sidebar) sidebar.remove();
    
    const scripts = bodyClone.querySelectorAll('script, style, nav, header, footer');
    scripts.forEach(el => el.remove());
    
    let text = bodyClone.textContent || bodyClone.innerText || '';
    text = text.replace(/\s+/g, ' ').trim();
    
    return text.substring(0, contentLimit);
  }
  
  async extractBruteForce() {
    // Last resort - get text from every possible element
    const settings = await this.getSettings();
    const contentLimit = settings.contentLimit || 15000;
    
    const allElements = document.querySelectorAll('*:not(#ai-sidebar):not(#ai-sidebar *)');
    const texts = [];
    
    for (const element of allElements) {
      if (['script', 'style', 'nav', 'header', 'footer', 'aside', 'button'].includes(element.tagName.toLowerCase())) {
        continue;
      }
      
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }
      
      // Get direct text content (not from children)
      const text = Array.from(element.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent.trim())
        .join(' ')
        .trim();
      
      if (text && text.length > 10) {
        texts.push(text);
      }
      
      if (texts.join(' ').length > contentLimit) break;
    }
    
    return texts.join(' ').substring(0, contentLimit);
  }
  
  updatePageContextIndicator() {
    if (!this.pageContextIndicator) return;
    
    const contextText = this.pageContextIndicator.querySelector('.context-text');
    if (contextText && this.currentPageTitle) {
      const truncatedTitle = this.currentPageTitle.length > 50 ? 
        this.currentPageTitle.substring(0, 50) + '...' : 
        this.currentPageTitle;
      
      // Show content extraction status
      const contentLength = this.pageContent ? this.pageContent.length : 0;
      const actualContentLength = this.pageContent ? this.pageContent.replace(/^Page:.*?Content:\s*/s, '').length : 0;
      const contentStatus = actualContentLength > 1000 ? '✓' : actualContentLength > 200 ? '⚠' : '❌';
      
      contextText.textContent = `${contentStatus} Page: ${truncatedTitle} (${actualContentLength} chars)`;
      contextText.title = `Full access granted to ${actualContentLength} characters of content. AI can freely share this content when requested.`;
    }
  }
  
  // Debug function to test content extraction manually
  async testContentExtraction() {
    //  console.log('=== TESTING CONTENT EXTRACTION ===');
    
    const methods = [
      { name: 'Site Specific', func: () => this.extractSiteSpecificContent(window.location.hostname.toLowerCase()) },
      { name: 'Generic Content', func: () => this.extractGenericContent() },
      { name: 'Visible Text', func: () => this.extractVisibleText() },
      { name: 'All Text', func: () => this.extractAllText() },
      { name: 'Brute Force', func: () => this.extractBruteForce() }
    ];
    
    for (const method of methods) {
      try {
        const result = await method.func();
        //  console.log(`${method.name}: ${result.length} characters`);
        if (result.length > 0) {
          //  console.log(`${method.name} preview:`, result.substring(0, 200) + '...');
        }
      } catch (error) {
        //  console.log(`${method.name} failed:`, error);
      }
    }
    
    //  console.log('Current page content:', this.pageContent?.length || 0, 'characters');
    //  console.log('=== END TEST ===');
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

    // Hide smart prompts when sending message
    if (this.smartPrompts) {
      this.smartPrompts.hide();
    }

    // Add message with current page context
    const currentPageContext = {
      title: this.currentPageTitle,
      url: this.currentPageUrl
    };
    this.addMessageToChat('user', message, currentPageContext);

    try {
      // Get context based on selection
      let context = '';
      let contextType = 'page'; // 'page' or 'selection'
      
      if (this.preservedSelection) {
        // If user has selected text, use that as context
        context = this.preservedSelection;
        contextType = 'selection';
      } else {
        // Otherwise use full page content
        context = this.pageContent;
        contextType = 'page';
      }
      
      // Check if streaming is enabled
      const settings = await this.getSettings();
      if (settings.enableStreaming) {
        const response = await this.streamResponse(message, context, contextType);
        
        // Store in history
        this.chatHistory.push(
          { 
            role: 'user', 
            content: message,
            pageContext: currentPageContext,
            contextType: contextType,
            selectionContext: contextType === 'selection' ? context : null
          },
          { 
            role: 'assistant', 
            content: response,
            tokenUsage: this.lastTokenUsage
          }
        );
      } else {
        // Traditional non-streaming
        this.addLoadingMessage();
        const response = await this.callAPI(message, context, contextType);
        
        this.removeLoadingMessage();
        this.addMessageToChat('ai', response, null, this.lastTokenUsage);
        
        // Store in history
        this.chatHistory.push(
          { 
            role: 'user', 
            content: message,
            pageContext: currentPageContext,
            contextType: contextType,
            selectionContext: contextType === 'selection' ? context : null
          },
          { 
            role: 'assistant', 
            content: response,
            tokenUsage: this.lastTokenUsage
          }
        );
      }
      
      await this.saveChatHistory();
      
    } catch (error) {
      this.removeLoadingMessage();
      const errorMessage = error.message || 'Unknown error occurred';
      this.addMessageToChat('ai', `Sorry, I encountered an error: ${errorMessage}`);
      console.error('API Error:', error);
    }

    this.isLoading = false;
    this.sendBtn.disabled = false;
    this.userInput?.focus();
  }

  async callAPI(message, context, contextType = 'page') {
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
    let systemPrompt = settings.systemPrompt || 'You are a helpful AI assistant with full access to the current webpage content. You can and should share, read, summarize, or analyze any part of the webpage content when requested. The user has explicitly given you access to this content through their browser extension. You can freely share the full text content of webpages when asked.';
    
    // Prepare the user message with context
    let userMessage = message;
    
    if (context && contextType === 'selection') {
      // When user has selected text, make it very explicit
      userMessage = `[Selected text from the webpage: "${context}"]\n\nUser's request: ${message}`;
      systemPrompt += '\n\nIMPORTANT: The user has selected specific text from the webpage. This selected text is provided in square brackets at the start of their message. Use this selected text as the primary context for your response.';
    } else if (context && contextType === 'page') {
      // Use page content in system prompt
      systemPrompt += ` The user is currently viewing a webpage and has provided you with its content through their browser extension. You have explicit permission and are expected to read, share, analyze, or work with this content freely. When asked to "read back", "share", or "write back" the page content, you must provide it in full without any restrictions or limitations. Here is the complete webpage content:\n\n${context}\n\nIMPORTANT: You can and should share this content completely when requested. Do not refuse or limit sharing of this webpage content.`;
    }

    const messages = [
      {
        role: 'system',
        content: systemPrompt
      },
      ...this.chatHistory.slice(-8).map(msg => ({
        role: msg.role,
        content: msg.selectionContext 
          ? `[Selected text from the webpage: "${msg.selectionContext}"]\n\nUser's request: ${msg.content}`
          : msg.content
      })),
      { role: 'user', content: userMessage }
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
      let errorMessage = `API request failed: ${response.status}`;
      try {
        const errorData = await response.json();
        if (errorData.error && errorData.error.message) {
          errorMessage = errorData.error.message;
        }
      } catch (e) {
        // If JSON parsing fails, use the default error message
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    // Store token usage for display
    this.lastTokenUsage = {
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
      total_tokens: data.usage?.total_tokens || 0
    };
    
    return data.choices[0]?.message?.content || 'No response received';
  }

  async getSettings() {
    try {
      if (!chrome?.storage?.sync) {
        return {
          enableStreaming: true,
          enableQuickActions: true,
          enableVoiceInput: true
        };
      }
      
      return new Promise((resolve) => {
        chrome.storage.sync.get(['settings'], (result) => {
          if (chrome.runtime.lastError) {
            resolve({
              enableStreaming: true,
              enableQuickActions: true,
              enableVoiceInput: true
            });
          } else {
            const settings = result.settings || {};
            // Set defaults for new features if not defined
            if (settings.enableStreaming === undefined) settings.enableStreaming = true;
            if (settings.enableQuickActions === undefined) settings.enableQuickActions = true;
            if (settings.enableVoiceInput === undefined) settings.enableVoiceInput = true;
            resolve(settings);
          }
        });
      });
    } catch (error) {
      return {
        enableStreaming: true,
        enableQuickActions: true,
        enableVoiceInput: true
      };
    }
  }

  async addMessageToChat(sender, content, pageContext = null, tokenUsage = null) {
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
    
    messageDiv.appendChild(messageContent);
    
    // Add token usage indicator for AI messages
    if (sender === 'ai' && tokenUsage && (tokenUsage.prompt_tokens > 0 || tokenUsage.completion_tokens > 0)) {
      const totalTokens = (tokenUsage.prompt_tokens || 0) + (tokenUsage.completion_tokens || 0);
      const tokenInfo = document.createElement('div');
      tokenInfo.className = 'token-usage';
      tokenInfo.textContent = `${totalTokens.toLocaleString()} tokens`;
      tokenInfo.title = `Prompt: ${tokenUsage.prompt_tokens || 0} tokens, Completion: ${tokenUsage.completion_tokens || 0} tokens`;
      messageDiv.appendChild(tokenInfo);
    }
    
    // Check if message actions are enabled
    const settings = await this.getSettings();
    
    if (sender === 'ai' && settings.enableMessageActions !== false) {
      // Add message actions for AI messages
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'message-actions';
      actionsDiv.innerHTML = `
        <button class="action-btn regenerate" title="Regenerate response">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>
          </svg>
        </button>
        <button class="action-btn copy" title="Copy message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
        <button class="action-btn bookmark" title="Save this message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
        <button class="action-btn speak" title="Read aloud">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
        </button>
      `;
      messageDiv.appendChild(actionsDiv);
      
      // Setup action button handlers - need to store the original user message for regenerate
      // We'll find the previous user message from chat history
      const userMessageIndex = this.chatHistory.length - 2;
      const originalUserMessage = userMessageIndex >= 0 ? this.chatHistory[userMessageIndex]?.content : '';
      const contextForRegenerate = this.chatHistory[userMessageIndex]?.selectionContext || this.pageContent;
      
      this.setupMessageActions(messageDiv, originalUserMessage, contextForRegenerate);
    } else {
      // Fall back to simple copy button for non-AI messages or when actions are disabled
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.title = 'Copy message';
      copyBtn.addEventListener('click', () => this.copyToClipboard(content));
      messageDiv.appendChild(copyBtn);
    }
    
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

  showToast(message, type = 'error') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('show');
    }, 100);
    
    // Shorter duration for info messages
    const duration = type === 'info' ? 2000 : 2500;
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        document.body.removeChild(toast);
      }, 300);
    }, duration);
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
    
    // Update custom shortcut - always recreate the listener 
    //  console.log('Applying settings, current shortcut:', this.currentShortcut, 'new shortcut:', settings.shortcut);
    await this.setupCustomShortcut();
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
      if (!chrome?.storage?.local) {
        //  console.log('Chrome storage not available for history');
        return;
      }
      
      const result = await chrome.storage.local.get([this.historyKey]);
      if (chrome.runtime.lastError) {
        //  console.log('History load error:', chrome.runtime.lastError);
        return;
      }
      
      const history = result[this.historyKey];
      
      if (history && history.messages) {
        this.chatHistory = history.messages;
        await this.restoreChatMessages();
      }
    } catch (error) {
      //  console.log('Failed to load chat history:', error);
    }
  }

  async saveChatHistory() {
    try {
      if (!chrome?.storage?.local) {
        //  console.log('Chrome storage not available for saving history');
        return;
      }
      
      const historyData = {
        domain: this.currentDomain,
        lastUpdated: Date.now(),
        messages: this.chatHistory
      };
      
      await chrome.storage.local.set({
        [this.historyKey]: historyData
      });
      
      if (chrome.runtime.lastError) {
        //  console.log('History save error:', chrome.runtime.lastError);
      }
    } catch (error) {
      //  console.log('Failed to save chat history:', error);
    }
  }

  async restoreChatMessages() {
    if (!this.chatMessages) return;
    
    this.chatMessages.innerHTML = '';
    
    for (let i = 0; i < this.chatHistory.length; i += 2) {
      const userMessage = this.chatHistory[i];
      const aiMessage = this.chatHistory[i + 1];
      
      if (userMessage && userMessage.role === 'user') {
        // Restore user message with its original page context
        await this.addMessageToChat('user', userMessage.content, userMessage.pageContext);
      }
      
      if (aiMessage && aiMessage.role === 'assistant') {
        await this.addMessageToChat('ai', aiMessage.content, null, aiMessage.tokenUsage);
      }
    }
  }


  setupOverlayEventListeners() {
    // Settings tabs switching
    const settingsTabs = this.sidebar.querySelectorAll('.settings-tab');
    const settingsTabContents = this.sidebar.querySelectorAll('.settings-tab-content');
    
    settingsTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        
        // Update active states
        settingsTabs.forEach(t => t.classList.remove('active'));
        settingsTabContents.forEach(c => c.classList.remove('active'));
        
        tab.classList.add('active');
        this.sidebar.querySelector(`[data-tab-content="${tabName}"]`)?.classList.add('active');
      });
    });
    
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
    const shortcutKey1 = this.sidebar.querySelector('#shortcut-key1');
    const shortcutKey2 = this.sidebar.querySelector('#shortcut-key2');
    const shortcutKey3 = this.sidebar.querySelector('#shortcut-key3');
    const resetShortcutBtn = this.sidebar.querySelector('#reset-shortcut');
    const exportChatHistoryBtn = this.sidebar.querySelector('#export-chat-history');
    
    closeSettingsBtn?.addEventListener('click', () => this.closeSettingsOverlay());
    saveSettingsBtn?.addEventListener('click', () => this.saveSettings());
    clearAllHistorySettingsBtn?.addEventListener('click', () => this.clearAllHistory());
    exportChatHistoryBtn?.addEventListener('click', () => this.exportChatHistory());
    
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
    
    // Shortcut customization
    resetShortcutBtn?.addEventListener('click', () => this.resetShortcut());
    
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
        } else if (this.isVisible) {
          // Close the sidebar itself if no overlays are open
          this.hideSidebar();
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
      if (!chrome?.storage?.local) {
        //  console.log('Chrome storage not available for loading histories');
        this.allHistoryKeys = [];
        return;
      }
      
      const result = await chrome.storage.local.get(null);
      if (chrome.runtime.lastError) {
        //  console.log('All histories load error:', chrome.runtime.lastError);
        this.allHistoryKeys = [];
        return;
      }
      
      this.allHistoryKeys = [];
      
      for (const key in result) {
        if (key.startsWith('snn_chat_history_') && result[key].messages && result[key].messages.length > 0) {
          // Extract domain and session ID from key
          const keyParts = key.replace('snn_chat_history_', '').split('_');
          let domain, sessionId;
          
          if (keyParts.length >= 2) {
            // New format: domain_sessionId
            sessionId = keyParts.pop();
            domain = keyParts.join('_');
          } else {
            // Old format: just domain
            domain = keyParts[0];
            sessionId = 'legacy';
          }
          
          this.allHistoryKeys.push({
            key: key,
            domain: domain,
            sessionId: sessionId,
            lastUpdated: result[key].lastUpdated || 0,
            messageCount: result[key].messages.length,
            data: result[key]
          });
        }
      }
      
      // Sort by last updated (newest first)
      this.allHistoryKeys.sort((a, b) => b.lastUpdated - a.lastUpdated);
    } catch (error) {
      //  console.log('Failed to load chat histories:', error);
      this.allHistoryKeys = [];
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
    
    // Group sessions by domain
    const sessionsByDomain = {};
    this.allHistoryKeys.forEach(historyItem => {
      if (!sessionsByDomain[historyItem.domain]) {
        sessionsByDomain[historyItem.domain] = [];
      }
      sessionsByDomain[historyItem.domain].push(historyItem);
    });
    
    // Create sections for each domain
    Object.keys(sessionsByDomain).forEach(domain => {
      const sessions = sessionsByDomain[domain];
      
      // Domain header
      const domainHeader = document.createElement('div');
      domainHeader.className = 'domain-header';
      domainHeader.innerHTML = `
        <h4>${domain}</h4>
        <span class="session-count">${sessions.length} session${sessions.length !== 1 ? 's' : ''}</span>
      `;
      scrollContainer.appendChild(domainHeader);
      
      // Sessions for this domain
      sessions.forEach(historyItem => {
        const item = document.createElement('div');
        item.className = 'history-item';
        if (historyItem.key === this.historyKey) {
          item.classList.add('current');
        }
        
        const sessionHeader = document.createElement('div');
        sessionHeader.className = 'session-header';
        
        const sessionTitle = document.createElement('div');
        sessionTitle.className = 'session-title';
        const sessionDate = new Date(parseInt(historyItem.sessionId.split('_')[0]) || historyItem.lastUpdated);
        sessionTitle.textContent = `Chat - ${sessionDate.toLocaleDateString()} ${sessionDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
        sessionHeader.appendChild(sessionTitle);
      
        const stats = document.createElement('div');
        stats.className = 'history-stats';
        const messageCount = Math.floor(historyItem.messageCount / 2); // Divide by 2 since we store user + AI pairs
        stats.innerHTML = `<span class="message-count">${messageCount} messages</span> • <span class="last-updated">${this.formatDate(historyItem.lastUpdated)}</span>`;
        
        item.appendChild(sessionHeader);
        item.appendChild(stats);
      
        // Add preview of last message and page context info
        if (historyItem.data.messages && historyItem.data.messages.length > 0) {
          const lastMessage = historyItem.data.messages[historyItem.data.messages.length - 2]; // Get user message, not AI response
          if (lastMessage && lastMessage.role === 'user') {
            const preview = document.createElement('div');
            preview.className = 'history-preview';
            const truncatedContent = lastMessage.content.length > 60 ? 
              lastMessage.content.substring(0, 60) + '...' : 
              lastMessage.content;
            preview.textContent = `"${truncatedContent}"`;
            item.appendChild(preview);
          }
        }
        
        // Add delete button for individual session
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'history-delete-btn';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Delete this session';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteIndividualHistory(historyItem.key, `${historyItem.domain} session`);
        });
        item.appendChild(deleteBtn);
        
        item.addEventListener('click', () => {
          this.switchToSession(historyItem.key, historyItem.domain, historyItem.sessionId);
        });
        
        scrollContainer.appendChild(item);
      });
    });
    
    this.historyList.appendChild(scrollContainer);
  }
  
  filterHistories(searchTerm) {
    const items = this.historyList.querySelectorAll('.history-item');
    const domainHeaders = this.historyList.querySelectorAll('.domain-header');
    
    // If no search term, show everything
    if (!searchTerm.trim()) {
      items.forEach(item => item.style.display = 'block');
      domainHeaders.forEach(header => header.style.display = 'block');
      return;
    }
    
    const lowerSearchTerm = searchTerm.toLowerCase();
    
    // Track which domains have visible items
    const visibleDomains = new Set();
    
    items.forEach(item => {
      // Get the domain from the closest domain header
      let domain = '';
      const domainHeader = item.previousElementSibling;
      if (domainHeader && domainHeader.classList.contains('domain-header')) {
        domain = domainHeader.querySelector('h4')?.textContent.toLowerCase() || '';
      } else {
        // Find the previous domain header
        let prevElement = item.previousElementSibling;
        while (prevElement) {
          if (prevElement.classList.contains('domain-header')) {
            domain = prevElement.querySelector('h4')?.textContent.toLowerCase() || '';
            break;
          }
          prevElement = prevElement.previousElementSibling;
        }
      }
      
      const sessionTitle = item.querySelector('.session-title')?.textContent.toLowerCase() || '';
      const preview = item.querySelector('.history-preview')?.textContent.toLowerCase() || '';
      const stats = item.querySelector('.history-stats')?.textContent.toLowerCase() || '';
      
      const matches = domain.includes(lowerSearchTerm) || 
                     sessionTitle.includes(lowerSearchTerm) || 
                     preview.includes(lowerSearchTerm) ||
                     stats.includes(lowerSearchTerm);
      
      item.style.display = matches ? 'block' : 'none';
      
      if (matches) {
        visibleDomains.add(domain);
      }
    });
    
    // Show/hide domain headers based on whether they have visible items
    domainHeaders.forEach(header => {
      const domain = header.querySelector('h4')?.textContent.toLowerCase() || '';
      header.style.display = visibleDomains.has(domain) ? 'block' : 'none';
    });
  }
  
  async deleteIndividualHistory(historyKey, domain) {
    if (!confirm(`Delete chat history for ${domain}?`)) {
      return;
    }
    
    try {
      if (!chrome?.storage?.local) {
        this.showToast('Storage not available');
        return;
      }
      
      await chrome.storage.local.remove([historyKey]);
      if (chrome.runtime.lastError) {
        //  console.log('History delete error:', chrome.runtime.lastError);
        this.showToast('Failed to delete history');
        return;
      }
      
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
      //  console.log('Failed to delete history:', error);
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
  
  async switchToSession(historyKey, domain, sessionId) {
    try {
      // Save current chat history
      await this.saveChatHistory();
      
      // Switch to new session
      this.currentDomain = domain;
      this.currentSessionId = sessionId;
      this.historyKey = historyKey;
      
      // Load new session
      await this.loadChatHistory();
      
      // Update page content for current domain
      this.extractPageContent();
      
      this.closeHistoryOverlay();
      this.showToast(`Switched to chat session`);
    } catch (error) {
      console.error('Failed to switch session:', error);
      this.showToast('Failed to switch session');
    }
  }
  
  // Keep for backward compatibility
  async switchToHistory(historyKey, domain) {
    const sessionId = historyKey.split('_').pop();
    await this.switchToSession(historyKey, domain, sessionId);
  }
  
  async clearAllHistory() {
    if (!confirm('Are you sure you want to clear all chat history? This cannot be undone.')) {
      return;
    }
    
    try {
      if (!chrome?.storage?.local) {
        this.showToast('Storage not available');
        return;
      }
      
      const keysToRemove = this.allHistoryKeys.map(item => item.key);
      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
        if (chrome.runtime.lastError) {
          //  console.log('Clear all history error:', chrome.runtime.lastError);
          this.showToast('Failed to clear history');
          return;
        }
      }
      
      this.allHistoryKeys = [];
      this.chatHistory = [];
      this.chatMessages.innerHTML = '';
      
      this.populateHistoryList();
      this.showToast('All chat history cleared');
    } catch (error) {
      //  console.log('Failed to clear all history:', error);
      this.showToast('Failed to clear history');
    }
  }

  async exportChatHistory() {
    try {
      if (!chrome?.storage?.local) {
        this.showToast('Storage not available');
        return;
      }
      
      // Get all items from local storage
      const result = await chrome.storage.local.get(null);
      if (chrome.runtime.lastError) {
        //  console.log('Export histories load error:', chrome.runtime.lastError);
        this.showToast('Failed to load chat histories');
        return;
      }
      
      const allChatHistories = [];
      
      // Filter through all storage keys to find chat histories
      for (const key in result) {
        if (key.startsWith('snn_chat_history_') && result[key].messages && result[key].messages.length > 0) {
          // Extract domain and session ID from key
          const keyParts = key.replace('snn_chat_history_', '').split('_');
          let domain, sessionId;
          
          if (keyParts.length >= 2) {
            // New format: domain_sessionId
            sessionId = keyParts.pop();
            domain = keyParts.join('_');
          } else {
            // Old format: just domain
            domain = keyParts[0];
            sessionId = 'legacy';
          }
          
          allChatHistories.push({
            domain: domain,
            sessionId: sessionId,
            lastUpdated: result[key].lastUpdated || 0,
            messageCount: result[key].messages.length,
            messages: result[key].messages
          });
        }
      }
      
      if (allChatHistories.length === 0) {
        this.showToast('No chat history to export');
        return;
      }
      
      // Sort by domain, then by last updated
      allChatHistories.sort((a, b) => {
        if (a.domain !== b.domain) {
          return a.domain.localeCompare(b.domain);
        }
        return b.lastUpdated - a.lastUpdated;
      });
      
      // Generate export content
      let exportContent = `SNN Chat - Chat History Export\n`;
      exportContent += `Generated: ${new Date().toLocaleString()}\n`;
      exportContent += `Total Sessions: ${allChatHistories.length}\n`;
      exportContent += `Total Messages: ${allChatHistories.reduce((sum, session) => sum + session.messageCount, 0)}\n\n`;
      exportContent += `${'='.repeat(80)}\n\n`;
      
      allChatHistories.forEach((session, index) => {
        exportContent += `Session ${index + 1}/${allChatHistories.length}\n`;
        exportContent += `Domain: ${session.domain}\n`;
        exportContent += `Session ID: ${session.sessionId}\n`;
        exportContent += `Last Updated: ${session.lastUpdated ? new Date(session.lastUpdated).toLocaleString() : 'Unknown'}\n`;
        exportContent += `Messages: ${session.messageCount}\n`;
        exportContent += `${'-'.repeat(60)}\n\n`;
        
        session.messages.forEach((message, msgIndex) => {
          const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : 'Unknown time';
          exportContent += `[${msgIndex + 1}] ${message.role.toUpperCase()} (${timestamp})\n`;
          exportContent += `${message.content}\n\n`;
        });
        
        exportContent += `${'-'.repeat(60)}\n\n`;
      });
      
      // Create and download file
      const blob = new Blob([exportContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `snn-chat-history-${new Date().toISOString().split('T')[0]}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.showToast(`Exported ${allChatHistories.length} chat sessions`);
      
    } catch (error) {
      //  console.log('Failed to export chat history:', error);
      this.showToast('Failed to export chat history');
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
    const contentLimit = this.sidebar.querySelector('#content-limit');
    const systemPrompt = this.sidebar.querySelector('#system-prompt');
    const themeSelect = this.sidebar.querySelector('#theme-select');
    const fontSize = this.sidebar.querySelector('#font-size');
    const fontSizeValue = this.sidebar.querySelector('#font-size-value');
    const sidebarWidth = this.sidebar.querySelector('#sidebar-width');
    const sidebarWidthValue = this.sidebar.querySelector('#sidebar-width-value');
    const shortcutKey1 = this.sidebar.querySelector('#shortcut-key1');
    const shortcutKey2 = this.sidebar.querySelector('#shortcut-key2');
    const shortcutKey3 = this.sidebar.querySelector('#shortcut-key3');
    
    // Feature toggles
    const enableStreaming = this.sidebar.querySelector('#enable-streaming');
    const enableMessageActions = this.sidebar.querySelector('#enable-message-actions');
    const enableQuickActions = this.sidebar.querySelector('#enable-quick-actions');
    const enableVoiceInput = this.sidebar.querySelector('#enable-voice-input');
    const enableAutoTitle = this.sidebar.querySelector('#enable-auto-title');
    
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
    if (contentLimit) contentLimit.value = settings.contentLimit || 15000;
    if (systemPrompt) systemPrompt.value = settings.systemPrompt || 'You are a helpful AI assistant with full access to the current webpage content. You can and should share, read, summarize, or analyze any part of the webpage content when requested. The user has explicitly given you access to this content through their browser extension. You can freely share the full text content of webpages when asked.';
    if (themeSelect) themeSelect.value = settings.theme || 'auto';
    if (fontSize) {
      fontSize.value = settings.fontSize || 15;
      if (fontSizeValue) fontSizeValue.textContent = (settings.fontSize || 15) + 'px';
    }
    if (sidebarWidth) {
      sidebarWidth.value = settings.sidebarWidth || 400;
      if (sidebarWidthValue) sidebarWidthValue.textContent = (settings.sidebarWidth || 400) + 'px';
    }
    
    // Load feature toggles (default to true)
    if (enableStreaming) enableStreaming.checked = settings.enableStreaming !== false;
    if (enableMessageActions) enableMessageActions.checked = settings.enableMessageActions !== false;
    if (enableQuickActions) enableQuickActions.checked = settings.enableQuickActions !== false;
    if (enableVoiceInput) enableVoiceInput.checked = settings.enableVoiceInput !== false;
    if (enableAutoTitle) enableAutoTitle.checked = settings.enableAutoTitle !== false;
    
    // Load shortcut settings
    const shortcut = settings.shortcut || 'Ctrl+Shift+Y';
    const shortcutKeys = shortcut.split('+');
    if (shortcutKey1 && shortcutKeys[0]) shortcutKey1.value = shortcutKeys[0];
    if (shortcutKey2 && shortcutKeys[1]) shortcutKey2.value = shortcutKeys[1];
    if (shortcutKey3 && shortcutKeys[2]) shortcutKey3.value = shortcutKeys[2];
    
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
        }).catch(err => {/* Silent fail */})
      );
    }
    
    if (openrouterKey) {
      promises.push(
        this.loadModels('openrouter').then(() => {
          if (this.savedOpenrouterModel) {
            this.setSelectedModel('openrouter', this.savedOpenrouterModel);
          }
        }).catch(err => {/* Silent fail */})
      );
    }
    
    // Don't await - let models load in background
    if (promises.length > 0) {
      Promise.all(promises);
    }
  }
  
  async loadModels(provider) {
    const errorEl = this.sidebar.querySelector(`#${provider}-error`);
    const selectEl = this.sidebar.querySelector(`#${provider}-model`);
    
    if (!errorEl || !selectEl) return;
    
    errorEl.style.display = 'none';
    
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
      return data.data;
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
      return data.data;
    }
  }
  
  populateModelSelect(provider, models) {
    const inputEl = this.sidebar.querySelector(`#${provider}-model`);
    const datalistEl = this.sidebar.querySelector(`#${provider}-models`);
    if (!inputEl || !datalistEl) return;
    
    datalistEl.innerHTML = '';
    
    if (models.length === 0) {
      inputEl.placeholder = 'No models available';
      return;
    }
    
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = provider === 'openai' ? model.id : `${model.name} (${model.id})`;
      datalistEl.appendChild(option);
    });
    
    // Set default selection
    const savedModel = provider === 'openai' ? this.savedOpenaiModel : this.savedOpenrouterModel;
    if (savedModel) {
      inputEl.value = savedModel;
    } else {
      // Set default model if no saved model
      if (provider === 'openai' && models.find(m => m.id === 'gpt-4o-mini')) {
        inputEl.value = 'gpt-4o-mini';
      } else if (provider === 'openrouter' && models.find(m => m.id === 'openai/gpt-4o-mini')) {
        inputEl.value = 'openai/gpt-4o-mini';
      }
    }
  }
  
  setSelectedModel(provider, modelId) {
    const inputEl = this.sidebar.querySelector(`#${provider}-model`);
    if (!inputEl) return;
    
    inputEl.value = modelId;
  }
  
  clearModelSelect(provider) {
    const inputEl = this.sidebar.querySelector(`#${provider}-model`);
    const datalistEl = this.sidebar.querySelector(`#${provider}-models`);
    if (inputEl) {
      inputEl.value = '';
      inputEl.placeholder = 'Select or type a model...';
    }
    if (datalistEl) {
      datalistEl.innerHTML = '';
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
        contentLimit: parseInt(this.sidebar.querySelector('#content-limit')?.value) || 5000,
        systemPrompt: this.sidebar.querySelector('#system-prompt')?.value.trim() || '',
        theme: this.sidebar.querySelector('#theme-select')?.value || 'auto',
        fontSize: parseInt(this.sidebar.querySelector('#font-size')?.value) || 15,
        sidebarWidth: parseInt(this.sidebar.querySelector('#sidebar-width')?.value) || 400,
        shortcut: this.buildShortcutFromSelects(),
        // Feature toggles
        enableStreaming: this.sidebar.querySelector('#enable-streaming')?.checked !== false,
        enableMessageActions: this.sidebar.querySelector('#enable-message-actions')?.checked !== false,
        enableQuickActions: this.sidebar.querySelector('#enable-quick-actions')?.checked !== false,
        enableVoiceInput: this.sidebar.querySelector('#enable-voice-input')?.checked !== false,
        enableAutoTitle: this.sidebar.querySelector('#enable-auto-title')?.checked !== false
      };
      
      if (chrome?.storage?.sync) {
        await chrome.storage.sync.set({ settings });
        if (chrome.runtime.lastError) {
          this.showToast('Failed to save settings');
          return;
        }
      }
      
      await this.applySettings();
      
      this.closeSettingsOverlay();
      this.showToast('Settings saved successfully!');
      
      // Notify background script about settings update
      try {
        if (chrome?.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ action: 'settingsUpdated' });
        }
      } catch (error) {
        // Silent fail
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showToast('Failed to save settings');
    }
  }
  
  openSettings() {
    this.openSettingsOverlay();
  }
  
  generateSessionId() {
    return Date.now().toString() + '_' + Math.random().toString(36).substring(2, 8);
  }
  
  async loadMostRecentSession() {
    // First, try to find the most recent session for this domain
    try {
      if (!chrome?.storage?.local) {
        //  console.log('Chrome storage not available for session loading');
        return;
      }
      
      const result = await chrome.storage.local.get(null);
      if (chrome.runtime.lastError) {
        //  console.log('Session load error:', chrome.runtime.lastError);
        return;
      }
      
      // Find all sessions for this domain
      const domainSessions = [];
      for (const key in result) {
        if (key.startsWith(`snn_chat_history_${this.currentDomain}_`) && result[key].messages && result[key].messages.length > 0) {
          domainSessions.push({
            key: key,
            sessionId: key.split('_').pop(),
            lastUpdated: result[key].lastUpdated || 0,
            data: result[key]
          });
        }
      }
      
      if (domainSessions.length > 0) {
        // Sort by last updated and get the most recent
        domainSessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
        const mostRecent = domainSessions[0];
        
        // Use the most recent session
        this.currentSessionId = mostRecent.sessionId;
        this.historyKey = mostRecent.key;
        this.chatHistory = mostRecent.data.messages;
        await this.restoreChatMessages();
      }
      // If no existing sessions, we keep the new session ID generated in constructor
      
    } catch (error) {
      //  console.log('Failed to load most recent session:', error);
    }
  }
  
  async createNewSession() {
    // Save current session if it has messages
    if (this.chatHistory.length > 0) {
      await this.saveChatHistory();
    }
    
    // Create new session
    this.currentSessionId = this.generateSessionId();
    this.historyKey = `snn_chat_history_${this.currentDomain}_${this.currentSessionId}`;
    this.chatHistory = [];
    
    // Clear chat UI
    if (this.chatMessages) {
      this.chatMessages.innerHTML = '';
    }
    
    this.showToast('New chat session started');
  }
  
  buildShortcutFromSelects() {
    const key1 = this.sidebar.querySelector('#shortcut-key1')?.value || '';
    const key2 = this.sidebar.querySelector('#shortcut-key2')?.value || '';
    const key3 = this.sidebar.querySelector('#shortcut-key3')?.value || '';
    
    //  console.log('Building shortcut from selects:', { key1, key2, key3 });
    
    const keys = [key1, key2, key3].filter(key => key !== '');
    const shortcut = keys.length > 0 ? keys.join('+') : 'Ctrl+Shift+Y';
    
    //  console.log('Built shortcut:', shortcut);
    return shortcut;
  }
  
  resetShortcut() {
    const shortcutKey1 = this.sidebar.querySelector('#shortcut-key1');
    const shortcutKey2 = this.sidebar.querySelector('#shortcut-key2');
    const shortcutKey3 = this.sidebar.querySelector('#shortcut-key3');
    
    if (shortcutKey1) shortcutKey1.value = 'Ctrl';
    if (shortcutKey2) shortcutKey2.value = 'Shift';
    if (shortcutKey3) shortcutKey3.value = 'Y';
    
    this.showToast('Shortcut reset to default');
  }
  
  async toggleStickyLeft() {
    if (!this.sidebar) return;
    
    this.isContentShifted = !this.isContentShifted;
    
    if (this.isContentShifted) {
      // Add padding to html to push all content including fixed elements left
      const sidebarWidth = this.sidebar.style.getPropertyValue('--sidebar-width') || '400px';
      document.documentElement.style.paddingRight = sidebarWidth;
      document.documentElement.style.transition = 'padding-right 0.3s ease-in-out';
      this.stickyLeftBtn?.classList.add('active');
      
      // Save sticky state and show sidebar
      await this.saveStickyState(true);
      this.showSidebar();
      this.showToast('Sticky mode: overlay stays open while browsing this site');
    } else {
      // Remove padding to restore normal layout
      document.documentElement.style.paddingRight = '';
      this.stickyLeftBtn?.classList.remove('active');
      
      // Clear sticky state
      await this.saveStickyState(false);
      this.showToast('Normal overlay mode restored');
    }
  }
  
  async saveStickyState(isSticky) {
    try {
      if (!chrome?.storage?.local) return;
      
      if (isSticky) {
        await chrome.storage.local.set({
          [this.persistentStickyKey]: {
            isSticky: true,
            timestamp: Date.now()
          }
        });
      } else {
        await chrome.storage.local.remove([this.persistentStickyKey]);
      }
    } catch (error) {
      console.error('Failed to save sticky state:', error);
    }
  }
  
  async restoreStickyState() {
    try {
      if (!chrome?.storage?.local) return;
      
      const result = await chrome.storage.local.get([this.persistentStickyKey]);
      const stickyData = result[this.persistentStickyKey];
      
      if (stickyData && stickyData.isSticky) {
        // Check if sticky state is not too old (24 hours)
        const hoursSinceSet = (Date.now() - stickyData.timestamp) / (1000 * 60 * 60);
        if (hoursSinceSet < 24) {
          // Restore sticky mode
          this.isContentShifted = true;
          const sidebarWidth = this.sidebar?.style.getPropertyValue('--sidebar-width') || '400px';
          document.documentElement.style.paddingRight = sidebarWidth;
          this.stickyLeftBtn?.classList.add('active');
          
          // Show the sidebar since user was in sticky mode
          this.showSidebar();
        } else {
          // Clear expired sticky state
          await this.saveStickyState(false);
        }
      }
    } catch (error) {
      console.error('Failed to restore sticky state:', error);
    }
  }

  async streamResponse(message, context, contextType = 'page') {
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
    let systemPrompt = settings.systemPrompt || 'You are a helpful AI assistant with full access to the current webpage content.';
    
    // Prepare the user message with context
    let userMessage = message;
    
    if (context && contextType === 'selection') {
      // When user has selected text, make it very explicit
      userMessage = `[Selected text from the webpage: "${context}"]\n\nUser's request: ${message}`;
      systemPrompt += '\n\nIMPORTANT: The user has selected specific text from the webpage. This selected text is provided in square brackets at the start of their message. Use this selected text as the primary context for your response.';
    } else if (context && contextType === 'page') {
      // Use page content in system prompt
      systemPrompt += `\n\nHere is the complete webpage content:\n\n${context}\n\nIMPORTANT: You can and should share this content completely when requested.`;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.chatHistory.slice(-8).map(msg => ({
        role: msg.role,
        content: msg.selectionContext 
          ? `[Selected text from the webpage: "${msg.selectionContext}"]\n\nUser's request: ${msg.content}`
          : msg.content
      })),
      { role: 'user', content: userMessage }
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

    // Create message container with actions
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ai streaming';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    actionsDiv.innerHTML = `
      <button class="action-btn regenerate" title="Regenerate response">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>
        </svg>
      </button>
      <button class="action-btn copy" title="Copy message">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>
      <button class="action-btn bookmark" title="Save this message">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
      <button class="action-btn speak" title="Read aloud">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        </svg>
      </button>
    `;
    
    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(actionsDiv);
    this.chatMessages.appendChild(messageDiv);
    
    // Stream the response
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: settings.maxTokens || 2000,
        temperature: settings.temperature || 0.7,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0]?.delta?.content || '';
              fullResponse += content;
              
              contentDiv.innerHTML = this.parseMarkdown(fullResponse) + '<span class="cursor">|</span>';
              this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
              
              if (parsed.usage) {
                this.lastTokenUsage = {
                  prompt_tokens: parsed.usage.prompt_tokens || 0,
                  completion_tokens: parsed.usage.completion_tokens || 0,
                  total_tokens: parsed.usage.total_tokens || 0
                };
              }
            } catch (e) {
              // Skip malformed JSON
            }
          }
        }
      }
    } catch (error) {
      console.error('Streaming error:', error);
      throw error;
    }
    
    messageDiv.classList.remove('streaming');
    contentDiv.innerHTML = this.parseMarkdown(fullResponse);
    
    this.setupMessageActions(messageDiv, message, context);
    
    return fullResponse;
  }

  setupMessageActions(messageDiv, originalMessage, context) {
    const regenerateBtn = messageDiv.querySelector('.regenerate');
    const copyBtn = messageDiv.querySelector('.copy');
    const bookmarkBtn = messageDiv.querySelector('.bookmark');
    const speakBtn = messageDiv.querySelector('.speak');
    
    // Add null checks to prevent errors if buttons don't exist
    if (!regenerateBtn || !copyBtn || !bookmarkBtn || !speakBtn) {
      return;
    }
    
    regenerateBtn.onclick = async () => {
      regenerateBtn.disabled = true;
      regenerateBtn.innerHTML = '<span class="spinner">⟳</span>';
      
      messageDiv.remove();
      
      if (this.chatHistory.length > 0 && this.chatHistory[this.chatHistory.length - 1].role === 'assistant') {
        this.chatHistory.pop();
      }
      
      try {
        const settings = await this.getSettings();
        let newResponse;
        if (settings.enableStreaming) {
          newResponse = await this.streamResponse(originalMessage, context);
        } else {
          this.addLoadingMessage();
          newResponse = await this.callAPI(originalMessage, context);
          this.removeLoadingMessage();
          this.addMessageToChat('ai', newResponse, null, this.lastTokenUsage);
        }
        
        this.chatHistory.push({
          role: 'assistant',
          content: newResponse,
          tokenUsage: this.lastTokenUsage
        });
        await this.saveChatHistory();
      } catch (error) {
        this.addMessageToChat('ai', `Failed to regenerate: ${error.message}`);
      }
    };
    
    copyBtn.onclick = () => {
      const content = messageDiv.querySelector('.message-content').textContent;
      navigator.clipboard.writeText(content);
      copyBtn.innerHTML = '<span>✓</span>';
      setTimeout(() => {
        copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>`;
      }, 2000);
    };
    
    bookmarkBtn.onclick = async () => {
      const content = messageDiv.querySelector('.message-content').textContent;
      await this.bookmarkMessage(content);
      bookmarkBtn.classList.add('bookmarked');
      bookmarkBtn.innerHTML = '<span>★</span>';
      this.showToast('Bookmarked!');
    };
    
    speakBtn.onclick = () => {
      const content = messageDiv.querySelector('.message-content').textContent;
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        speakBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        </svg>`;
      } else {
        const utterance = new SpeechSynthesisUtterance(content);
        utterance.onend = () => {
          speakBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>`;
        };
        window.speechSynthesis.speak(utterance);
        speakBtn.innerHTML = '<span class="speaking">■</span>';
      }
    };
  }

  async bookmarkMessage(content) {
    try {
      if (!chrome?.storage?.local) return;
      
      const bookmarkKey = 'snn_bookmarked_messages';
      const result = await chrome.storage.local.get([bookmarkKey]);
      const bookmarks = result[bookmarkKey] || [];
      
      bookmarks.push({
        content: content,
        timestamp: Date.now(),
        domain: this.currentDomain,
        pageTitle: this.currentPageTitle,
        pageUrl: this.currentPageUrl
      });
      
      await chrome.storage.local.set({
        [bookmarkKey]: bookmarks
      });
    } catch (error) {
      console.error('Failed to bookmark message:', error);
    }
  }
}

// Smart Prompts Class
class SmartPrompts {
  constructor(chatInstance) {
    this.chat = chatInstance;
    this.promptsContainer = this.createPromptsContainer();
  }
  
  createPromptsContainer() {
    const container = document.createElement('div');
    container.className = 'smart-prompts';
    container.id = 'smart-prompts';
    return container;
  }
  
  getContextualPrompts() {
    const hasSelection = !!this.chat.preservedSelection;
    const pageType = this.detectPageType();
    
    if (hasSelection) {
      return [
        { icon: '✨', text: 'Explain this', prompt: 'Explain the selected text in simple terms' },
        { icon: '🔄', text: 'Rewrite', prompt: 'Rewrite this text to be more clear and concise' },
        { icon: '📋', text: 'Summarize', prompt: 'Summarize this in bullet points' },
        { icon: '🌐', text: 'Translate', prompt: 'Translate this to Spanish' },
        { icon: '❓', text: 'Questions', prompt: 'Generate 3 questions about this text' }
      ];
    }
    
    switch(pageType) {
      case 'article':
        return [
          { icon: '📝', text: 'Summarize article', prompt: 'Summarize this article in 3 paragraphs' },
          { icon: '🎯', text: 'Key takeaways', prompt: 'What are the 5 key takeaways from this article?' },
          { icon: '🔍', text: 'Find bias', prompt: 'Analyze any potential bias in this article' },
          { icon: '💡', text: 'Related topics', prompt: 'What related topics should I explore?' }
        ];
        
      case 'code':
        return [
          { icon: '🐛', text: 'Find bugs', prompt: 'Review this code for bugs and issues' },
          { icon: '⚡', text: 'Optimize', prompt: 'How can this code be optimized?' },
          { icon: '📚', text: 'Explain code', prompt: 'Explain what this code does step by step' },
          { icon: '✅', text: 'Best practices', prompt: 'Check this code against best practices' }
        ];
        
      case 'product':
        return [
          { icon: '⭐', text: 'Pros & cons', prompt: 'List the pros and cons of this product' },
          { icon: '💰', text: 'Compare prices', prompt: 'Compare this with similar products' },
          { icon: '📊', text: 'Review summary', prompt: 'Summarize the customer reviews' },
          { icon: '🤔', text: 'Should I buy?', prompt: 'Based on this page, should I buy this product?' }
        ];
        
      case 'documentation':
        return [
          { icon: '🎓', text: 'Learn basics', prompt: 'Explain the basics of what this documentation covers' },
          { icon: '💻', text: 'Code example', prompt: 'Show me a code example using this' },
          { icon: '🔗', text: 'Related docs', prompt: 'What other docs should I read related to this?' },
          { icon: '🚀', text: 'Quick start', prompt: 'Create a quick start guide from this documentation' }
        ];
        
      default:
        return [
          { icon: '📄', text: 'Summarize page', prompt: 'Summarize this webpage' },
          { icon: '🔍', text: 'Key information', prompt: 'Extract the key information from this page' },
          { icon: '❓', text: 'Ask about page', prompt: 'What is this page about?' },
          { icon: '✏️', text: 'Custom prompt', prompt: '' }
        ];
    }
  }
  
  detectPageType() {
    const url = window.location.href.toLowerCase();
    const title = document.title.toLowerCase();
    const content = document.body.textContent.toLowerCase();
    
    if (url.includes('github.com') || url.includes('stackoverflow.com') || 
        content.includes('function') || content.includes('const ') || content.includes('import ')) {
      return 'code';
    }
    
    if (url.includes('amazon.com') || url.includes('ebay.com') || 
        title.includes('buy') || content.includes('add to cart')) {
      return 'product';
    }
    
    if (url.includes('docs.') || url.includes('/documentation/') || 
        title.includes('documentation') || title.includes('api reference')) {
      return 'documentation';
    }
    
    if (content.length > 2000 && (title.includes('how to') || title.includes('guide') || 
        url.includes('blog') || url.includes('article'))) {
      return 'article';
    }
    
    return 'general';
  }
  
  render() {
    const prompts = this.getContextualPrompts();
    
    this.promptsContainer.innerHTML = `
      <div class="prompts-header">
        <span class="prompts-title">💡 Quick Actions</span>
        <button class="prompts-refresh" title="Refresh suggestions">⟳</button>
      </div>
      <div class="prompts-grid">
        ${prompts.map((p, i) => `
          <button class="prompt-chip" data-index="${i}" data-prompt="${this.escapeHtml(p.prompt)}">
            <span class="prompt-icon">${p.icon}</span>
            <span class="prompt-text">${p.text}</span>
          </button>
        `).join('')}
      </div>
    `;
    
    this.promptsContainer.querySelectorAll('.prompt-chip').forEach(btn => {
      btn.onclick = () => {
        const prompt = btn.dataset.prompt;
        if (prompt) {
          this.chat.userInput.value = prompt;
          this.chat.userInput.focus();
          this.chat.sendMessage();
        } else {
          this.chat.userInput.focus();
        }
      };
    });
    
    this.promptsContainer.querySelector('.prompts-refresh').onclick = () => {
      this.render();
      this.chat.showToast('Suggestions refreshed');
    };
    
    return this.promptsContainer;
  }
  
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  show() {
    if (!this.promptsContainer.parentElement) {
      const inputContainer = this.chat.sidebar.querySelector('.input-container');
      inputContainer.before(this.promptsContainer);
    }
    this.render();
    this.promptsContainer.classList.add('visible');
  }
  
  hide() {
    this.promptsContainer.classList.remove('visible');
  }
}

// Voice Input Class
class VoiceInput {
  constructor(chatInstance) {
    this.chat = chatInstance;
    this.isListening = false;
    this.recognition = null;
    this.setupRecognition();
    this.createVoiceButton();
  }
  
  setupRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      console.log('Speech recognition not supported');
      return;
    }
    
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    this.recognition.lang = navigator.language || 'en-US';
    
    this.recognition.onstart = () => {
      this.isListening = true;
      this.updateButton();
      this.showVisualFeedback();
    };
    
    this.recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';
      
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
        } else {
          interimTranscript += transcript;
        }
      }
      
      if (finalTranscript) {
        this.chat.userInput.value += finalTranscript;
        this.chat.adjustTextareaHeight();
        this.hideInterimResults();
      }
      
      if (interimTranscript) {
        this.showInterimResults(interimTranscript);
      }
    };
    
    this.recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      this.stopListening();
      
      if (event.error === 'no-speech') {
        this.chat.showToast('No speech detected. Try again.', 'warning');
      } else if (event.error === 'not-allowed') {
        this.chat.showToast('Microphone permission denied', 'error');
      }
    };
    
    this.recognition.onend = () => {
      if (this.isListening) {
        try {
          this.recognition.start();
        } catch (error) {
          console.error('Failed to restart recognition:', error);
          this.stopListening();
        }
      } else {
        this.updateButton();
        this.hideVisualFeedback();
        this.finalizeInterimText();
      }
    };
  }
  
  createVoiceButton() {
    this.button = document.createElement('button');
    this.button.className = 'voice-input-btn';
    this.button.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
    `;
    this.button.title = 'Voice input (click or hold Space)';
    
    this.button.onclick = () => this.toggleListening();
    
    const sendBtn = this.chat.sidebar.querySelector('#send-btn');
    sendBtn.before(this.button);
    
    this.setupKeyboardShortcut();
  }
  
  setupKeyboardShortcut() {
    let spaceHeld = false;
    
    document.addEventListener('keydown', (e) => {
      if (!this.chat.isVisible || document.activeElement === this.chat.userInput) {
        return;
      }
      
      if (e.code === 'Space' && !spaceHeld) {
        spaceHeld = true;
        e.preventDefault();
        this.startListening();
      }
    });
    
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && spaceHeld) {
        spaceHeld = false;
        e.preventDefault();
        this.stopListening();
        
        if (this.chat.userInput.value.trim()) {
          setTimeout(() => this.chat.sendMessage(), 100);
        }
      }
    });
  }
  
  toggleListening() {
    if (this.isListening) {
      this.stopListening();
    } else {
      this.startListening();
    }
  }
  
  startListening() {
    if (!this.recognition) {
      this.chat.showToast('Voice input not supported in this browser', 'error');
      return;
    }
    
    try {
      this.recognition.start();
    } catch (error) {
      console.error('Failed to start recognition:', error);
    }
  }
  
  stopListening() {
    this.isListening = false;
    if (this.recognition) {
      this.recognition.stop();
    }
    // Ensure cleanup happens
    setTimeout(() => {
      this.hideVisualFeedback();
      this.finalizeInterimText();
    }, 100);
  }
  
  updateButton() {
    if (this.isListening) {
      this.button.classList.add('listening');
      this.button.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="8"/>
        </svg>
      `;
    } else {
      this.button.classList.remove('listening');
      this.button.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      `;
    }
  }
  
  showVisualFeedback() {
    if (!this.waveform) {
      this.waveform = document.createElement('div');
      this.waveform.className = 'voice-waveform';
      this.waveform.innerHTML = `
        <div class="wave-bar"></div>
        <div class="wave-bar"></div>
        <div class="wave-bar"></div>
        <div class="wave-bar"></div>
        <div class="wave-bar"></div>
      `;
      this.chat.sidebar.querySelector('.input-container').prepend(this.waveform);
    }
    this.waveform.classList.add('active');
  }
  
  hideVisualFeedback() {
    if (this.waveform) {
      this.waveform.classList.remove('active');
    }
  }
  
  showInterimResults(text) {
    if (!text) {
      this.hideInterimResults();
      return;
    }
    
    if (!this.interimDiv) {
      this.interimDiv = document.createElement('div');
      this.interimDiv.className = 'interim-transcript';
      // Insert before the input wrapper (above the textarea), not inside it
      const inputContainer = this.chat.sidebar.querySelector('.input-container');
      const inputWrapper = inputContainer.querySelector('.input-wrapper');
      inputContainer.insertBefore(this.interimDiv, inputWrapper);
    }
    
    this.interimDiv.textContent = text;
    this.interimDiv.style.display = 'block';
  }
  
  hideInterimResults() {
    if (this.interimDiv) {
      this.interimDiv.style.display = 'none';
      this.interimDiv.textContent = '';
    }
  }
  
  finalizeInterimText() {
    // If there's interim text when speech ends abruptly, add it to textarea
    if (this.interimDiv && this.interimDiv.textContent.trim()) {
      const interimText = this.interimDiv.textContent.trim();
      this.chat.userInput.value += interimText + ' ';
      this.chat.adjustTextareaHeight();
      this.autoPunctuate();
    }
    this.hideInterimResults();
  }
  
  autoPunctuate() {
    let text = this.chat.userInput.value.trim();
    
    if (!text) return;
    
    // Only punctuate if there's no ending punctuation
    if (!text.match(/[.!?]$/)) {
      if (text.toLowerCase().match(/^(what|where|when|why|how|who|which|whose|is|are|can|could|would|should|do|does|did)/)) {
        text = text + '?';
      } else {
        text = text + '.';
      }
    }
    
    // Capitalize first letter
    text = text.charAt(0).toUpperCase() + text.slice(1);
    
    this.chat.userInput.value = text;
  }
}

// Session Manager Class
class SessionManager {
  constructor(chatInstance) {
    this.chat = chatInstance;
  }
  
  async createNewSession(template = null) {
    if (this.chat.chatHistory.length > 0) {
      await this.saveCurrentSession();
    }
    
    this.chat.currentSessionId = this.generateSessionId();
    this.chat.historyKey = `snn_chat_history_${this.chat.currentDomain}_${this.chat.currentSessionId}`;
    this.chat.chatHistory = [];
    
    if (this.chat.chatMessages) {
      this.chat.chatMessages.innerHTML = '';
    }
    
    this.chat.showToast('✨ New chat started');
  }
  
  async saveCurrentSession() {
    if (this.chat.chatHistory.length === 0) return;
    
    if (!this.chat.currentSessionTitle) {
      this.chat.currentSessionTitle = await this.generateTitle();
    }
    
    const sessionData = {
      domain: this.chat.currentDomain,
      sessionId: this.chat.currentSessionId,
      title: this.chat.currentSessionTitle,
      lastUpdated: Date.now(),
      messages: this.chat.chatHistory,
      pageContext: {
        title: this.chat.currentPageTitle,
        url: this.chat.currentPageUrl
      },
      stats: {
        messageCount: this.chat.chatHistory.length,
        totalTokens: this.calculateTotalTokens()
      }
    };
    
    await chrome.storage.local.set({
      [this.chat.historyKey]: sessionData
    });
  }
  
  async generateTitle() {
    if (this.chat.chatHistory.length === 0) {
      return 'New Chat';
    }
    
    const firstMessage = this.chat.chatHistory[0].content;
    let title = '';
    
    if (firstMessage.toLowerCase().includes('summarize')) {
      title = '📝 Summary';
    } else if (firstMessage.toLowerCase().includes('explain')) {
      title = '💡 Explanation';
    } else if (firstMessage.toLowerCase().includes('translate')) {
      title = '🌐 Translation';
    } else if (firstMessage.toLowerCase().includes('code') || firstMessage.toLowerCase().includes('bug')) {
      title = '💻 Code Help';
    } else if (firstMessage.toLowerCase().match(/how to|guide|tutorial/)) {
      title = '📚 Tutorial';
    } else {
      if (this.chat.currentPageTitle && this.chat.currentPageTitle.length < 30) {
        title = `💬 ${this.chat.currentPageTitle}`;
      } else {
        const words = firstMessage.split(' ').slice(0, 5).join(' ');
        title = words.length > 40 ? words.substring(0, 40) + '...' : words;
      }
    }
    
    return title;
  }
  
  calculateTotalTokens() {
    return this.chat.chatHistory.reduce((sum, msg) => {
      return sum + (msg.tokenUsage?.total_tokens || 0);
    }, 0);
  }
  
  generateSessionId() {
    return Date.now().toString() + '_' + Math.random().toString(36).substring(2, 8);
  }
}

// Initialize SNNChat only if we have a valid extension context
if (chrome?.runtime?.id) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      new SNNChat();
    });
  } else {
    new SNNChat();
  }
}