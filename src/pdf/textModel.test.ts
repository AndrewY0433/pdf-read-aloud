import { describe, expect, it } from 'vitest';
import { assignCharOffsets, buildSpeakText, charIndexToWordIndex } from './textModel';
import type { WordEntity } from '../types';

type WordSeed = Omit<WordEntity, 'charStart' | 'charEnd' | 'wordIndex'>;

function seeds(...texts: string[]): WordSeed[] {
  return texts.map((t, i) => ({
    pageIndex: 0,
    sentenceId: i,
    text: t,
    left: 0,
    top: 0,
    width: t.length * 7,
    height: 12,
  }));
}

describe('assignCharOffsets', () => {
  it('assigns gap-free, single-space-separated character offsets', () => {
    const words = assignCharOffsets(seeds('foo', 'bar', 'baz'));
    expect(words.map((w) => [w.charStart, w.charEnd])).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]);
  });

  it('assigns wordIndex in input order', () => {
    const words = assignCharOffsets(seeds('a', 'b', 'c', 'd'));
    expect(words.map((w) => w.wordIndex)).toEqual([0, 1, 2, 3]);
  });

  it('handles single-character and unicode words', () => {
    const words = assignCharOffsets(seeds('a', 'é', '汉字'));
    expect(words[0]!.charEnd).toBe(1);
    // 'é' is one UTF-16 code unit, '汉字' is two.
    expect(words[1]!.charEnd - words[1]!.charStart).toBe(1);
    expect(words[2]!.charEnd - words[2]!.charStart).toBe(2);
  });

  it('returns an empty array for empty input', () => {
    expect(assignCharOffsets([])).toEqual([]);
  });
});

describe('buildSpeakText', () => {
  it('joins word text with single spaces', () => {
    const words = assignCharOffsets(seeds('Hello', 'world', '!'));
    expect(buildSpeakText(words)).toBe('Hello world !');
  });

  it('produces a string whose char positions match the word offsets', () => {
    const words = assignCharOffsets(seeds('alpha', 'beta', 'gamma'));
    const speak = buildSpeakText(words);
    for (const w of words) {
      expect(speak.substring(w.charStart, w.charEnd)).toBe(w.text);
    }
  });
});

describe('charIndexToWordIndex', () => {
  const words = assignCharOffsets(seeds('one', 'two', 'three', 'four'));
  //                                 |0..2| 4..6| 8..12 | 14..17

  it('returns 0 for an empty word array', () => {
    expect(charIndexToWordIndex([], 5)).toBe(0);
  });

  it('returns the index of the word whose charStart is <= charIndex', () => {
    expect(charIndexToWordIndex(words, 0)).toBe(0);
    expect(charIndexToWordIndex(words, 2)).toBe(0);
    expect(charIndexToWordIndex(words, 3)).toBe(0); // space before "two"
    expect(charIndexToWordIndex(words, 4)).toBe(1); // start of "two"
    expect(charIndexToWordIndex(words, 8)).toBe(2); // start of "three"
    expect(charIndexToWordIndex(words, 11)).toBe(2);
    expect(charIndexToWordIndex(words, 14)).toBe(3);
    expect(charIndexToWordIndex(words, 100)).toBe(3); // past-the-end clamps
  });

  it('is monotonically non-decreasing across the document', () => {
    let last = 0;
    for (let i = 0; i < 50; i++) {
      const idx = charIndexToWordIndex(words, i);
      expect(idx).toBeGreaterThanOrEqual(last);
      last = idx;
    }
  });
});
