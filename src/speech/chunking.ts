import type { WordEntity } from '../types';

export type SpeechChunk = {
  wordStart: number;
  wordEnd: number; // inclusive
  charStart: number;
  charEnd: number;
  text: string;
};

const MIN_WORDS = 6;
const SOFT_WORDS = 22;
const HARD_WORDS = 48;

const SENTENCE_END_RE = /[.!?…][")'\]]?$/;
const CLAUSE_END_RE = /[,;:][")'\]]?$/;

/**
 * Group words into short utterances suitable for one-shot neural TTS
 * generation. We prefer sentence boundaries, fall back to clause boundaries
 * once the chunk gets long enough, and force a hard break at HARD_WORDS so
 * we never overrun the model's token budget.
 */
export function buildChunks(words: WordEntity[], speakText: string): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  if (words.length === 0) return chunks;

  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const inChunk = i - start + 1;
    const sentenceEnd = SENTENCE_END_RE.test(w.text);
    const clauseEnd = CLAUSE_END_RE.test(w.text);

    const shouldBreak =
      inChunk >= HARD_WORDS ||
      (sentenceEnd && inChunk >= MIN_WORDS) ||
      (clauseEnd && inChunk >= SOFT_WORDS);

    if (shouldBreak) {
      chunks.push(toChunk(words, speakText, start, i));
      start = i + 1;
    }
  }
  if (start < words.length) {
    chunks.push(toChunk(words, speakText, start, words.length - 1));
  }
  return chunks;
}

function toChunk(
  words: WordEntity[],
  speakText: string,
  wordStart: number,
  wordEnd: number,
): SpeechChunk {
  const first = words[wordStart]!;
  const last = words[wordEnd]!;
  return {
    wordStart,
    wordEnd,
    charStart: first.charStart,
    charEnd: last.charEnd,
    text: speakText.substring(first.charStart, last.charEnd),
  };
}

export function findChunkForWord(chunks: SpeechChunk[], wordIndex: number): number {
  if (chunks.length === 0) return 0;
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid]!.wordEnd < wordIndex) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
