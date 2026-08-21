// ═══════════════════════════════════════════════════════════════════
// SNN Offscreen Document — PDF Text Extraction via PDF.js
// ═══════════════════════════════════════════════════════════════════
// Runs in an offscreen document (has DOM access, unlike service worker).
// Receives PDF URLs/bytes from background.js, extracts text via PDF.js,
// and sends the extracted text back.

// ── DEBUG LOGGING ──────────────────────────────────────────────────
var SNN_D = {
  enabled: false,
  module: 'Offscreen',
  _ts: () => new Date().toISOString().slice(11, 23),
  _fmt(o) {
    if (o === undefined) return 'undefined';
    if (o === null) return 'null';
    if (typeof o === 'string') return o.length > 200 ? o.slice(0, 200) + '…(' + o.length + ')' : o;
    if (o instanceof Error) return `[${o.name}] ${o.message}`;
    try { return JSON.stringify(o).slice(0, 300); } catch(e) { return String(o).slice(0, 300); }
  },
  log(...args) { if (!this.enabled) return; console.log(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#aed581;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  warn(...args) { if (!this.enabled) return; console.warn(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ffb74d;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  error(...args) { console.error(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ef5350;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
};
var D = SNN_D;

import * as pdfjsLib from '../assets/lib/pdf.min.mjs';

// ── Configure PDF.js worker ───────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = '../assets/lib/pdf.worker.min.mjs';

// ═══════════════════════════════════════════════════════════════════
// MESSAGE LISTENER
// ═══════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'offscreen:extractPdf') {
    D.log('← PDF extract request', { url: (message.url || '').substring(0, 100), hasBuffer: !!message.arrayBuffer });
    _extractPdfText(message.url, message.arrayBuffer)
      .then(text => { D.log('PDF extract OK', { textLen: text.length }); sendResponse({ success: true, text }); })
      .catch(err => { D.error('PDF extract FAIL', { error: err.message }); sendResponse({ success: false, error: err.message }); });
    return true;
  }

  if (message.action === 'offscreen:extractPdfFromBuffer') {
    D.log('← PDF buffer extract request', { byteLen: message.arrayBuffer?.byteLength || 0 });
    _extractPdfFromArrayBuffer(message.arrayBuffer)
      .then(text => { D.log('PDF buffer extract OK', { textLen: text.length }); sendResponse({ success: true, text }); })
      .catch(err => { D.error('PDF buffer extract FAIL', { error: err.message }); sendResponse({ success: false, error: err.message }); });
    return true;
  }
});

// ═══════════════════════════════════════════════════════════════════
// PDF TEXT EXTRACTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch a PDF from a URL and extract its text.
 * @param {string} url - The PDF URL to fetch
 * @param {ArrayBuffer} [arrayBuffer] - Pre-fetched PDF bytes (optional)
 */
async function _extractPdfText(url, arrayBuffer) {
  let data;

  if (arrayBuffer) {
    D.log('_extractPdfText: using provided buffer');
    data = arrayBuffer;
  } else if (url) {
    D.log('_extractPdfText: fetching URL', { url: url.substring(0, 100) });
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: HTTP ${response.status}`);
      }
      data = await response.arrayBuffer();
      D.log('_extractPdfText: fetched', { byteLen: data.byteLength });
    } catch (fetchErr) {
      D.error('_extractPdfText: fetch failed', { error: fetchErr.message });
      throw new Error(`Could not fetch PDF: ${fetchErr.message}`);
    }
  } else {
    throw new Error('No PDF URL or data provided');
  }

  return _extractPdfFromArrayBuffer(data);
}

/**
 * Extract text from a PDF ArrayBuffer using PDF.js.
 */
async function _extractPdfFromArrayBuffer(data) {
  if (!data || data.byteLength === 0) {
    throw new Error('Empty PDF data received');
  }

  D.log('_extractPdfFromArrayBuffer', { byteLen: data.byteLength });

  // Load the PDF document
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;

  const numPages = pdf.numPages;
  D.log('PDF loaded', { numPages });
  const pageTexts = [];

  // Extract text from each page
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();

    // Build page text, preserving some layout via y-position grouping
    const pageText = _buildPageText(textContent.items);
    pageTexts.push(`--- Page ${i} of ${numPages} ---\n${pageText}`);
  }

  // Clean up
  await loadingTask.destroy();

  const result = pageTexts.join('\n\n');
  D.log('_extractPdfFromArrayBuffer DONE', { numPages, totalChars: result.length });
  return result;
}

/**
 * Build readable text from PDF.js text items.
 * Groups items by approximate line (y-position) and sorts left-to-right.
 */
function _buildPageText(items) {
  if (!items || items.length === 0) return '';

  // Group items by y-position (lines), with tolerance for same-line detection
  const tolerance = 5;
  const lines = [];

  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const y = Math.round(item.transform[5]);

    let line = lines.find(l => Math.abs(l.y - y) < tolerance);
    if (!line) {
      line = { y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  // Sort lines top-to-bottom (larger y = lower on page, so descending)
  lines.sort((a, b) => b.y - a.y);

  // Within each line, sort left-to-right (by x-position transform[4])
  // Then join with spaces
  return lines.map(line => {
    line.items.sort((a, b) => a.transform[4] - b.transform[4]);
    return line.items.map(item => item.str).join(' ');
  }).join('\n');
}

D.log('PDF extractor ready');

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
