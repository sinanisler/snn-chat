// ═══════════════════════════════════════════════════════════════════
// SNN Agent UI — Progress, Error Cards, Status Indicators, Modals
// ═══════════════════════════════════════════════════════════════════
// All UI components for the agent loop. Rendered by the side panel.
// The side panel calls these functions to show agent state visually.
// ═══════════════════════════════════════════════════════════════════

class SNNAgentUI {
  constructor(sidePanel) {
    this.sp = sidePanel;
  }

  // ═══════════════════════════════════════════════════════════════
  // STATUS BAR — above the input area (moved from top of chat)
  // ═══════════════════════════════════════════════════════════════
  renderStatusBar(state, detail = {}) {
    let bar = document.getElementById('snn-agent-status');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'snn-agent-status';
      bar.className = 'snn-agent-status';
      // Insert above the input area (footer)
      const inputArea = document.querySelector('.sp-input-area');
      if (inputArea) {
        inputArea.parentNode.insertBefore(bar, inputArea);
      } else {
        const chatArea = this.sp.els.chatMessages;
        chatArea.parentNode.appendChild(bar);
      }
    }

    const stateConfig = {
      IDLE:       { icon: '',   cls: '',           text: '' },
      PARSING:    { icon: '🔍', cls: 'status-parsing',   text: 'Analyzing your request...' },
      PLANNING:   { icon: '📋', cls: 'status-planning',  text: 'Building action plan...' },
      EXECUTING:  { icon: '⚡', cls: 'status-executing', text: `${detail.step?.description || 'Working...'}` },
      WAITING:    { icon: '⏳', cls: 'status-waiting',   text: 'Waiting for page...' },
      OBSERVING:  { icon: '👁', cls: 'status-observing', text: 'Checking result...' },
      RETRYING:   { icon: '🔄', cls: 'status-retrying',  text: `Retrying (${detail.attempt || '?'}/${detail.maxRetries || '?'})...` },
      REPORTING:  { icon: '📊', cls: 'status-reporting', text: 'Compiling results...' },
      FAILED:     { icon: '⚠️', cls: 'status-failed',    text: '' },
      BLOCKED:    { icon: '🔒', cls: 'status-blocked',   text: 'Waiting for permission...' },
      CANCELLED:  { icon: '✖',  cls: 'status-cancelled', text: 'Cancelled' }
    };

    const cfg = stateConfig[state] || stateConfig.IDLE;

    if (state === 'IDLE' || state === 'FAILED') {
      bar.style.display = 'none';
      // Also hide progress
      this.hideProgress();
    } else {
      bar.style.display = 'flex';
      bar.className = `snn-agent-status ${cfg.cls}`;
      bar.innerHTML = `
        <span class="snn-agent-status-icon">${cfg.icon}</span>
        <span class="snn-agent-status-text">${cfg.text}</span>
        ${state === 'EXECUTING' || state === 'WAITING' ? `<span class="snn-agent-status-spinner"></span>` : ''}
        <button class="snn-agent-status-cancel" title="Cancel (Escape)">✕</button>
      `;
      bar.querySelector('.snn-agent-status-cancel')?.addEventListener('click', () => {
        if (this.sp._agentLoop) this.sp._agentLoop.cancel();
      });
    }
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
  // ACTION HISTORY ENTRY — a chat bubble showing what agent did
  // ═══════════════════════════════════════════════════════════════
  addActionHistoryEntry(action, description, status, detail = '') {
    const entry = document.createElement('div');
    entry.className = `snn-action-entry snn-action-${status}`; // status: 'start', 'ok', 'fail', 'info'

    const icons = { start: '▶️', ok: '✅', fail: '❌', info: 'ℹ️' };
    const icon = icons[status] || '•';

    entry.innerHTML = `
      <span class="snn-action-entry-icon">${icon}</span>
      <span class="snn-action-entry-text">${this.sp.escapeHtml(description)}</span>
      ${detail ? `<span class="snn-action-entry-detail">${this.sp.escapeHtml(detail)}</span>` : ''}
    `;

    this.sp.els.chatMessages.appendChild(entry);
    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;
    return entry;
  }

  /**
   * Update the last action history entry (e.g., change from ▶️ to ✅)
   */
  updateLastActionEntry(status, detail = '') {
    const entries = this.sp.els.chatMessages.querySelectorAll('.snn-action-entry');
    if (entries.length === 0) return;
    const last = entries[entries.length - 1];
    last.className = `snn-action-entry snn-action-${status}`;
    const icons = { start: '▶️', ok: '✅', fail: '❌', info: 'ℹ️' };
    const iconEl = last.querySelector('.snn-action-entry-icon');
    if (iconEl) iconEl.textContent = icons[status] || '•';
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
    this.sp.els.chatMessages.scrollTop = this.sp.els.chatMessages.scrollHeight;
  }

  /**
   * Show discovered page navigation / links in chat
   */
  showPageNavigation(links) {
    if (!links || links.length === 0) return;
    const entry = document.createElement('div');
    entry.className = 'snn-page-nav';
    const linkItems = links.slice(0, 8).map(l =>
      `<span class="snn-page-nav-link" title="${this.sp.escapeHtml(l.href || '')}">${this.sp.escapeHtml(l.text || l.href || '?')}</span>`
    ).join('');
    entry.innerHTML = `
      <div class="snn-page-nav-header">🧭 Found ${links.length} links in navigation</div>
      <div class="snn-page-nav-links">${linkItems}</div>
    `;
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
        <span class="snn-error-card-icon">⚠️</span>
        <span class="snn-error-card-title">Action Failed</span>
      </div>
      <div class="snn-error-card-body">
        <p><strong>Tried to:</strong> ${step?.description || step?.action || 'Unknown action'}</p>
        <p><strong>Failed after:</strong> ${totalAttempts || '?'} attempt${totalAttempts !== 1 ? 's' : ''}</p>
        <div class="snn-error-code">
          <span class="snn-error-code-label">${error.code || 'ERROR'}</span>
          <span class="snn-error-code-msg">${error.message || 'Unknown error'}</span>
        </div>
        ${selectorsHtml}
        ${error.detail ? `<div class="snn-error-detail">${this.sp.escapeHtml(error.detail)}</div>` : ''}
        ${error.suggestion ? `<div class="snn-error-suggestion">💡 ${this.sp.escapeHtml(error.suggestion)}</div>` : ''}
      </div>
      <div class="snn-error-card-actions">
        <button class="snn-error-btn snn-error-btn-retry" data-action="retry">🔄 Retry</button>
        <button class="snn-error-btn snn-error-btn-different" data-action="different">💡 Try Differently</button>
        <button class="snn-error-btn snn-error-btn-dismiss" data-action="dismiss">✕ Dismiss</button>
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
      const icon = ok ? '✅' : '❌';
      const desc = r.step.description || r.step.action || `Step ${i + 1}`;
      return `<div class="snn-result-step"><span class="snn-result-step-icon">${icon}</span> ${this.sp.escapeHtml(desc)} <span class="snn-result-step-attempts">(${r.attempts} attempt${r.attempts !== 1 ? 's' : ''})</span></div>`;
    }).join('');

    card.innerHTML = `
      <div class="snn-result-card-header">
        <span class="snn-result-card-icon">✅</span>
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
          <div class="snn-permission-icon">🔒</div>
          <h3>Permission Required</h3>
          <p>${this.sp.escapeHtml(question || 'SNN needs your permission to continue.')}</p>
          <div class="snn-permission-actions">
            <button class="snn-permission-allow">✓ Allow</button>
            <button class="snn-permission-deny">✕ Deny</button>
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
