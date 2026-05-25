import { describe, expect, it } from 'vitest';
import { buildChunks, findChunkForWord, type SpeechChunk } from './chunking';
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

function totalWords(chunks: SpeechChunk[]): number {
  return chunks.reduce((acc, c) => acc + (c.wordEnd - c.wordStart + 1), 0);
}

describe('buildChunks', () => {
  it('returns an empty array for empty input', () => {
    expect(buildChunks([], '')).toEqual([]);
  });

  it('emits a single chunk for a short single sentence (below MIN_WORDS sentence-break)', () => {
    const { words, speakText } = makeWords('Hi there friend.');
    const chunks = buildChunks(words, speakText);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      wordStart: 0,
      wordEnd: 2,
      charStart: 0,
      text: 'Hi there friend.',
    });
  });

  it('breaks at sentence boundaries once MIN_WORDS is reached', () => {
    // Two sentences of 8 words each — each above the MIN_WORDS=6 threshold.
    const { words, speakText } = makeWords(
      'one two three four five six seven eight. nine ten eleven twelve thirteen fourteen fifteen sixteen.',
    );
    const chunks = buildChunks(words, speakText);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.wordStart).toBe(0);
    expect(chunks[0]!.wordEnd).toBe(7);
    expect(chunks[1]!.wordStart).toBe(8);
    expect(chunks[1]!.wordEnd).toBe(15);
  });

  it('keeps very short sentences merged with the next one (below MIN_WORDS)', () => {
    const { words, speakText } = makeWords('Yes. ' + 'a b c d e f g h i j k.');
    const chunks = buildChunks(words, speakText);
    // "Yes." is only 1 word — should be folded into the next sentence.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text.startsWith('Yes.')).toBe(true);
  });

  it('enforces a hard cap so chunks never exceed HARD_WORDS', () => {
    const tokens = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ');
    const { words, speakText } = makeWords(tokens);
    const chunks = buildChunks(words, speakText);
    for (const c of chunks) {
      const len = c.wordEnd - c.wordStart + 1;
      expect(len).toBeLessThanOrEqual(36);
    }
    expect(totalWords(chunks)).toBe(120);
  });

  it('breaks at a clause boundary (comma/semicolon/colon) once SOFT_WORDS is reached', () => {
    // Build a long stretch without sentence-ending punctuation but with one
    // comma well past the soft threshold (18 words).
    const tokens =
      Array.from({ length: 22 }, (_, i) => `w${i}`).join(' ') +
      ', and then ' +
      Array.from({ length: 10 }, (_, i) => `x${i}`).join(' ');
    const { words, speakText } = makeWords(tokens);
    const chunks = buildChunks(words, speakText);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.text.trim().endsWith(',')).toBe(true);
  });

  it('produces contiguous, gap-free word ranges', () => {
    const tokens = Array.from({ length: 80 }, (_, i) =>
      (i + 1) % 8 === 0 ? `w${i}.` : `w${i}`,
    ).join(' ');
    const { words, speakText } = makeWords(tokens);
    const chunks = buildChunks(words, speakText);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i + 1]!.wordStart).toBe(chunks[i]!.wordEnd + 1);
    }
    expect(chunks[0]!.wordStart).toBe(0);
    expect(chunks[chunks.length - 1]!.wordEnd).toBe(words.length - 1);
  });

  it('captures the correct text slice for each chunk', () => {
    const { words, speakText } = makeWords(
      'one two three four five six seven eight. nine ten eleven twelve thirteen fourteen fifteen sixteen.',
    );
    const chunks = buildChunks(words, speakText);
    for (const c of chunks) {
      expect(speakText.substring(c.charStart, c.charEnd)).toBe(c.text);
    }
  });
});

describe('findChunkForWord', () => {
  const chunks: SpeechChunk[] = [
    { wordStart: 0, wordEnd: 5, charStart: 0, charEnd: 10, text: 'a' },
    { wordStart: 6, wordEnd: 12, charStart: 11, charEnd: 25, text: 'b' },
    { wordStart: 13, wordEnd: 20, charStart: 26, charEnd: 40, text: 'c' },
  ];

  it('returns 0 for an empty chunk list', () => {
    expect(findChunkForWord([], 5)).toBe(0);
  });

  it('finds the chunk that contains the word', () => {
    expect(findChunkForWord(chunks, 0)).toBe(0);
    expect(findChunkForWord(chunks, 5)).toBe(0);
    expect(findChunkForWord(chunks, 6)).toBe(1);
    expect(findChunkForWord(chunks, 12)).toBe(1);
    expect(findChunkForWord(chunks, 20)).toBe(2);
  });

  it('clamps past-the-end word indices to the last chunk', () => {
    expect(findChunkForWord(chunks, 999)).toBe(2);
  });
});
