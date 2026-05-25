import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatRate,
  RATE_DEFAULT,
  RATE_MAX,
  RATE_MIN,
  RATE_STEP,
  ReadAloudSession,
  type PlaybackHooks,
} from './playback';
import type { WordEntity } from '../types';

function makeWords(text: string): { words: WordEntity[]; speakText: string } {
  const tokens = text.split(/\s+/).filter(Boolean);
  let offset = 0;
  const words: WordEntity[] = tokens.map((t, i) => {
    const charStart = offset;
    const charEnd = offset + t.length;
    offset = charEnd + 1;
    return {
      pageIndex: 0,
      wordIndex: i,
      sentenceId: 0,
      text: t,
      charStart,
      charEnd,
      left: 0,
      top: 0,
      width: t.length * 7,
      height: 12,
    };
  });
  return { words, speakText: words.map((w) => w.text).join(' ') };
}

function blankHooks(): PlaybackHooks {
  return {
    onWordIndex: vi.fn(),
    onIdle: vi.fn(),
    onStatus: vi.fn(),
  };
}

describe('formatRate', () => {
  it('renders whole numbers with a single decimal', () => {
    expect(formatRate(1)).toBe('1.0x');
    expect(formatRate(2)).toBe('2.0x');
    expect(formatRate(0.5)).toBe('0.5x');
  });

  it('renders quarter steps with two decimals', () => {
    expect(formatRate(1.25)).toBe('1.25x');
    expect(formatRate(0.75)).toBe('0.75x');
    expect(formatRate(1.75)).toBe('1.75x');
  });

  it('matches the visual style shown in the speed widget', () => {
    expect(formatRate(1.5)).toBe('1.5x');
    expect(formatRate(2.5)).toBe('2.5x');
  });
});

describe('Rate constants', () => {
  it('expose a coherent stepping range', () => {
    expect(RATE_MIN).toBeLessThan(RATE_DEFAULT);
    expect(RATE_DEFAULT).toBeLessThan(RATE_MAX);
    expect(RATE_STEP).toBeGreaterThan(0);
    // Whole stops from MIN→MAX should land on RATE_DEFAULT.
    const steps = (RATE_DEFAULT - RATE_MIN) / RATE_STEP;
    expect(steps).toBeCloseTo(Math.round(steps), 5);
  });
});

describe('ReadAloudSession orchestration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to the kokoro engine when no preference is stored', () => {
    const session = new ReadAloudSession([], '', blankHooks());
    expect(session.getEngineId()).toBe('kokoro');
  });

  it('honors a persisted engine preference', () => {
    localStorage.setItem('pdf-read-aloud.engine', 'web-speech');
    const session = new ReadAloudSession([], '', blankHooks());
    expect(session.getEngineId()).toBe('web-speech');
  });

  it('ignores invalid persisted engine values', () => {
    localStorage.setItem('pdf-read-aloud.engine', 'gibberish');
    const session = new ReadAloudSession([], '', blankHooks());
    expect(session.getEngineId()).toBe('kokoro');
  });

  it('setEngine swaps engines and persists the choice', () => {
    const session = new ReadAloudSession([], '', blankHooks());
    expect(session.getEngineId()).toBe('kokoro');
    session.setEngine('web-speech');
    expect(session.getEngineId()).toBe('web-speech');
    expect(localStorage.getItem('pdf-read-aloud.engine')).toBe('web-speech');
  });

  it('persists and restores voice preferences per engine', () => {
    localStorage.setItem('pdf-read-aloud.voice.kokoro', 'af_bella');
    localStorage.setItem('pdf-read-aloud.voice.web-speech', 'fake://en-US');
    localStorage.setItem('pdf-read-aloud.engine', 'web-speech');

    const session = new ReadAloudSession([], '', blankHooks());
    expect(session.getVoiceId()).toBe('fake://en-US');

    session.setEngine('kokoro');
    expect(session.getVoiceId()).toBe('af_bella');

    session.setVoiceId('af_sarah');
    expect(localStorage.getItem('pdf-read-aloud.voice.kokoro')).toBe('af_sarah');
    expect(session.getVoiceId()).toBe('af_sarah');
  });

  it('lists Kokoro voices from the neural engine', () => {
    const session = new ReadAloudSession([], '', blankHooks());
    expect(session.listVoices().length).toBeGreaterThan(10);
    expect(session.listVoices().some((v) => v.id === 'af_heart')).toBe(true);
  });

  it('setEngine is a noop when already active', () => {
    const session = new ReadAloudSession([], '', blankHooks());
    session.setEngine('kokoro');
    expect(session.getEngineId()).toBe('kokoro');
  });

  it('returns the persisted rate or the default', () => {
    expect(new ReadAloudSession([], '', blankHooks()).getRate()).toBe(RATE_DEFAULT);
    localStorage.setItem('pdf-read-aloud.rate', '1.5');
    expect(new ReadAloudSession([], '', blankHooks()).getRate()).toBe(1.5);
  });

  it('clamps invalid persisted rate values back into range', () => {
    localStorage.setItem('pdf-read-aloud.rate', '99');
    expect(new ReadAloudSession([], '', blankHooks()).getRate()).toBe(RATE_MAX);
    localStorage.setItem('pdf-read-aloud.rate', '-1');
    expect(new ReadAloudSession([], '', blankHooks()).getRate()).toBe(RATE_MIN);
    localStorage.setItem('pdf-read-aloud.rate', 'oops');
    expect(new ReadAloudSession([], '', blankHooks()).getRate()).toBe(RATE_DEFAULT);
  });

  it('setRate snaps to the nearest step and persists', () => {
    const session = new ReadAloudSession([], '', blankHooks());
    expect(session.setRate(1.1)).toBe(1.0);
    expect(session.setRate(1.13)).toBe(1.25);
    expect(session.setRate(1.62)).toBe(1.5);
    expect(session.setRate(1.63)).toBe(1.75);
    expect(localStorage.getItem('pdf-read-aloud.rate')).toBe('1.75');
  });

  it('setRate clamps to RATE_MIN and RATE_MAX', () => {
    const session = new ReadAloudSession([], '', blankHooks());
    expect(session.setRate(-100)).toBe(RATE_MIN);
    expect(session.setRate(100)).toBe(RATE_MAX);
  });

  it('bumpRate walks the steps up and down', () => {
    const session = new ReadAloudSession([], '', blankHooks());
    session.setRate(1);
    expect(session.bumpRate(RATE_STEP)).toBe(1.25);
    expect(session.bumpRate(RATE_STEP)).toBe(1.5);
    expect(session.bumpRate(-RATE_STEP)).toBe(1.25);
  });

  it('bumpRate cannot exceed RATE_MAX or fall below RATE_MIN', () => {
    const session = new ReadAloudSession([], '', blankHooks());
    session.setRate(RATE_MAX);
    expect(session.bumpRate(RATE_STEP)).toBe(RATE_MAX);
    session.setRate(RATE_MIN);
    expect(session.bumpRate(-RATE_STEP)).toBe(RATE_MIN);
  });

  it('forwards setContent and reports the same engine after a swap', () => {
    const { words, speakText } = makeWords('hello there friend.');
    const session = new ReadAloudSession([], '', blankHooks());
    session.setContent(words, speakText);
    session.setEngine('web-speech');
    expect(session.getEngineId()).toBe('web-speech');
    // After swap the new engine should also be able to play without error.
    expect(() => session.play(true)).not.toThrow();
  });

  it('dispose stops the engine and releases resources', () => {
    localStorage.setItem('pdf-read-aloud.engine', 'web-speech');
    const { words, speakText } = makeWords('hello there friend kind.');
    const session = new ReadAloudSession(words, speakText, blankHooks());
    session.play(true);
    expect((globalThis.speechSynthesis as unknown as { speak: { mock: { calls: unknown[] } } }).speak.mock.calls.length).toBeGreaterThan(0);
    session.dispose();
    // Stop should have cancelled the in-flight utterance.
    expect((globalThis.speechSynthesis as unknown as { cancel: { mock: { calls: unknown[] } } }).cancel.mock.calls.length).toBeGreaterThan(0);
  });
});
