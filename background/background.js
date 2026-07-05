// SNN Chat Background Service Worker
// Coordinates between content script (page context) and side panel (chat UI)
// Tracks active tab so the side panel can maintain per-tab chat sessions.

// ── Side Panel Behavior ───────────────────────────────────────────
// Open side panel when user clicks the extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Side panel setup:', error));

// Also toggle via keyboard shortcut
// NOTE: Do NOT use async/await here — sidePanel.open() requires a user gesture
// which is only preserved in synchronous-style callbacks from chrome.commands.
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
// The side panel needs to know which tab is active so it can maintain
// separate chat sessions per tab (not per domain!). We store the
// active tab per window in session storage and broadcast tab switches.
//
// CRITICAL: chrome.runtime.sendMessage broadcasts to ALL extension
// pages in ALL windows. Each side panel MUST filter by its own
// windowId to avoid cross-window tab leaks (e.g. multi-monitor setups).

const CONTEXT_KEY = 'snn_page_context';
const SELECTION_KEY = 'snn_selection';
const TAB_SWITCH_PREFIX = 'snn_active_tab'; // per-window key: snn_active_tab_{windowId}

function tabSwitchKey(windowId) {
  return `${TAB_SWITCH_PREFIX}_${windowId}`;
}

async function notifyTabSwitch(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || !tab?.windowId) return;
    const domain = new URL(tab.url).hostname;
    const info = { tabId, windowId: tab.windowId, url: tab.url, domain, title: tab.title || '' };
    // Per-window storage so each side panel reads only its own window's active tab
    await chrome.storage.session.set({ [tabSwitchKey(tab.windowId)]: info });
    // Broadcast to ALL side panels — each MUST filter by windowId!
    chrome.runtime.sendMessage({ action: 'tabSwitched', ...info }).catch(() => {});
  } catch (e) {
    // Tab may have been closed between activation and query
  }
}

// Detect tab switches (fires for ALL windows)
chrome.tabs.onActivated.addListener((activeInfo) => {
  notifyTabSwitch(activeInfo.tabId);
});

// Detect URL changes in the active tab (e.g. user clicks a link, SPA navigation)
// NOTE: fires for ALL windows; tab.active means active in ITS window, not necessarily
// the window the side panel is in. Side panel filters by windowId.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) {
    notifyTabSwitch(tabId);
  }
});

// On startup, notify the active tab in each window
chrome.tabs.query({ active: true }).then((tabs) => {
  for (const tab of tabs) {
    if (tab?.id) notifyTabSwitch(tab.id);
  }
});

// ── Page Context Management ────────────────────────────────────────
// Content script sends page context here; we store in session storage
// so the side panel can pick it up on load or via onChanged listener.
// Each context/selection is tagged with the tabId so the side panel
// can ignore stale data from non-active tabs.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id; // Which tab sent this?

  if (message.action === 'updatePageContext') {
    // Content script extracted page content
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
    // User selected text on the page
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
    // Side panel asking for fresh page content — forward to content script
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'extractContent' })
          .catch(() => {}); // Content script may not be loaded yet
      }
    });
  }

  // ── Voice Relay ──────────────────────────────────────────────
  // Forward voice commands from side panel → content script (active tab)
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
    return true; // keep channel open for async sendResponse
  }

  // Forward voice results from content script → side panel
  if (message.action === 'voice:transcript' || message.action === 'voice:error' || message.action === 'voice:ended') {
    chrome.runtime.sendMessage(message).catch(() => {});
  }
});

// ── Cleanup on tab close ──────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Notify side panel so it can switch sessions
  chrome.runtime.sendMessage({ action: 'tabClosed', tabId }).catch(() => {});

  // Clean up this tab's chat sessions from local storage
  const all = await chrome.storage.local.get(null);
  const prefix = `snn_chat_history_${tabId}_`;
  const keys = Object.keys(all).filter(k => k.startsWith(prefix));
  if (keys.length) {
    await chrome.storage.local.remove(keys);
  }

  // If no tabs remain, clear ALL session storage keys (including per-window active tab keys)
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