import type { WordEntity } from '../types';

function endsSentence(word: string): boolean {
  return /[.!?…]["']?$/.test(word);
}

type Fragment = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  spanId: number;
  startsAtSpanStart: boolean;
  endsAtSpanEnd: boolean;
};

function collectFragments(textLayerDiv: HTMLElement, layerRect: DOMRect): Fragment[] {
  const out: Fragment[] = [];
  const spans = textLayerDiv.querySelectorAll<HTMLElement>('span');
  let spanId = 0;

  for (const span of spans) {
    const textNode = span.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      spanId += 1;
      continue;
    }
    const text = textNode.nodeValue ?? '';
    if (!text.trim()) {
      spanId += 1;
      continue;
    }

    const re = /\S+/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      const range = document.createRange();
      try {
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
      } catch {
        continue;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      out.push({
        text: m[0],
        left: rect.left - layerRect.left,
        top: rect.top - layerRect.top,
        width: rect.width,
        height: rect.height,
        spanId,
        startsAtSpanStart: start === 0,
        endsAtSpanEnd: end === text.length,
      });
    }
    spanId += 1;
  }

  return out;
}

/**
 * Decide whether `next` should be glued onto `prev` as part of the same word.
 *
 * PDF.js can render a single visual word across multiple spans (e.g. due to
 * justification, kerning, or font changes). When that happens we get back
 * separate `\S+` fragments like "h" + "ow" or "self-" + "condemnation" even
 * though the user — and the speech synthesizer — should see one word.
 *
 * We merge when both ends of the gap are at span boundaries (i.e. there was
 * no whitespace between them in the source text), the fragments share a
 * baseline, and the horizontal gap is no larger than ~half a glyph.
 */
function shouldMerge(
  prev: { left: number; top: number; width: number; height: number; spanId: number; endsAtSpanEnd: boolean },
  next: Fragment,
): boolean {
  if (next.spanId === prev.spanId) return false;
  if (!prev.endsAtSpanEnd) return false;
  if (!next.startsAtSpanStart) return false;

  const prevCenter = prev.top + prev.height / 2;
  const nextCenter = next.top + next.height / 2;
  const hRef = Math.max(prev.height, next.height);
  if (Math.abs(prevCenter - nextCenter) > hRef * 0.5) return false;

  const gap = next.left - (prev.left + prev.width);
  if (gap > hRef * 0.5) return false;

  return true;
}

/**
 * Extract word bounding boxes from a PDF.js-rendered text layer.
 *
 * PDF.js positions each text-item span correctly via inline styles (left, top,
 * font-size, transform: scaleX(...)), so the most reliable way to get per-word
 * rectangles in viewport pixel space is to ask the browser via the Range API,
 * then merge fragments that PDF.js happened to split across spans.
 */
export function buildWordsFromTextLayer(
  textLayerDiv: HTMLElement,
  pageIndex: number,
  sentenceIdBase = 0,
): Omit<WordEntity, 'charStart' | 'charEnd' | 'wordIndex'>[] {
  const layerRect = textLayerDiv.getBoundingClientRect();
  const frags = collectFragments(textLayerDiv, layerRect);
  const result: Omit<WordEntity, 'charStart' | 'charEnd' | 'wordIndex'>[] = [];
  let sentenceId = sentenceIdBase;

  let i = 0;
  while (i < frags.length) {
    const first = frags[i]!;
    let curText = first.text;
    let curLeft = first.left;
    let curTop = first.top;
    let curRight = first.left + first.width;
    let curBottom = first.top + first.height;
    let curSpanId = first.spanId;
    let curEndsAtSpanEnd = first.endsAtSpanEnd;

    let j = i + 1;
    while (j < frags.length) {
      const next = frags[j]!;
      const prevState = {
        left: curLeft,
        top: curTop,
        width: curRight - curLeft,
        height: curBottom - curTop,
        spanId: curSpanId,
        endsAtSpanEnd: curEndsAtSpanEnd,
      };
      if (!shouldMerge(prevState, next)) break;

      curText += next.text;
      curLeft = Math.min(curLeft, next.left);
      curTop = Math.min(curTop, next.top);
      curRight = Math.max(curRight, next.left + next.width);
      curBottom = Math.max(curBottom, next.top + next.height);
      curSpanId = next.spanId;
      curEndsAtSpanEnd = next.endsAtSpanEnd;
      j += 1;
    }

    result.push({
      pageIndex,
      sentenceId,
      text: curText,
      left: curLeft,
      top: curTop,
      width: curRight - curLeft,
      height: curBottom - curTop,
    });
    if (endsSentence(curText)) sentenceId += 1;

    i = j;
  }

  return result;
}

export function assignCharOffsets(words: Omit<WordEntity, 'charStart' | 'charEnd' | 'wordIndex'>[]): WordEntity[] {
  let offset = 0;
  return words.map((w, wordIndex) => {
    const charStart = offset;
    const charEnd = offset + w.text.length;
    offset = charEnd + 1;
    return { ...w, wordIndex, charStart, charEnd };
  });
}

export function buildSpeakText(words: WordEntity[]): string {
  return words.map((w) => w.text).join(' ');
}

export function charIndexToWordIndex(words: WordEntity[], charIndex: number): number {
  if (words.length === 0) return 0;
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (words[mid]!.charStart <= charIndex) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
