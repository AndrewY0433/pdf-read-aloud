import { describe, expect, it } from 'vitest';
import type { WordEntity } from '../types';
import {
  buildWordTimeline,
  charDurationWeight,
  rescaleTimeline,
  wordIndexAtTime,
} from './kokoroAlignment';

function makeWords(text: string): WordEntity[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  let offset = 0;
  return tokens.map((t, i) => {
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
      width: 10,
      height: 10,
    };
  });
}

describe('charDurationWeight', () => {
  it('weights sentence-ending punctuation higher than letters', () => {
    expect(charDurationWeight('.')).toBeGreaterThan(charDurationWeight('a'));
    expect(charDurationWeight(' ')).toBeLessThan(charDurationWeight('a'));
  });
});

describe('buildWordTimeline', () => {
  it('allocates the full clip duration across words', () => {
    const words = makeWords('Hello world today.');
    const synthText = 'Hello world today.';
    const timeline = buildWordTimeline(synthText, 4, words, 0, 2, 0);
    expect(timeline).toHaveLength(3);
    expect(timeline[0]!.startSec).toBe(0);
    expect(timeline[timeline.length - 1]!.endSec).toBeCloseTo(4, 5);
  });

  it('gives later words more time when the sentence ends with a pause', () => {
    const words = makeWords('Hi there friend.');
    const synthText = 'Hi there friend.';
    const timeline = buildWordTimeline(synthText, 3, words, 0, 2, 0);
    const hiSpan = timeline[0]!.endSec - timeline[0]!.startSec;
    const friendSpan = timeline[2]!.endSec - timeline[2]!.startSec;
    expect(friendSpan).toBeGreaterThan(hiSpan);
  });

  it('supports mid-chunk resume offsets', () => {
    const words = makeWords('one two three four five.');
    const synthText = 'three four five.';
    const timeline = buildWordTimeline(synthText, 2, words, 2, 4, words[2]!.charStart);
    expect(timeline.map((t) => t.wordIndex)).toEqual([2, 3, 4]);
    expect(timeline[0]!.startSec).toBe(0);
    expect(timeline[timeline.length - 1]!.endSec).toBeCloseTo(2, 5);
  });
});

describe('wordIndexAtTime', () => {
  const timeline = [
    { wordIndex: 0, startSec: 0, endSec: 0.4 },
    { wordIndex: 1, startSec: 0.4, endSec: 0.9 },
    { wordIndex: 2, startSec: 0.9, endSec: 1.5 },
  ];

  it('returns the active word for a timestamp inside its span', () => {
    expect(wordIndexAtTime(timeline, 0.5, 0, 2)).toBe(1);
    expect(wordIndexAtTime(timeline, 1.2, 0, 2)).toBe(2);
  });

  it('clamps to the playback window', () => {
    expect(wordIndexAtTime(timeline, 0.05, 1, 2)).toBe(1);
    expect(wordIndexAtTime(timeline, 1.4, 0, 1)).toBe(1);
  });

  it('returns the first word for timestamps before the timeline starts', () => {
    expect(wordIndexAtTime(timeline, -1, 0, 2)).toBe(0);
  });

  it('returns minWordIndex when the timeline is empty', () => {
    expect(wordIndexAtTime([], 0.5, 3, 9)).toBe(3);
  });
});

describe('rescaleTimeline', () => {
  it('scales boundaries when audio metadata duration drifts', () => {
    const scaled = rescaleTimeline(
      [{ wordIndex: 0, startSec: 1, endSec: 2 }],
      1.5,
    );
    expect(scaled[0]).toEqual({ wordIndex: 0, startSec: 1.5, endSec: 3 });
  });
});
