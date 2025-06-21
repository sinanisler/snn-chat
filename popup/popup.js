document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggle-sidebar');
  
  toggleBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
      window.close();
    } catch (error) {
      console.error('Failed to toggle sidebar:', error);
    }
  });
});