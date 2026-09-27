// ═══════════════════════════════════════════════════════════════════
// SNN OpenRouter TTS — speech model catalog, auto model pick, synthesis
// ═══════════════════════════════════════════════════════════════════
// Pure logic, no DOM. The side panel owns the settings UI and the
// "Generate audio" button; this class only talks to OpenRouter:
//   GET  /models?output_modalities=speech   (public, no key needed)
//   POST /audio/speech                      (raw audio byte stream back)
//
// No model id is ever hardcoded as a default. "Auto" resolves at runtime
// to the best free speech model in the live catalog, so a retired model
// never breaks the feature — the next catalog fetch simply picks another.
// ═══════════════════════════════════════════════════════════════════

const SNN_TTS_API = 'https://openrouter.ai/api/v1';
const SNN_TTS_CATALOG_KEY = 'snn_tts_models_cache';
const SNN_TTS_CATALOG_TTL = 24 * 60 * 60 * 1000;
const SNN_TTS_AUTO = 'auto';

// Models that reject mp3 and only stream raw PCM (Gemini TTS today). The
// catalog doesn't expose supported formats, so this is learned: a model
// that 400s on mp3 with a "pcm" message gets remembered here.
const SNN_TTS_PCM_ONLY = [/^google\/gemini-.*tts/i];

// Gemini PCM is documented as 24 kHz / 16-bit / mono; the Content-Type
// header ("audio/pcm;rate=24000;channels=1") overrides these when present.
const SNN_TTS_PCM_DEFAULT = { rate: 24000, channels: 1 };

// Fallback input budget (characters) for models whose catalog entry has
// no context_length (reported as 0 for most per-character-priced models).
const SNN_TTS_DEFAULT_MAX_CHARS = 4000;

const SNN_TTS_DEFAULT_PROMPT = `You turn text into a script that will be read aloud by a text-to-speech voice, in the style of a friendly, engaging podcast host.

Rules:
- Summarize and explain; don't read the text word for word. Keep the key facts, numbers and conclusions.
- Start with a short, natural intro line and end with a brief wrap-up.
- Write only what should be spoken: no markdown, headings, bullet points, emojis, URLs, code or tables.
- Say numbers, symbols, units and abbreviations the way a person would say them out loud.
- Use short sentences, natural transitions and a conversational tone.
- Write in the same language as the original text.
- Keep the script under {maxChars} characters.

Output only the script.`;

class SNNOpenRouterTTS {
  constructor() {
    this._catalog = null;          // [{ id, name, voices, pricePerChar, maxChars, free, created }]
    this._catalogPromise = null;
    this._learnedPcmOnly = new Set();
  }

  // ── Catalog ─────────────────────────────────────────────────────

  /** Speech models from OpenRouter, cached in chrome.storage.local for a day. */
  async getModels({ force = false } = {}) {
    if (this._catalog && !force) return this._catalog;
    if (!force) {
      try {
        const { [SNN_TTS_CATALOG_KEY]: c } = await chrome.storage.local.get([SNN_TTS_CATALOG_KEY]);
        if (c?.models?.length && Date.now() - c.at < SNN_TTS_CATALOG_TTL) {
          this._catalog = c.models;
          return this._catalog;
        }
      } catch (e) { /* fall through to network */ }
    }
    if (!this._catalogPromise) {
      this._catalogPromise = this._fetchModels().finally(() => { this._catalogPromise = null; });
    }
    try {
      return await this._catalogPromise;
    } catch (e) {
      // Offline or API hiccup: a stale cache beats an empty picker.
      try {
        const { [SNN_TTS_CATALOG_KEY]: c } = await chrome.storage.local.get([SNN_TTS_CATALOG_KEY]);
        if (c?.models?.length) { this._catalog = c.models; return this._catalog; }
      } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  async _fetchModels() {
    const res = await fetch(`${SNN_TTS_API}/models?output_modalities=speech`);
    if (!res.ok) throw new Error(`Could not load speech models (${res.status})`);
    const data = await res.json();
    const models = (data.data || [])
      .filter(m => (m.architecture?.output_modalities || []).includes('speech'))
      .map(m => {
        const p = m.pricing || {};
        const prompt = parseFloat(p.prompt) || 0;
        const completion = parseFloat(p.completion) || 0;
        const allZero = Object.values(p).every(v => !(parseFloat(v) > 0));
        return {
          id: m.id,
          name: m.name || m.id,
          voices: Array.isArray(m.supported_voices) ? m.supported_voices : [],
          description: m.description || '',
          pricePerChar: prompt,
          // Gemini TTS / Seed Audio bill per token (text in, audio out)
          // rather than per input character like everything else.
          pricedPerToken: completion > 0,
          priceCompletion: completion,
          maxChars: m.context_length > 0 ? m.context_length : SNN_TTS_DEFAULT_MAX_CHARS,
          limitKnown: m.context_length > 0,
          free: m.id.endsWith(':free') || allZero,
          created: m.created || 0
        };
      });
    this._catalog = models;
    try {
      await chrome.storage.local.set({ [SNN_TTS_CATALOG_KEY]: { at: Date.now(), models } });
    } catch (e) { /* cache is best-effort */ }
    return models;
  }

  isPcmOnly(modelId) {
    return this._learnedPcmOnly.has(modelId) || SNN_TTS_PCM_ONLY.some(r => r.test(modelId));
  }

  /**
   * Best free model for "Auto": free first (the `:free` suffix, or an
   * all-zero price as a backstop), mp3-capable over PCM-only, a voice list
   * over none, newest first. With no free model left, the cheapest one.
   */
  pickAutoModel(models) {
    if (!models?.length) return null;
    const rank = (m) => [
      m.free ? 0 : 1,
      this.isPcmOnly(m.id) ? 1 : 0,
      m.voices.length ? 0 : 1,
      m.free ? -m.created : (m.pricedPerToken ? Infinity : m.pricePerChar)
    ];
    return [...models].sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return 0;
    })[0];
  }

  /**
   * Turn saved settings into a concrete { model, voice }. A saved model
   * that has vanished from the catalog falls back to Auto (`fellBack`
   * lets the UI say so); a saved voice the model no longer offers falls
   * back to the model's first voice.
   */
  async resolve(settings) {
    const models = await this.getModels();
    if (!models.length) throw new Error('OpenRouter lists no text-to-speech models right now.');
    const wanted = settings.ttsModel || SNN_TTS_AUTO;
    let model = wanted !== SNN_TTS_AUTO ? models.find(m => m.id === wanted) : null;
    const fellBack = wanted !== SNN_TTS_AUTO && !model;
    if (!model) model = this.pickAutoModel(models);
    const voice = model.voices.includes(settings.ttsVoice) ? settings.ttsVoice : (model.voices[0] || '');
    return { model, voice, fellBack };
  }

  // ── Synthesis ───────────────────────────────────────────────────

  /**
   * Speak `text` with `model` and return { blob, ext, mime }. Text longer
   * than the model's input limit is split at sentence boundaries and the
   * parts are joined (MP3 frames concatenate cleanly; PCM is joined raw
   * and wrapped in one WAV header).
   */
  async synthesize(text, { apiKey, model, voice, speed = 1, style = '', signal } = {}) {
    if (!apiKey) throw Object.assign(new Error('Text-to-speech needs an OpenRouter API key. Add it in Settings → API.'), { status: 401 });
    const chunks = this.splitText(text, Math.max(200, model.maxChars - 50));
    let format = this.isPcmOnly(model.id) ? 'pcm' : 'mp3';
    const parts = [];
    let pcmInfo = SNN_TTS_PCM_DEFAULT;

    for (const chunk of chunks) {
      let res = await this._post({ model: model.id, input: chunk, voice, speed, style, format, apiKey, signal });
      // Learn PCM-only models on the fly instead of relying on the regex alone.
      if (res.status === 400 && format === 'mp3') {
        const errText = await res.text().catch(() => '');
        if (/pcm/i.test(errText)) {
          this._learnedPcmOnly.add(model.id);
          format = 'pcm';
          res = await this._post({ model: model.id, input: chunk, voice, speed, style, format, apiKey, signal });
        } else if (style) {
          // Supported styles vary per voice (MAI's Harper rejects "cheerful"
          // but takes "excited") — a bad style shouldn't cost the whole clip.
          style = '';
          res = await this._post({ model: model.id, input: chunk, voice, speed, style, format, apiKey, signal });
        } else {
          throw this._httpError(400, errText);
        }
      }
      if (!res.ok) throw this._httpError(res.status, await res.text().catch(() => ''));
      if (format === 'pcm') pcmInfo = this._parsePcmType(res.headers.get('content-type'));
      parts.push(await res.arrayBuffer());
    }

    if (format === 'pcm') {
      return { blob: this.pcmToWav(parts, pcmInfo), ext: 'wav', mime: 'audio/wav' };
    }
    return { blob: new Blob(parts, { type: 'audio/mpeg' }), ext: 'mp3', mime: 'audio/mpeg' };
  }

  _post({ model, input, voice, speed, style, format, apiKey, signal }) {
    const body = { model, input, response_format: format };
    if (voice) body.voice = voice;
    if (speed && Math.abs(speed - 1) > 0.001) body.speed = speed;
    const st = (style || '').trim();
    if (st) {
      // Options are keyed by provider slug and only the matched provider's
      // block is forwarded, so sending all of them is safe. Azure expects a
      // single style keyword (cheerful, sad…), so free text is kept away from it.
      const options = {
        openai: { instructions: st },
        'google-ai-studio': { speech_metadata: { style: st } }
      };
      if (/^[a-z-]+$/i.test(st)) options.azure = { style: st.toLowerCase() };
      body.provider = { options };
    }
    return fetch(`${SNN_TTS_API}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/sinanisler/SNN-Chat',
        'X-Title': 'SNN Chat'
      },
      body: JSON.stringify(body),
      signal
    });
  }

  _httpError(status, errText) {
    let message = `Text-to-speech error ${status}`;
    try {
      const d = JSON.parse(errText);
      if (d.error?.message) message = d.error.message;
    } catch (e) {
      if (errText) message = errText.substring(0, 200);
    }
    return Object.assign(new Error(message), { status });
  }

  _parsePcmType(ct) {
    const rate = parseInt((ct || '').match(/rate=(\d+)/)?.[1], 10);
    const channels = parseInt((ct || '').match(/channels=(\d+)/)?.[1], 10);
    return { rate: rate || SNN_TTS_PCM_DEFAULT.rate, channels: channels || SNN_TTS_PCM_DEFAULT.channels };
  }

  /** Wrap raw 16-bit little-endian PCM in a 44-byte WAV header. */
  pcmToWav(buffers, { rate, channels }) {
    const dataLen = buffers.reduce((n, b) => n + b.byteLength, 0);
    const h = new DataView(new ArrayBuffer(44));
    const str = (off, s) => { for (let i = 0; i < s.length; i++) h.setUint8(off + i, s.charCodeAt(i)); };
    const blockAlign = channels * 2;
    str(0, 'RIFF'); h.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true);
    h.setUint16(22, channels, true); h.setUint32(24, rate, true);
    h.setUint32(28, rate * blockAlign, true); h.setUint16(32, blockAlign, true);
    h.setUint16(34, 16, true);
    str(36, 'data'); h.setUint32(40, dataLen, true);
    return new Blob([h.buffer, ...buffers], { type: 'audio/wav' });
  }

  /** Split at sentence ends (then spaces) so no piece exceeds `max` chars. */
  splitText(text, max) {
    const clean = (text || '').trim();
    if (clean.length <= max) return [clean];
    const sentences = clean.match(/[^.!?。！？\n]+[.!?。！？]*\s*|\n+/g) || [clean];
    const out = [];
    let cur = '';
    const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
    for (let s of sentences) {
      while (s.length > max) {
        // A single run-on "sentence" longer than the limit: cut at a space.
        let cut = s.lastIndexOf(' ', max);
        if (cut < max * 0.5) cut = max;
        push();
        out.push(s.slice(0, cut).trim());
        s = s.slice(cut);
      }
      if ((cur + s).length > max) push();
      cur += s;
    }
    push();
    return out;
  }

  /** Human price label for a model picker entry. */
  priceLabel(m) {
    if (m.free) return 'Free';
    const perM = (v) => {
      const n = v * 1e6;
      return `$${n < 1 ? n.toFixed(2) : (+n.toFixed(2)).toLocaleString('en-US')}`;
    };
    if (m.pricedPerToken) {
      return m.pricePerChar > 0
        ? `${perM(m.pricePerChar)} in / ${perM(m.priceCompletion)} out per 1M tokens`
        : `${perM(m.priceCompletion)} per 1M output tokens`;
    }
    return `${perM(m.pricePerChar)} per 1M chars`;
  }
}
