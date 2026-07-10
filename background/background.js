// SNN Chat Background Service Worker
// Coordinates between content script (page context) and side panel (chat UI)
// Tracks active tab so the side panel can maintain per-tab chat sessions.
//
// v2.1 — Extended with agent action relay, tab management, screenshots,
// context menus, notifications, alarms, and download support.

// ── DEBUG LOGGING ──────────────────────────────────────────────────
var SNN_D = {
  enabled: true,
  module: 'BgSW',
  _ts: () => new Date().toISOString().slice(11, 23),
  _fmt(o) {
    if (o === undefined) return 'undefined';
    if (o === null) return 'null';
    if (typeof o === 'string') return o.length > 300 ? o.slice(0, 300) + '…(' + o.length + ')' : o;
    if (o instanceof Error) return `[${o.name}] ${o.message}`;
    try { return JSON.stringify(o).slice(0, 500); } catch(e) { return String(o).slice(0, 500); }
  },
  log(...args) { if (!this.enabled) return; console.log(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#64b5f6;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  warn(...args) { console.warn(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ffb74d;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  error(...args) { console.error(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ef5350;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
};
var D = SNN_D;

// ── Side Panel Behavior ───────────────────────────────────────────
// Open side panel when user clicks the extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Side panel setup:', error));

// Also toggle via keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-sidebar') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        console.warn('toggle-sidebar: no active tab available');
        return;
      }
      _openSidePanelForTab(tab);
    });
  }
});

// ── Tab Tracking ──────────────────────────────────────────────────
const CONTEXT_KEY = 'snn_page_context';
const SELECTION_KEY = 'snn_selection';
const TAB_SWITCH_PREFIX = 'snn_active_tab';
const ACTION_QUEUE_KEY = 'snn_action_queue'; // pending agent actions
const OFFSCREEN_DOC_PATH = 'offscreen/offscreen.html';

// ── Offscreen Document Management (for PDF.js text extraction) ────
let _creatingOffscreen = null; // Promise to avoid concurrent creation

async function _hasOffscreenDocument() {
  // Check all extension contexts for our offscreen document
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOC_PATH)]
  });
  return contexts.length > 0;
}

async function _setupOffscreenDocument() {
  // Already exists?
  if (await _hasOffscreenDocument()) return;

  // Already being created? Wait for it
  if (_creatingOffscreen) {
    await _creatingOffscreen;
    return;
  }

  // Create the offscreen document
  _creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOC_PATH,
    reasons: ['DOM_PARSER'],
    justification: 'Extract text from PDF files using PDF.js for AI chat context'
  });

  try {
    await _creatingOffscreen;
    console.log('[SNN] Offscreen document created for PDF extraction');
  } catch (err) {
    console.error('[SNN] Failed to create offscreen document:', err.message);
    throw err;
  } finally {
    _creatingOffscreen = null;
  }
}

/**
 * Extract text from a PDF using the offscreen document.
 * @param {string} pdfUrl - URL of the PDF file
 * @param {ArrayBuffer} [pdfData] - Pre-fetched PDF bytes (for local/restricted files)
 * @returns {Promise<string>} Extracted text
 */
async function _extractPdfText(pdfUrl, pdfData) {
  await _setupOffscreenDocument();

  // Send extraction request to offscreen document
  // Pass ArrayBuffer directly — Chrome's structured cloning supports it
  const message = pdfData
    ? { action: 'offscreen:extractPdfFromBuffer', arrayBuffer: pdfData }
    : { action: 'offscreen:extractPdf', url: pdfUrl };

  const response = await chrome.runtime.sendMessage(message);

  if (!response || !response.success) {
    throw new Error(response?.error || 'PDF extraction failed');
  }

  return response.text;
}

function tabSwitchKey(windowId) {
  return `${TAB_SWITCH_PREFIX}_${windowId}`;
}

async function notifyTabSwitch(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || !tab?.windowId) return;
    const domain = new URL(tab.url).hostname;
    const info = { tabId, windowId: tab.windowId, url: tab.url, domain, title: tab.title || '' };
    await chrome.storage.session.set({ [tabSwitchKey(tab.windowId)]: info });
    chrome.runtime.sendMessage({ action: 'tabSwitched', ...info }).catch(() => {});
  } catch (e) { /* tab may have closed */ }
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  notifyTabSwitch(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) {
    notifyTabSwitch(tabId);
  }
});

chrome.tabs.query({ active: true }).then((tabs) => {
  for (const tab of tabs) {
    if (tab?.id) notifyTabSwitch(tab.id);
  }
});

// ═══════════════════════════════════════════════════════════════════
// CONTEXT MENU — Right-click "Ask SNN" on selected text
// ═══════════════════════════════════════════════════════════════════
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'snn-ask-selection',
    title: 'Ask SNN about "%s"',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'snn-ask-page',
    title: 'Ask SNN about this page',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'snn-explain-image',
    title: 'Ask SNN to describe this image',
    contexts: ['image']
  });
  chrome.contextMenus.create({
    id: 'snn-explain-link',
    title: 'Ask SNN to summarize this link',
    contexts: ['link']
  });
});

// ── Robust side-panel opener ──────────────────────────────────
// MUST be called synchronously from a user-gesture handler
// (contextMenus.onClicked, action.onClicked, commands.onCommand).
// Tries windowId first, falls back to tabId, then tries the
// focused window as a last resort.
async function _openSidePanelForTab(tab) {
  if (!tab?.id) {
    console.error('[SNN] _openSidePanelForTab: no tab provided');
    return;
  }

  // Try all approaches; first success wins, fastest fallback saves the day.
  // We race windowId vs tabId instead of sequencing them so that if one
  // hangs (e.g. windowId on some Chrome versions) the other kicks in quickly.
  const candidates = [];

  // Approach 1: open by windowId (most reliable in modern Chrome)
  if (tab.windowId) {
    candidates.push(
      chrome.sidePanel.open({ windowId: tab.windowId }).then(() => 'windowId')
    );
  }

  // Approach 2: open by tabId (fallback for older Chrome / edge cases)
  candidates.push(
    chrome.sidePanel.open({ tabId: tab.id }).then(() => 'tabId')
  );

  // Race the two approaches — whichever succeeds first
  if (candidates.length > 0) {
    try {
      const winner = await Promise.any(candidates);
      console.log('[SNN] Side panel opened via', winner);
      return;
    } catch (e) {
      // All fast approaches failed — log and fall through to last resort
      console.warn('[SNN] Fast sidePanel.open approaches failed:', e?.message || e);
    }
  }

  // Approach 3 (last resort): open for the focused window
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const currentWin = wins.find(w => w.focused) || wins[0];
    if (currentWin?.id) {
      await chrome.sidePanel.open({ windowId: currentWin.id });
      console.log('[SNN] Side panel opened via focused-window fallback');
      return;
    }
  } catch (e) {
    console.error('[SNN] All sidePanel.open attempts failed:', e?.message || e);
  }

  // Ultimate fallback: try one more time with a fresh options reset.
  // Some Chrome versions need setOptions + open sequenced explicitly.
  try {
    await chrome.sidePanel.setOptions({ enabled: true });
    if (tab.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } else {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
    console.log('[SNN] Side panel opened via setOptions+open fallback');
  } catch (e) {
    console.error('[SNN] All side-panel open attempts exhausted:', e?.message || e);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  let prompt = '';
  switch (info.menuItemId) {
    case 'snn-ask-selection':
      prompt = info.selectionText || '';
      break;
    case 'snn-ask-page':
      prompt = 'Summarize this page.';
      break;
    case 'snn-explain-image':
      prompt = `Describe this image: ${info.srcUrl}`;
      break;
    case 'snn-explain-link':
      prompt = `Summarize the content at this link: ${info.linkUrl}`;
      break;
    default:
      return;
  }

  if (prompt) {
    // ═══════════════════════════════════════════════════════════
    // CRITICAL: chrome.sidePanel.open() MUST be called
    // SYNCHRONOUSLY within the user-gesture event handler.
    // Calling it inside a .then() callback loses the gesture
    // context and the call silently fails.  We open the panel
    // FIRST, then fire-and-forget the prompt into storage.
    // ═══════════════════════════════════════════════════════════
    _openSidePanelForTab(tab);

    // Fire-and-forget: store the prompt so the side panel picks it up.
    // The side panel calls _checkContextMenuPrompt() on init AND listens
    // for storage changes, so it will catch this regardless of timing.
    chrome.storage.session.set({
      snn_context_menu_prompt: { prompt, tabId: tab.id, timestamp: Date.now() }
    }).catch(err => console.warn('[SNN] Failed to store context-menu prompt:', err?.message || err));
  }
});

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATION HELPERS
// ═══════════════════════════════════════════════════════════════════
function showNotification(title, message, options = {}) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'assets/icons/icon128.png',
    title: title,
    message: message,
    priority: options.priority || 0,
    ...options
  });
}

// ═══════════════════════════════════════════════════════════════════
// HELPER: Resolve a potentially-relative URL against a tab's origin
// ═══════════════════════════════════════════════════════════════════
async function _makeAbsoluteUrl(rawUrl, tabId) {
  if (!rawUrl) return rawUrl;
  // Already absolute with scheme
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  // Absolute path — resolve against tab's origin
  if (rawUrl.startsWith('/')) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url) {
        const origin = new URL(tab.url).origin;
        return origin + rawUrl;
      }
    } catch (e) { /* fall through */ }
  }
  // Domain-like pattern — prepend https://
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(rawUrl)) {
    return 'https://' + rawUrl;
  }
  // Bare word like "blog" or "library" — resolve against tab's current URL
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) return new URL('/' + rawUrl.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, ''), tab.url).href;
  } catch (e) { /* give up */ }
  return rawUrl;
}

// ═══════════════════════════════════════════════════════════════════// BACKGROUND-LEVEL AGENT ACTION HANDLER
// ═══════════════════════════════════════════════════════════════
async function _handleBgAgentAction(message, sendResponse) {
  const p = message.payload || {};
  D.log('_handleBgAgentAction', { action: message.action, payloadKeys: Object.keys(p).join(','), tabId: p.tabId });

  try {
    switch (message.action) {
      case 'agent:listActions':
      case 'agent:getCapabilities':
        sendResponse({ success: true, result: _getCapabilities() });
        return;

      case 'agent:navigate': {
        const tabId = p.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No target tab for navigation.', retryable: false } }); return; }
        const url = await _makeAbsoluteUrl(p.url, tabId);
        await chrome.tabs.update(tabId, { url });
        sendResponse({ success: true, result: { navigated: true, url, tabId } });
        return;
      }

      case 'agent:openTab': {
        const tab = await chrome.tabs.create({ url: p.url, active: p.active !== false, index: p.index });
        sendResponse({ success: true, result: { tabId: tab.id, url: tab.url, title: tab.title } });
        return;
      }

      case 'agent:closeTab':
        await chrome.tabs.remove(p.tabId);
        sendResponse({ success: true, result: { closed: true } });
        return;

      case 'agent:goBack': {
        const tabId = p.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No tab.', retryable: false } }); return; }
        await chrome.tabs.goBack(tabId);
        sendResponse({ success: true, result: { wentBack: true } });
        return;
      }

      case 'agent:goForward': {
        const tabId = p.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No tab.', retryable: false } }); return; }
        await chrome.tabs.goForward(tabId);
        sendResponse({ success: true, result: { wentForward: true } });
        return;
      }

      case 'agent:reload': {
        const tabId = p.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No tab.', retryable: false } }); return; }
        await chrome.tabs.reload(tabId);
        sendResponse({ success: true, result: { reloaded: true } });
        return;
      }

      case 'agent:screenshot': {
        const tabId = p.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No visible tab to capture.', retryable: false } }); return; }
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.windowId) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No tab window.', retryable: false } }); return; }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: p.format || 'png' });
        sendResponse({ success: true, result: { screenshot: dataUrl, format: p.format || 'png' } });
        return;
      }

      case 'agent:download':
        chrome.downloads.download({ url: p.url, filename: p.filename, saveAs: p.saveAs || false }, (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: { code: 'DOWNLOAD_FAILED', message: chrome.runtime.lastError.message, retryable: false } });
          } else {
            sendResponse({ success: true, result: { downloadId } });
          }
        });
        return;

      case 'agent:notify':
        showNotification(p.title || 'SNN Chat', p.message || '');
        sendResponse({ success: true, result: { notified: true } });
        return;

      case 'agent:setAlarm': {
        const name = p.name || 'snn-alarm';
        chrome.alarms.create(name, {
          delayInMinutes: p.delayMs ? p.delayMs / 60000 : undefined,
          periodInMinutes: (p.periodMs || 60000) / 60000
        });
        await chrome.storage.session.set({ [`snn_alarm_${name}`]: { name, periodMs: p.periodMs || 60000, action: p.onTrigger || null, created: Date.now() } });
        sendResponse({ success: true, result: { alarmSet: true, name } });
        return;
      }

      case 'agent:clearAlarm': {
        const name = p.name || 'snn-alarm';
        const wasCleared = await chrome.alarms.clear(name);
        await chrome.storage.session.remove([`snn_alarm_${name}`]);
        sendResponse({ success: true, result: { cleared: wasCleared } });
        return;
      }

      case 'agent:listAlarms': {
        const alarms = await chrome.alarms.getAll();
        sendResponse({ success: true, result: { alarms: alarms.map(a => ({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes })) } });
        return;
      }

      case 'agent:page_script': {
        const tabId = p.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No target tab for page script.', retryable: false } }); return; }
        const code = p.code;
        if (!code) { sendResponse({ success: false, error: { code: 'NO_CODE', message: 'No code provided for page_script.', retryable: false } }); return; }
        D.log('page_script EXECUTE via executeScript', { tabId, codeLen: code.length, codePreview: String(code).substring(0, 120) });
        try {
          const result = await _executePageScriptInMainWorld(tabId, code, p.options || {});
          // Use null instead of undefined so JSON.stringify preserves the key for the LLM
          const value = result !== undefined ? result : null;
          D.log('page_script OK', { resultType: typeof result, isUndefined: result === undefined });
          sendResponse({ success: true, result: { action: 'page_script', result: value } });
        } catch (err) {
          D.error('page_script FAIL', { error: err.message });
          sendResponse({ success: false, error: { code: 'SCRIPT_ERROR', message: err.message, retryable: true, suggestion: 'The page may block script execution. Try a different approach.' } });
        }
        return;
      }

      default:
        sendResponse({ success: false, error: { code: 'UNKNOWN_BG_ACTION', message: `Unknown background action: ${message.action}`, retryable: false } });
    }
  } catch (err) {
    sendResponse({ success: false, error: { code: 'BG_ACTION_FAILED', message: err.message, retryable: false } });
  }
}

/**
 * Execute a dynamic code string in the page's MAIN world via chrome.scripting.executeScript.
 * This bypasses the extension's CSP (which blocks new Function() in content scripts)
 * because the browser itself injects the pre-compiled wrapper function.
 *
 * Inside the MAIN world, the wrapper uses eval() to run the user's code.
 * This works on most pages; pages with strict CSP (no unsafe-eval) will get a clear error.
 */
async function _executePageScriptInMainWorld(tabId, code, options) {
  // Wrapper that runs in MAIN world — receives the code string, executes it via eval(),
  // and returns {ok, value} or {ok, error}. Handles both sync and async (Promise) returns.
  // Uses DIRECT eval(codeStr) — NOT wrapped in an IIFE — because eval() returns
  // the completion value of the last statement, whereas (function(){...})() always
  // returns undefined without an explicit `return`.
  function injectedFn(codeStr, opts) {
    try {
      var __r = eval(codeStr);
      if (__r && typeof __r.then === 'function') {
        return __r.then(
          function(v) { return { ok: true, value: v }; },
          function(e) { return { ok: false, error: (e && e.message) || String(e) }; }
        );
      }
      return { ok: true, value: __r };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: injectedFn,
    args: [code, options || {}]
  });

  const outcome = results[0]?.result;
  if (!outcome) {
    throw new Error('Script produced no result');
  }
  if (!outcome.ok) {
    throw new Error(outcome.error || 'Unknown script error');
  }
  return outcome.value;
}

/**
 * Returns the full capability manifest — all actions the agent can perform.
 */
function _getCapabilities() {
  return {
    agent: 'SNN Chat v2.1',
    description: 'I can interact with web pages in real-time. I can click buttons, type into forms, scroll, highlight elements, extract data, take screenshots, navigate, manage tabs, fill forms, monitor pages, and more.',
    pageActions: [
      { action: 'click', description: 'Click any button, link, or element on the page', params: ['selector'] },
      { action: 'type', description: 'Type text into input fields and textareas', params: ['selector', 'text'] },
      { action: 'scroll', description: 'Scroll the page up, down, left, right, to top, or to bottom', params: ['direction', 'amount'] },
      { action: 'scrollToElement', description: 'Scroll to bring a specific element into view', params: ['selector'] },
      { action: 'highlight', description: 'Highlight an element with a colored overlay', params: ['selector', 'color'] },
      { action: 'clearHighlights', description: 'Remove all highlight overlays', params: [] },
      { action: 'findElements', description: 'Find all elements matching a CSS selector, returns info about each', params: ['selector'] },
      { action: 'getPageInfo', description: 'Get summary of the page (title, URL, form count, link count, etc.)', params: [] },
      { action: 'extractTable', description: 'Extract a table as structured data (headers + rows)', params: ['selector'] },
      { action: 'getElementText', description: 'Get the text content of a specific element', params: ['selector'] },
      { action: 'pressKey', description: 'Press a keyboard key (Enter, Escape, Tab, etc.)', params: ['key', 'selector'] },
      { action: 'hover', description: 'Hover over an element (trigger tooltips, dropdowns)', params: ['selector'] },
      { action: 'waitForElement', description: 'Wait until an element appears on the page', params: ['selector', 'timeout'] },
      { action: 'wait', description: 'Wait for a specified number of milliseconds', params: ['ms'] },
      { action: 'fillForm', description: 'Fill multiple form fields at once', params: ['fields'] },
      { action: 'selectDropdown', description: 'Select an option from a dropdown/select element', params: ['selector', 'value'] },
      { action: 'checkToggle', description: 'Check or uncheck a checkbox/radio', params: ['selector', 'checked'] },
      { action: 'getClipboard', description: 'Read text from clipboard', params: [] },
      { action: 'copyToClipboard', description: 'Copy text to clipboard', params: ['text'] },
      { action: 'startPicker', description: 'Enter element picker mode — hover to highlight, click to select', params: [] },
      { action: 'getViewportInfo', description: 'Get viewport dimensions and scroll position', params: [] },
      { action: 'page_script', description: 'Run a script on the page to read or modify content and styles', params: ['code'] },
      { action: 'startMonitoring', description: 'Watch for a DOM element to appear or change', params: ['selector', 'options'] }
    ],
    browserActions: [
      { action: 'navigate', description: 'Navigate the current tab to a URL', params: ['url'] },
      { action: 'openTab', description: 'Open a URL in a new tab', params: ['url'] },
      { action: 'closeTab', description: 'Close a tab', params: ['tabId'] },
      { action: 'goBack', description: 'Go back in browser history', params: [] },
      { action: 'goForward', description: 'Go forward in browser history', params: [] },
      { action: 'reload', description: 'Reload the current page', params: [] },
      { action: 'screenshot', description: 'Capture a screenshot of the visible tab', params: [] },
      { action: 'download', description: 'Download a file from a URL', params: ['url', 'filename'] },
      { action: 'notify', description: 'Show a system notification', params: ['title', 'message'] },
      { action: 'setAlarm', description: 'Set a periodic alarm (for monitoring)', params: ['name', 'periodMs'] },
      { action: 'clearAlarm', description: 'Clear a previously set alarm', params: ['name'] }
    ],
    selectorFormats: [
      '"#id" or ".class" — standard CSS selectors',
      '":text(\'exact button text\')" — find element by exact text',
      '":contains(\'partial text\')" — find element containing text',
      '":nth(\'selector\', 3)" — pick the Nth matching element',
      '":xpath(\'//div[@data-testid=\"foo\"]\')" — XPath selector',
      '":role(\'button\', \'Submit\')" — find by ARIA role + accessible name'
    ]
  };
}

// ═══════════════════════════════════════════════════════════════// MAIN MESSAGE ROUTER
// ═══════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // ── Log ALL messages (except high-frequency context/selection) ──
  if (!['updatePageContext', 'updateSelection', 'clearSelection', 'requestPageContent'].includes(message.action)) {
    D.log('← MSG', { action: message.action, sender: sender.tab ? `tab:${sender.tab.id}` : (sender.id || 'ext'), payloadKeys: message.payload ? Object.keys(message.payload).join(',') : 'none' });
  }

  // ── Page Context ──────────────────────────────────────────────
  if (message.action === 'updatePageContext') {
    chrome.storage.session.set({
      [CONTEXT_KEY]: {
        title: message.title,
        url: message.url,
        content: message.content,
        domain: message.domain,
        wordCount: message.wordCount,
        tabId: tabId || null,
        timestamp: Date.now()
      }
    }).catch(err => console.error('Context storage error:', err));
  }

  if (message.action === 'updateSelection') {
    chrome.storage.session.set({
      [SELECTION_KEY]: {
        text: message.text,
        tabId: tabId || null,
        timestamp: Date.now()
      }
    }).catch(err => console.error('Selection storage error:', err));
  }

  if (message.action === 'clearSelection') {
    chrome.storage.session.remove([SELECTION_KEY])
      .catch(err => console.error('Clear selection error:', err));
  }

  if (message.action === 'requestPageContent') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'extractContent' }).catch(() => {});
      }
    });
  }

  // ── PDF Text Extraction ─────────────────────────────────────
  if (message.action === 'extractPdfText') {
    const pdfUrl = message.url;
    const senderTabId = sender.tab?.id || message.tabId || tabId;
    console.log('[SNN] PDF extraction requested for:', pdfUrl);

    // Convert pdfData back to ArrayBuffer if it came as a plain array
    let pdfDataBuffer = null;
    if (message.pdfData) {
      if (message.pdfData instanceof ArrayBuffer) {
        pdfDataBuffer = message.pdfData;
      } else if (Array.isArray(message.pdfData)) {
        pdfDataBuffer = new Uint8Array(message.pdfData).buffer;
      }
    }

    _extractPdfText(pdfUrl, pdfDataBuffer)
      .then(async (text) => {
        // Store extracted PDF text as page context so the side panel picks it up
        const domain = (() => { try { return new URL(pdfUrl).hostname; } catch (e) { return 'pdf'; } })();
        const title = message.title || 'PDF Document';
        const content = `=== PDF CONTENT ===\nTitle: ${title}\nURL: ${pdfUrl}\n\n${text}\n=== END ===`;
        const wordCount = text.trim().split(/\s+/).filter(w => w.length).length;

        await chrome.storage.session.set({
          [CONTEXT_KEY]: {
            title,
            url: pdfUrl,
            content,
            domain,
            wordCount,
            tabId: senderTabId || null,
            timestamp: Date.now(),
            isPdf: true
          }
        });

        // Notify side panel that context is updated
        chrome.runtime.sendMessage({
          action: 'updatePageContext',
          title,
          url: pdfUrl,
          content,
          domain,
          wordCount,
          isPdf: true
        }).catch(() => {});

        sendResponse({ success: true, text, wordCount });
      })
      .catch((err) => {
        console.error('[SNN] PDF extraction failed:', err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true; // async
  }

  // ── Voice Relay ──────────────────────────────────────────────
  if (message.action === 'voice:start' || message.action === 'voice:stop') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, message).then((response) => {
          sendResponse(response);
        }).catch(() => {
          sendResponse({ success: false, error: 'content-script-unavailable' });
        });
      } else {
        sendResponse({ success: false, error: 'no-active-tab' });
      }
    });
    return true;
  }

  if (message.action === 'voice:transcript' || message.action === 'voice:error' || message.action === 'voice:ended') {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════
  // BACKGROUND-LEVEL AGENT ACTIONS (handled here, NOT forwarded to page)
  // These actions: navigate, openTab, closeTab, goBack, goForward,
  // reload, screenshot, download, notify, setAlarm, clearAlarm, listAlarms
  // ═══════════════════════════════════════════════════════════════
  const BG_AGENT_ACTIONS = [
    'agent:navigate', 'agent:openTab', 'agent:closeTab', 'agent:goBack',
    'agent:goForward', 'agent:reload', 'agent:screenshot', 'agent:download',
    'agent:notify', 'agent:setAlarm', 'agent:clearAlarm', 'agent:listAlarms',
    'agent:listActions', 'agent:getCapabilities', 'agent:page_script'
  ];

  if (BG_AGENT_ACTIONS.includes(message.action)) {
    D.log('→ ROUTE BG', message.action);
    _handleBgAgentAction(message, sendResponse);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // PAGE-LEVEL AGENT ACTIONS — Forward to content script
  // ═══════════════════════════════════════════════════════════════
  if (message.action && message.action.startsWith('agent:')) {
    D.log('→ ROUTE PAGE', message.action);
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) {
        D.warn('→ ROUTE PAGE: no active tab');
        sendResponse({
          success: false,
          error: {
            code: 'NO_ACTIVE_TAB',
            message: 'No active tab to perform the action on.',
            retryable: false,
            suggestion: 'Open a web page and try again.'
          }
        });
        return;
      }
      D.log('→ FORWARD to tab', { tabId: tab.id, action: message.action });
      chrome.tabs.sendMessage(tab.id, message).then((response) => {
        sendResponse(response);
      }).catch((err) => {
        D.error('→ FORWARD FAILED', { tabId: tab.id, action: message.action, error: err.message });
        sendResponse({
          success: false,
          error: {
            code: 'CONTENT_SCRIPT_UNAVAILABLE',
            message: 'Could not reach the page. It may not be fully loaded.',
            retryable: true,
            suggestion: 'Refresh the page and try again.'
          }
        });
      });
    });
    return true;
  }
});

// ═══════════════════════════════════════════════════════════════════
// ALARM HANDLER — Periodic monitoring & SW keep-alive
// ═══════════════════════════════════════════════════════════════════
chrome.alarms.onAlarm.addListener(async (alarm) => {
  const key = `snn_alarm_${alarm.name}`;
  const { [key]: alarmData } = await chrome.storage.session.get(key);

  if (alarmData?.action) {
    // Notify side panel that the alarm fired
    chrome.runtime.sendMessage({
      action: 'agent:alarmFired',
      name: alarm.name,
      alarmData
    }).catch(() => {});

    // If the alarm has a monitoring action, request content extraction
    if (alarmData.action === 'checkPage') {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'extractContent' }).catch(() => {});
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATION CLICK HANDLER — Open side panel when notification clicked
// ═══════════════════════════════════════════════════════════════════
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) {
      _openSidePanelForTab(tab);
    }
  });
});

// ── Cleanup on tab close ──────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  chrome.runtime.sendMessage({ action: 'tabClosed', tabId }).catch(() => {});

  const all = await chrome.storage.local.get(null);
  const prefix = `snn_chat_history_${tabId}_`;
  const keys = Object.keys(all).filter(k => k.startsWith(prefix));
  if (keys.length) {
    await chrome.storage.local.remove(keys);
  }

  const tabs = await chrome.tabs.query({});
  if (tabs.length === 0) {
    const sessionData = await chrome.storage.session.get(null);
    const keysToRemove = Object.keys(sessionData).filter(k =>
      k === CONTEXT_KEY || k === SELECTION_KEY || k.startsWith(TAB_SWITCH_PREFIX)
    );
    if (keysToRemove.length) {
      chrome.storage.session.remove(keysToRemove).catch(() => {});
    }
  }
});

console.log('SNN Chat background service worker ready');