document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Automatically toggle sidebar when popup opens
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
    window.close();
  } catch (error) {
    console.error('Failed to toggle sidebar:', error);
    // If direct toggle fails, show the button as fallback
    const toggleBtn = document.getElementById('toggle-sidebar');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
          window.close();
        } catch (error) {
          console.error('Failed to toggle sidebar:', error);
        }
      });
    }
  }
});