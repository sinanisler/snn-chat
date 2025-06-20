class OptionsManager {
  constructor() {
    this.form = document.getElementById('settings-form');
    this.statusMessage = document.getElementById('status-message');
    
    this.providerRadios = document.querySelectorAll('input[name="provider"]');
    this.openaiProvider = document.getElementById('openai-provider');
    this.openrouterProvider = document.getElementById('openrouter-provider');
    
    this.openaiKeyInput = document.getElementById('openai-key');
    this.openrouterKeyInput = document.getElementById('openrouter-key');
    this.openaiModelSelect = document.getElementById('openai-model');
    this.openrouterModelSelect = document.getElementById('openrouter-model');
    
    this.maxTokensInput = document.getElementById('max-tokens');
    this.temperatureInput = document.getElementById('temperature');
    this.temperatureValue = document.getElementById('temperature-value');
    this.fontSizeInput = document.getElementById('font-size');
    this.sidebarWidthInput = document.getElementById('sidebar-width');
    this.clearHistoryBtn = document.getElementById('clear-history');
    this.toggleShortcutInput = document.getElementById('toggle-shortcut');
    this.resetShortcutBtn = document.getElementById('reset-shortcut');
    
    this.themeOptions = document.querySelectorAll('.theme-option');
    this.selectedTheme = 'auto';
    
    this.init();
  }
  
  async init() {
    await this.loadSettings();
    this.setupEventListeners();
    this.loadInitialModels();
  }
  
  setupEventListeners() {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveSettings();
    });
    
    this.providerRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        this.updateProviderSelection();
      });
    });
    
    this.temperatureInput.addEventListener('input', () => {
      this.temperatureValue.textContent = this.temperatureInput.value;
    });
    
    this.clearHistoryBtn.addEventListener('click', () => {
      this.clearAllHistory();
    });
    
    this.toggleShortcutInput.addEventListener('click', () => {
      this.recordShortcut();
    });
    
    this.resetShortcutBtn.addEventListener('click', () => {
      this.resetShortcut();
    });
    
    this.themeOptions.forEach(option => {
      option.addEventListener('click', () => {
        this.selectTheme(option.dataset.theme);
      });
    });
    
    document.getElementById('test-openai').addEventListener('click', () => {
      this.testConnection('openai');
    });
    
    document.getElementById('test-openrouter').addEventListener('click', () => {
      this.testConnection('openrouter');
    });
    
    this.openaiKeyInput.addEventListener('input', () => {
      const apiKey = this.openaiKeyInput.value.trim();
      if (apiKey) {
        this.loadModels('openai');
      } else {
        this.clearModelSelect('openai');
      }
    });
    
    this.openrouterKeyInput.addEventListener('input', () => {
      const apiKey = this.openrouterKeyInput.value.trim();
      if (apiKey) {
        this.loadModels('openrouter');
      } else {
        this.clearModelSelect('openrouter');
      }
    });
  }
  
  async loadSettings() {
    try {
      const result = await chrome.storage.sync.get(['settings']);
      const settings = result.settings || this.getDefaultSettings();
      
      const provider = settings.provider || 'openai';
      document.getElementById(`${provider}-radio`).checked = true;
      this.updateProviderSelection();
      
      this.openaiKeyInput.value = settings.openaiKey || '';
      this.openrouterKeyInput.value = settings.openrouterKey || '';
      
      this.maxTokensInput.value = settings.maxTokens || 2000;
      this.temperatureInput.value = settings.temperature || 0.7;
      this.temperatureValue.textContent = settings.temperature || 0.7;
      this.fontSizeInput.value = settings.fontSize || 15;
      this.sidebarWidthInput.value = settings.sidebarWidth || 400;
      this.toggleShortcutInput.value = settings.toggleShortcut || 'Ctrl+Shift+Y';
      
      this.selectedTheme = settings.theme || 'auto';
      this.selectTheme(this.selectedTheme);
      
      this.savedOpenaiModel = settings.openaiModel;
      this.savedOpenrouterModel = settings.openrouterModel;
      
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.showStatus('Failed to load settings', 'error');
    }
  }
  
  async loadInitialModels() {
    if (this.openaiKeyInput.value.trim()) {
      await this.loadModels('openai');
      if (this.savedOpenaiModel) {
        this.setSelectedModel('openai', this.savedOpenaiModel);
      }
    }
    if (this.openrouterKeyInput.value.trim()) {
      await this.loadModels('openrouter');
      if (this.savedOpenrouterModel) {
        this.setSelectedModel('openrouter', this.savedOpenrouterModel);
      }
    }
  }
  
  updateProviderSelection() {
    const selectedProvider = document.querySelector('input[name="provider"]:checked').value;
    
    this.openaiProvider.classList.toggle('active', selectedProvider === 'openai');
    this.openrouterProvider.classList.toggle('active', selectedProvider === 'openrouter');
  }
  
  selectTheme(theme) {
    this.selectedTheme = theme;
    this.themeOptions.forEach(option => {
      option.classList.toggle('selected', option.dataset.theme === theme);
    });
  }
  
  async loadModels(provider) {
    const loadingEl = document.getElementById(`${provider}-loading`);
    const errorEl = document.getElementById(`${provider}-error`);
    const selectEl = document.getElementById(`${provider}-model`);
    
    loadingEl.style.display = 'flex';
    errorEl.style.display = 'none';
    selectEl.innerHTML = '<option value="">Loading models...</option>';
    
    try {
      const apiKey = provider === 'openai' ? this.openaiKeyInput.value : this.openrouterKeyInput.value;
      if (!apiKey.trim()) {
        throw new Error('API key is required');
      }
      
      const models = await this.fetchModels(provider, apiKey);
      this.populateModelSelect(provider, models);
      
    } catch (error) {
      console.error(`Failed to load ${provider} models:`, error);
      errorEl.textContent = `Failed to load models: ${error.message}`;
      errorEl.style.display = 'block';
      selectEl.innerHTML = '<option value="">Failed to load models</option>';
    } finally {
      loadingEl.style.display = 'none';
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
      return data.data
        .filter(model => model.id.includes('gpt'))
        .sort((a, b) => {
          const priority = { 'gpt-4o-mini': 0, 'gpt-4o': 1, 'gpt-4-turbo': 2, 'gpt-4': 3, 'gpt-3.5-turbo': 4 };
          return (priority[a.id] || 999) - (priority[b.id] || 999);
        });
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
      return data.data
        .filter(model => !model.id.includes('free'))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  }
  
  populateModelSelect(provider, models) {
    const selectEl = document.getElementById(`${provider}-model`);
    selectEl.innerHTML = '';
    
    if (models.length === 0) {
      selectEl.innerHTML = '<option value="">No models available</option>';
      return;
    }
    
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = provider === 'openai' ? model.id : `${model.name} (${model.id})`;
      
      if (provider === 'openai' && model.id === 'gpt-4o-mini') {
        option.selected = true;
      }
      
      selectEl.appendChild(option);
    });
  }
  
  setSelectedModel(provider, modelId) {
    const selectEl = document.getElementById(`${provider}-model`);
    const option = selectEl.querySelector(`option[value="${modelId}"]`);
    if (option) {
      option.selected = true;
    }
  }

  clearModelSelect(provider) {
    const selectEl = document.getElementById(`${provider}-model`);
    selectEl.innerHTML = '<option value="">Select a model...</option>';
  }
  
  async testConnection(provider) {
    const testBtn = document.getElementById(`test-${provider}`);
    const statusEl = document.getElementById(`${provider}-status`);
    const apiKey = provider === 'openai' ? this.openaiKeyInput.value : this.openrouterKeyInput.value;
    
    if (!apiKey.trim()) {
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
    const statusEl = document.getElementById(`${provider}-status`);
    statusEl.textContent = message;
    statusEl.className = `connection-status ${type}`;
    statusEl.style.display = 'block';
    
    setTimeout(() => {
      statusEl.style.display = 'none';
    }, 5000);
  }
  
  async saveSettings() {
    try {
      const provider = document.querySelector('input[name="provider"]:checked').value;
      const openaiKey = this.openaiKeyInput.value.trim();
      const openrouterKey = this.openrouterKeyInput.value.trim();
      
      if (provider === 'openai' && !openaiKey) {
        this.showStatus('OpenAI API key is required', 'error');
        return;
      }
      
      if (provider === 'openrouter' && !openrouterKey) {
        this.showStatus('OpenRouter API key is required', 'error');
        return;
      }
      
      if (provider === 'openai' && openaiKey && !openaiKey.startsWith('sk-')) {
        this.showStatus('Invalid OpenAI API key format. Should start with "sk-"', 'error');
        return;
      }
      
      if (provider === 'openrouter' && openrouterKey && !openrouterKey.startsWith('sk-or-')) {
        this.showStatus('Invalid OpenRouter API key format. Should start with "sk-or-"', 'error');
        return;
      }
      
      const settings = {
        provider: provider,
        openaiKey: openaiKey,
        openrouterKey: openrouterKey,
        openaiModel: this.openaiModelSelect.value,
        openrouterModel: this.openrouterModelSelect.value,
        maxTokens: parseInt(this.maxTokensInput.value),
        temperature: parseFloat(this.temperatureInput.value),
        fontSize: parseInt(this.fontSizeInput.value),
        sidebarWidth: parseInt(this.sidebarWidthInput.value),
        theme: this.selectedTheme,
        toggleShortcut: this.toggleShortcutInput.value
      };
      
      await chrome.storage.sync.set({ settings });
      this.showStatus('Settings saved successfully!', 'success');
      
      chrome.runtime.sendMessage({ action: 'settingsUpdated', settings });
      
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showStatus('Failed to save settings', 'error');
    }
  }
  
  getDefaultSettings() {
    return {
      provider: 'openai',
      openaiKey: '',
      openrouterKey: '',
      openaiModel: 'gpt-4o-mini',
      openrouterModel: '',
      maxTokens: 2000,
      temperature: 0.7,
      fontSize: 15,
      sidebarWidth: 400,
      theme: 'auto',
      toggleShortcut: 'Ctrl+Shift+Y'
    };
  }

  async clearAllHistory() {
    if (confirm('Are you sure you want to clear all chat history? This cannot be undone.')) {
      try {
        const keys = await new Promise(resolve => {
          chrome.storage.local.get(null, resolve);
        });
        
        const historyKeys = Object.keys(keys).filter(key => key.startsWith('snn_chat_history_'));
        
        if (historyKeys.length > 0) {
          await chrome.storage.local.remove(historyKeys);
          this.showStatus(`Cleared ${historyKeys.length} chat histories`, 'success');
        } else {
          this.showStatus('No chat history found', 'success');
        }
      } catch (error) {
        console.error('Failed to clear history:', error);
        this.showStatus('Failed to clear history', 'error');
      }
    }
  }

  recordShortcut() {
    this.toggleShortcutInput.value = 'Press keys...';
    this.toggleShortcutInput.focus();
    
    const handleKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const keys = [];
      if (e.ctrlKey) keys.push('Ctrl');
      if (e.altKey) keys.push('Alt');
      if (e.shiftKey) keys.push('Shift');
      if (e.metaKey) keys.push('Meta');
      
      let mainKey = '';
      if (e.key && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        // Handle special keys
        if (e.key === ' ') {
          mainKey = 'Space';
        } else if (e.key === '+') {
          mainKey = 'Plus';
        } else if (e.key.length === 1) {
          mainKey = e.key.toUpperCase();
        } else {
          mainKey = e.key;
        }
        keys.push(mainKey);
      }
      
      // Require at least one modifier + one main key
      const modifierCount = keys.filter(k => ['Ctrl', 'Alt', 'Shift', 'Meta'].includes(k)).length;
      if (modifierCount > 0 && keys.length > 1) {
        this.toggleShortcutInput.value = keys.join('+');
        this.toggleShortcutInput.removeEventListener('keydown', handleKeyDown);
        this.toggleShortcutInput.blur();
      } else if (keys.length === 1 && !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(keys[0])) {
        // Single key without modifier - show error
        this.toggleShortcutInput.value = 'Need modifier key (Ctrl/Alt/Shift)';
        setTimeout(() => {
          this.toggleShortcutInput.value = this.originalShortcut || 'Ctrl+Shift+Y';
        }, 1500);
        this.toggleShortcutInput.removeEventListener('keydown', handleKeyDown);
        this.toggleShortcutInput.blur();
      }
    };
    
    this.originalShortcut = this.toggleShortcutInput.value;
    this.toggleShortcutInput.addEventListener('keydown', handleKeyDown);
    
    // Cancel on blur
    const handleBlur = () => {
      this.toggleShortcutInput.removeEventListener('keydown', handleKeyDown);
      this.toggleShortcutInput.removeEventListener('blur', handleBlur);
      if (this.toggleShortcutInput.value === 'Press keys...') {
        this.toggleShortcutInput.value = this.originalShortcut || 'Ctrl+Shift+Y';
      }
    };
    this.toggleShortcutInput.addEventListener('blur', handleBlur);
  }

  resetShortcut() {
    this.toggleShortcutInput.value = 'Ctrl+Shift+Y';
  }
  
  showStatus(message, type) {
    this.statusMessage.textContent = message;
    this.statusMessage.className = `status-message ${type}`;
    this.statusMessage.style.display = 'block';
    
    setTimeout(() => {
      this.statusMessage.style.display = 'none';
    }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new OptionsManager();
});