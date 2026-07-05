// SNN Chat Background Service Worker
// Coordinates between content script (page context) and side panel (chat UI)
// Tracks active tab so the side panel can maintain per-tab chat sessions.
//
// v2.1 — Extended with agent action relay, tab management, screenshots,
// context menus, notifications, alarms, and download support.

// ── Side Panel Behavior ───────────────────────────────────────────
// Open side panel when user clicks the extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Side panel setup:', error));

// Also toggle via keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-sidebar') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.windowId) {
        console.warn('toggle-sidebar: no active tab available');
        return;
      }
      chrome.sidePanel.open({ windowId: tab.windowId })
        .catch((error) => console.error('Failed to toggle side panel via shortcut:', error));
    });
  }
});

// ── Tab Tracking ──────────────────────────────────────────────────
const CONTEXT_KEY = 'snn_page_context';
const SELECTION_KEY = 'snn_selection';
const TAB_SWITCH_PREFIX = 'snn_active_tab';
const ACTION_QUEUE_KEY = 'snn_action_queue'; // pending agent actions

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
    // Store the prompt so the side panel can pick it up
    chrome.storage.session.set({
      snn_context_menu_prompt: { prompt, tabId: tab.id, timestamp: Date.now() }
    }).then(() => {
      // Open side panel
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    });
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

// ═══════════════════════════════════════════════════════════════════// BACKGROUND-LEVEL AGENT ACTION HANDLER
// ═══════════════════════════════════════════════════════════════
async function _handleBgAgentAction(message, sendResponse) {
  const p = message.payload || {};

  try {
    switch (message.action) {
      case 'agent:listActions':
      case 'agent:getCapabilities':
        sendResponse({ success: true, result: _getCapabilities() });
        return;

      case 'agent:navigate': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No active tab.', retryable: false } }); return; }
        await chrome.tabs.update(tab.id, { url: p.url });
        sendResponse({ success: true, result: { navigated: true, url: p.url } });
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
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No tab.', retryable: false } }); return; }
        await chrome.tabs.goBack(tab.id);
        sendResponse({ success: true, result: { wentBack: true } });
        return;
      }

      case 'agent:goForward': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No tab.', retryable: false } }); return; }
        await chrome.tabs.goForward(tab.id);
        sendResponse({ success: true, result: { wentForward: true } });
        return;
      }

      case 'agent:reload': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No tab.', retryable: false } }); return; }
        await chrome.tabs.reload(tab.id);
        sendResponse({ success: true, result: { reloaded: true } });
        return;
      }

      case 'agent:screenshot': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab?.windowId) { sendResponse({ success: false, error: { code: 'NO_TAB', message: 'No visible tab to capture.', retryable: false } }); return; }
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

      default:
        sendResponse({ success: false, error: { code: 'UNKNOWN_BG_ACTION', message: `Unknown background action: ${message.action}`, retryable: false } });
    }
  } catch (err) {
    sendResponse({ success: false, error: { code: 'BG_ACTION_FAILED', message: err.message, retryable: false } });
  }
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
      { action: 'evaluate', description: 'Execute custom JavaScript on the page', params: ['code'] },
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
    'agent:listActions', 'agent:getCapabilities'
  ];

  if (BG_AGENT_ACTIONS.includes(message.action)) {
    _handleBgAgentAction(message, sendResponse);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // PAGE-LEVEL AGENT ACTIONS — Forward to content script
  // ═══════════════════════════════════════════════════════════════
  if (message.action && message.action.startsWith('agent:')) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) {
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
      chrome.tabs.sendMessage(tab.id, message).then((response) => {
        sendResponse(response);
      }).catch(() => {
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
    if (tab?.windowId) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
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