import type { WordEntity } from '../types';

/** Playback window for one word inside a synthesised audio clip. */
export type WordTiming = {
  wordIndex: number;
  startSec: number;
  endSec: number;
};

/** Relative weight of a character when apportioning audio duration. */
export function charDurationWeight(char: string): number {
  if (/\s/.test(char)) return 0.55;
  if (/[.!?…]/.test(char)) return 1.55;
  if (/[,;:]/.test(char)) return 1.2;
  if (/['"()[\]{}]/.test(char)) return 0.45;
  if (/\d/.test(char)) return 1.15;
  return 1;
}

function charBoundaries(text: string, durationSec: number): { startSec: number[]; endSec: number[] } {
  const chars = [...text];
  if (chars.length === 0 || durationSec <= 0) {
    return { startSec: [], endSec: [] };
  }

  const weights = chars.map(charDurationWeight);
  const total = weights.reduce((sum, w) => sum + w, 0) || 1;
  const startSec: number[] = [];
  let acc = 0;
  for (let i = 0; i < chars.length; i++) {
    startSec.push(acc);
    acc += (weights[i]! / total) * durationSec;
  }
  const endSec = startSec.map((_, i) =>
    i + 1 < chars.length ? startSec[i + 1]! : durationSec,
  );
  return { startSec, endSec };
}

/**
 * Map synthesised audio duration onto word indices using weighted character
 * spans in `synthText`. Punctuation and whitespace receive extra (or reduced)
 * weight so highlights track pauses better than uniform char interpolation.
 */
export function buildWordTimeline(
  synthText: string,
  durationSec: number,
  words: WordEntity[],
  wordStart: number,
  wordEnd: number,
  synthCharOffset: number,
): WordTiming[] {
  if (wordEnd < wordStart || durationSec <= 0 || !synthText) return [];

  const { startSec, endSec } = charBoundaries(synthText, durationSec);
  const timeline: WordTiming[] = [];

  for (let wi = wordStart; wi <= wordEnd; wi++) {
    const w = words[wi];
    if (!w) continue;

    const relStart = w.charStart - synthCharOffset;
    const relEnd = w.charEnd - synthCharOffset - 1;
    if (relEnd < 0 || relStart >= synthText.length) continue;

    const clampedStart = Math.max(0, Math.min(relStart, startSec.length - 1));
    const clampedEnd = Math.max(clampedStart, Math.min(relEnd, endSec.length - 1));

    timeline.push({
      wordIndex: wi,
      startSec: startSec[clampedStart] ?? 0,
      endSec: endSec[clampedEnd] ?? durationSec,
    });
  }

  return timeline;
}

/** Scale timeline to match the decoded `<audio>` duration when it drifts. */
export function rescaleTimeline(timeline: WordTiming[], scale: number): WordTiming[] {
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < 0.01) return timeline;
  return timeline.map((slot) => ({
    wordIndex: slot.wordIndex,
    startSec: slot.startSec * scale,
    endSec: slot.endSec * scale,
  }));
}

export function wordIndexAtTime(
  timeline: WordTiming[],
  timeSec: number,
  minWordIndex: number,
  maxWordIndex: number,
): number {
  if (timeline.length === 0) return minWordIndex;

  let lo = 0;
  let hi = timeline.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeline[mid]!.startSec <= timeSec) lo = mid;
    else hi = mid - 1;
  }

  const slot = timeline[lo]!;
  const idx =
    timeSec >= slot.endSec && lo + 1 < timeline.length
      ? timeline[lo + 1]!.wordIndex
      : slot.wordIndex;

  return Math.min(maxWordIndex, Math.max(minWordIndex, idx));
}
