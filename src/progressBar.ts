import type { LoadedPdf } from './pdf/renderPages';

export type ProgressBar = {
  root: HTMLElement;
  fill: HTMLElement;
  tooltip: HTMLElement;
};

export function createProgressBar(): ProgressBar {
  const root = document.createElement('div');
  root.className = 'progress-bar';
  root.hidden = true;
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '100');
  root.setAttribute('aria-valuenow', '0');

  const track = document.createElement('div');
  track.className = 'progress-bar__track';

  const fill = document.createElement('div');
  fill.className = 'progress-bar__fill';
  track.append(fill);

  const tooltip = document.createElement('div');
  tooltip.className = 'progress-bar__tooltip';
  tooltip.setAttribute('role', 'tooltip');

  root.append(track, tooltip);
  return { root, fill, tooltip };
}

/** 1-based page number for a word index; falls back to page 1. */
export function pageForWordIndex(loaded: LoadedPdf, wordIndex: number): number {
  if (loaded.words.length === 0) return 1;
  const clamped = Math.min(Math.max(0, wordIndex), loaded.words.length - 1);
  return (loaded.words[clamped]?.pageIndex ?? 0) + 1;
}

/** Reading progress as 0–1 from word position through the document. */
export function readingProgress(wordIndex: number, wordCount: number): number {
  if (wordCount <= 0) return 0;
  if (wordCount === 1) return 1;
  return Math.min(1, Math.max(0, wordIndex / (wordCount - 1)));
}

export function syncProgressBar(bar: ProgressBar, pdf: LoadedPdf | null, wordIndex: number): void {
  if (!pdf || pdf.words.length === 0) {
    bar.root.hidden = true;
    return;
  }

  const totalPages = pdf.doc.numPages;
  const currentPage = pageForWordIndex(pdf, wordIndex);
  const pct = Math.round(readingProgress(wordIndex, pdf.words.length) * 100);

  bar.root.hidden = false;
  bar.fill.style.width = `${pct}%`;
  bar.tooltip.textContent = `Page ${currentPage} of ${totalPages}`;
  bar.root.setAttribute('aria-valuenow', String(pct));
  bar.root.setAttribute(
    'aria-label',
    `Reading progress, page ${currentPage} of ${totalPages}`,
  );
}
