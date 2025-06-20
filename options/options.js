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
    this.maxTokensValue = document.getElementById('max-tokens-value');
    this.temperatureInput = document.getElementById('temperature');
    this.temperatureValue = document.getElementById('temperature-value');
    
    this.themeOptions = document.querySelectorAll('.theme-option');
    this.selectedTheme = 'auto';
    
    this.init();
  }
  
  init() {
    this.loadSettings();
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
    
    this.maxTokensInput.addEventListener('input', () => {
      this.maxTokensValue.textContent = this.maxTokensInput.value;
    });
    
    this.temperatureInput.addEventListener('input', () => {
      this.temperatureValue.textContent = this.temperatureInput.value;
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
      if (this.openaiKeyInput.value.trim()) {
        this.loadModels('openai');
      }
    });
    
    this.openrouterKeyInput.addEventListener('input', () => {
      if (this.openrouterKeyInput.value.trim()) {
        this.loadModels('openrouter');
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
      this.maxTokensValue.textContent = settings.maxTokens || 2000;
      this.temperatureInput.value = settings.temperature || 0.7;
      this.temperatureValue.textContent = settings.temperature || 0.7;
      
      this.selectedTheme = settings.theme || 'auto';
      this.selectTheme(this.selectedTheme);
      
      if (settings.openaiModel) {
        this.setSelectedModel('openai', settings.openaiModel);
      }
      if (settings.openrouterModel) {
        this.setSelectedModel('openrouter', settings.openrouterModel);
      }
      
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.showStatus('Failed to load settings', 'error');
    }
  }
  
  async loadInitialModels() {
    if (this.openaiKeyInput.value.trim()) {
      this.loadModels('openai');
    }
    if (this.openrouterKeyInput.value.trim()) {
      this.loadModels('openrouter');
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
        .filter(model => !model.id.includes('free') && (
          model.id.includes('gpt') || 
          model.id.includes('claude') || 
          model.id.includes('gemini') ||
          model.id.includes('llama')
        ))
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
        theme: this.selectedTheme
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
      theme: 'auto'
    };
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