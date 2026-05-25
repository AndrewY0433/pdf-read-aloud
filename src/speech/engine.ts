import type { WordEntity } from '../types';

export type EngineId = 'web-speech' | 'kokoro';

export type PlaybackHooks = {
  onWordIndex: (index: number) => void;
  onIdle: () => void;
  /** Optional status updates (e.g. "Loading Kokoro… 42%"). Null clears the status. */
  onStatus?: (msg: string | null) => void;
  /** Fires when the engine becomes ready (model loaded). */
  onEngineReady?: (id: EngineId) => void;
};

export interface PlaybackEngine {
  readonly id: EngineId;
  /**
   * Asynchronous warm-up (e.g. fetching neural model weights). Engines that
   * don't need it may return immediately. Safe to call multiple times: later
   * calls await the first attempt.
   */
  prepare(): Promise<void>;
  /**
   * Pre-render audio from `wordIndex` through the end of its speech chunk so
   * the first Play() does not wait on synthesis. Engines that don't batch
   * audio may no-op after prepare().
   */
  prewarmFrom(wordIndex: number): Promise<void>;
  setContent(words: WordEntity[], speakText: string): void;
  /**
   * Set the playback rate (1.0 = normal). If playback is in progress the
   * engine should adopt the new rate immediately (possibly by restarting
   * the current utterance); when idle/paused it is just stored.
   */
  setRate(rate: number): void;
  /** Cold start at the given word index. Always restarts from scratch. */
  startAt(wordIndex: number): void;
  /** Resume after a previous pause(). No state reset. */
  resume(): void;
  pause(): void;
  stop(): void;
  /** Releases any resources (audio nodes, blob URLs, model handles). */
  dispose(): void;
}
