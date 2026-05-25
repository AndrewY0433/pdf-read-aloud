import type { WordEntity } from '../types';
import { charIndexToWordIndex } from '../pdf/textModel';
import type { PlaybackEngine, PlaybackHooks } from './engine';
import { buildChunks, findChunkForWord, type SpeechChunk } from './chunking';
import { float32ToWavBlob } from './wav';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart';
// How many chunks ahead of the consumer we'll allow the generator to pre-synthesise.
// Higher = smoother audio handoffs, lower = less wasted work if user navigates.
const LOOKAHEAD = 2;

type KokoroTtsModule = typeof import('kokoro-js');
type KokoroInstance = InstanceType<KokoroTtsModule['KokoroTTS']>;

type ProgressEvent = {
  status?: string;
  progress?: number;
  file?: string;
};

export class KokoroEngine implements PlaybackEngine {
  readonly id = 'kokoro' as const;

  private words: WordEntity[] = [];
  private speakText = '';
  private chunks: SpeechChunk[] = [];
  private hooks: PlaybackHooks;

  private kokoro: KokoroInstance | null = null;
  private modelLoading: Promise<KokoroInstance> | null = null;
  private device: 'webgpu' | 'wasm' = 'wasm';
  private dtype: 'fp32' | 'q8' = 'q8';

  private audio: HTMLAudioElement | null = null;
  private currentChunkIdx = -1;
  private wordIndex = 0;
  private runId = 0;
  private genGeneration = 0;
  private rate = 1;
  /** Chunk index -> blob URL of synthesised audio, freed after playback. */
  private cache = new Map<number, string>();
  /** Kokoro `speed` used when each cached chunk was synthesised. */
  private chunkSynthesisRate = new Map<number, number>();
  private prewarmPromise: Promise<void> | null = null;
  /** Becomes true while playback loop is paused awaiting `resume()`. */
  private paused = false;

  constructor(hooks: PlaybackHooks) {
    this.hooks = hooks;
  }

  async prepare(): Promise<void> {
    if (this.kokoro) return;
    if (!this.modelLoading) this.modelLoading = this.loadModel();
    try {
      this.kokoro = await this.modelLoading;
    } finally {
      this.modelLoading = null;
    }
  }

  async prewarmFrom(wordIndex: number): Promise<void> {
    if (this.chunks.length === 0) return;
    const clamped = Math.max(0, Math.min(wordIndex, this.words.length - 1));
    const chunkIdx = findChunkForWord(this.chunks, clamped);
    if (this.cache.has(chunkIdx)) return;

    if (this.prewarmPromise) {
      await this.prewarmPromise.catch(() => {});
      return;
    }

    this.prewarmPromise = this.synthesizeChunk(chunkIdx, clamped, true);
    try {
      await this.prewarmPromise;
    } finally {
      this.prewarmPromise = null;
    }
  }

  setContent(words: WordEntity[], speakText: string): void {
    this.stopPlayback();
    this.words = words;
    this.speakText = speakText;
    this.chunks = buildChunks(words, speakText);
    this.wordIndex = 0;
  }

  setRate(rate: number): void {
    if (rate === this.rate) return;
    this.rate = rate;

    // Mid-chunk: time-stretch the clip already playing (browser pitch correction),
    // drop any pre-rendered future chunks, and re-synthesise them at the new rate.
    if (this.audio && !this.paused && this.currentChunkIdx >= 0) {
      const synRate = this.chunkSynthesisRate.get(this.currentChunkIdx) ?? rate;
      applyTimeStretch(this.audio, rate / synRate);
      this.invalidateFutureChunks(this.currentChunkIdx + 1);
      this.scheduleGenerator(this.currentChunkIdx + 1);
    }
  }

  startAt(wordIndex: number): void {
    if (this.chunks.length === 0) {
      this.hooks.onIdle();
      return;
    }
    const clamped = Math.max(0, Math.min(wordIndex, this.words.length - 1));
    const start = findChunkForWord(this.chunks, clamped);
    void this.runPlayback(start, clamped);
  }

  resume(): void {
    if (this.paused && this.audio) {
      this.paused = false;
      void this.audio.play().catch(() => {});
      return;
    }
    // Nothing to resume from — treat as a cold start at the current word.
    this.startAt(this.wordIndex);
  }

  pause(): void {
    if (this.audio && !this.audio.paused) {
      this.paused = true;
      this.audio.pause();
    }
  }

  stop(): void {
    this.stopPlayback();
    this.wordIndex = 0;
    this.hooks.onWordIndex(0);
    this.hooks.onIdle();
  }

  dispose(): void {
    this.stopPlayback();
    this.kokoro = null;
  }

  private async runPlayback(startChunkIdx: number, resumeWordIndex: number): Promise<void> {
    if (this.prewarmPromise) {
      await this.prewarmPromise.catch(() => {});
      this.prewarmPromise = null;
    }

    const preserveCache = this.cache.has(startChunkIdx);
    this.abortPlayback(preserveCache ? startChunkIdx : undefined);
    const runId = this.runId;

    if (!this.kokoro) {
      try {
        this.hooks.onStatus?.('Preparing speech…');
        await this.prepare();
      } catch (e) {
        console.error('Kokoro model load failed', e);
        this.hooks.onStatus?.('Kokoro failed to load. Switch to the browser engine in the toolbar.');
        this.hooks.onIdle();
        return;
      }
    }
    if (runId !== this.runId) return;
    this.hooks.onStatus?.(null);

    this.wordIndex = resumeWordIndex;
    this.hooks.onWordIndex(resumeWordIndex);

    this.scheduleGenerator(startChunkIdx, resumeWordIndex);
    await this.runConsumer(startChunkIdx, runId, resumeWordIndex);
  }

  private async synthesizeChunk(
    chunkIdx: number,
    fromWord: number,
    showStatus = false,
  ): Promise<void> {
    if (this.cache.has(chunkIdx)) return;
    const chunk = this.chunks[chunkIdx];
    if (!chunk) return;

    try {
      if (showStatus) this.hooks.onStatus?.('Preparing speech…');
      await this.prepare();
    } catch (e) {
      console.error('Kokoro model load failed during synthesis', e);
      if (showStatus) {
        this.hooks.onStatus?.('Kokoro failed to load. Switch to the browser engine in the toolbar.');
      }
      return;
    }

    const text =
      fromWord > chunk.wordStart ? this.textFromWord(fromWord, chunk) : chunk.text;
    const synthesisRate = this.rate;
    try {
      const result = await this.kokoro!.generate(text, {
        voice: DEFAULT_VOICE,
        speed: synthesisRate,
      });
      const blob = float32ToWavBlob(result.audio as Float32Array, result.sampling_rate);
      this.cache.set(chunkIdx, URL.createObjectURL(blob));
      this.chunkSynthesisRate.set(chunkIdx, synthesisRate);
    } catch (e) {
      console.error(`Kokoro generation failed for chunk ${chunkIdx}`, e);
    } finally {
      if (showStatus) this.hooks.onStatus?.(null);
    }
  }

  private scheduleGenerator(fromIdx: number, resumeWordIndex?: number): void {
    if (fromIdx >= this.chunks.length) return;
    this.genGeneration++;
    const genId = this.genGeneration;
    const runId = this.runId;
    void this.runGenerator(fromIdx, runId, genId, resumeWordIndex);
  }

  private textFromWord(wordIndex: number, chunk: SpeechChunk): string {
    const w = this.words[wordIndex];
    if (!w) return chunk.text;
    return this.speakText.substring(w.charStart, chunk.charEnd);
  }

  private async runGenerator(
    startIdx: number,
    runId: number,
    genId: number,
    resumeWordIndex?: number,
  ): Promise<void> {
    for (let i = startIdx; i < this.chunks.length; i++) {
      if (runId !== this.runId || genId !== this.genGeneration) return;
      // Stay no more than LOOKAHEAD chunks ahead of the chunk currently playing.
      while (
        runId === this.runId &&
        genId === this.genGeneration &&
        this.currentChunkIdx >= 0 &&
        i > this.currentChunkIdx + LOOKAHEAD
      ) {
        await delay(40);
      }
      if (runId !== this.runId || genId !== this.genGeneration) return;
      if (this.cache.has(i)) continue;

      const chunk = this.chunks[i]!;
      const fromWord =
        resumeWordIndex !== undefined && i === startIdx ? resumeWordIndex : chunk.wordStart;
      await this.synthesizeChunk(i, fromWord);
      if (runId !== this.runId || genId !== this.genGeneration) return;
    }
  }

  private async runConsumer(startIdx: number, runId: number, resumeWordIndex: number): Promise<void> {
    for (let i = startIdx; i < this.chunks.length; i++) {
      if (runId !== this.runId) return;

      while (!this.cache.has(i) && runId === this.runId) {
        await delay(40);
      }
      if (runId !== this.runId) return;

      const url = this.cache.get(i)!;
      const chunk = this.chunks[i]!;
      this.currentChunkIdx = i;
      const playbackWordStart = i === startIdx ? resumeWordIndex : chunk.wordStart;
      this.wordIndex = playbackWordStart;
      this.hooks.onWordIndex(playbackWordStart);

      await this.playChunk(url, chunk, i, runId, playbackWordStart);
      if (runId !== this.runId) return;

      URL.revokeObjectURL(url);
      this.cache.delete(i);
      this.chunkSynthesisRate.delete(i);
    }

    if (runId === this.runId) {
      this.wordIndex = Math.max(0, this.words.length - 1);
      this.hooks.onWordIndex(this.wordIndex);
      this.hooks.onIdle();
    }
  }

  private playChunk(
    blobUrl: string,
    chunk: SpeechChunk,
    chunkIdx: number,
    runId: number,
    playbackWordStart = chunk.wordStart,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const audio = new Audio(blobUrl);
      audio.preload = 'auto';
      this.audio = audio;

      const synRate = this.chunkSynthesisRate.get(chunkIdx) ?? this.rate;
      applyTimeStretch(audio, this.rate / synRate);

      const playbackCharStart =
        this.words[playbackWordStart]?.charStart ?? chunk.charStart;
      const playbackCharEnd = chunk.charEnd;

      const onTimeUpdate = (): void => {
        if (runId !== this.runId || !audio.duration || !Number.isFinite(audio.duration)) return;
        const ratio = Math.min(1, Math.max(0, audio.currentTime / audio.duration));
        const span = Math.max(1, playbackCharEnd - playbackCharStart);
        const targetChar = playbackCharStart + ratio * span;
        const idx = charIndexToWordIndex(this.words, targetChar);
        const clamped = Math.min(Math.max(idx, playbackWordStart), chunk.wordEnd);
        if (clamped !== this.wordIndex) {
          this.wordIndex = clamped;
          this.hooks.onWordIndex(clamped);
        }
      };

      const finish = (): void => {
        audio.removeEventListener('timeupdate', onTimeUpdate);
        audio.removeEventListener('ended', finish);
        audio.removeEventListener('error', finish);
        if (this.audio === audio) this.audio = null;
        resolve();
      };

      audio.addEventListener('timeupdate', onTimeUpdate);
      audio.addEventListener('ended', finish);
      audio.addEventListener('error', finish);

      audio.play().catch(() => finish());
    });
  }

  private invalidateFutureChunks(fromIdx: number): void {
    for (const idx of [...this.cache.keys()]) {
      if (idx < fromIdx) continue;
      const url = this.cache.get(idx);
      if (url) URL.revokeObjectURL(url);
      this.cache.delete(idx);
      this.chunkSynthesisRate.delete(idx);
    }
  }

  /** Stop audio/generators; optionally keep one pre-rendered chunk in cache. */
  private abortPlayback(preserveChunkIdx?: number): void {
    this.runId++;
    this.genGeneration++;
    this.prewarmPromise = null;
    this.paused = false;
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {
        // ignore
      }
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio = null;
    }
    this.currentChunkIdx = -1;

    if (preserveChunkIdx === undefined) {
      for (const url of this.cache.values()) URL.revokeObjectURL(url);
      this.cache.clear();
      this.chunkSynthesisRate.clear();
      return;
    }

    for (const idx of [...this.cache.keys()]) {
      if (idx === preserveChunkIdx) continue;
      const url = this.cache.get(idx);
      if (url) URL.revokeObjectURL(url);
      this.cache.delete(idx);
      this.chunkSynthesisRate.delete(idx);
    }
  }

  private stopPlayback(): void {
    this.abortPlayback();
  }

  private async loadModel(): Promise<KokoroInstance> {
    const webgpu = await detectWebGPU();
    this.device = webgpu ? 'webgpu' : 'wasm';
    // fp32 on WebGPU is the recommended config (q8 is best on WASM for size).
    this.dtype = webgpu ? 'fp32' : 'q8';
    this.hooks.onStatus?.(`Loading Kokoro TTS (${this.device})…`);

    const mod = (await import('kokoro-js')) as KokoroTtsModule;
    const tts = await mod.KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: this.dtype,
      device: this.device,
      progress_callback: (e: ProgressEvent) => {
        if (e?.status === 'progress' && typeof e.progress === 'number') {
          this.hooks.onStatus?.(`Loading Kokoro TTS… ${Math.floor(e.progress)}%`);
        } else if (e?.status === 'done') {
          this.hooks.onStatus?.('Kokoro TTS ready');
        }
      },
    });

    this.hooks.onStatus?.(null);
    this.hooks.onEngineReady?.(this.id);
    return tts;
  }
}

/** Stretch tempo via playbackRate while asking the browser to preserve pitch. */
function applyTimeStretch(audio: HTMLAudioElement, factor: number): void {
  const clamped = Math.min(16, Math.max(0.25, factor));
  audio.playbackRate = clamped;
  audio.preservesPitch = true;
  // Legacy vendor flags — harmless on modern Chromium.
  const legacy = audio as HTMLAudioElement & {
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  legacy.mozPreservesPitch = true;
  legacy.webkitPreservesPitch = true;
}

async function detectWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
