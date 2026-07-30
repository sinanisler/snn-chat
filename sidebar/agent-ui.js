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

    // Session the CURRENTLY RUNNING agent-loop belongs to (sessionRef()
    // captured at run() start — see agent-loop.js). Tab switches no longer
    // cancel a busy run, so this can diverge from the side panel's visible
    // session for the run's whole lifetime. Set/cleared by agent-loop.js.
    this._runRef = null;
  }

  /**
   * True when the run this entry belongs to is the session on screen right
   * now. False means the agent is working on a tab the user isn't looking
   * at — the entry must still be PERSISTED (below) but never painted into
   * the DOM, which belongs to whatever session IS on screen.
   */
  _isLive() {
    return !this._runRef || this._runRef.key === this.sp._liveKey();
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
    if (!this._isLive()) return; // belongs to a tab not on screen — leave the visible DOM alone
    const bar = document.getElementById('snn-agent-status');
    if (bar) bar.remove();
  }

  // ═══════════════════════════════════════════════════════════════
  // PROGRESS BAR — shown above status bar for multi-step tasks
  // ═══════════════════════════════════════════════════════════════
  renderProgress(step, total, description) {
    if (!this._isLive()) return; // background run — don't paint into the visible session
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
      <span class="snn-agent-progress-label">${description || 'Step'}</span>
      <span class="snn-agent-progress-pct">${pct}%</span>
    `;
    prog.style.display = 'flex';
  }

  hideProgress() {
    if (!this._isLive()) return;
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
    this.sp.smartScrollToBottom();

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

    // Background run for a tab not on screen — the write above already
    // landed in the right session; painting it here would land in the
    // WRONG one (whatever session IS on screen right now).
    if (!this._isLive()) return null;

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

    this.sp.smartScrollToBottom();
    return entry;
  }

  /**
   * Persist a write to the session that is live RIGHT NOW, and log any
   * failure instead of swallowing it.
   *
   * The ref is captured synchronously so the pending write can't be
   * redirected by a tab switch that happens before it settles — see
   * SNNSidePanel.sessionRef().
   */
  _save(ref) {
    this.sp.saveChatHistory(ref).catch((err) => {
      D.error('agent-ui: chat save failed', err?.message || String(err));
    });
  }

  /**
   * Persist a status entry to chatHistory for tab-switch survival.
   */
  _persistStatusEntry(state, label, detail = {}) {
    const ref = this._runRef || this.sp.sessionRef();
    // When starting a new agent run (PARSING), cancel any stale in-progress
    // status entries from a previous run so history stays clean.
    if (state === 'PARSING') {
      for (let i = ref.messages.length - 1; i >= 0; i--) {
        const m = ref.messages[i];
        if (m.role !== 'agent-status') continue;
        // A terminal entry marks the end of the previous run — stop here.
        // Otherwise we'd walk past a completed run and corrupt an inner
        // status entry from an earlier, already-finished run.
        if (['IDLE','FAILED','CANCELLED'].includes(m.state)) break;
        m.state = 'CANCELLED';
        m.label = 'Interrupted';
        break; // Only cancel the most recent run
      }
    }

    // Every state transition gets its own entry — nothing overwrites.
    // taskId lets snn_checkPreviousTask (agent-loop.js) tell "this run's own
    // entries" apart from an EARLIER run's trace when it looks back.
    ref.messages.push({
      role: 'agent-status',
      state,
      label,
      taskId: this.sp._agentLoop?._taskId || null,
      timestamp: Date.now()
    });
    this._save(ref);
  }

  /**
   * Persist an action history entry to chatHistory so it survives tab switches.
   * Called by addActionHistoryEntry for 'start', and updated by updateLastActionEntry.
   */
  _persistActionEntry(status, description, detail = '') {
    const ref = this._runRef || this.sp.sessionRef();
    // If starting a new action, only cancel the SINGLE most recent stale 'start'
    // entry (the one that was interrupted). Completed entries are already 'ok'/'fail'.
    if (status === 'start') {
      for (let i = ref.messages.length - 1; i >= 0; i--) {
        if (ref.messages[i].role === 'agent-action' && ref.messages[i].status === 'start') {
          ref.messages[i].status = 'cancelled';
          ref.messages[i].detail = 'Interrupted';
          break; // Only cancel ONE — the most recent interrupted entry
        }
      }
    }

    // If updating (not 'start'), find and update the last agent-action entry.
    // description is optional here — updateLastActionEntry doesn't have a new
    // one to give (it never changed), so omitting it keeps the original
    // instead of overwriting it with an empty string.
    if (status !== 'start') {
      for (let i = ref.messages.length - 1; i >= 0; i--) {
        if (ref.messages[i].role === 'agent-action') {
          ref.messages[i].status = status;
          ref.messages[i].detail = detail;
          if (description) ref.messages[i].description = description;
          // Also save the final state
          this._save(ref);
          return;
        }
      }
    }
    // New 'start' entry — append to chatHistory
    ref.messages.push({
      role: 'agent-action',
      action: '', description, status, detail,
      taskId: this.sp._agentLoop?._taskId || null,
      timestamp: Date.now()
    });
    // Auto-save (fire and forget, but failures are logged)
    this._save(ref);
  }

  // ═══════════════════════════════════════════════════════════════
  // ACTION HISTORY ENTRY — a chat bubble showing what agent did
  // ═══════════════════════════════════════════════════════════════
  addActionHistoryEntry(action, description, status, detail = '') {
    // Persist to chatHistory for tab-switch survival
    this._persistActionEntry(status, description, detail);

    if (!this._isLive()) return null; // background run — leave the visible DOM alone

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
    this.sp.smartScrollToBottom();
    return entry;
  }

  /**
   * Update the last action history entry (e.g., change from ▶️ to ✅)
   */
  updateLastActionEntry(status, detail = '') {
    // Persist the ok/fail status to chatHistory so it survives tab switches.
    // No description to give — it never changed — so _persistActionEntry
    // keeps whatever was already stored instead of us having to read it
    // back out of a DOM entry that may not exist for a background run.
    this._persistActionEntry(status, null, detail);

    if (!this._isLive()) return; // background run — leave the visible DOM alone

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
    this.sp.smartScrollToBottom();
  }

  /**
   * Render a collapsible "Thinking..." block showing the model's internal
   * reasoning between tool calls. Default: collapsed to avoid clutter.
   */
  addReasoningEntry(text, iteration) {
    // Persist to chatHistory for session survival
    const ref = this._runRef || this.sp.sessionRef();
    ref.messages.push({
      role: 'agent-reasoning',
      text,
      iteration,
      taskId: this.sp._agentLoop?._taskId || null,
      timestamp: Date.now()
    });
    this._save(ref);

    if (!this._isLive()) return null; // background run — leave the visible DOM alone

    const container = this._actionGroupBodyEl || this.sp.els.chatMessages;

    const entry = document.createElement('div');
    entry.className = 'snn-reasoning-entry';
    entry.innerHTML = `
      <details class="snn-reasoning-details" open>
        <summary class="snn-reasoning-summary">
          <span class="snn-reasoning-label">Thinking...</span>
        </summary>
        <div class="snn-reasoning-content">${this.sp.escapeHtml(text)}</div>
      </details>
    `;

    container.appendChild(entry);
    this.sp.smartScrollToBottom();

    return entry;
  }

  /**
   * Attach a screenshot image to the last action entry so the user can see it.
   */
  attachScreenshotToLastEntry(dataUrl) {
    if (!this._isLive()) return; // background run — the screenshot isn't lost, just not re-shown live
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
    this.sp.smartScrollToBottom();
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
    this.sp.smartScrollToBottom();
  }

  // ═══════════════════════════════════════════════════════════════
  // ERROR CARD — shown in chat when all retries exhausted
  //
  // Compact by design: a one-line header carrying the code + who is at
  // fault, then a scroll-capped body so a 200-line stack trace can never
  // push the conversation off screen. The body is open by default —
  // a hidden error is a silent failure, which is what we're guarding
  // against — but it is bounded, not unbounded.
  // ═══════════════════════════════════════════════════════════════

  /** Who is responsible — drives the header tag and the wording. */
  static SOURCE_LABELS = {
    user:      { label: 'your settings', cls: 'snn-src-user' },
    page:      { label: 'this page',     cls: 'snn-src-page' },
    provider:  { label: 'provider',      cls: 'snn-src-provider' },
    network:   { label: 'network',       cls: 'snn-src-network' },
    extension: { label: 'SNN bug',       cls: 'snn-src-extension' }
  };

  renderErrorCard(errorData) {
    if (!this._isLive()) return; // background run — the failure is still in the persisted trace, just not popped up here
    const { step, error = {}, totalAttempts, message } = errorData || {};
    const esc = (s) => this.sp.escapeHtml(String(s));

    const source = error.source || 'extension';
    const src = SNNAgentUI.SOURCE_LABELS[source] || SNNAgentUI.SOURCE_LABELS.extension;
    const code = error.code || 'ERROR';

    // The suggestion and the loop's trailing message say the same kind of
    // thing — join them into one hint line instead of stacking two panels.
    const hint = [error.suggestion, message].filter(Boolean).map(esc).join(' ');

    const attempts = totalAttempts || error.attempt;

    const card = document.createElement('div');
    card.className = 'snn-error-card';
    card.dataset.source = source;

    card.innerHTML = `
      <div class="snn-error-head">
        <i class="fas fa-triangle-exclamation snn-error-ico"></i>
        <span class="snn-error-code">${esc(code)}</span>
        <span class="snn-error-src ${src.cls}">${esc(src.label)}</span>
        <span class="snn-error-spacer"></span>
        <button class="snn-error-link" data-action="retry">Retry</button>
        <button class="snn-error-link" data-action="different">Different</button>
        <button class="snn-error-icon-btn" data-action="copy" title="Copy error details"><i class="fas fa-copy"></i></button>
        <button class="snn-error-icon-btn" data-action="dismiss" title="Dismiss"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="snn-error-body">
        <div class="snn-error-msg">${esc(error.message || 'Unexpected error.')}</div>
        ${hint ? `<div class="snn-error-hint">${hint}</div>` : ''}
      </div>
    `;

    // ── Wire buttons ──
    card.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
      card.remove();
      if (this.sp._onErrorRetry) this.sp._onErrorRetry();
    });
    card.querySelector('[data-action="different"]')?.addEventListener('click', () => {
      card.remove();
      if (this.sp._onErrorTryDifferently) this.sp._onErrorTryDifferently();
    });
    card.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => card.remove());

    // Copy a plain-text block the user can paste straight into a bug report.
    card.querySelector('[data-action="copy"]')?.addEventListener('click', async (e) => {
      const lines = [
        `SNN Chat error`,
        `code: ${code}`,
        `source: ${source}`,
        `message: ${error.message || ''}`,
        step?.action ? `action: ${step.action}` : null,
        step?.description ? `step: ${step.description}` : null,
        attempts ? `attempts: ${attempts}` : null,
        error.selector ? `selector: ${error.selector}` : null,
        error.detail ? `detail: ${error.detail}` : null,
        `url: ${location.href}`,
        `time: ${new Date().toISOString()}`
      ].filter(Boolean);
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        const btn = e.currentTarget;
        btn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1400);
      } catch (err) {
        this.showToast('Could not copy to clipboard', 'warning');
      }
    });

    this.sp.els.chatMessages.appendChild(card);
    this.sp.smartScrollToBottom();
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
      const desc = r.step.description || r.step.action || 'Step';
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
    this.sp.smartScrollToBottom();
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
