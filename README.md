# SNN Chat Chrome Extension 

SNN Chat is a Chrome extension that provides an AI-powered chat sidebar with advanced context awareness, per-domain chat history, and intelligent session management. Features a fixed top-right sidebar with full height display for seamless web browsing integration.

![image](https://github.com/user-attachments/assets/73646284-c26c-42e0-b74c-326d495b0a9b)


## Features

- **Smart Sidebar**: Fixed top-right sidebar with full height display and customizable width (300-900px)
- **Dual API Support**: Integrated with OpenAI and OpenRouter APIs with dynamic model loading
- **Advanced Context Awareness**: Automatically extracts page content, monitors selections, and detects page changes
- **Per-Domain Chat History**: Separate chat history for each website domain with session management
- **Intelligent Page Detection**: Monitors SPA navigation and dynamic content changes
- **Customizable Interface**: Adjustable font size, theme (Light/Dark/Auto), and layout
- **Flexible Shortcuts**: Customizable keyboard shortcuts (default: Ctrl+Shift+Y)
- **Export Functionality**: Export chat history for backup and analysis
- **Model Switching**: Real-time model indicator with easy switching between AI models
- **Selection Preview**: Visual preview of selected text with context management

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the `chrome-extension` folder
5. The extension will be installed and ready to use

## Setup

1. Click the extension icon or press `Ctrl+Shift+Y` to open the sidebar
2. Click "Settings" in the sidebar to configure your API provider and key
3. Choose between OpenAI or OpenRouter
4. Get your API key from [OpenAI Platform](https://platform.openai.com/api-keys) or [OpenRouter](https://openrouter.ai/keys)
5. Select your preferred AI model from the dynamically loaded list
6. Customize your experience (theme, font size, shortcuts, etc.)
7. Save your settings and start chatting!

## Usage

### Opening the Sidebar
- Click the extension icon in the toolbar
- Use the keyboard shortcut `Ctrl+Shift+Y`
- Use the popup menu

### Chat Features
- Type your message and click "Send" or press `Enter`
- Select text on any webpage to provide context to the AI
- **Per-Domain History**: Chat history is automatically saved per website domain
- **Session Management**: Each browser session creates a new chat session
- **Page Change Detection**: Automatically detects navigation and SPA route changes
- **Context Management**: Clear context, start new chats, or view chat history
- **Export Functionality**: Export your chat history for backup or analysis

### Keyboard Shortcuts
- **Customizable Toggle**: Default `Ctrl+Shift+Y` (customizable in settings)
- `Enter` - Send message (when typing in the chat input)
- **Smart Context**: Automatic page content extraction and selection monitoring

## File Structure

```
chrome-extension/
├── manifest.json           # Manifest V3 configuration
├── background/
│   └── background.js      # Service worker for extension lifecycle and shortcuts
├── content/
│   ├── content.js         # Main SNNChat class with sidebar logic and API integration
│   └── content.css        # Complete sidebar styling with themes and responsive design
├── sidebar/
│   └── sidebar.html       # Comprehensive sidebar template with settings overlay
├── utils/                  # Utility functions and helpers
└── assets/
    └── icons/             # Extension icons
```

## Configuration

The extension provides comprehensive settings accessible directly from the sidebar:

### API Settings
- **Provider Selection**: Choose between OpenAI or OpenRouter
- **API Keys**: Secure storage of your OpenAI or OpenRouter API key
- **Dynamic Models**: Automatically loads available models from each provider
- **Connection Testing**: Test API connectivity before saving

### Chat Configuration
- **Max Tokens**: Response length limit (100-4000)
- **Temperature**: AI creativity level (0.0-1.0)
- **Content Limit**: Page content extraction limit (1000-100000 characters)
- **System Prompt**: Customize AI behavior with custom instructions

### Interface Customization
- **Theme**: Light, Dark, or Auto (follows system preference)
- **Font Size**: Adjustable from 12px to 20px
- **Sidebar Width**: Customizable width from 300px to 900px
- **Keyboard Shortcuts**: Fully customizable keyboard combinations

### Data Management
- **Chat History**: Per-domain automatic saving
- **Export/Import**: Export chat history for backup
- **Clear History**: Option to clear all stored conversations

## Key Features

### Smart Sidebar Interface
- **Fixed Top-Right Position**: Always accessible without interfering with page content
- **Full Height Display**: Maximizes chat area visibility (100vh)
- **Smooth Animations**: Elegant slide-in/out transitions
- **Responsive Design**: Adapts to different screen sizes and orientations
- **Customizable Width**: Adjustable sidebar width for optimal viewing

### Advanced Context Management
- **Automatic Content Extraction**: Intelligently reads page content
- **Selection Monitoring**: Real-time detection of text selections
- **Page Change Detection**: Monitors SPA navigation and dynamic content
- **Context Indicators**: Visual feedback for active page content and selections
- **Smart Context Clearing**: Manual and automatic context management

### Enhanced User Experience
- **Model Indicator**: Real-time display of current AI model
- **Loading States**: Visual feedback during API calls
- **Error Handling**: User-friendly error messages and recovery
- **Auto-Resizing Input**: Text area adapts to message length
- **History Management**: Built-in chat history browser and management
- **Export Functionality**: Save conversations for later reference

## Development

This is a vanilla JavaScript Chrome extension with no build process required:

### Development Setup
1. **Load Extension**: Open `chrome://extensions/`, enable Developer mode, click "Load unpacked" and select the `chrome-extension/` folder
2. **Reload After Changes**: Click the reload button in `chrome://extensions/` after making code changes
3. **Debug Content Script**: Use Chrome DevTools on any webpage
4. **Debug Background Script**: Use "Inspect views" link in `chrome://extensions/`
5. **Debug Sidebar**: Right-click on sidebar and select "Inspect"

### Key Architecture Components
- **SNNChat Class**: Main application logic in `content/content.js`
- **Background Service Worker**: Extension lifecycle and keyboard shortcuts
- **Chrome Storage API**: Settings sync and local chat history storage
- **Dynamic Model Loading**: Real-time API integration with OpenAI and OpenRouter

### Testing
Test the extension manually by:
- Loading on various websites to verify context extraction
- Testing keyboard shortcuts and UI interactions
- Verifying API provider switching and model selection
- Checking responsive behavior across different screen sizes
- Testing per-domain chat history and session management

Any issues or bug reports → https://github.com/sinanisler/SNN-Chat/


## Privacy & Security

- **Local Storage**: API keys and chat history stored securely using Chrome's storage API
- **Minimal Data Transmission**: Data only sent to your chosen AI provider (OpenAI/OpenRouter)
- **Domain Isolation**: Chat history separated by domain for privacy
- **No Tracking**: No analytics, tracking, or data collection
- **Secure Communication**: All API calls use HTTPS encryption
- **User Control**: Complete control over data export and deletion

## Browser Compatibility

- Chrome (Manifest V3)
- Edge (Chromium-based)
- Other Chromium-based browsers

## License

This project is open source and available under the MIT License.
