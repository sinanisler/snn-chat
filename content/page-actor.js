// ═══════════════════════════════════════════════════════════════════
// SNN Page Actor — Executes Agent Actions on the Web Page
// ═══════════════════════════════════════════════════════════════════
// Runs in content script context (full DOM access).
// Every action: validate → execute → report.
// Every error is caught, categorized, returned — NEVER silent.
// Supports: CSS selectors, :text("..."), :contains("..."),
//           :nth(sel,N), :xpath(...), :role(button,"Name"), :name("field")
// Prefer role/name/text over brittle CSS whenever possible.
// ═══════════════════════════════════════════════════════════════════

// ── DEBUG LOGGING ──────────────────────────────────────────────────
var SNN_D = {
  enabled: false,
  module: 'PageActor',
  _ts: () => new Date().toISOString().slice(11, 23),
  _fmt(o) {
    if (o === undefined) return 'undefined';
    if (o === null) return 'null';
    if (typeof o === 'string') return o.length > 200 ? o.slice(0, 200) + '…(' + o.length + ')' : o;
    if (o instanceof Error) return `[${o.name || 'Error'}] ${o.message}`;
    try { return JSON.stringify(o).slice(0, 500); } catch(e) { return String(o).slice(0, 500); }
  },
  log(...args) {
    if (!this.enabled) return;
    console.log(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#4fc3f7;font-weight:bold', '', ...args.map(a => this._fmt(a)));
  },
  warn(...args) {
    if (!this.enabled) return;
    console.warn(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ffb74d;font-weight:bold', '', ...args.map(a => this._fmt(a)));
  },
  error(...args) {
    console.error(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ef5350;font-weight:bold', '', ...args.map(a => this._fmt(a)));
  },
};
var D = SNN_D;

class SNNPageActor {
  constructor() {
    this._setupListener();
    D.log('INIT', { url: location.href, readyState: document.readyState });
  }

  // ── Message Listener ────────────────────────────────────────────
  _setupListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message.action || !message.action.startsWith('agent:')) return;
      D.log('← RECEIVED', message.action, { taskId: message.taskId, stepId: message.stepId, payload: message.payload, meta: message.meta });
      this._dispatch(message, sendResponse);
      return true; // keep channel open for async sendResponse
    });
  }

  async _dispatch(msg, sendResponse) {
    const { taskId, stepId, action, payload, meta } = msg;
    const startTime = performance.now();
    D.log('_dispatch START', action, { taskId, stepId, payload, meta });
    try {
      let result;
      switch (action) {
        case 'agent:click':            result = await this.click(payload.selector, payload.options); break;
        case 'agent:type':             result = await this.type(payload.selector, payload.text, payload.options); break;
        case 'agent:scroll':           result = await this.scroll(payload.direction, payload.amount, payload.options); break;
        case 'agent:pressKey':         result = this.pressKey(payload.key, payload.selector, payload.options); break;
        case 'agent:waitForElement':   result = await this.waitForElement(payload.selector, payload.timeout); break;
        case 'agent:wait':             result = await this.wait(payload.ms || 1000); break;
        case 'agent:mapPage':          result = this.mapPage(); break;
        default:
          return this._respond(sendResponse, false, { code: 'UNKNOWN_ACTION', message: `Unknown action: "${action}"`, retryable: false, suggestion: 'Check available actions.' }, stepId);
      }
      const duration = Math.round(performance.now() - startTime);
      D.log('_dispatch OK', action, { duration_ms: duration, result_keys: result ? Object.keys(result) : 'none' });
      this._respond(sendResponse, true, { ...result, _duration_ms: duration }, stepId);
    } catch (err) {
      const duration = Math.round(performance.now() - startTime);
      const catErr = this._categorizeError(err, action, payload, duration);
      D.error('_dispatch FAIL', action, { duration_ms: duration, error: err.message, stack: err.stack?.split('\n').slice(0,3).join(' | '), categorized: catErr });
      this._respond(sendResponse, false, catErr, stepId);
    }
  }

  _respond(sendResponse, success, data, stepId) {
    const response = {
      action: success ? 'agent:result' : 'agent:error',
      stepId, success,
      ...(success ? { result: data } : { error: data }),
      pageState: this._snapshotPageState()
    };
    D.log(success ? '→ RESPOND OK' : '→ RESPOND ERROR', { stepId, data_keys: Object.keys(data).join(','), pageState: response.pageState.url });
    try {
      sendResponse(response);
    } catch (e) { D.error('sendResponse failed:', e.message); }
  }

  // ═══════════════════════════════════════════════════════════════
  // ERROR CATEGORIZATION
  // ═══════════════════════════════════════════════════════════════
  _categorizeError(err, action, payload, duration) {
    const msg = err.message || String(err);
    const base = { detail: msg, duration_ms: duration };

    if (err.name === 'NotAllowedError' || /permission/i.test(msg))
      return { ...base, code: 'PERMISSION_DENIED', source: 'user', message: 'The page or browser denied permission.', retryable: false, suggestion: 'Grant the required permission and try again.' };

    if (/not found|no element|selector/i.test(msg))
      return { ...base, code: 'ELEMENT_NOT_FOUND', source: 'page', message: 'Could not find that element on the page.', selector: payload?.selector, retryable: true, suggestion: 'The page may have changed or not finished loading. Try again or describe the element differently.' };

    if (/not interactable|not visible|hidden|disabled/i.test(msg))
      return { ...base, code: 'ELEMENT_NOT_INTERACTABLE', source: 'page', message: 'Found the element, but it cannot be clicked or typed into.', selector: payload?.selector, retryable: true, suggestion: 'It may be hidden, disabled, or covered by something else.' };

    if (err.name === 'TimeoutError' || /timeout|timed out/i.test(msg))
      return { ...base, code: 'TIMEOUT', source: 'page', message: 'The page took too long to respond.', retryable: true, suggestion: 'The page may be slow or still loading. Try again.' };

    if (/network|fetch|NetworkError/i.test(msg))
      return { ...base, code: 'NETWORK_ERROR', source: 'network', message: 'A network request failed.', retryable: true, suggestion: 'Check your internet connection and try again.' };

    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError)
      return { ...base, code: 'SCRIPT_ERROR', source: 'extension', message: 'SNN hit an internal script error.', retryable: false, suggestion: 'This is a bug on our side — please copy the details and report it.' };

    if (/cross-origin|CORS|iframe/i.test(msg))
      return { ...base, code: 'CROSS_ORIGIN', source: 'page', message: 'This content is inside a cross-origin frame.', retryable: false, suggestion: 'Browser security prevents SNN from reaching elements inside cross-origin iframes.' };

    return { ...base, code: 'UNKNOWN', source: 'extension', message: 'Unexpected error.', retryable: true, suggestion: 'Try again or use a different approach. If it keeps happening, copy the details and report it.' };
  }

  // ═══════════════════════════════════════════════════════════════
  // ELEMENT RESOLUTION ENGINE
  // ═══════════════════════════════════════════════════════════════
  _resolveElement(selector, options = {}) {
    if (!selector) { D.warn('_resolveElement: empty selector!'); throw new Error('No selector provided'); }
    D.log('_resolveElement', { selector: selector.substring(0, 150), allowHidden: options.allowHidden });

    // :text("exact text") — tiered priority: most specific interactive elements first
    if (selector.startsWith(':text(')) {
      const text = selector.slice(6, -1).replace(/^["']|["']$/g, '');

      // Helper: find first visible element matching any of the given selectors whose
      // trimmed textContent equals `text`. Prefer elements with no interactive children.
      const findExact = (selList) => {
        for (const el of document.querySelectorAll(selList)) {
          if (el.textContent?.trim() === text && el.offsetParent !== null) {
            // Skip if this is a container whose child already matches (avoid <li> wrapping <a>)
            const hasInteractiveChild = el.querySelector('a, button, [role="button"], [role="link"]');
            if (hasInteractiveChild && hasInteractiveChild.textContent?.trim() === text) continue;
            return el;
          }
        }
        return null;
      };
      const findContains = (selList) => {
        for (const el of document.querySelectorAll(selList)) {
          if (el.textContent?.trim().toLowerCase().includes(text.toLowerCase()) && el.offsetParent !== null) {
            const hasInteractiveChild = el.querySelector('a, button, [role="button"], [role="link"]');
            if (hasInteractiveChild && hasInteractiveChild.textContent?.trim().toLowerCase().includes(text.toLowerCase())) continue;
            return el;
          }
        }
        return null;
      };

      // Tier 1: Most specific — <a>, <button>, .paginate_button, [role="link"] (exact match)
      let el = findExact('a, button, .paginate_button, [class*="pagination"] a, [class*="page"] a, nav a, .nav a, .menu a, header a');
      if (el) return el;

      // Tier 2: Role-based interactive elements (exact match)
      el = findExact('[role="button"], [role="link"], [role="menuitem"], [role="tab"]');
      if (el) return el;

      // Tier 3: Any leaf element (no children) with exact text
      for (const node of document.querySelectorAll('*')) {
        if (node.children.length === 0 && node.textContent?.trim() === text && node.offsetParent !== null) return node;
      }

      // Tier 4: Interactive elements with text containing the target (prioritize <a>, <button>)
      el = findContains('a, button, .paginate_button, [class*="pagination"] a, [class*="page"] a, nav a');
      if (el) return el;
      el = findContains('[role="button"], [role="link"], [onclick], [class*="btn"], [class*="button"], [class*="page"], [class*="pagination"], [class*="tab"]');
      if (el) return el;

      // Tier 5: Any standard text element
      for (const node of document.querySelectorAll('button, a, input, label, span, p, h1, h2, h3, h4, h5, h6, li, td, th')) {
        if (node.textContent?.trim().toLowerCase().includes(text.toLowerCase()) && node.offsetParent !== null) return node;
      }
      throw new Error(`No element found with text "${text}"`);
    }

    // :contains("partial text") — tiered priority same as :text()
    if (selector.startsWith(':contains(')) {
      const text = selector.slice(10, -1).replace(/^["']|["']$/g, '').toLowerCase();
      const candidates = [];

      const addCandidates = (selList, priority) => {
        for (const el of document.querySelectorAll(selList)) {
          if (el.textContent?.toLowerCase().includes(text) && el.offsetParent !== null) {
            // Skip containers whose interactive child also matches
            const hasInteractiveChild = el.querySelector('a, button, [role="button"], [role="link"]');
            if (hasInteractiveChild && hasInteractiveChild.textContent?.toLowerCase().includes(text)) continue;
            candidates.push({ el, priority, len: el.textContent.length });
          }
        }
      };

      // Tier 1: Most specific interactive
      addCandidates('a, button, .paginate_button, [class*="pagination"] a, [class*="page"] a, nav a, .nav a, .menu a, header a', 1);
      // Tier 2: Role-based
      addCandidates('[role="button"], [role="link"], [role="menuitem"], [role="tab"]', 2);
      // Tier 3: Broader interactive
      addCandidates('[onclick], [class*="btn"], [class*="button"], [class*="page"], [class*="pagination"], [class*="tab"]', 3);
      // Tier 4: Standard elements
      addCandidates('button, a, input, label, span, p, h1, h2, h3, h4, h5, h6, li, td, th, div', 4);

      candidates.sort((a, b) => a.priority - b.priority || a.len - b.len);
      if (candidates[0]) return candidates[0].el;
      throw new Error(`No element found containing "${text}"`);
    }

    // :nth(selector, N)
    if (selector.startsWith(':nth(')) {
      const inner = selector.slice(5, -1);
      const lastComma = inner.lastIndexOf(',');
      const sel = inner.slice(0, lastComma).trim();
      const idx = parseInt(inner.slice(lastComma + 1).trim()) - 1;
      const all = document.querySelectorAll(sel);
      if (all.length <= idx || idx < 0) throw new Error(`"${sel}" has ${all.length} matches (wanted #${idx + 1})`);
      return all[idx];
    }

    // :nthText("text", N) — find Nth occurrence of exact text (for pagination: "2" appearing multiple times)
    if (selector.startsWith(':nthText(')) {
      const inner = selector.slice(10, -1);
      const lastComma = inner.lastIndexOf(',');
      const text = inner.slice(0, lastComma).trim().replace(/^["']|["']$/g, '');
      const idx = parseInt(inner.slice(lastComma + 1).trim()) - 1;
      const matches = [];
      const interactiveSelectors = 'a, button, [role="button"], [role="link"], [onclick], ' +
        '.paginate_button, [class*="btn"], [class*="button"], [class*="page"], [class*="pagination"]';
      for (const el of document.querySelectorAll(interactiveSelectors)) {
        if (el.textContent?.trim() === text && el.offsetParent !== null) matches.push(el);
      }
      if (matches.length <= idx || idx < 0) throw new Error(`Found ${matches.length} interactive elements with text "${text}" (wanted #${idx + 1})`);
      return matches[idx];
    }

    // :xpath(...)
    if (selector.startsWith(':xpath(')) {
      const xpath = selector.slice(7, -1);
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (!result.singleNodeValue) throw new Error(`XPath "${xpath}" returned nothing`);
      return result.singleNodeValue;
    }

    // :role(button, "Name") — ARIA role + accessible name (preferred over CSS)
    if (selector.startsWith(':role(')) {
      const inner = selector.slice(6, -1);
      const parts = inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      const role = (parts[0] || '').toLowerCase();
      const name = (parts[1] || '').toLowerCase();

      // Map common ARIA roles to native elements
      const roleToNative = {
        button: 'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]',
        link: 'a[href], a:not([href]), [role="link"]',
        textbox: 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, [role="textbox"]',
        searchbox: 'input[type="search"], [role="searchbox"]',
        checkbox: 'input[type="checkbox"], [role="checkbox"]',
        radio: 'input[type="radio"], [role="radio"]',
        combobox: 'select, [role="combobox"]',
        listbox: 'select, [role="listbox"]',
        menuitem: '[role="menuitem"]',
        tab: '[role="tab"]',
        option: 'option, [role="option"]',
        switch: '[role="switch"], input[type="checkbox"]',
        heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]'
      };

      const query = roleToNative[role] || `[role="${role}"], ${role}`;
      const candidates = [];
      for (const el of document.querySelectorAll(query)) {
        if (!options.allowHidden && !(el.offsetParent || /^(BODY|HTML)$/i.test(el.tagName))) continue;
        const n = this._accessibleName(el).toLowerCase();
        if (!name) { candidates.push({ el, score: 1, len: n.length }); continue; }
        if (n === name) candidates.push({ el, score: 100, len: n.length });
        else if (n.includes(name)) candidates.push({ el, score: 70, len: n.length });
        else if (name.includes(n) && n.length >= 2) candidates.push({ el, score: 40, len: n.length });
      }
      candidates.sort((a, b) => b.score - a.score || a.len - b.len);
      if (candidates[0]) return candidates[0].el;
      throw new Error(`No element with role="${role}"${name ? ', name="' + name + '"' : ''}`);
    }

    // :name("fieldName") — form control name / id / aria-labelledby-ish match
    if (selector.startsWith(':name(')) {
      const name = selector.slice(6, -1).replace(/^["']|["']$/g, '');
      if (!name) throw new Error('Empty :name() selector');
      const lower = name.toLowerCase();

      // Exact name attribute
      let el = document.querySelector(`[name="${CSS.escape(name)}"]`);
      if (el && (el.offsetParent || options.allowHidden)) return el;

      // Exact id
      el = document.getElementById(name);
      if (el && (el.offsetParent || options.allowHidden)) return el;

      // Case-insensitive name/id/placeholder/aria-label scan on form controls
      for (const node of document.querySelectorAll('input, textarea, select, button, [contenteditable="true"]')) {
        if (!options.allowHidden && !node.offsetParent) continue;
        const attrs = [
          node.getAttribute('name'),
          node.id,
          node.getAttribute('placeholder'),
          node.getAttribute('aria-label'),
          node.getAttribute('title')
        ].filter(Boolean).map(s => s.toLowerCase());
        if (attrs.some(a => a === lower || a.includes(lower))) return node;
      }

      // Associated <label for="..."> text
      for (const label of document.querySelectorAll('label')) {
        const t = (label.textContent || '').trim().toLowerCase();
        if (!t.includes(lower)) continue;
        if (label.control && (label.control.offsetParent || options.allowHidden)) return label.control;
        const forId = label.getAttribute('for');
        if (forId) {
          const target = document.getElementById(forId);
          if (target && (target.offsetParent || options.allowHidden)) return target;
        }
      }

      throw new Error(`No form control matching name "${name}"`);
    }

    // Standard CSS
    try {
      const all = document.querySelectorAll(selector);
      if (all.length === 0) {
        D.warn('_resolveElement CSS: no matches for', selector);
        throw new Error(`No element matching "${selector}"`);
      }
      if (!options.allowHidden) {
        for (const el of all) {
          if (el.offsetParent || /^(BODY|HTML)$/i.test(el.tagName)) {
            D.log('_resolveElement OK (CSS)', { selector, tag: el.tagName, text: (el.textContent||'').trim().slice(0,60), visible: true });
            return el;
          }
        }
        D.warn('_resolveElement CSS: found but ALL hidden', { selector, total: all.length });
      }
      D.log('_resolveElement OK (CSS, allowHidden)', { selector, tag: all[0].tagName, text: (all[0].textContent||'').trim().slice(0,60) });
      return all[0];
    } catch (e) {
      if (/No element/.test(e.message)) throw e;
      D.error('_resolveElement CSS error', { selector, error: e.message });
      throw new Error(`Invalid selector "${selector}": ${e.message}`);
    }
  }

  /** Best-effort accessible name for role/name matching. */
  _accessibleName(el) {
    if (!el) return '';
    let labelledBy = '';
    const labelledByIds = el.getAttribute('aria-labelledby');
    if (labelledByIds) {
      labelledBy = labelledByIds.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
    }
    const raw =
      el.getAttribute('aria-label') ||
      labelledBy ||
      el.title ||
      el.getAttribute('placeholder') ||
      el.getAttribute('alt') ||
      el.getAttribute('name') ||
      ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') ? (el.value || '') : '') ||
      el.textContent ||
      '';
    return String(raw).trim().replace(/\s+/g, ' ').substring(0, 120);
  }

  _isInteractable(el) {
    if (!el?.isConnected) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  async _ensureInteractable(el, options = {}) {
    if (!el) throw new Error('Element is null');
    if (!options.skipScroll) { el.scrollIntoView({ behavior: 'instant', block: 'center' }); await this.wait(300); }
    if (!this._isInteractable(el)) {
      await this.wait(500);
      if (!this._isInteractable(el)) throw new Error(`Element not interactable: ${this._describeElement(el)}`);
    }
    return el;
  }

  _describeElement(el) {
    const tag = el.tagName?.toLowerCase() || '?';
    const id = el.id ? `#${el.id}` : '';
    const cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.split(' ').slice(0, 2).join('.') : '';
    const text = (el.textContent || '').trim().substring(0, 40);
    return `<${tag}${id}${cls}> "${text}"`;
  }

  _snapshotPageState() {
    return {
      url: location.href, title: document.title, domain: location.hostname,
      readyState: document.readyState, scrollY: Math.round(window.scrollY),
      viewportW: window.innerWidth, viewportH: window.innerHeight,
      timestamp: Date.now()
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Click — Multi-strategy for SPA/dynamic pages
  // ═══════════════════════════════════════════════════════════════
  async click(selector, options = {}) {
    D.log('click START', { selector });
    const el = this._resolveElement(selector, options);
    D.log('click resolved element', { tag: el.tagName, text: (el.textContent||'').trim().slice(0,50), id: el.id, class: (el.className||'').slice(0,40) });
    await this._ensureInteractable(el, options);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;

    let clicked = false;

    // ── Detect native click elements (browser handles navigation/submit natively) ──
    const tag = el.tagName.toLowerCase();
    const hasNativeClick = (tag === 'a' && el.href) || tag === 'button' ||
                           (tag === 'input' && (el.type === 'submit' || el.type === 'button' || el.type === 'reset'));

    if (hasNativeClick) {
      // ── Native elements: use ONLY native .click() — no synthetic double-fire ──
      try {
        if (el.focus) el.focus();
        el.click();
        clicked = true;
      } catch (e) { /* fall through to multi-strategy */ }
    }

    if (!clicked) {
      // ── Strategy 1: Full synthetic event sequence (works for vanilla JS & jQuery) ──
      try {
        for (const T of [['pointerdown', PointerEvent], ['mousedown', MouseEvent], ['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', MouseEvent]]) {
          el.dispatchEvent(new T[1](T[0], { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, view: window }));
        }
        clicked = true;
      } catch (e) { /* continue */ }

      // ── Strategy 2: Native .click() — triggers React/Vue synthetic handlers ──
      try {
        if (el.focus) el.focus();
        el.click();
        clicked = true;
      } catch (e) { /* some elements throw on .click() */ }
    }

    // ── Strategy 3: Click the closest interactive ancestor (handles icon-inside-button) ──
    if (!clicked || options.forceAncestor) {
      let ancestor = el.parentElement;
      for (let i = 0; i < 5 && ancestor; i++) {
        const tag = ancestor.tagName.toLowerCase();
        if (tag === 'a' || tag === 'button' || ancestor.getAttribute('role') === 'button' ||
            ancestor.getAttribute('onclick') || ancestor.classList.contains('paginate_button') ||
            /btn|button/i.test(ancestor.className || '')) {
          const ar = ancestor.getBoundingClientRect();
          const acx = ar.left + ar.width / 2, acy = ar.top + ar.height / 2;
          try {
            for (const T of [['pointerdown', PointerEvent], ['mousedown', MouseEvent], ['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', MouseEvent]]) {
              ancestor.dispatchEvent(new T[1](T[0], { bubbles: true, cancelable: true, clientX: acx, clientY: acy, button: 0, view: window }));
            }
            if (ancestor.focus) ancestor.focus();
            ancestor.click();
            clicked = true;
          } catch (e) { /* continue */ }
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }

    // ── Strategy 4: Keyboard activation (Enter/Space) — last resort for ARIA widgets ──
    if (!clicked) {
      try {
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true, view: window }));
        clicked = true;
      } catch (e) { /* continue */ }
    }

    await this.wait(300); // Wait longer for SPA re-renders
    return { action: 'click', element: this._describeElement(el), selector, strategyUsed: clicked ? 'success' : 'all-failed' };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Type — handles <input>, <textarea>, AND contenteditable divs
  // ═══════════════════════════════════════════════════════════════
  async type(selector, text, options = {}) {
    if (text == null) throw new Error('No text provided');
    D.log('type START', { selector, textLen: String(text).length, textPreview: String(text).substring(0, 60) });
    const el = this._resolveElement(selector, options);
    const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
    D.log('type resolved element', { tag: el.tagName, isContentEditable, type: el.type, placeholder: el.placeholder, name: el.name, id: el.id });
    await this._ensureInteractable(el, options);

    // ── <select> — the one control a click cannot operate ──────────
    // The option popup a native <select> opens is drawn by the OS, not the
    // DOM, so there is nothing for a follow-up click to target and nothing
    // for mapPage to see. Setting the value here is the only way in.
    if (el.tagName === 'SELECT') {
      await this._setSelectValue(el, String(text));
      await this.wait(150);
      return { action: 'type', element: this._describeElement(el), selector, contentType: 'select', selectedValue: el.value };
    }

    // ── Checkbox / radio — "type" the desired state ────────────────
    // Click toggles, which means the model has to know the current state to
    // reach a target state. Setting it directly is idempotent: asking for
    // "true" twice leaves it checked, where two clicks would undo the first.
    if (el.type === 'checkbox' || el.type === 'radio') {
      const want = text === true || /^(true|yes|on|checked|1)$/i.test(String(text));
      if (el.checked !== want) {
        el.click();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await this.wait(150);
      return { action: 'type', element: this._describeElement(el), selector, contentType: el.type, checked: el.checked };
    }

    el.focus();
    const str = String(text);

    // ── ContentEditable DIVs (X/Twitter, LinkedIn, Gmail, Notion, Slack, etc.) ──
    if (isContentEditable) {
      // ── Clear existing content if requested (via native editing pipeline) ──
      if (options.clearFirst || options.replace) {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      }

      // ── Ensure cursor is inside the editable element ──
      el.focus();
      const sel = window.getSelection();
      if (!sel || !el.contains(sel.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel && sel.removeAllRanges();
        sel && sel.addRange(range);
      }

      // ── Insert text via execCommand — the ONLY reliable way ──
      // execCommand fires native beforeinput+input events that React/Draft.js
      // intercept internally. Do NOT dispatch extra events here — that would
      // cause Draft.js to double-process and duplicate the content.
      if (options.slow) {
        for (const ch of str) {
          document.execCommand('insertText', false, ch);
          await this.wait(35 + Math.random() * 40);
        }
      } else {
        document.execCommand('insertText', false, str);
      }

      if (options.blurAfter) { el.blur(); }
      await this.wait(150);
      return { action: 'type', element: this._describeElement(el), selector, textLength: str.length, contentType: 'contenteditable' };
    }

    // ── Traditional <input> / <textarea> ──
    if (options.clearFirst || options.replace) {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (options.slow) {
      for (const ch of str) {
        el.value += ch;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        await this.wait(35 + Math.random() * 40);
      }
    } else {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, str);
      else el.value = str;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (options.blurAfter) { el.blur(); el.dispatchEvent(new Event('blur', { bubbles: true })); }
    await this.wait(100);
    return { action: 'type', element: this._describeElement(el), selector, textLength: str.length, contentType: 'input' };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Scroll
  // ═══════════════════════════════════════════════════════════════
  async scroll(direction = 'down', amount = 500, options = {}) {
    const b = options.smooth ? 'smooth' : 'instant';
    switch (direction) {
      case 'down':  window.scrollBy({ top: amount, behavior: b }); break;
      case 'up':    window.scrollBy({ top: -amount, behavior: b }); break;
      case 'right': window.scrollBy({ left: amount, behavior: b }); break;
      case 'left':  window.scrollBy({ left: -amount, behavior: b }); break;
      case 'top':   window.scrollTo({ top: 0, behavior: b }); break;
      case 'bottom':window.scrollTo({ top: document.documentElement.scrollHeight, behavior: b }); break;
      default: throw new Error(`Unknown direction "${direction}". Use: up/down/left/right/top/bottom`);
    }
    await this.wait(300);
    return { action: 'scroll', direction, amount, scrollY: window.scrollY, maxScroll: document.documentElement.scrollHeight - window.innerHeight };
  }

  async _setSelectValue(selectEl, value) {
    const opts = Array.from(selectEl.options);
    let m = opts.find(o => o.value === value || o.textContent?.trim() === value);
    if (!m) { const lo = value.toLowerCase(); m = opts.find(o => o.value?.toLowerCase() === lo || o.textContent?.trim().toLowerCase() === lo); }
    if (!m) { const lo = value.toLowerCase(); m = opts.find(o => o.textContent?.toLowerCase().includes(lo)); }
    if (!m) throw new Error(`No option matching "${value}". Options: ${opts.map(o => o.textContent?.trim()).join(', ')}`);
    selectEl.value = m.value;
    selectEl.dispatchEvent(new Event('input', { bubbles: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Press Key
  // ═══════════════════════════════════════════════════════════════
  pressKey(key, selector = null, options = {}) {
    // No selector means "send it wherever the user's cursor is" — which is
    // document.activeElement, not document.body. Enter after typing into a
    // search box has to reach that box to submit it; dispatching on body
    // bubbles to nothing and the form never fires.
    const target = selector
      ? this._resolveElement(selector, { ...options, allowHidden: true })
      : (document.activeElement || document.body);
    if (selector) target.focus?.();
    for (const evt of ['keydown', 'keypress', 'keyup'])
      target.dispatchEvent(new KeyboardEvent(evt, { key, code: key, bubbles: true, cancelable: true }));
    return { action: 'pressKey', key, target: selector || this._describeElement(target) };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Wait
  // ═══════════════════════════════════════════════════════════════
  wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async waitForElement(selector, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { const el = this._resolveElement(selector); if (el) return { found: true, timeMs: Date.now() - start, element: this._describeElement(el) }; }
      catch (e) { /* not found */ }
      await this.wait(100);
    }
    throw new Error(`Element "${selector}" did not appear within ${timeout}ms`);
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Map Page — Real-Time Accessibility Tree Snapshot
  // Builds a complete, framework-agnostic map of every interactive
  // element on screen. Uses accessibility roles + bounding boxes —
  // works on React, Vue, Svelte, Web Components, everything.
  // The LLM uses this map to "see" the page before interacting.
  // ═══════════════════════════════════════════════════════════════
  mapPage() {
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
      'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'option',
      'slider', 'spinbutton', 'heading', 'img', 'separator'
    ]);

    // ── Helper: compute the most specific accessible role ──
    const computeRole = (el) => {
      const explicit = (el.getAttribute('role') || '').toLowerCase().trim();
      if (explicit && interactiveRoles.has(explicit)) return explicit;

      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();

      if (tag === 'button' || type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (tag === 'a' && el.href) return 'link';
      if (tag === 'a' && !el.href) return 'link'; // SPA router links
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'search') return 'searchbox';
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') return null;
        return 'textbox';
      }
      if (tag === 'select') return 'combobox';
      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return 'textbox';
      if (el.hasAttribute('onclick') || el.getAttribute('ng-click') || el.getAttribute('@click')) return 'button';

      // Heuristic: cursor:pointer on non-container elements suggests clickable
      try {
        const cs = window.getComputedStyle(el);
        if (cs.cursor === 'pointer' && el.children.length === 0) return 'button';
      } catch (e) { /* cross-origin iframe */ }

      return null;
    };

    // ── Helper: accessible name (ARIA label, label[for], placeholder, text) ──
    const accName = (el) => {
      const label = (el.getAttribute('aria-label') || '').trim();
      if (label) return label;

      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\s+/)
          .map(id => (document.getElementById(id)?.textContent || '')).join(' ').trim();
        if (text) return text;
      }

      if (el.id) {
        const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (labelEl) { const t = (labelEl.textContent || '').trim(); if (t) return t; }
      }

      const wrapLabel = el.closest?.('label');
      if (wrapLabel) { const t = (wrapLabel.textContent || '').trim(); if (t && t.length < 120) return t; }

      const ph = (el.getAttribute('placeholder') || '').trim();
      if (ph) return ph;

      const title = (el.getAttribute('title') || '').trim();
      if (title) return title;

      const alt = (el.getAttribute('alt') || '').trim();
      if (alt) return alt;

      // Leaf element: use its own text
      if (!el.children || el.children.length === 0) {
        const txt = (el.textContent || '').trim();
        if (txt && txt.length <= 80) return txt;
      }

      const txt = (el.textContent || '').trim();
      if (txt && txt.length <= 80) return txt;

      return '';
    };

    // ── Helper: is element visible in the current viewport? ──
    const isVisible = (el) => {
      if (!el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (r.bottom < -50 || r.top > window.innerHeight + 50) return false;
      if (r.right < -50 || r.left > window.innerWidth + 50) return false;
      try {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      } catch (e) { return false; }
      return true;
    };

    // ── Walk all elements including Shadow DOM, collect interactive ones ──
    const elements = [];
    const seen = new Set();

    const walkDOM = (root) => {
      if (elements.length >= 150) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode()) && elements.length < 150) {
        const el = node;
        if (!isVisible(el)) continue;

        const role = computeRole(el);
        if (!role) continue;

        const name = accName(el);
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();

        const dedupKey = `${role}|${name}|${Math.round(rect.x)},${Math.round(rect.y)}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        elements.push({
          id: `e${elements.length}`,
          role,
          name: name.substring(0, 100),
          tag,
          rect: {
            x: Math.round(rect.x + window.scrollX),
            y: Math.round(rect.y + window.scrollY),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          },
          isContentEditable: !!(el.isContentEditable || el.getAttribute('contenteditable') === 'true'),
          disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          checked: !!el.checked || undefined,
          href: (el.href || '').substring(0, 200) || undefined,
          type: el.getAttribute('type') || undefined
        });

        // Recurse into shadow roots (Web Components)
        if (el.shadowRoot) walkDOM(el.shadowRoot);
      }
    };

    walkDOM(document.documentElement);

    return {
      action: 'mapPage',
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollY: Math.round(window.scrollY),
      elementCount: elements.length,
      elements
    };
  }

}

// ── Instantiate ────────────────────────────────────────────────────
if (chrome?.runtime?.id) {
  // Ensure page-actor runs alongside existing content script classes
  if (!window.__snnPageActor) {
    window.__snnPageActor = new SNNPageActor();
  }
}

// ── Debug mode: read settings & listen for changes ──────────────
(async function _initDebugMode() {
  try {
    const { settings } = await chrome.storage.local.get(['settings']);
    SNN_D.enabled = settings?.debugLogging === true;
  } catch (e) { /* ignore */ }
})();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    SNN_D.enabled = changes.settings.newValue?.debugLogging === true;
  }
});
