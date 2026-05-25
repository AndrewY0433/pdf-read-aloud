import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { WebSpeechEngine } from './webSpeechEngine';
import type { PlaybackHooks } from './engine';
import type { WordEntity } from '../types';
import type { FakeSpeechSynthesis } from '../../tests/setup';

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

type MockedHooks = {
  onWordIndex: Mock;
  onIdle: Mock;
};

function makeHooks(): MockedHooks {
  return {
    onWordIndex: vi.fn(),
    onIdle: vi.fn(),
  };
}

function asPlaybackHooks(h: MockedHooks): PlaybackHooks {
  return h as unknown as PlaybackHooks;
}

function fakeSpeech(): FakeSpeechSynthesis {
  return globalThis.speechSynthesis as unknown as FakeSpeechSynthesis;
}

describe('WebSpeechEngine', () => {
  let hooks: ReturnType<typeof makeHooks>;
  let engine: WebSpeechEngine;
  let words: WordEntity[];
  let speakText: string;

  beforeEach(() => {
    hooks = makeHooks();
    engine = new WebSpeechEngine(asPlaybackHooks(hooks));
    ({ words, speakText } = makeWords(
      'The quick brown fox jumps over the lazy dog. Another short line.',
    ));
    engine.setContent(words, speakText);
  });

  it('exposes the correct engine id', () => {
    expect(engine.id).toBe('web-speech');
  });

  it('startAt builds an utterance covering the suffix and reports the start word', () => {
    engine.startAt(4); // word "jumps"
    expect(fakeSpeech().speak).toHaveBeenCalledTimes(1);
    const utt = fakeSpeech().speak.mock.calls[0]![0] as SpeechSynthesisUtterance;
    expect(utt.text.startsWith('jumps over the lazy dog.')).toBe(true);
    expect(hooks.onWordIndex).toHaveBeenCalledWith(4);
  });

  it('startAt(0) on empty text fires onIdle and never speaks', () => {
    engine.setContent([], '');
    engine.startAt(0);
    expect(fakeSpeech().speak).not.toHaveBeenCalled();
    expect(hooks.onIdle).toHaveBeenCalled();
  });

  it('boundary events advance the active word', () => {
    engine.startAt(0);
    const utt = fakeSpeech().speak.mock.calls[0]![0] as SpeechSynthesisUtterance;
    // "fox" starts at char 16 ("The quick brown fox").
    utt.onboundary?.({ charIndex: 16 } as SpeechSynthesisEvent);
    expect(hooks.onWordIndex).toHaveBeenLastCalledWith(3);
    // "over" starts at char 26.
    utt.onboundary?.({ charIndex: 26 } as SpeechSynthesisEvent);
    expect(hooks.onWordIndex).toHaveBeenLastCalledWith(5);
  });

  it('onend reports the final word and goes idle', () => {
    engine.startAt(0);
    const utt = fakeSpeech().speak.mock.calls[0]![0] as SpeechSynthesisUtterance;
    utt.onend?.({} as SpeechSynthesisEvent);
    expect(hooks.onWordIndex).toHaveBeenLastCalledWith(words.length - 1);
    expect(hooks.onIdle).toHaveBeenCalled();
  });

  it('pause + resume issues the right Web Speech calls', () => {
    engine.startAt(0);
    const speech = fakeSpeech();
    speech.speaking = true; // simulate that speak() began playing
    engine.pause();
    expect(speech.pause).toHaveBeenCalled();
    speech.paused = true;
    engine.resume();
    expect(speech.resume).toHaveBeenCalled();
  });

  it('stop cancels speech and resets the word index', () => {
    engine.startAt(2);
    engine.stop();
    expect(fakeSpeech().cancel).toHaveBeenCalled();
    expect(hooks.onWordIndex).toHaveBeenLastCalledWith(0);
    expect(hooks.onIdle).toHaveBeenCalled();
  });

  it('setRate applies to subsequent utterances', () => {
    engine.setRate(1.5);
    engine.startAt(0);
    const utt = fakeSpeech().speak.mock.calls[0]![0] as SpeechSynthesisUtterance;
    expect(utt.rate).toBeCloseTo(1.5);
  });

  it('setRate while speaking cancels and restarts the utterance at the same word', () => {
    engine.startAt(0);
    const speech = fakeSpeech();
    // Advance to word 3 via boundary, then change rate.
    const first = speech.speak.mock.calls[0]![0] as SpeechSynthesisUtterance;
    first.onboundary?.({ charIndex: 16 } as SpeechSynthesisEvent); // "fox" at 16
    speech.speaking = true; // simulate active playback
    speech.paused = false;
    engine.setRate(2);
    // Should have spoken a SECOND utterance with rate=2, starting at "fox".
    expect(speech.speak).toHaveBeenCalledTimes(2);
    const restart = speech.speak.mock.calls[1]![0] as SpeechSynthesisUtterance;
    expect(restart.rate).toBeCloseTo(2);
    expect(restart.text.startsWith('fox')).toBe(true);
  });

  it('setContent cancels any in-flight utterance and resets state', () => {
    engine.startAt(0);
    const speech = fakeSpeech();
    engine.setContent(words.slice(0, 3), 'a b c');
    expect(speech.cancel).toHaveBeenCalled();
  });
});
