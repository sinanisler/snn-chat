// SNN Chat — Content Script (lightweight)
// Extracts page content & monitors text selection only.
// Sends everything to background service worker via chrome.runtime.sendMessage.
// The side panel UI is a separate chrome.sidePanel page — NO DOM injection.

class SNNContentExtractor {
  constructor() {
    if (!chrome?.runtime?.id) return;
    this.selectedText = '';
    this.currentDomain = window.location.hostname;
    this.init();
  }

  async init() {
    this.extractAndSend();
    this.setupSelectionMonitoring();
    this.setupNavigationDetection();
    this.setupMessageListener();
  }

  // ── Message Listener ────────────────────────────────────────────
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'extractContent') {
        this.extractAndSend();
      }
    });
  }

  // ── Page Content Extraction ──────────────────────────────────────
  async extractAndSend() {
    const title = document.title;
    const url = window.location.href;
    const hostname = window.location.hostname.toLowerCase();
    let textContent = '';

    const methods = [
      () => this.extractSiteSpecific(hostname),
      () => this.extractGeneric(),
      () => this.extractVisibleText(),
      () => this.extractAllText()
    ];

    for (const method of methods) {
      try {
        textContent = await method();
        if (textContent.length > 200) break;
      } catch (e) { /* try next method */ }
    }

    if (textContent.length < 100) {
      textContent = this.extractBruteForce();
    }

    const wordCount = this.countWords(textContent);
    const content = `=== WEBPAGE CONTENT ===\nTitle: ${title}\nURL: ${url}\n\n${textContent}\n=== END ===`;

    chrome.runtime.sendMessage({
      action: 'updatePageContext',
      title, url, content,
      domain: hostname,
      wordCount
    }).catch(() => {});
  }

  // ── Site-Specific Extractors ─────────────────────────────────────
  extractSiteSpecific(hostname) {
    const selectorMap = {
      'linkedin.com': ['main span[dir="ltr"]', '.feed-shared-update-v2__description span', 'article span[dir="ltr"]'],
      'twitter.com': ['[data-testid="tweetText"] span', 'article [lang] span'],
      'x.com': ['[data-testid="tweetText"] span', 'article [lang] span'],
      'reddit.com': ['.Post p', '[data-test-id="post-content"] p', '.RichTextJSON-root p'],
      'github.com': ['.markdown-body p', '.repository-description', '.js-issue-title']
    };
    const key = Object.keys(selectorMap).find(k => hostname.includes(k));
    return key ? this.extractBySelectors(selectorMap[key]) : '';
  }

  extractGeneric() {
    return this.extractBySelectors([
      'main', 'article', '.content', '#content', '[role="main"]',
      'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      '.post-content', '.entry-content', '.article-content',
      '[class*="content"]', '[class*="text"]', '[class*="body"]'
    ]);
  }

  extractBySelectors(selectors) {
    let content = '';
    const processed = new Set();
    const limit = 15000;

    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (processed.has(el)) continue;
          processed.add(el);
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          let text = (el.textContent || '').trim().replace(/\s+/g, ' ');
          if (text.length > 20 && !content.includes(text.substring(0, 50))) {
            content += text + ' ';
            if (this.countWords(content) > limit) return this.truncate(content, limit);
          }
        }
      } catch (e) { /* skip */ }
    }
    return this.truncate(content, limit);
  }

  extractVisibleText() {
    const limit = 15000;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (['script','style','noscript','svg','path'].includes(p.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
        const s = window.getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return node.textContent.trim().length > 2 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const texts = [];
    let node;
    while ((node = walker.nextNode())) {
      texts.push(node.textContent.trim());
      if (this.countWords(texts.join(' ')) >= limit) break;
    }
    return this.truncate(texts.join(' '), limit);
  }

  extractAllText() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, nav, header, footer, noscript, svg, iframe').forEach(e => e.remove());
    return this.truncate((clone.textContent || '').replace(/\s+/g, ' ').trim(), 15000);
  }

  extractBruteForce() {
    const els = document.querySelectorAll('p,div,span,li,td,th,h1,h2,h3,h4,h5,h6,a,blockquote,pre,code,section,article,main,aside');
    const texts = [];
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (t.length > 15 && !t.match(/^[{}[\]()<>;:]+$/)) {
        texts.push(t);
        if (this.countWords(texts.join(' ')) > 15000) break;
      }
    }
    return this.truncate(texts.join(' '), 15000);
  }

  countWords(text) { return text ? text.trim().split(/\s+/).filter(w => w.length).length : 0; }
  truncate(text, limit) {
    const words = (text || '').trim().split(/\s+/);
    return words.length <= limit ? text : words.slice(0, limit).join(' ');
  }

  // ── Text Selection Monitoring ────────────────────────────────────
  setupSelectionMonitoring() {
    let timeout;
    const handle = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const text = window.getSelection().toString().trim();
        if (text) {
          this.selectedText = text;
          chrome.runtime.sendMessage({ action: 'updateSelection', text }).catch(() => {});
        } else {
          chrome.runtime.sendMessage({ action: 'clearSelection' }).catch(() => {});
        }
      }, 200);
    };
    document.addEventListener('mouseup', handle);
    document.addEventListener('keyup', (e) => {
      if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) handle();
    });
  }

  // ── Navigation Detection (SPA support) ──────────────────────────
  setupNavigationDetection() {
    let lastUrl = location.href, lastTitle = document.title;
    const check = () => {
      if (location.href !== lastUrl || document.title !== lastTitle) {
        lastUrl = location.href;
        lastTitle = document.title;
        this.extractAndSend();
      }
    };
    setInterval(check, 2000);
    window.addEventListener('popstate', () => setTimeout(check, 100));
    const origPush = history.pushState, origReplace = history.replaceState;
    history.pushState = function(...a) { origPush.apply(history, a); setTimeout(check, 100); };
    history.replaceState = function(...a) { origReplace.apply(history, a); setTimeout(check, 100); };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE && (n.textContent?.trim()?.length || 0) > 50) {
              clearTimeout(this._ct);
              this._ct = setTimeout(() => this.extractAndSend(), 2000);
              return;
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// Voice Relay — handles mic permission & speech recognition from
// the PAGE context so the permission prompt appears on the website
// (not a confusing redirect to chrome://settings).
// ═══════════════════════════════════════════════════════════════════

class SNNVoiceRelay {
  constructor() {
    this.recognition = null;
    this.micStream = null;
    this._setupListener();
  }

  _setupListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'voice:start') {
        this._start(message, sendResponse);
        return true; // keep channel open for async response
      }
      if (message.action === 'voice:stop') {
        this._stop();
        sendResponse({ success: true });
      }
    });
  }

  async _start(message, sendResponse) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      sendResponse({ success: false, error: 'unsupported' });
      return;
    }

    // ── Request mic permission from the PAGE origin ────────────
    // This shows the NORMAL browser permission prompt on the
    // website the user is viewing — no settings redirect!
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      sendResponse({
        success: false,
        error: err.name === 'NotAllowedError' ? 'denied' : 'no-mic'
      });
      return;
    }

    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = navigator.language || 'en-US';

    this._lastFinalIdx = -1;
    this._lastInterim = '';
    this._voiceGen = message.gen || 0;

    this.recognition.onresult = (e) => {
      let final = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          final += e.results[i][0].transcript + ' ';
          this._lastFinalIdx = i;
        } else {
          interim += e.results[i][0].transcript;
        }
      }
      // Dedup: skip if nothing changed since last event
      if (!final && interim === this._lastInterim) return;
      this._lastInterim = interim;
      chrome.runtime.sendMessage({
        action: 'voice:transcript',
        final,
        interim
      }).catch(() => {});
    };

    this.recognition.onerror = (e) => {
      chrome.runtime.sendMessage({
        action: 'voice:error',
        error: e.error
      }).catch(() => {});
      this._cleanup();
    };

    this.recognition.onend = () => {
      chrome.runtime.sendMessage({ action: 'voice:ended', gen: this._voiceGen }).catch(() => {});
      this._cleanup();
    };

    try {
      this.recognition.start();
      sendResponse({ success: true });
    } catch (err) {
      this._cleanup();
      sendResponse({ success: false, error: 'start-failed' });
    }
  }

  _stop() {
    if (this.recognition) {
      try { this.recognition.stop(); } catch (e) { /* ignore */ }
    }
    this._cleanup();
  }

  _cleanup() {
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }
    this.recognition = null;
  }
}

// ── Start ─────────────────────────────────────────────────────────
if (chrome?.runtime?.id) {
  new SNNContentExtractor();
  new SNNVoiceRelay();
}
