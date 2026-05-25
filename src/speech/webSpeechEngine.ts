import type { WordEntity } from '../types';
import { charIndexToWordIndex } from '../pdf/textModel';
import type { PlaybackEngine, PlaybackHooks } from './engine';
import {
  defaultVoiceForEngine,
  listBrowserVoices,
  loadPreferredVoice,
  resolveBrowserVoice,
  savePreferredVoice,
} from './voices';

const FALLBACK_CPS = 13;

export class WebSpeechEngine implements PlaybackEngine {
  readonly id = 'web-speech' as const;

  private words: WordEntity[] = [];
  private speakText = '';
  private hooks: PlaybackHooks;
  private wordIndex = 0;
  private raf = 0;
  private speakStartedAt = 0;
  private pausedAccumMs = 0;
  private pauseStartedAt = 0;
  private lastBoundaryChar = 0;
  private lastBoundaryAt = 0;
  private rate = 1;
  private voiceId: string;
  private currentUtterance: SpeechSynthesisUtterance | null = null;

  constructor(hooks: PlaybackHooks, voiceId?: string) {
    this.hooks = hooks;
    this.voiceId = voiceId ?? loadPreferredVoice('web-speech');
    speechSynthesis.onvoiceschanged = () => {
      speechSynthesis.getVoices();
      this.ensureVoiceId();
      this.hooks.onVoicesChanged?.();
    };
    speechSynthesis.getVoices();
    this.ensureVoiceId();
  }

  async prepare(): Promise<void> {
    speechSynthesis.getVoices();
    this.ensureVoiceId();
  }

  async prewarmFrom(_wordIndex: number): Promise<void> {
    speechSynthesis.getVoices();
    this.ensureVoiceId();
  }

  setContent(words: WordEntity[], speakText: string): void {
    this.cancelSpeech();
    this.words = words;
    this.speakText = speakText;
    this.wordIndex = 0;
  }

  setRate(rate: number): void {
    this.rate = rate;
    // SpeechSynthesisUtterance.rate is locked once `speak()` is called, so
    // we have to throw away the current utterance and restart at the same
    // word to actually hear the new speed.
    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      this.startUtterance(this.wordIndex);
    }
  }

  listVoices() {
    return listBrowserVoices();
  }

  getVoiceId(): string {
    return this.voiceId;
  }

  setVoiceId(voiceId: string): void {
    if (!voiceId || voiceId === this.voiceId) return;
    this.voiceId = voiceId;
    savePreferredVoice('web-speech', voiceId);
    if (speechSynthesis.speaking || speechSynthesis.paused) {
      this.startUtterance(this.wordIndex);
    }
  }

  startAt(wordIndex: number): void {
    if (!this.speakText.trim() || this.words.length === 0) {
      this.hooks.onIdle();
      return;
    }
    const clamped = Math.max(0, Math.min(wordIndex, this.words.length - 1));
    this.startUtterance(clamped);
  }

  resume(): void {
    if (speechSynthesis.speaking && speechSynthesis.paused) {
      speechSynthesis.resume();
      this.pausedAccumMs += performance.now() - this.pauseStartedAt;
      this.scheduleFallback();
    } else if (!speechSynthesis.speaking) {
      this.startAt(this.wordIndex);
    }
  }

  pause(): void {
    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause();
      this.pauseStartedAt = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  stop(): void {
    this.cancelSpeech();
    this.wordIndex = 0;
    this.hooks.onWordIndex(0);
    this.hooks.onIdle();
  }

  dispose(): void {
    this.cancelSpeech();
  }

  private ensureVoiceId(): void {
    const options = listBrowserVoices();
    if (options.length === 0) return;
    if (options.some((v) => v.id === this.voiceId)) return;
    this.voiceId = defaultVoiceForEngine('web-speech');
  }

  private cancelSpeech(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    // Detach handlers BEFORE cancel() so the synthetic onend / onerror it
    // fires for the cancelled utterance doesn't flip our state machine back
    // to 'idle' when we're really just swapping utterances.
    if (this.currentUtterance) {
      this.currentUtterance.onboundary = null;
      this.currentUtterance.onend = null;
      this.currentUtterance.onerror = null;
      this.currentUtterance = null;
    }
    speechSynthesis.cancel();
    this.speakStartedAt = 0;
    this.pausedAccumMs = 0;
    this.lastBoundaryChar = 0;
    this.lastBoundaryAt = 0;
  }

  private startUtterance(startWordIndex: number): void {
    this.cancelSpeech();
    const w = this.words[startWordIndex];
    const sliceStart = w?.charStart ?? 0;
    const text = this.speakText.slice(sliceStart);
    if (!text.trim()) {
      this.hooks.onIdle();
      return;
    }

    this.wordIndex = startWordIndex;
    this.hooks.onWordIndex(this.wordIndex);

    const u = new SpeechSynthesisUtterance(text);
    const voice = resolveBrowserVoice(this.voiceId);
    u.lang = voice?.lang ?? 'en-US';
    if (voice) u.voice = voice;
    u.rate = this.rate;

    this.speakStartedAt = performance.now();
    this.pausedAccumMs = 0;
    this.lastBoundaryChar = sliceStart;
    this.lastBoundaryAt = this.speakStartedAt;

    u.onboundary = (ev: SpeechSynthesisEvent) => {
      if (typeof ev.charIndex !== 'number') return;
      const abs = sliceStart + ev.charIndex;
      this.lastBoundaryChar = abs;
      this.lastBoundaryAt = performance.now();
      const idx = charIndexToWordIndex(this.words, abs);
      if (idx !== this.wordIndex) {
        this.wordIndex = idx;
        this.hooks.onWordIndex(idx);
      }
    };

    u.onend = () => {
      if (this.currentUtterance !== u) return;
      this.currentUtterance = null;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.wordIndex = Math.max(0, this.words.length - 1);
      this.hooks.onWordIndex(this.wordIndex);
      this.hooks.onIdle();
    };

    u.onerror = () => {
      if (this.currentUtterance !== u) return;
      this.currentUtterance = null;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.hooks.onIdle();
    };

    this.currentUtterance = u;
    speechSynthesis.speak(u);
    this.scheduleFallback();
  }

  private scheduleFallback(): void {
    cancelAnimationFrame(this.raf);
    const tick = (): void => {
      if (!speechSynthesis.speaking || speechSynthesis.paused) return;

      const now = performance.now();
      const elapsedSpeaking = now - this.speakStartedAt - this.pausedAccumMs;
      if (now - this.lastBoundaryAt < 350) {
        this.raf = requestAnimationFrame(tick);
        return;
      }

      const estChars = (elapsedSpeaking / 1000) * FALLBACK_CPS * this.rate;
      const targetChar = this.lastBoundaryChar + Math.max(0, estChars);
      const maxChar = Math.max(0, this.speakText.length - 1);
      const idx = charIndexToWordIndex(this.words, Math.min(targetChar, maxChar));
      if (idx > this.wordIndex) {
        this.wordIndex = idx;
        this.hooks.onWordIndex(idx);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
