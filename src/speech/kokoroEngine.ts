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
  private rate = 1;
  /** Chunk index -> blob URL of synthesised audio, freed after playback. */
  private cache = new Map<number, string>();
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

  setContent(words: WordEntity[], speakText: string): void {
    this.stopPlayback();
    this.words = words;
    this.chunks = buildChunks(words, speakText);
    this.wordIndex = 0;
  }

  setRate(rate: number): void {
    if (rate === this.rate) return;
    this.rate = rate;
    // Any already-synthesised chunks were rendered at the old speed, so
    // restart from the current word to make the change audible immediately.
    // When paused/idle we just store the value and the next startAt picks
    // it up.
    if (this.audio && !this.paused) {
      this.startAt(this.wordIndex);
    }
  }

  startAt(wordIndex: number): void {
    if (this.chunks.length === 0) {
      this.hooks.onIdle();
      return;
    }
    const start = findChunkForWord(this.chunks, wordIndex);
    void this.runPlayback(start);
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

  private async runPlayback(startChunkIdx: number): Promise<void> {
    this.stopPlayback();
    const runId = ++this.runId;

    try {
      this.hooks.onStatus?.('Preparing speech…');
      await this.prepare();
    } catch (e) {
      console.error('Kokoro model load failed', e);
      this.hooks.onStatus?.('Kokoro failed to load. Switch to the browser engine in the toolbar.');
      this.hooks.onIdle();
      return;
    }
    if (runId !== this.runId) return;
    this.hooks.onStatus?.(null);

    const firstChunk = this.chunks[startChunkIdx];
    if (firstChunk) {
      this.wordIndex = firstChunk.wordStart;
      this.hooks.onWordIndex(this.wordIndex);
    }

    void this.runGenerator(startChunkIdx, runId);
    await this.runConsumer(startChunkIdx, runId);
  }

  private async runGenerator(startIdx: number, runId: number): Promise<void> {
    for (let i = startIdx; i < this.chunks.length; i++) {
      if (runId !== this.runId) return;
      // Stay no more than LOOKAHEAD chunks ahead of the chunk currently playing.
      while (
        runId === this.runId &&
        this.currentChunkIdx >= 0 &&
        i > this.currentChunkIdx + LOOKAHEAD
      ) {
        await delay(40);
      }
      if (runId !== this.runId) return;
      if (this.cache.has(i)) continue;

      const chunk = this.chunks[i]!;
      try {
        const result = await this.kokoro!.generate(chunk.text, {
          voice: DEFAULT_VOICE,
          speed: this.rate,
        });
        if (runId !== this.runId) return;
        const blob = float32ToWavBlob(result.audio as Float32Array, result.sampling_rate);
        this.cache.set(i, URL.createObjectURL(blob));
      } catch (e) {
        console.error(`Kokoro generation failed for chunk ${i}`, e);
        return;
      }
    }
  }

  private async runConsumer(startIdx: number, runId: number): Promise<void> {
    for (let i = startIdx; i < this.chunks.length; i++) {
      if (runId !== this.runId) return;

      while (!this.cache.has(i) && runId === this.runId) {
        await delay(40);
      }
      if (runId !== this.runId) return;

      const url = this.cache.get(i)!;
      const chunk = this.chunks[i]!;
      this.currentChunkIdx = i;
      this.wordIndex = chunk.wordStart;
      this.hooks.onWordIndex(this.wordIndex);

      await this.playChunk(url, chunk, runId);
      if (runId !== this.runId) return;

      URL.revokeObjectURL(url);
      this.cache.delete(i);
    }

    if (runId === this.runId) {
      this.wordIndex = Math.max(0, this.words.length - 1);
      this.hooks.onWordIndex(this.wordIndex);
      this.hooks.onIdle();
    }
  }

  private playChunk(blobUrl: string, chunk: SpeechChunk, runId: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const audio = new Audio(blobUrl);
      audio.preload = 'auto';
      this.audio = audio;

      const onTimeUpdate = (): void => {
        if (runId !== this.runId || !audio.duration || !Number.isFinite(audio.duration)) return;
        const ratio = Math.min(1, Math.max(0, audio.currentTime / audio.duration));
        const targetChar = chunk.charStart + ratio * Math.max(1, chunk.charEnd - chunk.charStart);
        const idx = charIndexToWordIndex(this.words, targetChar);
        const clamped = Math.min(Math.max(idx, chunk.wordStart), chunk.wordEnd);
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

  private stopPlayback(): void {
    // Bump runId before tearing things down so any awaiting loops see the
    // change and bail out without firing onIdle for a stale run.
    this.runId++;
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
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
    this.currentChunkIdx = -1;
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
