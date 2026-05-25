/**
 * Global test setup: install minimal mocks for browser APIs that happy-dom
 * doesn't provide (Web Speech, WebGPU detection). Individual tests can
 * override these via `vi.spyOn` or by replacing the global stub entirely.
 */
import { vi, beforeEach } from 'vitest';

declare global {
  interface Window {
    __speechSynthesis?: SpeechSynthesis;
  }
}

class FakeSpeechSynthesisUtterance {
  text: string;
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onend: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((ev: SpeechSynthesisErrorEvent) => void) | null = null;
  onpause: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onresume: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onmark: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onboundary: ((ev: SpeechSynthesisEvent) => void) | null = null;

  constructor(text = '') {
    this.text = text;
  }

  addEventListener(): void {
    // Engine code uses `on*` handlers exclusively; this satisfies type
    // checks for callers that may use addEventListener.
  }
  removeEventListener(): void {
    /* noop */
  }
  dispatchEvent(): boolean {
    return true;
  }
}

class FakeSpeechSynthesis {
  speaking = false;
  paused = false;
  pending = false;
  onvoiceschanged: (() => void) | null = null;
  private utterances: FakeSpeechSynthesisUtterance[] = [];

  speak = vi.fn((u: FakeSpeechSynthesisUtterance) => {
    this.speaking = true;
    this.paused = false;
    this.utterances.push(u);
  });

  cancel = vi.fn(() => {
    this.speaking = false;
    this.paused = false;
    this.utterances = [];
  });

  pause = vi.fn(() => {
    if (this.speaking) this.paused = true;
  });

  resume = vi.fn(() => {
    if (this.paused) this.paused = false;
  });

  getVoices = vi.fn((): SpeechSynthesisVoice[] => [
    {
      default: true,
      lang: 'en-US',
      localService: true,
      name: 'Fake English',
      voiceURI: 'fake://en-US',
    } as SpeechSynthesisVoice,
  ]);

  addEventListener(): void {
    /* noop */
  }
  removeEventListener(): void {
    /* noop */
  }
  dispatchEvent(): boolean {
    return true;
  }

  /** Test helper: fires onend on the most recently `speak()`-ed utterance. */
  finishCurrent(): void {
    const u = this.utterances.pop();
    this.speaking = false;
    this.paused = false;
    u?.onend?.({} as SpeechSynthesisEvent);
  }

  /** Test helper: fires onboundary at a given absolute char index. */
  fireBoundary(charIndex: number): void {
    const u = this.utterances[this.utterances.length - 1];
    u?.onboundary?.({ charIndex } as SpeechSynthesisEvent);
  }
}

function installSpeechMocks(): FakeSpeechSynthesis {
  const fake = new FakeSpeechSynthesis();
  Object.defineProperty(globalThis, 'speechSynthesis', {
    value: fake,
    writable: true,
    configurable: true,
  });
  (globalThis as unknown as { SpeechSynthesisUtterance: typeof FakeSpeechSynthesisUtterance }).SpeechSynthesisUtterance =
    FakeSpeechSynthesisUtterance;
  return fake;
}

// Install on first import.
installSpeechMocks();

// Reset between tests so spy counts don't leak.
beforeEach(() => {
  installSpeechMocks();
  // happy-dom's localStorage persists across tests; clear it so engine /
  // rate preferences from a previous test don't bleed in.
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
});

export { FakeSpeechSynthesis, FakeSpeechSynthesisUtterance };
