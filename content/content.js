// SNN Chat — Content Script (lightweight)
// Extracts page content & monitors text selection only.
// Sends everything to background service worker via chrome.runtime.sendMessage.
// The side panel UI is a separate chrome.sidePanel page — NO DOM injection.

// ── DEBUG LOGGING ──────────────────────────────────────────────────
var SNN_D = {
  enabled: false,
  module: 'Content',
  _ts: () => new Date().toISOString().slice(11, 23),
  _fmt(o) {
    if (o === undefined) return 'undefined';
    if (o === null) return 'null';
    if (typeof o === 'string') return o.length > 200 ? o.slice(0, 200) + '…(' + o.length + ')' : o;
    if (o instanceof Error) return `[${o.name}] ${o.message}`;
    try { return JSON.stringify(o).slice(0, 300); } catch(e) { return String(o).slice(0, 300); }
  },
  log(...args) { if (!this.enabled) return; console.log(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ff8a65;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  warn(...args) { if (!this.enabled) return; console.warn(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ffb74d;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  error(...args) { console.error(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ef5350;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
};
var D = SNN_D;

// ── Tags whose text is source code or markup, never readable page text ──
// textContent on a container returns the body of every <script> and <style>
// inside it. That was the single largest source of junk in the payload sent
// to the LLM: measured across 12 real pages, 46% of everything extracted was
// JavaScript, JSON props and CSS — 92% on sinanisler.com, 90% on GitHub,
// where React prop blobs also carry escaped HTML markup. <noscript> is worse
// still: with scripting on, its markup is exposed as literal text.
var SNN_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'IFRAME', 'CANVAS']);

/**
 * The readable text of an element — textContent minus the tags above.
 *
 * Walks text nodes instead of cloning: a clone of <main> on a large page
 * costs more than the extraction itself, and a detached clone also loses
 * getComputedStyle, which the callers rely on to skip hidden elements.
 *
 * Nodes are joined with a space rather than concatenated the way textContent
 * does, so adjacent blocks cannot fuse into "wordword". A descendant's text
 * is still a contiguous run of its ancestor's, which is what keeps the
 * substring de-dupe in extractBySelectors working.
 */
function snnTextOf(el) {
  if (!el) return '';
  const tag = el.tagName && el.tagName.toUpperCase();
  if (tag && SNN_SKIP_TAGS.has(tag)) return '';
  try {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement;
        if (p && SNN_SKIP_TAGS.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const parts = [];
    let node;
    while ((node = walker.nextNode())) parts.push(node.textContent);
    return parts.join(' ');
  } catch (e) {
    return el.textContent || '';
  }
}

// ── Safe API wrapper — survives extension reloads/updates ─────────
// chrome.runtime.sendMessage can throw SYNCHRONOUSLY when the
// extension context is invalidated (not just reject the promise),
// so .catch() alone is not enough. This wrapper guards both paths.
function safeSendMessage(msg) {
  if (!chrome?.runtime?.id) return;
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* context gone */ }
}
function safeAddListener(cb) {
  if (!chrome?.runtime?.id) return;
  try { chrome.runtime.onMessage.addListener(cb); } catch (e) { /* context gone */ }
}

class SNNContentExtractor {
  constructor() {
    if (!chrome?.runtime?.id) return;
    this.selectedText = '';
    this.currentDomain = window.location.hostname;
    this.init();
  }

  async init() {
    D.log('INIT', { url: window.location.href, hostname: window.location.hostname });
    this.extractAndSend();
    this.setupSelectionMonitoring();
    this.setupNavigationDetection();
    this.setupMessageListener();
  }

  // ── Message Listener ────────────────────────────────────────────
  setupMessageListener() {
    safeAddListener((message, sender, sendResponse) => {
      if (message.action === 'extractContent') {
        this.extractAndSend();
      }
      if (message.action === 'extractContentSync') {
        this.extractAndRespond(sendResponse);
        return true; // keep channel open for async sendResponse
      }
    });
  }

  // ── Sync Content Extraction (direct response for agent:readPage) ──
  async extractAndRespond(sendResponse) {
    const title = document.title;
    const url = window.location.href;
    const hostname = window.location.hostname.toLowerCase();
    let textContent = '';

    if (this._isPdfPage()) {
      sendResponse({ title, url, content: '(PDF page — text extraction not available synchronously)', wordCount: 0, domain: hostname });
      return;
    }

    const methods = [
      () => this.extractSiteSpecific(hostname),
      () => this.extractVisibleText(),
      () => this.extractGeneric(),
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

    sendResponse({ title, url, content, wordCount, domain: hostname });
  }

  // ── Page Content Extraction ──────────────────────────────────────
  async extractAndSend() {
    if (!chrome?.runtime?.id) return; // bail early if context invalidated
    const title = document.title;
    const url = window.location.href;
    const hostname = window.location.hostname.toLowerCase();
    let textContent = '';

    // ── PDF Detection ───────────────────────────────────────────
    // Chrome's PDF viewer embeds the PDF in an <embed> tag.
    // The DOM has NO text nodes for PDF content, so DOM scraping returns 0 words.
    // Instead, we send the PDF URL to background.js which uses an offscreen
    // document + PDF.js to extract the actual text.
    if (this._isPdfPage()) {
      D.log('PDF detected — delegating to background PDF.js extraction', { url: url.substring(0, 100) });
      
      // For file:// URLs, the service worker can't fetch them.
      // We need to fetch the PDF from the page context and pass the bytes.
      if (url.startsWith('file://')) {
        try {
          const response = await fetch(url);
          const arrayBuffer = await response.arrayBuffer();
          safeSendMessage({
            action: 'extractPdfText',
            url: url,
            title: title,
            pdfData: Array.from(new Uint8Array(arrayBuffer))
          });
        } catch (err) {
          D.error('Failed to fetch local PDF:', err.message);
          // Fallback: send URL anyway, background will try to fetch it
          safeSendMessage({
            action: 'extractPdfText',
            url: url,
            title: title
          });
        }
      } else {
        safeSendMessage({
          action: 'extractPdfText',
          url: url,
          title: title
        });
      }
      return; // Background will store context when extraction completes
    }

    // ── Normal HTML page extraction ────────────────────────────

    const methods = [
      ['siteSpecific', () => this.extractSiteSpecific(hostname)],
      ['visibleText',  () => this.extractVisibleText()],
      ['generic',      () => this.extractGeneric()],
      ['allText',      () => this.extractAllText()]
    ];

    let methodUsed = 'none';
    for (const [name, method] of methods) {
      try {
        textContent = await method();
        if (textContent.length > 200) { methodUsed = name; break; }
      } catch (e) { /* try next method */ }
    }

    if (textContent.length < 100) {
      textContent = this.extractBruteForce();
      methodUsed = 'bruteForce';
    }

    const wordCount = this.countWords(textContent);
    D.log('extractAndSend', { method: methodUsed, wordCount, contentLen: textContent.length, url: url.substring(0, 80) });
    const content = `=== WEBPAGE CONTENT ===\nTitle: ${title}\nURL: ${url}\n\n${textContent}\n=== END ===`;

    safeSendMessage({
      action: 'updatePageContext',
      title, url, content,
      domain: hostname,
      wordCount
    });
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
          let text = snnTextOf(el).trim().replace(/\s+/g, ' ');
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
        if (SNN_SKIP_TAGS.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
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
    clone.querySelectorAll('script, style, nav, header, footer, noscript, template, svg, iframe, canvas').forEach(e => e.remove());
    return this.truncate((clone.textContent || '').replace(/\s+/g, ' ').trim(), 15000);
  }

  extractBruteForce() {
    const els = document.querySelectorAll('p,div,span,li,td,th,h1,h2,h3,h4,h5,h6,a,blockquote,pre,code,section,article,main,aside');
    const texts = [];
    for (const el of els) {
      const t = snnTextOf(el).trim();
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

  // ── PDF Detection ────────────────────────────────────────────────
  /**
   * Detect if the current page is a PDF rendered by Chrome's built-in viewer.
   * Chrome PDF viewer URLs: file:///...pdf, https://...pdf, or chrome-extension://...pdf
   * with an <embed type="application/pdf"> element.
   */
  _isPdfPage() {
    // Check for PDF embed element (Chrome's built-in viewer)
    const embed = document.querySelector('embed[type="application/pdf"]');
    if (embed) return true;

    // Check URL ends with .pdf (including file:// URLs)
    if (/\.pdf(\?.*)?(#.*)?$/i.test(window.location.href)) return true;

    // Check document.contentType (may not be reliable for all cases)
    if (document.contentType === 'application/pdf') return true;

    return false;
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
          safeSendMessage({ action: 'updateSelection', text });
        } else {
          safeSendMessage({ action: 'clearSelection' });
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
      if (!chrome?.runtime?.id) return;
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
      if (!chrome?.runtime?.id) return;
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
    safeAddListener((message, sender, sendResponse) => {
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
      safeSendMessage({
        action: 'voice:transcript',
        final,
        interim
      });
    };

    this.recognition.onerror = (e) => {
      safeSendMessage({
        action: 'voice:error',
        error: e.error
      });
      this._cleanup();
    };

    this.recognition.onend = () => {
      safeSendMessage({ action: 'voice:ended', gen: this._voiceGen });
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

// ── Debug mode: read settings & listen for changes ──────────────
(async function _initDebugMode() {
  try {
    const { settings } = await chrome.storage.local.get(['settings']);
    SNN_D.enabled = settings?.debugLogging === true;
  } catch (e) { /* ignore */ }
})();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    SNN_D.enabled = changes.settings.newValue?.debugLogging === true;
  }
});
