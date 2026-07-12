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
  enabled: true,
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
    this._highlights = [];
    this._pickerActive = false;
    this._pickerResolve = null;
    this._pickerHandlers = null;
    this._monitors = new Map();
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
        case 'agent:scrollToElement':  result = await this.scrollToElement(payload.selector, payload.options); break;
        case 'agent:highlight':        result = await this.highlight(payload.selector, payload.options); break;
        case 'agent:clearHighlights':  this.clearHighlights(); result = { cleared: true }; break;
        case 'agent:findElements':     result = this.findElements(payload.selector, payload.options); break;
        case 'agent:getPageInfo':      result = this.getPageInfo(); break;
        case 'agent:startPicker':      result = await this.startPicker(payload.options); break;
        case 'agent:stopPicker':       this.stopPicker(); result = { stopped: true }; break;
        case 'agent:fillForm':         result = await this.fillForm(payload.fields, payload.options); break;
        case 'agent:selectDropdown':   result = await this.selectDropdown(payload.selector, payload.value, payload.options); break;
        case 'agent:checkToggle':      result = await this.checkToggle(payload.selector, payload.checked, payload.options); break;
        case 'agent:pressKey':         result = this.pressKey(payload.key, payload.selector, payload.options); break;
        case 'agent:hover':            result = await this.hoverElement(payload.selector, payload.options); break;
        case 'agent:waitForElement':   result = await this.waitForElement(payload.selector, payload.timeout); break;
        case 'agent:wait':             result = await this.wait(payload.ms || 1000); break;
        case 'agent:extractTable':     result = this.extractTable(payload.selector, payload.options); break;
        case 'agent:getElementText':   result = this.getElementText(payload.selector); break;
        case 'agent:page_script':       result = await this.page_script(payload.code, payload.options); break;
        case 'agent:getClipboard':     result = { text: await this.getClipboard() }; break;
        case 'agent:copyToClipboard':  await this.copyToClipboard(payload.text); result = { copied: true }; break;
        case 'agent:getViewportInfo':  result = this.getViewportInfo(); break;
        case 'agent:startMonitoring':  result = this.startMonitoring(payload.selector, payload.options); break;
        case 'agent:stopMonitoring':   this.stopMonitoring(); result = { stopped: true }; break;
        case 'agent:scrollAndAct':     result = await this.scrollAndAct(payload.selector, payload.options); break;
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
      sendResponse({
        action: success ? 'agent:result' : 'agent:error',
        stepId, success,
        ...(success ? { result: data } : { error: data }),
        pageState: this._snapshotPageState()
      });
    } catch (e) { D.error('sendResponse failed:', e.message); }
  }

  // ═══════════════════════════════════════════════════════════════
  // ERROR CATEGORIZATION
  // ═══════════════════════════════════════════════════════════════
  _categorizeError(err, action, payload, duration) {
    const msg = err.message || String(err);
    const base = { detail: msg, duration_ms: duration };

    if (err.name === 'NotAllowedError' || /permission/i.test(msg))
      return { ...base, code: 'PERMISSION_DENIED', message: 'Permission denied.', retryable: false, suggestion: 'Grant the required permission and try again.' };

    if (/not found|no element|selector/i.test(msg))
      return { ...base, code: 'ELEMENT_NOT_FOUND', message: 'Element not found.', selector: payload?.selector, retryable: true, suggestion: 'Try a different selector or wait for the element to appear.' };

    if (/not interactable|not visible|hidden|disabled/i.test(msg))
      return { ...base, code: 'ELEMENT_NOT_INTERACTABLE', message: 'Element not interactable.', selector: payload?.selector, retryable: true, suggestion: 'Element may be hidden or disabled. Try scrolling to it first.' };

    if (err.name === 'TimeoutError' || /timeout|timed out/i.test(msg))
      return { ...base, code: 'TIMEOUT', message: 'Action timed out.', retryable: true, suggestion: 'The page may be slow. Try again or increase timeout.' };

    if (/network|fetch|NetworkError/i.test(msg))
      return { ...base, code: 'NETWORK_ERROR', message: 'Network error.', retryable: true, suggestion: 'Check your connection and try again.' };

    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError)
      return { ...base, code: 'SCRIPT_ERROR', message: 'Script error during execution.', retryable: false, suggestion: 'This may be a bug. Please report it.' };

    if (/cross-origin|CORS|iframe/i.test(msg))
      return { ...base, code: 'CROSS_ORIGIN', message: 'Cannot access cross-origin content.', retryable: false, suggestion: 'SNN cannot interact with elements inside cross-origin iframes.' };

    return { ...base, code: 'UNKNOWN', message: 'Unexpected error.', retryable: true, suggestion: 'Try again or use a different approach.' };
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

  _buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = []; let current = el;
    while (current && current !== document.body && current !== document.documentElement && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break; }
      if (typeof current.className === 'string') {
        const cls = current.className.trim().split(/\s+/).filter(c => c && !c.startsWith('snn-')).slice(0, 2);
        for (const c of cls) part += '.' + CSS.escape(c);
      }
      if (current.parentElement) {
        const same = Array.from(current.parentElement.children).filter(c => c.tagName === current.tagName);
        if (same.length > 1) part += `:nth-child(${same.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  _getKeyAttributes(el) {
    const a = {};
    for (const k of ['aria-label','title','role','name','data-testid','data-id','href','src','alt','type','placeholder','value']) {
      const v = el.getAttribute(k); if (v) a[k] = v;
    }
    return a;
  }

  _didPageChange() { return false; } // placeholder for mutation-based detection

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
  // ACTION: Type
  // ═══════════════════════════════════════════════════════════════
  async type(selector, text, options = {}) {
    if (text == null) throw new Error('No text provided');
    D.log('type START', { selector, textLen: String(text).length, textPreview: String(text).substring(0, 60) });
    const el = this._resolveElement(selector, options);
    D.log('type resolved element', { tag: el.tagName, type: el.type, placeholder: el.placeholder, name: el.name, id: el.id });
    await this._ensureInteractable(el, options);
    el.focus();
    const str = String(text);

    if (options.clearFirst || options.replace) {
      // Use native setter for React controlled inputs
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
    return { action: 'type', element: this._describeElement(el), selector, textLength: str.length };
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

  async scrollToElement(selector, options = {}) {
    const el = this._resolveElement(selector, { ...options, allowHidden: true });
    el.scrollIntoView({ behavior: options.smooth ? 'smooth' : 'instant', block: 'center' });
    await this.wait(300);
    return { action: 'scrollToElement', element: this._describeElement(el), selector, scrollY: window.scrollY };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Highlight
  // ═══════════════════════════════════════════════════════════════
  async highlight(selector, options = {}) {
    const el = this._resolveElement(selector, { ...options, allowHidden: true });
    const color = options.color || '#0556c7';
    const r = el.getBoundingClientRect();

    const overlay = document.createElement('div');
    overlay.dataset.snnHighlight = 'true';
    overlay.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;left:${r.left+window.scrollX}px;top:${r.top+window.scrollY}px;width:${r.width}px;height:${r.height}px;border:3px solid ${color};border-radius:4px;background:${color}22;box-shadow:0 0 15px ${color}44;animation:snn-pulse 1.5s ease-in-out infinite;`;

    const label = document.createElement('div');
    label.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;left:${r.left+window.scrollX}px;top:${r.top+window.scrollY-28}px;background:${color};color:#fff;padding:3px 8px;border-radius:4px;font-size:12px;font-family:-apple-system,sans-serif;font-weight:600;white-space:nowrap;`;
    label.textContent = options.label || el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');

    if (!document.getElementById('snn-highlight-css')) {
      const s = document.createElement('style'); s.id = 'snn-highlight-css';
      s.textContent = `@keyframes snn-pulse{0%,100%{box-shadow:0 0 10px ${color}44;}50%{box-shadow:0 0 25px ${color}88;}}`;
      document.head.appendChild(s);
    }

    document.body.appendChild(overlay);
    document.body.appendChild(label);

    const up = () => {
      const nr = el.getBoundingClientRect();
      overlay.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;left:${nr.left+window.scrollX}px;top:${nr.top+window.scrollY}px;width:${nr.width}px;height:${nr.height}px;border:3px solid ${color};border-radius:4px;background:${color}22;box-shadow:0 0 15px ${color}44;animation:snn-pulse 1.5s ease-in-out infinite;`;
      label.style.left = (nr.left + window.scrollX) + 'px';
      label.style.top = (nr.top + window.scrollY - 28) + 'px';
    };
    const onScroll = () => requestAnimationFrame(up);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    this._highlights.push({ overlay, label, _cleanup: () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); } });
    return { action: 'highlight', element: this._describeElement(el), selector, count: this._highlights.length };
  }

  clearHighlights() {
    for (const h of this._highlights) { h.overlay.remove(); h.label.remove(); if (h._cleanup) h._cleanup(); }
    this._highlights = [];
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Find Elements
  // ═══════════════════════════════════════════════════════════════
  findElements(selector, options = {}) {
    const limit = options.limit || 50;
    const all = document.querySelectorAll(selector);
    const results = [];
    for (let i = 0; i < Math.min(all.length, limit); i++) {
      const el = all[i], r = el.getBoundingClientRect();
      results.push({
        index: i + 1, tag: el.tagName.toLowerCase(), id: el.id || null,
        className: typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join(' ') : null,
        text: (el.textContent || '').trim().substring(0, 100),
        href: el.href || null, type: el.type || null, placeholder: el.placeholder || null,
        value: el.value || null, visible: el.offsetParent !== null,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        attributes: this._getKeyAttributes(el)
      });
    }
    return { action: 'findElements', selector, total: all.length, returned: results.length, elements: results };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Page Info
  // ═══════════════════════════════════════════════════════════════
  getPageInfo() {
    return {
      action: 'getPageInfo', url: location.href, title: document.title, domain: location.hostname, readyState: document.readyState,
      forms: document.forms.length, links: document.links.length, images: document.images.length,
      inputs: document.querySelectorAll('input, textarea, select').length,
      buttons: document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').length,
      headings: { h1: document.querySelectorAll('h1').length, h2: document.querySelectorAll('h2').length, h3: document.querySelectorAll('h3').length },
      viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: Math.round(window.scrollY), maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight) }
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Element Picker
  // ═══════════════════════════════════════════════════════════════
  async startPicker(options = {}) {
    if (this._pickerActive) this.stopPicker();
    this._pickerActive = true;
    return new Promise((resolve) => {
      this._pickerResolve = resolve;
      const cursor = document.createElement('div');
      cursor.id = 'snn-picker-cursor';
      cursor.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;width:30px;height:30px;border:3px dashed #0556c7;border-radius:50%;transform:translate(-50%,-50%);display:none;';
      document.body.appendChild(cursor);
      let hoveredEl = null, hoverOverlay = null;

      const onMove = (e) => {
        cursor.style.display = 'block'; cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px';
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el !== hoveredEl && el !== cursor && !el.closest('#snn-picker-cursor')) {
          if (hoverOverlay) hoverOverlay.remove();
          hoveredEl = el;
          const r = el.getBoundingClientRect();
          hoverOverlay = document.createElement('div');
          hoverOverlay.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid #0556c7;background:rgba(5,86,199,0.08);border-radius:3px;`;
          document.body.appendChild(hoverOverlay);
        }
      };

      const onClick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el !== cursor) {
          const info = { tag: el.tagName.toLowerCase(), id: el.id || null, className: typeof el.className === 'string' ? el.className : null, text: (el.textContent || '').trim().substring(0, 200), href: el.href || null, selector: this._buildSelector(el), attributes: this._getKeyAttributes(el), rect: el.getBoundingClientRect() };
          this._cleanupPicker();
          resolve({ action: 'startPicker', picked: info });
        }
      };

      const onKey = (e) => { if (e.key === 'Escape') { this._cleanupPicker(); resolve({ action: 'startPicker', cancelled: true }); } };

      this._pickerHandlers = { onMove, onClick, onKey, cursor, hoverOverlay: () => hoverOverlay };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      document.body.style.cursor = 'crosshair';
      setTimeout(() => { if (this._pickerActive) { this._cleanupPicker(); resolve({ action: 'startPicker', timeout: true }); } }, options.timeout || 30000);
    });
  }

  _cleanupPicker() {
    if (!this._pickerActive) return;
    const h = this._pickerHandlers;
    if (h) {
      document.removeEventListener('mousemove', h.onMove, true);
      document.removeEventListener('click', h.onClick, true);
      document.removeEventListener('keydown', h.onKey, true);
      if (h.cursor) h.cursor.remove();
      const ho = h.hoverOverlay(); if (ho) ho.remove();
    }
    this._pickerHandlers = null;
    this._pickerActive = false;
    document.body.style.cursor = '';
  }

  stopPicker() {
    if (this._pickerActive) {
      this._cleanupPicker();
      if (this._pickerResolve) { this._pickerResolve({ action: 'startPicker', cancelled: true }); this._pickerResolve = null; }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Fill Form (batch)
  // ═══════════════════════════════════════════════════════════════
  async fillForm(fields, options = {}) {
    if (!Array.isArray(fields)) throw new Error('fields must be an array');
    const results = [];
    for (const f of fields) {
      try {
        const el = this._resolveElement(f.selector, options);
        await this._ensureInteractable(el, options);
        if (el.tagName === 'SELECT') {
          await this._setSelectValue(el, f.value);
          results.push({ selector: f.selector, success: true, action: 'select' });
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          const want = f.value === true || f.value === 'true' || f.value === 'checked';
          if (el.checked !== want) { el.click(); el.dispatchEvent(new Event('change', { bubbles: true })); }
          results.push({ selector: f.selector, success: true, action: 'toggle' });
        } else {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, String(f.value));
          else el.value = String(f.value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ selector: f.selector, success: true, action: 'type' });
        }
      } catch (err) { results.push({ selector: f.selector, success: false, error: err.message }); }
    }
    await this.wait(200);
    return { action: 'fillForm', total: fields.length, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results };
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
  // ACTION: Select Dropdown
  // ═══════════════════════════════════════════════════════════════
  async selectDropdown(selector, value, options = {}) {
    const el = this._resolveElement(selector, options);
    await this._ensureInteractable(el, options);
    await this._setSelectValue(el, value);
    return { action: 'selectDropdown', element: this._describeElement(el), selector, selectedValue: el.value };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Check/Toggle
  // ═══════════════════════════════════════════════════════════════
  async checkToggle(selector, checked = true, options = {}) {
    const el = this._resolveElement(selector, options);
    await this._ensureInteractable(el, options);
    if (el.checked !== checked) { el.click(); el.dispatchEvent(new Event('change', { bubbles: true })); }
    return { action: 'checkToggle', element: this._describeElement(el), selector, checked: el.checked };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Press Key
  // ═══════════════════════════════════════════════════════════════
  pressKey(key, selector = null, options = {}) {
    const target = selector ? this._resolveElement(selector, { ...options, allowHidden: true }) : document.body;
    for (const evt of ['keydown', 'keypress', 'keyup'])
      target.dispatchEvent(new KeyboardEvent(evt, { key, code: key, bubbles: true, cancelable: true }));
    return { action: 'pressKey', key, target: selector || 'body' };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Hover
  // ═══════════════════════════════════════════════════════════════
  async hoverElement(selector, options = {}) {
    const el = this._resolveElement(selector, options);
    await this._ensureInteractable(el, options);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (const evt of ['mouseenter', 'mouseover', 'mousemove'])
      el.dispatchEvent(new MouseEvent(evt, { bubbles: true, clientX: cx, clientY: cy }));
    await this.wait(200);
    return { action: 'hover', element: this._describeElement(el), selector };
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
  // ACTION: Extract Table
  // ═══════════════════════════════════════════════════════════════
  extractTable(selector, options = {}) {
    const table = selector ? this._resolveElement(selector, { allowHidden: true }) : document.querySelector('table');
    if (!table || table.tagName !== 'TABLE') throw new Error(`No table found matching "${selector || 'table'}"`);
    const headers = [];
    const hRow = table.querySelector('thead tr, tr:first-child');
    if (hRow) hRow.querySelectorAll('th, td').forEach(c => headers.push(c.textContent.trim()));
    const rows = [];
    const bRows = table.querySelectorAll('tbody tr, tr');
    for (const row of bRows) {
      if (row === hRow) continue;
      const cells = []; row.querySelectorAll('td, th').forEach(c => cells.push(c.textContent.trim()));
      if (cells.length) rows.push(cells);
    }
    return { action: 'extractTable', selector, headers, rowCount: rows.length, rows };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Get Element Text
  // ═══════════════════════════════════════════════════════════════
  getElementText(selector) {
    const el = this._resolveElement(selector, { allowHidden: true });
    return { action: 'getElementText', selector, text: el.textContent?.trim() || '', element: this._describeElement(el) };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Page Script (content-script fallback)
  // Primary execution path: agent:page_script is routed to background.js
  // which uses chrome.scripting.executeScript(world:'MAIN') to bypass CSP.
  // This method remains as a direct-call fallback for internal use.
  // ═══════════════════════════════════════════════════════════════
  async page_script(code, options = {}) {
    if (!code) { D.warn('page_script: no code provided'); throw new Error('No code provided'); }
    D.log('page_script EXECUTE', { codeLen: code.length, codePreview: code.substring(0, 200), options });
    try {
      const fn = new Function('document', 'window', 'options', code);
      const result = await fn(document, window, options);
      D.log('page_script OK', { resultType: typeof result, resultPreview: typeof result === 'string' ? result.substring(0, 200) : String(result).substring(0, 200) });
      return { action: 'page_script', result };
    } catch (e) {
      D.error('page_script FAIL', { error: e.message, stack: e.stack?.split('\n').slice(0,4).join(' | '), codeSnippet: code.substring(0, 300) });
      throw new Error(`Script error: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Clipboard
  // ═══════════════════════════════════════════════════════════════
  async getClipboard() {
    try { return await navigator.clipboard.readText(); }
    catch (e) { throw new Error('Cannot read clipboard. The page may not have clipboard permission.'); }
  }

  async copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) { throw new Error('Cannot write to clipboard.'); }
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Viewport Info
  // ═══════════════════════════════════════════════════════════════
  getViewportInfo() {
    return {
      action: 'getViewportInfo',
      width: window.innerWidth, height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY),
      maxScrollX: Math.round(document.documentElement.scrollWidth - window.innerWidth),
      maxScrollY: Math.round(document.documentElement.scrollHeight - window.innerHeight),
      darkMode: window.matchMedia('(prefers-color-scheme: dark)').matches
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Scroll & Act — autonomous scroll→find→act loop for
  // virtual-list / infinite-scroll / lazy-rendering pages.
  // Scrolls through the page, waits for new content to render,
  // finds fresh matching elements, acts on them, tracks processed
  // items to avoid duplicates. Returns summary when done.
  // ═══════════════════════════════════════════════════════════════
  async scrollAndAct(selector, options = {}) {
    const {
      maxItems     = 50,
      maxScrolls   = 40,
      clickDelay   = 400,          // ms between actions
      clickJitter  = 600,          // random extra ms added to clickDelay
      scrollPause  = 1200,         // ms to wait for render after scroll
      scrollAmount = 0.75,         // fraction of viewport height per scroll
      containerSelector = null,    // element to observe for mutations (auto-detect if null)
      dedupAttr    = 'data-snn-done',
      expandSelector = null,       // selector for "show more" / "load more" buttons to click
      action       = 'click',      // 'click' | 'extract'
      stopWhen     = null,         // optional JS expression run per item; return true to stop
      maxEmptyScrolls = 3          // consecutive scrolls with zero new items before giving up
    } = options;

    let acted = 0, scrolls = 0, emptyStreak = 0;
    const processed = new WeakSet(); // track elements across re-renders where possible

    // ── Resolve container ──────────────────────────────────────
    let container = containerSelector
      ? document.querySelector(containerSelector)
      : null;
    if (!container) {
      // Auto-detect: prefer a scrollable feed/thread container
      const candidates = document.querySelectorAll(
        '[role="feed"], [role="list"], [id*="content"], [id*="items"], [id*="results"], [class*="feed"], [class*="thread"], [class*="items"], main, article'
      );
      for (const c of candidates) {
        if (c.scrollHeight > window.innerHeight * 2) { container = c; break; }
      }
      if (!container) container = document.body;
    }

    // ── Helpers ────────────────────────────────────────────────
    const findFresh = () => {
      const all = document.querySelectorAll(selector);
      const fresh = [];
      for (const el of all) {
        if (processed.has(el)) continue;
        if (!el.offsetParent) continue;
        // Also skip if any ancestor is marked done (catches re-rendered subtrees)
        let ancestor = el.parentElement;
        let ancestorDone = false;
        for (let i = 0; i < 8 && ancestor; i++) {
          if (ancestor.hasAttribute?.(dedupAttr)) { ancestorDone = true; break; }
          ancestor = ancestor.parentElement;
        }
        if (ancestorDone) continue;
        fresh.push(el);
      }
      return fresh;
    };

    const markDone = (el) => {
      processed.add(el);
      try { el.setAttribute(dedupAttr, '1'); } catch (_) { /* SVG elements may not support setAttribute */ }
      // Also mark the closest container row/card so re-renders of the same item are skipped
      const row = el.closest('[class*="item"], [class*="row"], [class*="card"], [class*="post"], [class*="comment"], [class*="thread"], [class*="entry"], li, article');
      if (row) {
        try { row.setAttribute(dedupAttr, '1'); } catch (_) { /* ignore */ }
      }
    };

    const doClick = async (el) => {
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      await this.wait(80);
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // Fast synthetic click (single strategy for speed in batch loops)
      try {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, view: window }));
      } catch (_) { /* continue */ }
      try { if (el.focus) el.focus(); } catch (_) { /* SVG etc. */ }
      try { el.click(); } catch (_) { /* some elements throw */ }
    };

    const doExtract = (el) => ({
      tag: el.tagName?.toLowerCase() || '?',
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3).join(' ') : null,
      text: (el.textContent || '').trim().substring(0, 300),
      href: el.href || null,
      attributes: this._getKeyAttributes(el)
    });

    const sendProgress = () => {
      try {
        chrome.runtime.sendMessage({
          action: 'agent:scrollAndActProgress',
          selector, acted, scrolls, emptyStreak,
          totalScrolled: Math.round(window.scrollY),
          maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
          timestamp: Date.now()
        }).catch(() => {});
      } catch (_) { /* context invalidated */ }
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ── Main scroll loop ───────────────────────────────────────
    const extracted = [];

    while (acted < maxItems && scrolls < maxScrolls && emptyStreak < maxEmptyScrolls) {
      // ── Expand "show more" / "load more" if present ──────────
      if (expandSelector) {
        try {
          const expandBtns = document.querySelectorAll(expandSelector);
          for (const btn of expandBtns) {
            if (btn.offsetParent) {
              btn.scrollIntoView({ behavior: 'instant', block: 'center' });
              await sleep(200);
              try { btn.click(); } catch (_) { /* ignore */ }
              await this._waitForRenderStability(container, scrollPause);
            }
          }
        } catch (_) { /* ignore */ }
      }

      // ── Find fresh targets in current viewport ───────────────
      const fresh = findFresh();
      if (fresh.length === 0) {
        // None in viewport — scroll to load more
        window.scrollBy(0, Math.round(window.innerHeight * scrollAmount));
        // Also try scrolling the container if it's the scrollable element
        if (container !== document.body && container.scrollHeight > container.clientHeight) {
          container.scrollBy(0, Math.round(container.clientHeight * scrollAmount));
        }
        scrolls++;
        await this._waitForRenderStability(container, scrollPause);
        emptyStreak++;
        sendProgress();
        continue;
      }

      emptyStreak = 0;

      // ── Act on each fresh element ────────────────────────────
      for (const el of fresh) {
        if (acted >= maxItems) break;

        // Optional early-stop condition — injected via <script> to avoid CSP unsafe-eval
        if (stopWhen) {
          try {
            const uid = '__snn_stop_' + Math.random().toString(36).slice(2);
            el.setAttribute('data-snn-stop', uid);

            const stopScript = document.createElement('script');
            stopScript.textContent = [
              '(function(){',
              'var _el=document.querySelector("[data-snn-stop=\\"' + uid + '\\"]");',
              'if(_el){',
              'window["' + uid + '"]=!!(' + stopWhen + ');',
              '_el.removeAttribute("data-snn-stop");',
              '}',
              '})();'
            ].join('\n');
            (document.documentElement || document.head).appendChild(stopScript);
            stopScript.remove();

            const shouldStop = !!window[uid];
            delete window[uid];
            // Fallback cleanup if injected script didn't remove attribute
            if (el.hasAttribute('data-snn-stop')) el.removeAttribute('data-snn-stop');

            if (shouldStop) { acted = maxItems; break; }
          } catch (_) { /* ignore bad expression */ }
        }

        markDone(el);

        if (action === 'extract') {
          extracted.push(doExtract(el));
        } else {
          await doClick(el);
        }

        acted++;
        sendProgress();

        // Human-like jittered delay between actions
        const delay = clickDelay + Math.random() * clickJitter;
        await sleep(delay);
      }

      // ── Scroll for next batch ────────────────────────────────
      window.scrollBy(0, Math.round(window.innerHeight * scrollAmount));
      if (container !== document.body && container.scrollHeight > container.clientHeight) {
        container.scrollBy(0, Math.round(container.clientHeight * scrollAmount));
      }
      scrolls++;
      await this._waitForRenderStability(container, scrollPause);
      sendProgress();
    }

    // ── Build final summary ────────────────────────────────────
    let terminatedBecause;
    if (acted >= maxItems) terminatedBecause = 'maxItems';
    else if (emptyStreak >= maxEmptyScrolls) terminatedBecause = 'noNewItems';
    else terminatedBecause = 'maxScrolls';

    return {
      action: 'scrollAndAct',
      selector,
      acted,
      scrolls,
      emptyStreak,
      terminatedBecause,
      viewportHeight: window.innerHeight,
      pageScrollY: Math.round(window.scrollY),
      pageMaxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
      ...(action === 'extract' ? { extracted } : {})
    };
  }

  /**
   * Wait for DOM mutations to settle after a scroll — signals that
   * the virtual list / infinite scroll has finished rendering new items.
   * Uses MutationObserver with a debounce window.
   */
  _waitForRenderStability(container, settleMs = 1200) {
    return new Promise((resolve) => {
      let timer;
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => { obs.disconnect(); resolve(); }, settleMs);
      });
      obs.observe(container, { childList: true, subtree: true });
      // Fallback: resolve even if no mutations occur (static content)
      timer = setTimeout(() => { obs.disconnect(); resolve(); }, settleMs + 200);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION: Monitor DOM
  // ═══════════════════════════════════════════════════════════════
  startMonitoring(selector, options = {}) {
    if (this._monitors.has(selector)) this.stopMonitoring(selector);
    const config = {
      pollMs: options.pollMs || 5000,
      check: options.check || 'exists',
      timeout: options.timeout || 60000,
      onChange: (result) => {
        chrome.runtime.sendMessage({
          action: 'agent:monitorChange',
          selector, result,
          timestamp: Date.now()
        }).catch(() => {});
      }
    };
    const start = Date.now();
    const interval = setInterval(() => {
      try {
        const el = document.querySelector(selector);
        if (config.check === 'exists' && el) { config.onChange({ found: true, element: this._describeElement(el) }); clearInterval(interval); this._monitors.delete(selector); }
        if (config.check === 'textChange' && el) {
          const txt = el.textContent?.trim() || '';
          if (txt !== config._lastText) { config._lastText = txt; config.onChange({ changed: true, text: txt }); }
        }
        if (Date.now() - start > config.timeout) { clearInterval(interval); this._monitors.delete(selector); }
      } catch (e) { /* keep monitoring */ }
    }, config.pollMs);
    config._interval = interval;
    this._monitors.set(selector, config);
    return { action: 'startMonitoring', selector, pollMs: config.pollMs, check: config.check };
  }

  stopMonitoring(selector) {
    if (selector) {
      const m = this._monitors.get(selector);
      if (m) { clearInterval(m._interval); this._monitors.delete(selector); }
    } else {
      for (const [k, m] of this._monitors) { clearInterval(m._interval); }
      this._monitors.clear();
    }
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
