# GitHub Copilot Instructions for SNN Chat

## Project Overview

SNN Chat is a Chrome extension that provides an AI-powered chat sidebar with advanced context awareness, per-domain chat history, and intelligent session management. The extension uses vanilla JavaScript with Chrome Manifest V3 and has **no build process** required.

## Technology Stack

- **Platform**: Chrome Extension (Manifest V3)
- **Language**: Vanilla JavaScript (ES6+)
- **APIs**: Chrome Extension APIs (storage, tabs, runtime, commands)
- **AI Integration**: OpenAI and OpenRouter APIs
- **Styling**: Pure CSS with theme support (Light/Dark/Auto)
- **Build Process**: None - files are loaded directly by Chrome

## Key Files and Architecture

### Main Components

- **`manifest.json`**: Chrome Extension configuration (Manifest V3)
- **`background/background.js`**: Service worker for extension lifecycle and keyboard shortcuts
- **`content/content.js`**: Main SNNChat class with sidebar logic, API integration, and chat functionality
- **`content/content.css`**: Complete sidebar styling with themes and responsive design
- **`sidebar/sidebar.html`**: Sidebar template with settings overlay

### Architecture Pattern

- **SNNChat Class**: Main application logic encapsulated in a single class
- **Chrome Storage API**: Used for settings sync and local chat history storage
- **Content Scripts**: Injected into all web pages to provide sidebar functionality
- **Background Service Worker**: Handles extension lifecycle and keyboard shortcuts

## Development Workflow

### No Build Process
This extension runs directly from source files without compilation or bundling:
1. Make code changes to JavaScript, CSS, or HTML files
2. Reload the extension in `chrome://extensions/` (click reload button)
3. Reload any web pages where you're testing the extension
4. Use Chrome DevTools for debugging

### Manual Testing Required
- Load extension on various websites to verify context extraction
- Test keyboard shortcuts and UI interactions
- Verify API provider switching and model selection
- Check responsive behavior across different screen sizes
- Test per-domain chat history and session management

### No Automated Tests
The project does not have automated tests. All verification is done through manual testing in Chrome.

## Coding Conventions

### JavaScript Style
- Use ES6+ class syntax for major components
- Use async/await for asynchronous operations
- Use arrow functions for callbacks and short functions
- Use template literals for string interpolation
- Use const/let, never var
- Keep functions focused and single-purpose
- Add descriptive comments for complex logic

### Chrome Extension Best Practices
- Always check if extension context is valid (`chrome?.runtime?.id`)
- Use `chrome.storage.sync` for settings that should sync across devices
- Use `chrome.storage.local` for large data like chat history
- Handle extension context invalidation gracefully
- Use proper message passing between content scripts and background scripts

### API Integration Patterns
- API calls are made directly from content scripts
- Support both OpenAI and OpenRouter providers
- Dynamic model loading from API providers
- Handle API errors with user-friendly messages
- Store API keys securely in Chrome storage

### CSS Organization
- All sidebar styles in `content/content.css`
- Use CSS custom properties for theming
- Support light, dark, and auto themes
- Responsive design with media queries
- Smooth animations for UI transitions

## Common Tasks

### Adding New Features
1. Update the SNNChat class in `content/content.js`
2. Add corresponding UI in `sidebar/sidebar.html` if needed
3. Update styles in `content/content.css` if needed
4. Update settings handling if new preferences are required
5. Test manually across different websites and scenarios

### Modifying Settings
1. Update the settings UI in the sidebar HTML
2. Update `getSettings()` and `saveSettings()` methods
3. Add default values for new settings
4. Update `applySettings()` to handle new preferences

### Updating API Integration
- API calls in content.js use fetch() directly
- Model lists are fetched dynamically from providers
- Response streaming is supported for real-time updates
- Handle rate limits and errors appropriately

## File Modification Guidelines

### DO:
- Make minimal, surgical changes to achieve the goal
- Preserve existing functionality when adding new features
- Follow the existing code style and patterns
- Update README.md if user-facing features change
- Test all changes manually in Chrome

### DON'T:
- Add build tools, bundlers, or transpilers (project is intentionally vanilla)
- Add automated testing frameworks (no test infrastructure exists)
- Break existing API patterns or storage structures
- Remove or modify working code unnecessarily
- Add external dependencies or libraries without strong justification

## Security and Privacy Considerations

- **Local Storage Only**: API keys and chat history stored locally using Chrome storage
- **No Tracking**: No analytics, tracking, or data collection
- **HTTPS Only**: All API calls must use HTTPS
- **Domain Isolation**: Chat history separated by domain for privacy
- **User Control**: Users have complete control over data export and deletion
- **Minimal Permissions**: Only request necessary Chrome permissions

## Version Management

- Version is stored in `manifest.json`
- GitHub Actions workflow handles releases (see `.github/workflows/release.yml`)
- Version bumping is automated when commit message contains 'release'
- Creates zip file and GitHub release automatically

## Common Pitfalls to Avoid

1. **Extension Context Invalidation**: Always check if `chrome.runtime.id` exists before using Chrome APIs
2. **Storage Limits**: Chrome storage has size limits; use local storage for large chat histories
3. **Content Security Policy**: Can't use inline scripts or eval() in extension pages
4. **Cross-Origin Requests**: Extension needs `host_permissions` for API calls
5. **Service Worker Lifecycle**: Background script can be terminated; don't rely on global state

## Testing Checklist

When making changes, verify:
- [ ] Extension loads without errors in `chrome://extensions/`
- [ ] Sidebar opens/closes via icon click and keyboard shortcut
- [ ] Chat functionality works with both OpenAI and OpenRouter
- [ ] Settings are saved and persisted correctly
- [ ] Theme changes apply correctly
- [ ] Per-domain chat history works properly
- [ ] Selected text context is captured correctly
- [ ] Page content extraction works on different websites
- [ ] No console errors in browser DevTools
- [ ] Extension works on different types of websites (static, SPA, etc.)

## Questions or Clarifications

If you're unsure about:
- **Code patterns**: Look at existing similar implementations in `content/content.js`
- **Chrome APIs**: Check the Chrome Extension documentation
- **Settings structure**: Review the `getSettings()` method for the full settings schema
- **UI layout**: Refer to `sidebar/sidebar.html` and `content/content.css`
- **Existing behavior**: Test manually in Chrome before making changes

## Getting Help

- Repository: https://github.com/sinanisler/snn-chat
- Chrome Extension API Docs: https://developer.chrome.com/docs/extensions/
- Issue Tracker: Use GitHub Issues at https://github.com/sinanisler/snn-chat/issues
- For bug reports or feature requests, create a new issue with detailed description and steps to reproduce
