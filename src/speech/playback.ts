import type { WordEntity } from '../types';
import type { EngineId, PlaybackEngine, PlaybackHooks } from './engine';
import { WebSpeechEngine } from './webSpeechEngine';
import { KokoroEngine } from './kokoroEngine';

const ENGINE_PREF_KEY = 'pdf-read-aloud.engine';
const RATE_PREF_KEY = 'pdf-read-aloud.rate';

export const RATE_MIN = 0.5;
export const RATE_MAX = 3;
export const RATE_STEP = 0.25;
export const RATE_DEFAULT = 1;

export type { PlaybackHooks } from './engine';
export type { EngineId } from './engine';

/** Format a rate like 1, 1.25, 1.5 → "1.0x", "1.25x", "1.5x". */
export function formatRate(rate: number): string {
  const fixed = rate.toFixed(2);
  return (fixed.endsWith('0') ? fixed.slice(0, -1) : fixed) + 'x';
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return RATE_DEFAULT;
  const stepped = Math.round(rate / RATE_STEP) * RATE_STEP;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Number(stepped.toFixed(2))));
}

function loadPreferredEngine(): EngineId {
  try {
    const raw = localStorage.getItem(ENGINE_PREF_KEY);
    if (raw === 'kokoro' || raw === 'web-speech') return raw;
  } catch {
    // localStorage unavailable; fall through
  }
  return 'kokoro';
}

function savePreferredEngine(id: EngineId): void {
  try {
    localStorage.setItem(ENGINE_PREF_KEY, id);
  } catch {
    // ignore quota / private-mode errors
  }
}

function loadPreferredRate(): number {
  try {
    const raw = localStorage.getItem(RATE_PREF_KEY);
    if (raw) return clampRate(Number(raw));
  } catch {
    // localStorage unavailable; fall through
  }
  return RATE_DEFAULT;
}

function savePreferredRate(rate: number): void {
  try {
    localStorage.setItem(RATE_PREF_KEY, String(rate));
  } catch {
    // ignore quota / private-mode errors
  }
}

export class ReadAloudSession {
  private hooks: PlaybackHooks;
  private engine: PlaybackEngine;
  private words: WordEntity[] = [];
  private speakText = '';
  private rate: number;

  constructor(words: WordEntity[], speakText: string, hooks: PlaybackHooks) {
    this.hooks = hooks;
    this.words = words;
    this.speakText = speakText;
    this.rate = loadPreferredRate();
    this.engine = this.createEngine(loadPreferredEngine());
    this.engine.setContent(words, speakText);
    this.engine.setRate(this.rate);
  }

  getEngineId(): EngineId {
    return this.engine.id;
  }

  getRate(): number {
    return this.rate;
  }

  setRate(rate: number): number {
    const next = clampRate(rate);
    if (next === this.rate) return this.rate;
    this.rate = next;
    this.engine.setRate(next);
    savePreferredRate(next);
    return next;
  }

  bumpRate(delta: number): number {
    return this.setRate(this.rate + delta);
  }

  setContent(words: WordEntity[], speakText: string): void {
    this.words = words;
    this.speakText = speakText;
    this.engine.setContent(words, speakText);
  }

  /** Play from the start when idle, or resume when paused. */
  play(fromBeginning: boolean): void {
    if (fromBeginning) {
      this.engine.startAt(0);
    } else {
      this.engine.resume();
    }
  }

  playFromWord(wordIndex: number): void {
    this.engine.startAt(wordIndex);
  }

  pause(): void {
    this.engine.pause();
  }

  stop(): void {
    this.engine.stop();
  }

  /**
   * Release the underlying engine. Stops playback and frees any system
   * resources (Web Speech queue, audio elements, blob URLs, neural model
   * handle). Safe to call on tab unload; the session must not be used after.
   */
  dispose(): void {
    try {
      this.engine.stop();
    } catch {
      /* best-effort */
    }
    this.engine.dispose();
  }

  /**
   * Switch to a different TTS engine. Preserves the current content so the
   * new engine is ready to play immediately. Stops any in-progress playback.
   */
  setEngine(id: EngineId): void {
    if (this.engine.id === id) return;
    this.engine.stop();
    this.engine.dispose();
    this.engine = this.createEngine(id);
    this.engine.setContent(this.words, this.speakText);
    this.engine.setRate(this.rate);
    savePreferredEngine(id);
  }

  /** Best-effort warm-up; safe to call before the user hits Play. */
  prepare(): Promise<void> {
    return this.engine.prepare();
  }

  /** Pre-render the first playable chunk so Play starts without a delay. */
  prewarmFrom(wordIndex: number): Promise<void> {
    return this.engine.prewarmFrom(wordIndex);
  }

  private createEngine(id: EngineId): PlaybackEngine {
    if (id === 'kokoro') return new KokoroEngine(this.hooks);
    return new WebSpeechEngine(this.hooks);
  }
}
