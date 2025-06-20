chrome.runtime.onInstalled.addListener(() => {
  console.log('AI Chat Sidebar extension installed');
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
  } catch (error) {
    console.error('Failed to send message to content script:', error);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-sidebar') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
    } catch (error) {
      console.error('Failed to toggle sidebar via shortcut:', error);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openOptionsPage') {
    chrome.runtime.openOptionsPage();
  }
});