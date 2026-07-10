// ═══════════════════════════════════════════════════════════════════
// SNN Kokoro TTS — High-quality local text-to-speech via Kokoro-82M
// ═══════════════════════════════════════════════════════════════════
// Uses kokoro-js (Transformers.js wrapper) with a locally-bundled
// ONNX model (model_q8f16.onnx, ~86 MB) + voice style vectors.
// First load fetches model files from HuggingFace & caches them;
// subsequent reads are near-instant from browser Cache API.
// ═══════════════════════════════════════════════════════════════════

var SNN_D = (typeof SNN_D !== 'undefined') ? SNN_D : {
  enabled: true,
  module: 'KokoroTTS',
  _ts: () => new Date().toISOString().slice(11, 23),
  _fmt(o) {
    if (o === undefined) return 'undefined';
    if (o === null) return 'null';
    if (typeof o === 'string') return o.length > 200 ? o.slice(0, 200) + '…' : o;
    if (o instanceof Error) return `[${o.name}] ${o.message}`;
    try { return JSON.stringify(o).slice(0, 300); } catch(e) { return String(o).slice(0, 300); }
  },
  log(...args) { if (!this.enabled) return; console.log(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#a5d6ff;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  warn(...args) { console.warn(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ffb74d;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
  error(...args) { console.error(`%c[${this._ts()}] [SNN:${this.module}]%c`, 'color:#ef5350;font-weight:bold', '', ...args.map(a => this._fmt(a))); },
};
var D = SNN_D;

class SNNKokoroTTS {
  constructor() {
    /** @type {import('kokoro-js').KokoroTTS|null} */
    this._tts = null;
    this._loading = false;
    this._ready = false;
    this._initPromise = null;
    // Track which backend we actually ended up using (may differ from requested)
    this._actualDevice = null;

    // Current playback state
    this._currentAudio = null;    // HTMLAudioElement
    this._currentPlayerEl = null; // player container div
    this._currentMsgDiv = null;   // which message bubble owns the player
    this._speakBtn = null;        // the button that triggered playback

    // Config
    this._defaultVoice = 'am_michael';  // American male — best quality
    this._modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';
    this._dtype = 'q8';  // loads model_quantized.onnx (~92 MB), ~98% quality
    // ── Prefer WebGPU: it runs on the GPU, doesn't block the main thread,
    //     and avoids SharedArrayBuffer threading hangs in extensions.
    //     Falls back to WASM (single-thread) if WebGPU is unavailable.
    this._device = this._detectBestDevice();
  }

  /**
   * Auto-detect the best available ONNX backend.
   * WebGPU > WASM (WebGPU avoids the SharedArrayBuffer freeze).
   */
  _detectBestDevice() {
    const hasWebGPU = typeof navigator !== 'undefined' && navigator.gpu;
    if (hasWebGPU) {
      D.log('WebGPU detected — will use GPU backend (no main-thread blocking)');
      return 'webgpu';
    }
    D.log('WebGPU not available — falling back to WASM');
    return 'wasm';
  }

  /**
   * Initialize the Kokoro TTS pipeline. Called automatically on first speak().
   * Downloads model files from HuggingFace on first run (cached thereafter).
   */
  async init(options = {}) {
    if (this._ready) return;

    // If already loading, wait for that to finish
    if (this._loading && this._initPromise) {
      await this._initPromise;
      return;
    }

    this._loading = true;
    this._initPromise = this._doInit(options);
    try {
      await this._initPromise;
    } finally {
      this._loading = false;
      this._initPromise = null;
    }
  }

  async _doInit(options = {}) {
    const voice = options.voice || this._defaultVoice;
    D.log('Initializing Kokoro TTS...', { device: this._device, dtype: this._dtype, voice });

    try {
      // ── Dynamic import of the kokoro-js web bundle ──
      const kokoroUrl = chrome.runtime.getURL('assets/lib/kokoro.web.js');
      D.log('Loading kokoro-js from:', kokoroUrl);

      /** @type {{ KokoroTTS: any, env: any }} */
      let mod;
      let KokoroTTS;
      try {
        mod = await import(kokoroUrl);
        KokoroTTS = mod.KokoroTTS;
        D.log('kokoro-js module loaded OK', {
          hasEnv: !!mod.env,
          hasKokoroTTS: !!mod.KokoroTTS
        });
      } catch (importErr) {
        // Fallback: try CDN
        D.warn('Local import failed, trying CDN fallback:', importErr.message);
        mod = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js');
        KokoroTTS = mod.KokoroTTS;
      }

      if (!KokoroTTS) {
        throw new Error('KokoroTTS export not found in kokoro-js module');
      }

      // ── Configure WASM paths (needed even for WebGPU as fallback) ──
      if (mod.env?.wasmPaths !== undefined) {
        const sidebarWasmPath = chrome.runtime.getURL('sidebar/');
        D.log('Setting ORT wasmPaths to:', sidebarWasmPath);
        mod.env.wasmPaths = sidebarWasmPath;
      } else {
        D.warn('mod.env.wasmPaths not available');
      }

      // ── Force single-threaded WASM through ALL accessible channels ──
      // Chrome extension side panels lack crossOriginIsolated → SharedArrayBuffer
      // is blocked → multi-threaded WASM hangs FOREVER. We attack this from
      // every angle to ensure numThreads=1.
      this._forceWasmSingleThread(mod);

      // ── Check environment capabilities ────────────────────────────
      D.log('Runtime capabilities', {
        crossOriginIsolated: self.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
        webgl: typeof WebGLRenderingContext !== 'undefined'
      });

      // ── Initialize the pipeline with fallback ──────────────────────
      // Try WebGPU first (GPU-backed, no main-thread blocking, no SAB needed).
      // If it fails, retry with WASM (already force-configured to single-thread).
      const devicesToTry = this._device === 'webgpu'
        ? ['webgpu', 'wasm']
        : ['wasm'];

      let lastError = null;
      for (const device of devicesToTry) {
        try {
          D.log(`Trying backend: ${device}`);
          const t0 = performance.now();

          this._tts = await KokoroTTS.from_pretrained(this._modelId, {
            dtype: this._dtype,
            device: device,
            session_options: {
              intra_op_num_threads: 1,
              inter_op_num_threads: 1,
              graph_optimization_level: 'all'
            },
            progress_callback: (info) => {
              if (info.status === 'download') {
                D.log(`Kokoro download: ${info.file} — ${info.progress?.toFixed(0) || '...'}%`);
              } else if (info.status === 'done') {
                D.log(`Kokoro ready: ${info.file}`);
              } else if (info.status === 'progress') {
                D.log(`Kokoro progress: ${info.file} — ${info.progress?.toFixed(0) || '...'}%`);
              } else {
                D.log(`Kokoro status: ${info.status}`, { file: info.file, progress: info.progress });
              }
            }
          });

          this._actualDevice = device;
          const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
          D.log(`✅ Kokoro pipeline loaded in ${elapsed}s on backend: ${device}`);
          break; // success — exit retry loop
        } catch (deviceErr) {
          lastError = deviceErr;
          D.warn(`Backend '${device}' failed:`, deviceErr.message);
          this._tts = null;
          // Continue to next device in the fallback list
        }
      }

      if (!this._tts) {
        throw new Error(
          `All backends failed. Last error: ${lastError?.message || 'unknown'}. ` +
          `Tried: ${devicesToTry.join(', ')}.`
        );
      }

      this._ready = true;
      D.log('Kokoro TTS initialized successfully!');

      // ── Diagnostics: inspect the backend ──────────────────────────
      this._logBackendInfo();

      // List available voices for debugging
      try {
        const voices = this._tts.list_voices();
        D.log('Available voices:', voices.length);
      } catch(e) {
        D.warn('list_voices() not available:', e.message);
      }

    } catch (err) {
      D.error('Kokoro TTS initialization failed:', {
        message: err.message,
        name: err.name,
        stack: (err.stack || '').split('\n').slice(0, 4).join('\n'),
        cause: err.cause?.message || null
      });
      this._ready = false;
      this._tts = null;
      throw err;
    }
  }

  /**
   * Log diagnostic info about the active ONNX backend.
   */
  _logBackendInfo() {
    try {
      // Try to access the internal Transformers.js env
      if (this._tts) {
        D.log('TTS model instance type:', this._tts.constructor?.name || 'unknown');
        if (this._tts.model) {
          D.log('TTS model backend type:', this._tts.model.constructor?.name || 'unknown');
        }
      }
      // Check if we can access the ORT env
      const ortInfo = {
        wasmSimd: typeof WebAssembly !== 'undefined' && WebAssembly.validate(
          new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,4,1,3,1,1,10,11,1,9,0,65,0,254,16,2,0,26,11])
        ),
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined'
      };
      D.log('ORT environment', ortInfo);
    } catch (e) {
      D.warn('Backend diagnostics failed:', e.message);
    }
  }

  /**
   * Force the ONNX WASM backend to single-thread mode through every
   * accessible channel. This is critical in Chrome extensions where
   * SharedArrayBuffer is blocked → multi-threaded WASM hangs forever.
   *
   * We try (in order):
   *  1. kokoro-js env.wasm (the thin exported wrapper — usually missing .wasm)
   *  2. globalThis.ort.env.wasm (ORT Web may store its env globally)
   *  3. self.ort.env.wasm (same, under self)
   *
   * @param {any} mod - The imported kokoro-js module
   */
  _forceWasmSingleThread(mod) {
    let found = false;

    // ── Channel 1: mod.env (kokoro-js thin wrapper) ────────────────
    // mod.env is { set wasmPaths, get wasmPaths } — does NOT expose .wasm directly.
    // But we can check its prototype and try to define the property.
    if (mod?.env) {
      try {
        // Attempt direct property access (may be undefined on the thin wrapper)
        if (mod.env.wasm !== undefined) {
          mod.env.wasm.numThreads = 1;
          mod.env.wasm.proxy = false;
          D.log('[chan 1] Set numThreads=1 via mod.env.wasm');
          found = true;
        }
      } catch (e) { /* channel unavailable */ }
    }

    // ── Channel 2: globalThis.ort ──────────────────────────────────
    // ONNX Runtime Web v1.18+ may expose ort.env globally
    try {
      const g = /** @type {any} */ (globalThis);
      if (g.ort?.env?.wasm) {
        g.ort.env.wasm.numThreads = 1;
        g.ort.env.wasm.proxy = false;
        D.log('[chan 2] Set numThreads=1 via globalThis.ort.env.wasm');
        found = true;
      }
    } catch (e) { /* channel unavailable */ }

    // ── Channel 3: self.ort ────────────────────────────────────────
    try {
      const s = /** @type {any} */ (self);
      if (s.ort?.env?.wasm) {
        s.ort.env.wasm.numThreads = 1;
        s.ort.env.wasm.proxy = false;
        D.log('[chan 3] Set numThreads=1 via self.ort.env.wasm');
        found = true;
      }
    } catch (e) { /* channel unavailable */ }

    // ── Channel 4: Any enumerable property on mod that looks like ORT env ──
    if (!found && mod) {
      try {
        for (const key of Object.keys(mod)) {
          const val = mod[key];
          if (val && typeof val === 'object' && val.env?.wasm) {
            val.env.wasm.numThreads = 1;
            val.env.wasm.proxy = false;
            D.log(`[chan 4] Set numThreads=1 via mod.${key}.env.wasm`);
            found = true;
            break;
          }
        }
      } catch (e) { /* channel unavailable */ }
    }

    if (!found) {
      D.warn('⚠ Could NOT set WASM numThreads through any channel! If using WASM backend, it may hang.');
      D.warn('  (Using WebGPU backend avoids this issue entirely.)');
    } else {
      D.log('✅ WASM single-thread mode configured successfully');
    }
  }

  /**
   * Generate speech audio and return a blob URL + audio element.
   * @param {string} text - The text to speak
   * @param {object} options
   * @param {string} [options.voice='am_michael'] - Voice ID
   * @returns {Promise<{url: string, audio: HTMLAudioElement, blob: Blob}>}
   */
  async generate(text, options = {}) {
    await this.init(options);

    const voice = options.voice || this._defaultVoice;
    const genStart = performance.now();
    D.log('▶ Generating speech START', {
      textLen: text.length,
      voice,
      isReady: this._ready,
      timestamp: new Date().toISOString()
    });

    // ── Pre-generation health check ──────────────────────────────
    this._logPreGenerationState();

    // ── Chunk long text to avoid buffer overflows ──
    // Kokoro works best with sentences. For very long text, we split
    // at sentence boundaries and concatenate audio.
    const MAX_CHUNK = 500; // characters per chunk
    let chunks;

    if (text.length <= MAX_CHUNK) {
      chunks = [text];
    } else {
      chunks = this._splitText(text, MAX_CHUNK);
      D.log(`Text chunked into ${chunks.length} parts`, {
        chunkLengths: chunks.map(c => c.length)
      });
    }

    // ── Heartbeat: log every 10s so we can see if main thread is alive ──
    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => {
      heartbeatTicks++;
      D.log(`⏱ TTS heartbeat ${heartbeatTicks * 10}s — still generating...`, {
        elapsed: ((performance.now() - genStart) / 1000).toFixed(1) + 's',
        pendingChunks: chunks.length - audioBuffers.length
      });
    }, 10000);

    // ── Generate audio for each chunk ──
    const audioBuffers = [];
    let chunkErrors = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk.trim()) {
          D.log(`Chunk ${i + 1}/${chunks.length} is empty, skipping`);
          continue;
        }

        const chunkStart = performance.now();
        D.log(`⚡ Generating chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`, {
          textPreview: chunk.substring(0, 80) + (chunk.length > 80 ? '…' : ''),
          timestamp: new Date().toISOString()
        });

        try {
          // ── Generate audio via kokoro-js ──────────────────────────
          // NOTE: kokoro-js generate() is an async generator that yields
          // {text, phonemes, audio} for each sentence. We collect all yields
          // and concatenate the audio. If the API changes to return a single
          // RawAudio, we handle that too.
          const genResult = await Promise.race([
            this._safeGenerate(chunk, voice),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`TTS chunk ${i+1}/${chunks.length} timed out after 60s — WASM may be stuck`)), 60000)
            )
          ]);

          const chunkElapsed = ((performance.now() - chunkStart) / 1000).toFixed(1);
          D.log(`✅ Chunk ${i + 1}/${chunks.length} done in ${chunkElapsed}s`, {
            audioLen: genResult?.audio?.length || 0,
            sampleRate: genResult?.sampling_rate || 24000,
            audioSecs: genResult?.audio ? (genResult.audio.length / (genResult.sampling_rate || 24000)).toFixed(1) + 's' : 'unknown'
          });
          audioBuffers.push(genResult);
        } catch (chunkErr) {
          D.error(`❌ Chunk ${i + 1}/${chunks.length} FAILED:`, {
            message: chunkErr.message,
            name: chunkErr.name,
            stack: (chunkErr.stack || '').split('\n').slice(0, 3).join('\n')
          });
          chunkErrors.push({ index: i, error: chunkErr.message });
          // Continue with remaining chunks rather than failing completely
        }
      }
    } finally {
      clearInterval(heartbeat);
    }

    // ── If all chunks failed, bail ────────────────────────────────
    if (audioBuffers.length === 0) {
      const errSummary = chunkErrors.map(e => `Chunk ${e.index+1}: ${e.error}`).join('; ');
      throw new Error(`TTS generation failed — all ${chunks.length} chunk(s) errored: ${errSummary}`);
    }

    // ── Warn if some chunks failed ────────────────────────────────
    if (chunkErrors.length > 0) {
      D.warn(`⚠ ${chunkErrors.length}/${chunks.length} chunks failed — audio may be incomplete`, chunkErrors);
    }

    // ── Concatenate audio if multiple chunks ──
    const concatStart = performance.now();
    let finalAudio;
    if (audioBuffers.length === 1) {
      finalAudio = audioBuffers[0];
      D.log('Single chunk — skipping concat');
    } else {
      D.log(`Concatenating ${audioBuffers.length} audio chunks...`);
      finalAudio = this._concatAudio(audioBuffers);
      D.log(`Concatenation done in ${((performance.now() - concatStart) / 1000).toFixed(2)}s`);
    }

    // ── Convert to WAV blob and create URL ──
    D.log('Converting to WAV blob...');
    let wavBlob;
    try {
      wavBlob = finalAudio.toBlob();
      D.log('WAV blob created', {
        sizeKB: (wavBlob.size / 1024).toFixed(1),
        type: wavBlob.type,
        audioLen: finalAudio.audio?.length || 0
      });
    } catch (blobErr) {
      D.error('toBlob() failed:', blobErr);
      throw new Error(`Failed to create WAV blob: ${blobErr.message}`);
    }

    const url = URL.createObjectURL(wavBlob);
    D.log('Blob URL created:', url.substring(0, 60) + '…');

    // Create audio element
    const audio = new Audio(url);
    audio.controls = false; // we use our own controls

    // ── Attach error listener for playback issues ──
    audio.addEventListener('error', (e) => {
      const err = audio.error;
      D.error('Audio element error:', {
        code: err?.code,
        message: err?.message || 'unknown',
        networkState: audio.networkState
      });
    });

    const totalElapsed = ((performance.now() - genStart) / 1000).toFixed(1);
    D.log(`🏁 Speech generation complete in ${totalElapsed}s`, {
      textLen: text.length,
      chunks: chunks.length,
      totalAudioSecs: finalAudio.audio ? (finalAudio.audio.length / (finalAudio.sampling_rate || 24000)).toFixed(1) + 's' : 'unknown',
      blobSizeKB: (wavBlob.size / 1024).toFixed(1)
    });

    return { url, audio, blob: wavBlob };
  }

  /**
   * Log diagnostic state before starting speech generation.
   * Helps identify WASM/backend issues before they cause hangs.
   */
  _logPreGenerationState() {
    try {
      D.log('Pre-generation state', {
        ttsExists: !!this._tts,
        ttsType: this._tts?.constructor?.name || 'null',
        modelExists: !!this._tts?.model,
        modelType: this._tts?.model?.constructor?.name || 'null',
        tokenizerExists: !!this._tts?.tokenizer,
        voiceCount: this._tts?.voices ? Object.keys(this._tts.voices).length : 'unknown',
        requestedDevice: this._device,
        actualDevice: this._actualDevice || 'unknown',
        dtype: this._dtype
      });
    } catch (e) {
      D.warn('Pre-generation state check failed:', e.message);
    }
  }

  /**
   * Safely call kokoro-js generate() which may be an async generator.
   * Collects all yielded audio chunks and concatenates into a single RawAudio.
   * If generate() returns a RawAudio directly (non-generator), use it as-is.
   * @param {string} text
   * @param {string} voice
   * @returns {Promise<import('kokoro-js').RawAudio>}
   */
  async _safeGenerate(text, voice) {
    const genResult = this._tts.generate(text, { voice });

    // Detect if the result is an async generator (kokoro-js >= 1.x)
    if (genResult && typeof genResult[Symbol.asyncIterator] === 'function') {
      D.log('kokoro-js generate() returned async generator — collecting yields');
      const audioPieces = [];
      let sentenceCount = 0;
      const iterStart = performance.now();
      try {
        for await (const item of genResult) {
          sentenceCount++;
          if (item.audio) {
            audioPieces.push(item.audio);
            D.log(`  Yield ${sentenceCount}: audio len=${item.audio.audio?.length || item.audio.length || '?'}, text="${(item.text || '').substring(0, 50)}"`);
          }
        }
      } catch (iterErr) {
        D.error('Async generator iteration failed:', iterErr);
        throw iterErr;
      }
      const iterElapsed = ((performance.now() - iterStart) / 1000).toFixed(1);
      D.log(`Async generator complete: ${sentenceCount} sentences in ${iterElapsed}s`);

      if (audioPieces.length === 0) {
        throw new Error('kokoro-js generate() yielded no audio pieces');
      }

      // Concatenate all audio pieces into one RawAudio
      if (audioPieces.length === 1) {
        return audioPieces[0];
      }
      return this._concatAudio(audioPieces);
    }

    // Non-generator: assume it's a Promise<RawAudio> or RawAudio directly
    D.log('kokoro-js generate() returned non-generator — awaiting directly');
    const result = await genResult;
    if (result && result.audio !== undefined && result.sampling_rate !== undefined) {
      return result; // Already a RawAudio
    }
    // Might be wrapped in { audio: RawAudio }
    if (result?.audio) {
      return result.audio;
    }
    throw new Error(`Unexpected generate() return type: ${typeof result}`);
  }

  /**
   * Split text into chunks at sentence boundaries.
   */
  _splitText(text, maxLen) {
    const chunks = [];
    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];

    let current = '';
    for (const sentence of sentences) {
      if ((current + sentence).length > maxLen && current.length > 0) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length ? chunks : [text];
  }

  /**
   * Concatenate multiple RawAudio objects into one.
   */
  _concatAudio(audioList) {
    if (audioList.length === 0) return null;
    if (audioList.length === 1) return audioList[0];

    // All Kokoro audio is 24000 Hz mono
    const sampleRate = audioList[0].sampling_rate;
    const totalLength = audioList.reduce((sum, a) => sum + a.audio.length, 0);
    const combined = new Float32Array(totalLength);

    let offset = 0;
    for (const a of audioList) {
      combined.set(a.audio, offset);
      offset += a.audio.length;
    }

    // Re-wrap as RawAudio-compatible object
    // kokoro-js RawAudio constructor takes (audio, sampling_rate)
    const RawAudio = audioList[0].constructor;
    return new RawAudio(combined, sampleRate);
  }

  /**
   * Stop any currently playing audio and clean up the player UI.
   */
  stop() {
    if (this._currentAudio) {
      try { this._currentAudio.pause(); } catch(e) {}
      this._currentAudio.src = '';
      this._currentAudio.load();
      this._currentAudio = null;
    }
    this._removePlayer();
    this._updateSpeakButton(false);
  }

  /**
   * Create an inline audio player below a message bubble.
   * @param {HTMLElement} msgDiv - The message container to attach player to
   * @param {string} url - Blob URL for the WAV audio
   * @param {HTMLButtonElement} speakBtn - The button that triggered playback
   */
  attachPlayer(msgDiv, url, speakBtn) {
    // Remove any existing player
    this._removePlayer();

    // Create player container
    const playerEl = document.createElement('div');
    playerEl.className = 'sp-tts-player';

    // Create audio element
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.controls = true;
    audio.className = 'sp-tts-audio';

    // Listen for playback end
    audio.addEventListener('ended', () => {
      this._updateSpeakButton(false);
    });
    audio.addEventListener('pause', () => {
      if (audio.currentTime >= audio.duration - 1) {
        this._updateSpeakButton(false);
      }
    });

    playerEl.appendChild(audio);
    msgDiv.appendChild(playerEl);

    // Store references
    this._currentAudio = audio;
    this._currentPlayerEl = playerEl;
    this._currentMsgDiv = msgDiv;
    this._speakBtn = speakBtn;

    // Auto-play
    audio.play().catch(e => {
      D.warn('Auto-play failed (user gesture needed):', e.message);
    });

    this._updateSpeakButton(true);
  }

  /**
   * Remove the inline player from the DOM.
   */
  _removePlayer() {
    if (this._currentPlayerEl) {
      this._currentPlayerEl.remove();
      this._currentPlayerEl = null;
    }
    this._currentMsgDiv = null;
    if (this._currentAudio) {
      try { this._currentAudio.pause(); } catch(e) {}
      this._currentAudio = null;
    }
  }

  /**
   * Update the speak button's visual state (playing vs idle).
   */
  _updateSpeakButton(playing) {
    if (!this._speakBtn) return;

    if (playing) {
      this._speakBtn.classList.add('playing');
      this._speakBtn.title = 'Stop';
      this._speakBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/></svg> Stop`;
    } else {
      this._speakBtn.classList.remove('playing');
      this._speakBtn.title = 'Read aloud';
      this._speakBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" fill="currentColor"/><path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" fill="currentColor"/></svg> Read`;
    }
  }

  /**
   * Handle clicking the Read button.
   * @param {string} text - Text content to read
   * @param {HTMLElement} msgDiv - The message container div
   * @param {HTMLButtonElement} speakBtn - The button clicked
   */
  async handleSpeakClick(text, msgDiv, speakBtn) {
    D.log('🔊 Speak button clicked', {
      textLen: text.length,
      isReady: this._ready,
      isLoading: this._loading,
      currentlyPlaying: !!(this._currentAudio && !this._currentAudio.paused),
      hasExistingPlayer: !!this._currentPlayerEl
    });

    // If currently playing, stop
    if (this._currentAudio && !this._currentAudio.paused) {
      D.log('Stopping current playback');
      this.stop();
      return;
    }

    // If player exists but paused, just resume
    if (this._currentAudio && this._currentAudio.paused && this._currentMsgDiv === msgDiv) {
      D.log('Resuming paused playback');
      this._currentAudio.play().catch(e => {
        D.warn('Resume playback failed:', e.message);
      });
      this._updateSpeakButton(true);
      return;
    }

    // Clean up any previous player from a different message
    this._removePlayer();

    const clickStart = performance.now();
    try {
      // Show loading state
      speakBtn.classList.add('loading');
      speakBtn.innerHTML = `<span class="sp-tts-spinner"></span> Loading...`;
      speakBtn.disabled = true;
      D.log('TTS loading state shown');

      // Generate speech
      D.log('Calling generate()...');
      const { url, audio } = await this.generate(text);
      const genElapsed = ((performance.now() - clickStart) / 1000).toFixed(1);
      D.log(`generate() returned in ${genElapsed}s`, { url: url.substring(0, 50) + '…' });

      // Remove loading state
      speakBtn.classList.remove('loading');
      speakBtn.disabled = false;

      // Attach player to message
      this.attachPlayer(msgDiv, url, speakBtn);

    } catch (err) {
      const failElapsed = ((performance.now() - clickStart) / 1000).toFixed(1);
      D.error(`TTS generation FAILED after ${failElapsed}s:`, {
        message: err.message,
        name: err.name,
        stack: (err.stack || '').split('\n').slice(0, 5).join('\n'),
        cause: err.cause?.message || null
      });

      speakBtn.classList.remove('loading');
      speakBtn.disabled = false;
      this._updateSpeakButton(false);

      // Show error toast if sidePanel is available
      if (typeof window !== 'undefined' && window._snnSidePanel?.showToast) {
        const friendlyMsg = this._friendlyErrorMessage(err);
        window._snnSidePanel.showToast('TTS: ' + friendlyMsg, 'error');
      }
    }
  }

  /**
   * Convert technical TTS errors into user-friendly messages.
   */
  _friendlyErrorMessage(err) {
    const msg = err.message || 'Unknown error';
    if (msg.includes('timed out')) return 'Speech generation timed out. The model may be too large for this device.';
    if (msg.includes('out of memory') || msg.includes('OOM')) return 'Not enough memory for speech. Try shorter text.';
    if (msg.includes('SharedArrayBuffer')) return 'Browser security policy blocks audio generation.';
    if (msg.includes('WebAssembly') || msg.includes('WASM')) return 'Speech engine failed to initialize. Try reloading.';
    if (msg.includes('NetworkError') || msg.includes('Failed to fetch')) return 'Could not download speech model. Check your internet connection.';
    return msg.length > 100 ? msg.substring(0, 97) + '…' : msg;
  }

  /**
   * Returns whether the TTS engine is initialized and ready.
   */
  get isReady() { return this._ready; }

  /**
   * Returns whether the engine is currently loading.
   */
  get isLoading() { return this._loading; }
}

// ── Create singleton ──
const snnKokoroTTS = new SNNKokoroTTS();
