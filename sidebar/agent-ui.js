// ═══════════════════════════════════════════════════════════════════
// SNN Agent UI — Progress, Error Cards, Status Indicators, Modals
// ═══════════════════════════════════════════════════════════════════
// All UI components for the agent loop. Rendered by the side panel.
// The side panel calls these functions to show agent state visually.
// ═══════════════════════════════════════════════════════════════════

class SNNAgentUI {
  constructor(sidePanel) {
    this.sp = sidePanel;

    // ── Action Group State ───────────────────────────────────
    // When the agent executes multiple actions, entries are grouped
    // under a collapsible accordion to save chat space.
    this._actionGroupEl = null;          // DOM element: .snn-action-group
    this._actionGroupBodyEl = null;      // DOM element: .snn-action-group-body
    this._actionGroupHeaderTextEl = null; // DOM element: header text span
    this._actionGroupDotsEl = null;      // DOM element: animated dots span
    this._actionGroupCount = 0;          // number of action entries in group
  }

  // ═══════════════════════════════════════════════════════════════
  // STATUS BAR — deprecated; status now shown as persistent chat entries.
  // The element is removed if it still exists from older sessions.
  // ═══════════════════════════════════════════════════════════════
  renderStatusBar(state, detail = {}) {
    // Always remove the floating status bar — status entries are now
    // persistent chat bubbles via addStatusEntry().
    this.hideStatusBar();
    if (state === 'IDLE' || state === 'FAILED' || state === 'CANCELLED') {
      this.hideProgress();
    }
  }

  hideStatusBar() {
    const bar = document.getElementById('snn-agent-status');
    if (bar) bar.remove();
  }

  // ═══════════════════════════════════════════════════════════════
  // PROGRESS BAR — shown above status bar for multi-step tasks
  // ═══════════════════════════════════════════════════════════════
  renderProgress(step, total, description) {
    let prog = document.getElementById('snn-agent-progress');
    if (!prog) {
      prog = document.createElement('div');
      prog.id = 'snn-agent-progress';
      prog.className = 'snn-agent-progress';
      const statusBar = document.getElementById('snn-agent-status');
      if (statusBar) {
        statusBar.parentNode.insertBefore(prog, statusBar);
      }
    }

    const pct = Math.round((step / total) * 100);
    prog.innerHTML = `
      <div class="snn-agent-progress-bar">
        <div class="snn-agent-progress-fill" style="width:${pct}%"></div>
      </div>
      <span class="snn-agent-progress-label">${description || `Step ${step} of ${total}`}</span>
      <span class="snn-agent-progress-pct">${pct}%</span>
    `;
    prog.style.display = 'flex';
  }

  hideProgress() {
    const prog = document.getElementById('snn-agent-progress');
    if (prog) prog.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════════
  // STATUS ENTRY — persistent chat bubble for agent state changes
  // ═══════════════════════════════════════════════════════════════

  /**
   * Icon + color config for persistent status entries (chat history).
   * Mirrors renderStatusBar but produces DOM entries that live in chat.
   */
  _statusEntryConfig(state) {
    const map = {
      PARSING:   { icon: 'fa-magnifying-glass', cls: 'snn-status-parsing',   label: 'Analyzing your request...' },
      PLANNING:  { icon: 'fa-list-check',        cls: 'snn-status-planning',  label: 'Building action plan...' },
      EXECUTING: { icon: 'fa-bolt',              cls: 'snn-status-executing', label: 'Working...' },
      WAITING:   { icon: 'fa-hourglass-half',    cls: 'snn-status-waiting',   label: 'Waiting for page...' },
      OBSERVING: { icon: 'fa-eye',               cls: 'snn-status-observing', label: 'Checking result...' },
      RETRYING:  { icon: 'fa-arrows-rotate',     cls: 'snn-status-retrying',  label: 'Retrying...' },
      REPORTING: { icon: 'fa-chart-simple',       cls: 'snn-status-reporting', label: 'Compiling results...' },
      FAILED:    { icon: 'fa-triangle-exclamation', cls: 'snn-status-failed', label: 'Failed' },
      BLOCKED:   { icon: 'fa-lock',              cls: 'snn-status-blocked',   label: 'Waiting for permission...' },
      CANCELLED: { icon: 'fa-xmark',             cls: 'snn-status-cancelled', label: 'Cancelled' },
      IDLE:      { icon: 'fa-circle-check',      cls: 'snn-status-idle',      label: 'Done' }
    };
    return map[state] || null;
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION GROUP — collapsible accordion for multi-step agent runs
  // ═══════════════════════════════════════════════════════════════

  /**
   * Start a new collapsible action group in the chat.
   * Called automatically when the first EXECUTING state fires after PARSING.
   */
  _startActionGroup() {
    if (this._actionGroupEl) return; // already active

    const group = document.createElement('div');
    group.className = 'snn-action-group';

    group.innerHTML = `
      <div class="snn-action-group-header">
        <span class="snn-action-group-chevron">▶</span>
        <span class="snn-action-group-header-icon"><i class="fas fa-bolt"></i></span>
        <span class="snn-action-group-header-text">Working</span>
        <span class="snn-action-group-dots">
          <span class="snn-action-group-dot">.</span>
          <span class="snn-action-group-dot">.</span>
          <span class="snn-action-group-dot">.</span>
        </span>
      </div>
      <div class="snn-action-group-body"></div>
    `;

    // Click header to toggle expand/collapse
    const header = group.querySelector('.snn-action-group-header');
    header.addEventListener('click', () => {
      group.classList.toggle('expanded');
    });

    this.sp.els.chatMessages.appendChild(group);
    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;

    this._actionGroupEl = group;
    this._actionGroupBodyEl = group.querySelector('.snn-action-group-body');
    this._actionGroupHeaderTextEl = group.querySelector('.snn-action-group-header-text');
    this._actionGroupDotsEl = group.querySelector('.snn-action-group-dots');
    this._actionGroupCount = 0;
  }

  /**
   * Finalize (close) the current action group.
   * Updates the header with a summary (completed / failed / interrupted)
   * and clears internal refs so the next run starts a fresh group.
   * The group DOM element stays in chat so the user can expand it later.
   */
  _finalizeActionGroup(state) {
    if (!this._actionGroupEl) return;

    // Stop animated dots
    if (this._actionGroupDotsEl) {
      this._actionGroupDotsEl.style.display = 'none';
    }

    // Count completed/failed actions in the group body
    const body = this._actionGroupBodyEl;
    let actionCount = 0;
    if (body) {
      actionCount = body.querySelectorAll('.snn-action-entry.snn-action-ok, .snn-action-entry.snn-action-fail').length;
      // Also count 'start' entries for interrupted runs
      if (state === 'CANCELLED') {
        actionCount = body.querySelectorAll('.snn-action-entry').length || actionCount;
      }
    }

    const iconEl = this._actionGroupEl.querySelector('.snn-action-group-header-icon');
    const countLabel = actionCount > 0 ? ` · ${actionCount} action${actionCount !== 1 ? 's' : ''}` : '';

    if (state === 'IDLE') {
      if (this._actionGroupHeaderTextEl) {
        this._actionGroupHeaderTextEl.textContent = `Completed${countLabel}`;
      }
      if (iconEl) iconEl.innerHTML = '<i class="fas fa-circle-check"></i>';
    } else if (state === 'FAILED') {
      if (this._actionGroupHeaderTextEl) {
        this._actionGroupHeaderTextEl.textContent = `Failed${countLabel}`;
      }
      if (iconEl) iconEl.innerHTML = '<i class="fas fa-triangle-exclamation"></i>';
    } else if (state === 'CANCELLED') {
      if (this._actionGroupHeaderTextEl) {
        this._actionGroupHeaderTextEl.textContent = 'Interrupted';
      }
      if (iconEl) iconEl.innerHTML = '<i class="fas fa-xmark"></i>';
    } else if (state === 'BLOCKED') {
      if (this._actionGroupHeaderTextEl) {
        this._actionGroupHeaderTextEl.textContent = `Blocked${countLabel}`;
      }
      if (iconEl) iconEl.innerHTML = '<i class="fas fa-lock"></i>';
    }

    // Clear refs so the next run can start a fresh group
    // (the DOM element stays in chat as a collapsed summary)
    this._actionGroupEl = null;
    this._actionGroupBodyEl = null;
    this._actionGroupHeaderTextEl = null;
    this._actionGroupDotsEl = null;
    this._actionGroupCount = 0;
  }

  /**
   * Add a persistent status entry to the chat history DOM.
   * Unlike action entries, these represent agent state transitions.
   * When an action group is active, entries are routed into the group body.
   */
  addStatusEntry(state, detail = {}) {
    const cfg = this._statusEntryConfig(state);
    if (!cfg) return null;

    // Customize label for specific states
    let label = cfg.label;
    if (state === 'RETRYING' && detail.attempt != null) {
      label = `Retrying (${detail.attempt}/${detail.maxRetries || '?'})...`;
    }

    // Persist to chatHistory for survival across tab switches
    this._persistStatusEntry(state, label, detail);

    // ── Action Group Logic ──────────────────────────────────
    // PARSING / PLANNING always render outside; close any stale group first.
    if (state === 'PARSING' || state === 'PLANNING') {
      this._finalizeActionGroup('CANCELLED');
    }

    // First EXECUTING after PARSING/PLANNING → start a new action group.
    if (state === 'EXECUTING' && !this._actionGroupEl) {
      this._startActionGroup();
    }

    // Terminal/error states that should appear OUTSIDE the group:
    // close the group first so the error is visible.
    if (state === 'FAILED' || state === 'BLOCKED' || state === 'CANCELLED') {
      this._finalizeActionGroup(state);
    }

    // Determine where to append this entry.
    const groupableStates = ['EXECUTING', 'OBSERVING', 'RETRYING', 'REPORTING', 'WAITING', 'IDLE'];
    const intoGroup = this._actionGroupBodyEl && groupableStates.includes(state);
    const container = intoGroup ? this._actionGroupBodyEl : this.sp.els.chatMessages;

    const entry = document.createElement('div');
    entry.className = `snn-status-entry ${cfg.cls}`;
    entry.innerHTML = `
      <span class="snn-status-entry-icon"><i class="fas ${cfg.icon}"></i></span>
      <span class="snn-status-entry-text">${this.sp.escapeHtml(label)}</span>
    `;

    container.appendChild(entry);

    // After appending IDLE into the group, finalize (update header, clear refs).
    if (state === 'IDLE' && this._actionGroupEl) {
      this._finalizeActionGroup('IDLE');
    }

    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;
    return entry;
  }

  /**
   * Persist a status entry to chatHistory for tab-switch survival.
   */
  _persistStatusEntry(state, label, detail = {}) {
    // When starting a new agent run (PARSING), cancel any stale in-progress
    // status entries from a previous run so history stays clean.
    if (state === 'PARSING') {
      for (let i = this.sp.chatHistory.length - 1; i >= 0; i--) {
        const m = this.sp.chatHistory[i];
        if (m.role === 'agent-status' && !['IDLE','FAILED','CANCELLED'].includes(m.state)) {
          m.state = 'CANCELLED';
          m.label = 'Interrupted';
          break; // Only cancel the most recent run
        }
      }
    }

    // Every state transition gets its own entry — nothing overwrites.
    this.sp.chatHistory.push({
      role: 'agent-status',
      state,
      label,
      timestamp: Date.now()
    });
    this.sp.saveChatHistory().catch(() => {});
  }

  /**
   * Persist an action history entry to chatHistory so it survives tab switches.
   * Called by addActionHistoryEntry for 'start', and updated by updateLastActionEntry.
   */
  _persistActionEntry(status, description, detail = '') {
    // If starting a new action, only cancel the SINGLE most recent stale 'start'
    // entry (the one that was interrupted). Completed entries are already 'ok'/'fail'.
    if (status === 'start') {
      for (let i = this.sp.chatHistory.length - 1; i >= 0; i--) {
        if (this.sp.chatHistory[i].role === 'agent-action' && this.sp.chatHistory[i].status === 'start') {
          this.sp.chatHistory[i].status = 'cancelled';
          this.sp.chatHistory[i].detail = 'Interrupted';
          break; // Only cancel ONE — the most recent interrupted entry
        }
      }
    }

    // If updating (not 'start'), find and update the last agent-action entry
    if (status !== 'start') {
      for (let i = this.sp.chatHistory.length - 1; i >= 0; i--) {
        if (this.sp.chatHistory[i].role === 'agent-action') {
          this.sp.chatHistory[i].status = status;
          this.sp.chatHistory[i].detail = detail;
          this.sp.chatHistory[i].description = description;
          // Also save the final state
          this.sp.saveChatHistory().catch(() => {});
          return;
        }
      }
    }
    // New 'start' entry — append to chatHistory
    this.sp.chatHistory.push({
      role: 'agent-action',
      action: '', description, status, detail,
      timestamp: Date.now()
    });
    // Auto-save (fire and forget)
    this.sp.saveChatHistory().catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION HISTORY ENTRY — a chat bubble showing what agent did
  // ═══════════════════════════════════════════════════════════════
  addActionHistoryEntry(action, description, status, detail = '') {
    // Persist to chatHistory for tab-switch survival
    this._persistActionEntry(status, description, detail);

    // Route into action group if one is active
    const container = this._actionGroupBodyEl || this.sp.els.chatMessages;

    const entry = document.createElement('div');
    entry.className = `snn-action-entry snn-action-${status}`; // status: 'start', 'ok', 'fail', 'info'

    const icons = { start: '<i class="fas fa-play"></i>', ok: '<i class="fas fa-circle-check"></i>', fail: '<i class="fas fa-circle-xmark"></i>', info: '<i class="fas fa-circle-info"></i>' };
    const icon = icons[status] || '<i class="fas fa-circle"></i>';

    entry.innerHTML = `
      <span class="snn-action-entry-icon">${icon}</span>
      <span class="snn-action-entry-text">${this.sp.escapeHtml(description)}</span>
      ${detail ? `<span class="snn-action-entry-detail">${this.sp.escapeHtml(detail)}</span>` : ''}
    `;

    container.appendChild(entry);
    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;
    return entry;
  }

  /**
   * Update the last action history entry (e.g., change from ▶️ to ✅)
   */
  updateLastActionEntry(status, detail = '') {
    const container = this._actionGroupBodyEl || this.sp.els.chatMessages;
    const entries = container.querySelectorAll('.snn-action-entry');
    if (entries.length === 0) return;
    const last = entries[entries.length - 1];
    last.className = `snn-action-entry snn-action-${status}`;
    const icons = { start: '<i class="fas fa-play"></i>', ok: '<i class="fas fa-circle-check"></i>', fail: '<i class="fas fa-circle-xmark"></i>', info: '<i class="fas fa-circle-info"></i>' };
    const iconEl = last.querySelector('.snn-action-entry-icon');
    if (iconEl) iconEl.innerHTML = icons[status] || '<i class="fas fa-circle"></i>';
    if (detail) {
      const detailEl = last.querySelector('.snn-action-entry-detail');
      if (detailEl) detailEl.textContent = detail;
      else {
        const span = document.createElement('span');
        span.className = 'snn-action-entry-detail';
        span.textContent = detail;
        last.appendChild(span);
      }
    }
    // Persist the ok/fail status to chatHistory so it survives tab switches
    const textEl = last.querySelector('.snn-action-entry-text');
    const desc = textEl ? textEl.textContent : '';
    this._persistActionEntry(status, desc, detail);
    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;
  }

  /**
   * Attach a screenshot image to the last action entry so the user can see it.
   */
  attachScreenshotToLastEntry(dataUrl) {
    const container = this._actionGroupBodyEl || this.sp.els.chatMessages;
    const entries = container.querySelectorAll('.snn-action-entry');
    if (entries.length === 0) return;
    const last = entries[entries.length - 1];
    // Don't double-append
    if (last.querySelector('.snn-screenshot-preview')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'snn-screenshot-preview';
    wrapper.style.cssText = 'margin-top:8px;max-width:150px;overflow:hidden;border-radius:6px;border:1px solid var(--border-color, #333);';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Screenshot';
    img.style.cssText = 'display:block;max-width:100%;height:auto;cursor:pointer;border-radius:4px;';
    img.title = 'Click to open full size';
    img.addEventListener('click', () => {
      const w = window.open('');
      if (w) { w.document.write(`<img src="${dataUrl}" style="max-width:100%">`); }
    });
    wrapper.appendChild(img);
    last.appendChild(wrapper);
    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;
  }

  /**
   * Show ALL discovered actionable elements on the page in chat.
   */
  showPageElements(scan) {
    if (!scan) return;
    const el = scan.elements;
    if (!el) return;

    const entry = document.createElement('div');
    entry.className = 'snn-page-nav';

    let html = `<div class="snn-page-nav-header"><i class="fas fa-compass"></i> Page Elements — ${scan.totalLinks || 0} links, ${scan.totalButtons || 0} buttons, ${scan.totalInputs || 0} inputs, ${scan.totalForms || 0} forms</div>`;

    // Links section
    if (el.links && el.links.length > 0) {
      html += '<div class="snn-page-nav-section"><span class="snn-page-nav-section-label"><i class="fas fa-link"></i> Links</span><div class="snn-page-nav-links">';
      html += el.links.slice(0, 12).map(l =>
        `<span class="snn-page-nav-link" title="${this.sp.escapeHtml(l.href || '')}">${this.sp.escapeHtml(l.text || '?')}</span>`
      ).join('');
      if (el.links.length > 12) html += `<span class="snn-page-nav-link snn-page-nav-more">+${el.links.length - 12} more</span>`;
      html += '</div></div>';
    }

    // Buttons section
    if (el.buttons && el.buttons.length > 0) {
      html += '<div class="snn-page-nav-section"><span class="snn-page-nav-section-label"><i class="fas fa-circle-dot"></i> Buttons</span><div class="snn-page-nav-links">';
      html += el.buttons.slice(0, 8).map(b =>
        `<span class="snn-page-nav-link snn-page-nav-btn" title="${this.sp.escapeHtml(b.type || 'button')}">${this.sp.escapeHtml(b.text || '?')}</span>`
      ).join('');
      if (el.buttons.length > 8) html += `<span class="snn-page-nav-link snn-page-nav-more">+${el.buttons.length - 8} more</span>`;
      html += '</div></div>';
    }

    // Inputs section (collapsed)
    if (el.inputs && el.inputs.length > 0) {
      html += `<div class="snn-page-nav-section"><span class="snn-page-nav-section-label"><i class="fas fa-pen-to-square"></i> Inputs</span><span class="snn-page-nav-count">${el.inputs.length} fields detected</span></div>`;
    }

    // Forms section
    if (el.forms && el.forms.length > 0) {
      html += `<div class="snn-page-nav-section"><span class="snn-page-nav-section-label"><i class="fas fa-list-check"></i> Forms</span><span class="snn-page-nav-count">${el.forms.length} forms, ${el.forms.reduce((s,f) => s + (f.inputCount||0), 0)} total fields</span></div>`;
    }

    // Selects section
    if (el.selects && el.selects.length > 0) {
      html += `<div class="snn-page-nav-section"><span class="snn-page-nav-section-label"><i class="fas fa-paperclip"></i> Dropdowns</span><span class="snn-page-nav-count">${el.selects.length} selects</span></div>`;
    }

    entry.innerHTML = html;
    this.sp.els.chatMessages.appendChild(entry);
    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════
  // ERROR CARD — shown in chat when all retries exhausted
  // ═══════════════════════════════════════════════════════════════
  renderErrorCard(errorData) {
    const { step, error, totalAttempts, message } = errorData;

    const card = document.createElement('div');
    card.className = 'snn-error-card';

    // Build tried-selectors list if available
    let selectorsHtml = '';
    if (error.selector) {
      selectorsHtml = `<div class="snn-error-detail">Selector: <code>${this.sp.escapeHtml(error.selector)}</code></div>`;
    }

    card.innerHTML = `
      <div class="snn-error-card-header">
        <span class="snn-error-card-icon"><i class="fas fa-triangle-exclamation"></i></span>
        <span class="snn-error-card-title">Action Failed</span>
      </div>
      <div class="snn-error-card-body">
        <p><strong>Tried to:</strong> ${step?.description || step?.action || 'Unknown action'}</p>
        ${step?.action ? `<p><strong>Action type:</strong> <code>${this.sp.escapeHtml(step.action)}</code></p>` : ''}
        <p><strong>Attempts:</strong> ${totalAttempts || (error?.attempt || '?')} ${totalAttempts > 1 ? 'attempts' : 'attempt'}</p>
        <div class="snn-error-code">
          <span class="snn-error-code-label">${error.code || 'ERROR'}</span>
          <span class="snn-error-code-msg">${error.message || 'Unknown error'}</span>
        </div>
        ${selectorsHtml}
        ${error.detail ? `<div class="snn-error-detail">${this.sp.escapeHtml(error.detail)}</div>` : ''}
        ${error.suggestion ? `<div class="snn-error-suggestion"><i class="fas fa-lightbulb"></i> ${this.sp.escapeHtml(error.suggestion)}</div>` : ''}
        ${message ? `<div class="snn-error-suggestion" style="margin-top:4px;">${this.sp.escapeHtml(message)}</div>` : ''}
      </div>
      <div class="snn-error-card-actions">
        <button class="snn-error-btn snn-error-btn-retry" data-action="retry"><i class="fas fa-arrows-rotate"></i> Retry</button>
        <button class="snn-error-btn snn-error-btn-different" data-action="different"><i class="fas fa-lightbulb"></i> Try Differently</button>
        <button class="snn-error-btn snn-error-btn-dismiss" data-action="dismiss"><i class="fas fa-xmark"></i> Dismiss</button>
      </div>
    `;

    // Wire up buttons
    card.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
      card.remove();
      if (this.sp._onErrorRetry) this.sp._onErrorRetry();
    });
    card.querySelector('[data-action="different"]')?.addEventListener('click', () => {
      card.remove();
      if (this.sp._onErrorTryDifferently) this.sp._onErrorTryDifferently();
    });
    card.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => {
      card.remove();
    });

    this.sp.els.chatMessages.appendChild(card);
    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULT CARD — shows what the agent accomplished
  // ═══════════════════════════════════════════════════════════════
  renderResultCard(results, plan) {
    const card = document.createElement('div');
    card.className = 'snn-result-card';

    const stepsHtml = results.map((r, i) => {
      const ok = r.result && !r.result.error;
      const icon = ok ? '<i class="fas fa-circle-check"></i>' : '<i class="fas fa-circle-xmark"></i>';
      const desc = r.step.description || r.step.action || `Step ${i + 1}`;
      return `<div class="snn-result-step"><span class="snn-result-step-icon">${icon}</span> ${this.sp.escapeHtml(desc)} <span class="snn-result-step-attempts">(${r.attempts} attempt${r.attempts !== 1 ? 's' : ''})</span></div>`;
    }).join('');

    card.innerHTML = `
      <div class="snn-result-card-header">
        <span class="snn-result-card-icon"><i class="fas fa-circle-check"></i></span>
        <span class="snn-result-card-title">Task Complete</span>
      </div>
      <div class="snn-result-card-body">
        <p>Completed ${results.length} step${results.length !== 1 ? 's' : ''}:</p>
        ${stepsHtml}
      </div>
    `;

    this.sp.els.chatMessages.appendChild(card);
    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════
  // PERMISSION MODAL — shown when agent hits BLOCKED state
  // ═══════════════════════════════════════════════════════════════
  showPermissionModal(question) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'snn-permission-overlay';
      overlay.innerHTML = `
        <div class="snn-permission-modal">
          <div class="snn-permission-icon"><i class="fas fa-lock"></i></div>
          <h3>Permission Required</h3>
          <p>${this.sp.escapeHtml(question || 'SNN needs your permission to continue.')}</p>
          <div class="snn-permission-actions">
            <button class="snn-permission-allow"><i class="fas fa-check"></i> Allow</button>
            <button class="snn-permission-deny"><i class="fas fa-xmark"></i> Deny</button>
          </div>
        </div>
      `;

      overlay.querySelector('.snn-permission-allow').addEventListener('click', () => {
        overlay.remove();
        resolve('approved');
      });
      overlay.querySelector('.snn-permission-deny').addEventListener('click', () => {
        overlay.remove();
        resolve('denied');
      });
      // Click outside to deny
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); resolve('denied'); }
      });

      document.body.appendChild(overlay);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // TOAST NOTIFICATION (extends existing toast with richer types)
  // ═══════════════════════════════════════════════════════════════
  showToast(msg, type = '') {
    // Use sidepanel's existing showToast
    this.sp.showToast(msg, type);
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP — remove all agent UI elements
  // ═══════════════════════════════════════════════════════════════
  cleanup() {
    document.getElementById('snn-agent-status')?.remove();
    document.getElementById('snn-agent-progress')?.remove();
    document.querySelectorAll('.snn-error-card, .snn-result-card, .snn-permission-overlay').forEach(el => el.remove());
  }
}

// Attach to window for non-module use
if (typeof window !== 'undefined') {
  window.SNNAgentUI = SNNAgentUI;
}
