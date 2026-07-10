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
    // Smoke test state (fire-and-forget after init)
    this._smokeTestPromise = null;
    this._smokeTestStart = null;

    // Current playback state
    this._currentAudio = null;    // HTMLAudioElement
    this._currentPlayerEl = null; // player container div
    this._currentMsgDiv = null;   // which message bubble owns the player
    this._speakBtn = null;        // the button that triggered playback

    // Config
    this._defaultVoice = 'am_michael';  // American male — best quality
    this._modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';
    this._dtype = 'q8';  // loads model_quantized.onnx (~92 MB), ~98% quality
    // ── WASM is the most compatible backend. We patched kokoro.web.js
    //     to force single-thread mode (numThreads=1), which fixes the
    //     SharedArrayBuffer hang in Chrome extensions.
    //     WebGPU is kept as an optional alternative for supported devices.
    this._device = 'wasm';
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
      // ── Pre-configure global ORT env BEFORE import ──────────────────
      // Safety net: if kokoro.web.js patch doesn't work, this ensures
      // ONNX Runtime Web picks up single-thread config from the global scope.
      // ORT Web checks globalThis.ort.env.wasm when initializing.
      const g = /** @type {any} */ (globalThis);
      if (!g.ort) g.ort = {};
      if (!g.ort.env) g.ort.env = {};
      if (!g.ort.env.wasm) g.ort.env.wasm = {};
      g.ort.env.wasm.numThreads = 1;
      g.ort.env.wasm.proxy = false;
      D.log('Pre-seeded globalThis.ort.env.wasm.numThreads=1');

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

      // ── Initialize the pipeline (WASM only, single-threaded) ──────
      D.log(`Loading Kokoro pipeline via ${this._device} backend...`);
      const t0 = performance.now();

      this._tts = await KokoroTTS.from_pretrained(this._modelId, {
        dtype: this._dtype,
        device: this._device,
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

      this._actualDevice = this._device;
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      D.log(`✅ Kokoro pipeline loaded in ${elapsed}s on backend: ${this._device}`);

      this._ready = true;
      D.log('Kokoro TTS initialized successfully!');

      // ── Diagnostics: inspect the backend ──────────────────────────
      this._logBackendInfo();

      // List available voices for debugging
      try {
        // list_voices() just does console.table and returns undefined.
        // Access .voices directly to get the voice map.
        const voices = this._tts.voices;
        if (voices) {
          const voiceIds = Object.keys(voices);
          D.log('Available voices:', voiceIds.length, voiceIds.slice(0, 5));
        } else {
          D.warn('this._tts.voices is undefined — voice list unavailable');
        }
      } catch(e) {
        D.warn('Voice listing failed:', e.message);
      }

      // ── Smoke test: generate 2 words to verify pipeline ──────────
      // Fire-and-forget: runs in background, doesn't block the user.
      // If the user starts a real generation before it finishes, the
      // real generation takes priority.
      this._smokeTestPromise = this._safeGenerate('Hello world.', voice)
        .then(result => {
          const elapsed = ((performance.now() - (this._smokeTestStart || performance.now())) / 1000).toFixed(1);
          D.log(`✅ TTS smoke test PASSED in ${elapsed}s`, {
            audioLen: result?.audio?.length || '?',
            sampleRate: result?.sampling_rate || '?'
          });
          this._smokeTestPromise = null;
        })
        .catch(smokeErr => {
          D.error('❌ TTS smoke test FAILED:', smokeErr.message);
          this._smokeTestPromise = null;
        });
      this._smokeTestStart = performance.now();

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

    // ── Cancel any pending smoke test ─────────────────────────────
    // The smoke test runs in background after init. If it's still going
    // when the user clicks Read, abandon it to free the WASM runtime.
    if (this._smokeTestPromise) {
      D.log('Abandoning pending smoke test for real generation');
      this._smokeTestPromise = null;
      this._smokeTestStart = null;
    }

    // ── Chunk long text ─────────────────────────────────────────
    // Kokoro works best with sentences. For very long text we split
    // at paragraph boundaries to keep inference calls reasonable.
    // Short texts go as one chunk — generate() handles internal processing.
    const MAX_CHUNK = 2000; // chars per chunk (was 500, too aggressive)
    let chunks;

    if (text.length <= MAX_CHUNK) {
      chunks = [text];
    } else {
      // Split at paragraph boundaries (double newlines), not arbitrary length
      const paragraphs = text.split(/\n{2,}/);
      chunks = [];
      let current = '';
      for (const para of paragraphs) {
        if ((current + para).length > MAX_CHUNK && current.length > 0) {
          chunks.push(current.trim());
          current = para;
        } else {
          current += (current ? '\n\n' : '') + para;
        }
      }
      if (current.trim()) chunks.push(current.trim());
      if (chunks.length <= 1) chunks = [text]; // if no good split, use as-is
      D.log(`Text chunked into ${chunks.length} parts at paragraph boundaries`, {
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
              setTimeout(() => reject(new Error(`TTS chunk ${i+1}/${chunks.length} timed out after 180s`)), 180000)
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
   * Generate audio from text using kokoro-js.
   *
   * Uses generate() (one-shot, all text at once) as the primary API.
   * This is faster than stream() because it does ONE model inference call
   * instead of N separate calls (one per sentence). The model internally
   * handles sentence-level generation efficiently.
   *
   * Falls back to stream() if generate() is unavailable.
   *
   * @param {string} text
   * @param {string} voice
   * @returns {Promise<import('kokoro-js').RawAudio>}
   */
  async _safeGenerate(text, voice) {
    // ── Primary: generate() — one-shot, fastest ────────────────────
    D.log('Using generate() (one-shot)');
    try {
      return await this._directGenerate(text, voice);
    } catch (genErr) {
      D.warn('generate() failed, trying stream() fallback:', genErr.message);
      // ── Fallback: stream() — per-sentence, more robust ──────────
      if (typeof this._tts.stream === 'function') {
        return await this._streamGenerate(text, voice);
      }
      throw genErr;
    }
  }

  /**
   * Generate via kokoro-js stream() — splits text into sentences,
   * yields audio per sentence. Much better for debugging and reliability.
   */
  async _streamGenerate(text, voice) {
    const audioPieces = [];
    let sentenceCount = 0;
    const streamStart = performance.now();

    try {
      // stream() with split_pattern splits text into sentences, yielding
      // audio per sentence. Without split_pattern, it processes the whole
      // text as one chunk (same as generate()). We WANT per-sentence splitting
      // for incremental progress and smaller inference calls.
      const stream = this._tts.stream(text, {
        voice,
        split_pattern: '\n'  // Split on newlines first; internal sentence logic handles the rest
      });

      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        D.warn('stream() did not return an async iterator, falling back to generate()');
        return await this._directGenerate(text, voice);
      }

      D.log('Starting stream iteration...');
      for await (const item of stream) {
        sentenceCount++;
        const hasAudio = !!(item.audio && (item.audio.audio || item.audio.length));
        D.log(`  Stream yield ${sentenceCount}: audio=${hasAudio}, text="${(item.text || '').substring(0, 60)}"`);

        if (item.audio) {
          audioPieces.push(item.audio);
        } else {
          D.warn(`  Stream yield ${sentenceCount} has no audio — skipping`);
        }
      }

      const elapsed = ((performance.now() - streamStart) / 1000).toFixed(1);
      D.log(`Stream complete: ${sentenceCount} sentences, ${audioPieces.length} audio pieces in ${elapsed}s`);

    } catch (streamErr) {
      D.error('Stream iteration failed:', streamErr);
      // If we got some audio, return what we have
      if (audioPieces.length > 0) {
        D.warn(`Returning partial audio (${audioPieces.length}/${sentenceCount} pieces) after stream error`);
      } else {
        throw streamErr;
      }
    }

    if (audioPieces.length === 0) {
      throw new Error('kokoro-js stream() yielded no audio pieces');
    }

    if (audioPieces.length === 1) {
      return audioPieces[0];
    }
    return this._concatAudio(audioPieces);
  }

  /**
   * Generate via kokoro-js generate() — one-shot, all text at once.
   * Used as fallback when stream() is unavailable.
   */
  async _directGenerate(text, voice) {
    D.log('Calling generate() directly...');
    const genResult = this._tts.generate(text, { voice });

    // Detect if generate() returned an async generator (older kokoro-js versions)
    if (genResult && typeof genResult[Symbol.asyncIterator] === 'function') {
      D.log('generate() returned async generator (older API) — iterating');
      const audioPieces = [];
      for await (const item of genResult) {
        if (item.audio) audioPieces.push(item.audio);
      }
      if (audioPieces.length === 0) throw new Error('generate() generator yielded no audio');
      return audioPieces.length === 1 ? audioPieces[0] : this._concatAudio(audioPieces);
    }

    // Modern kokoro-js: generate() returns Promise<RawAudio>
    D.log('generate() returned Promise — awaiting...');
    const result = await genResult;

    // RawAudio has .audio (Float32Array) and .sampling_rate (number)
    if (result && result.audio !== undefined && result.sampling_rate !== undefined) {
      D.log('generate() returned RawAudio directly', {
        audioLen: result.audio.length,
        sampleRate: result.sampling_rate
      });
      return result;
    }

    // Might be wrapped: { audio: RawAudio, ... }
    if (result?.audio && result.audio.audio !== undefined) {
      D.log('generate() returned wrapped result — extracting .audio');
      return result.audio;
    }

    throw new Error(`Unexpected generate() return type: ${typeof result}, keys: ${result ? Object.keys(result).join(',') : 'null'}`);
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
