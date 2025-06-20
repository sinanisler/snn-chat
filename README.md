# AI Chat Sidebar Chrome Extension

A Chrome extension that provides an AI-powered chat sidebar with fixed top-right positioning and full height display.

## Features

- **Fixed Top-Right Sidebar**: Full-height sidebar positioned at the top-right of any webpage
- **AI-Powered Chat**: Integrated with OpenAI's GPT models
- **Context Awareness**: Automatically reads page content and selected text
- **Keyboard Shortcuts**: Quick access with Ctrl+Shift+Y
- **Settings Panel**: Configurable API key, model selection, and parameters
- **Responsive Design**: Works on both desktop and mobile

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the `chrome-extension` folder
5. The extension will be installed and ready to use

## Setup

1. Click the extension icon or press `Ctrl+Shift+Y` to open the sidebar
2. Click "Settings" to configure your OpenAI API key
3. Get your API key from [OpenAI Platform](https://platform.openai.com/api-keys)
4. Save your settings and start chatting!

## Usage

### Opening the Sidebar
- Click the extension icon in the toolbar
- Use the keyboard shortcut `Ctrl+Shift+Y`
- Use the popup menu

### Chat Features
- Type your message and click "Send" or press `Ctrl+Enter`
- Select text on any webpage to provide context to the AI
- Clear chat history with the "Clear" button
- Access settings directly from the sidebar

### Keyboard Shortcuts
- `Ctrl+Shift+Y` - Toggle sidebar
- `Ctrl+Enter` - Send message (when typing in the chat input)

## File Structure

```
chrome-extension/
├── manifest.json           # Extension configuration
├── background/
│   └── background.js      # Background script for extension lifecycle
├── content/
│   ├── content.js         # Content script for sidebar injection
│   └── content.css        # Sidebar styling
├── sidebar/
│   └── sidebar.html       # Sidebar HTML template
├── popup/
│   ├── popup.html         # Extension popup interface
│   └── popup.js           # Popup functionality
├── options/
│   ├── options.html       # Settings page
│   └── options.js         # Settings management
└── assets/
    └── icons/             # Extension icons (add your own)
```

## Configuration

The extension supports the following settings:

- **API Key**: Your OpenAI API key (required)
- **Model**: Choose between GPT-3.5 Turbo, GPT-4, or GPT-4 Turbo
- **Max Tokens**: Maximum response length (100-2000)
- **Temperature**: Creativity level (0.0-1.0)

## Key Features

### Fixed Top-Right Positioning
- Sidebar is positioned at the top-right of the screen
- Full height (100vh) for maximum visibility
- Smooth slide-in animation
- Responsive design that adapts to different screen sizes

### Context Awareness
- Automatically extracts page content when no text is selected
- Shows selected text in a preview bubble
- Maintains chat history for context
- Clears context when needed

### User Experience
- Clean, modern interface
- Loading states and error handling
- Auto-resizing text input
- Scroll-to-bottom for new messages
- Keyboard navigation support

## Development

To modify or enhance the extension:

1. Make your changes to the relevant files
2. Reload the extension in `chrome://extensions/`
3. Test on various websites to ensure compatibility

## Privacy & Security

- API keys are stored locally using Chrome's storage API
- No data is sent to external servers except OpenAI's API
- All communication is handled securely
- No tracking or analytics

## Browser Compatibility

- Chrome (Manifest V3)
- Edge (Chromium-based)
- Other Chromium-based browsers

## License

This project is open source and available under the MIT License.