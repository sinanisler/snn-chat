// ═══════════════════════════════════════════════════════════════════
// SNN Offscreen Document — PDF Text Extraction via PDF.js
// ═══════════════════════════════════════════════════════════════════
// Runs in an offscreen document (has DOM access, unlike service worker).
// Receives PDF URLs/bytes from background.js, extracts text via PDF.js,
// and sends the extracted text back.

import * as pdfjsLib from '../lib/pdf.min.mjs';

// ── Configure PDF.js worker ───────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.mjs';

// ═══════════════════════════════════════════════════════════════════
// MESSAGE LISTENER
// ═══════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'offscreen:extractPdf') {
    _extractPdfText(message.url, message.arrayBuffer)
      .then(text => sendResponse({ success: true, text }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.action === 'offscreen:extractPdfFromBuffer') {
    _extractPdfFromArrayBuffer(message.arrayBuffer)
      .then(text => sendResponse({ success: true, text }))
      .catch(err => sendResponse({ success: false, error: err.message }));
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
    // Already have the bytes (e.g. from background fetch for local files)
    data = arrayBuffer;
  } else if (url) {
    // Fetch the PDF ourselves
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: HTTP ${response.status}`);
      }
      data = await response.arrayBuffer();
    } catch (fetchErr) {
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

  // Load the PDF document
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;

  const numPages = pdf.numPages;
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

  return pageTexts.join('\n\n');
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

console.log('[SNN Offscreen] PDF extractor ready');
