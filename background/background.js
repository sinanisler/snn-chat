// SNN Chat Background Service Worker
// Coordinates between content script (page context) and side panel (chat UI)

// ── Side Panel Behavior ───────────────────────────────────────────
// Open side panel when user clicks the extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Side panel setup:', error));

// Also toggle via keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-sidebar') {
    try {
      // Check if side panel is already open for this window
      const isOpen = await chrome.sidePanel.getOptions({}).catch(() => null);
      
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab?.windowId) {
        console.warn('toggle-sidebar: no active tab available');
        return;
      }

      await chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId });
    } catch (error) {
      console.error('Failed to toggle side panel via shortcut:', error);
    }
  }
});

// ── Page Context Management ────────────────────────────────────────
// Content script sends page context here; we store in session storage
// so the side panel can pick it up on load or via onChanged listener.

const CONTEXT_KEY = 'snn_page_context';
const SELECTION_KEY = 'snn_selection';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updatePageContext') {
    // Content script extracted page content
    chrome.storage.session.set({
      [CONTEXT_KEY]: {
        title: message.title,
        url: message.url,
        content: message.content,
        domain: message.domain,
        wordCount: message.wordCount,
        timestamp: Date.now()
      }
    }).catch(err => console.error('Context storage error:', err));
  }

  if (message.action === 'updateSelection') {
    // User selected text on the page
    chrome.storage.session.set({
      [SELECTION_KEY]: {
        text: message.text,
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
  // Forward voice commands from side panel → content script
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
chrome.tabs.onRemoved.addListener(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) {
    chrome.storage.session.remove([CONTEXT_KEY, SELECTION_KEY])
      .catch(() => {});
  }
});

console.log('SNN Chat background service worker ready');