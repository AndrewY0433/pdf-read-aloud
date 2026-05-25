import { describe, expect, it } from 'vitest';
import {
  createProgressBar,
  pageForWordIndex,
  readingProgress,
  syncProgressBar,
} from './progressBar';
import type { LoadedPdf } from './pdf/renderPages';

function mockPdf(wordCount: number, numPages: number): LoadedPdf {
  const words = Array.from({ length: wordCount }, (_, i) => ({
    pageIndex: Math.floor((i / wordCount) * numPages),
    wordIndex: i,
    sentenceId: 0,
    text: `w${i}`,
    charStart: i * 2,
    charEnd: i * 2 + 1,
    left: 0,
    top: 0,
    width: 10,
    height: 10,
  }));
  return {
    doc: { numPages } as LoadedPdf['doc'],
    fileName: 'test.pdf',
    pages: [],
    words,
    speakText: words.map((w) => w.text).join(' '),
    virtual: {} as LoadedPdf['virtual'],
  };
}

describe('readingProgress', () => {
  it('returns 0 at the start and 1 at the end', () => {
    expect(readingProgress(0, 10)).toBe(0);
    expect(readingProgress(9, 10)).toBe(1);
  });

  it('returns 1 for a single-word document', () => {
    expect(readingProgress(0, 1)).toBe(1);
  });
});

describe('pageForWordIndex', () => {
  it('maps word index to a 1-based page number', () => {
    const pdf = mockPdf(100, 10);
    expect(pageForWordIndex(pdf, 0)).toBe(1);
    expect(pageForWordIndex(pdf, 50)).toBe(6);
    expect(pageForWordIndex(pdf, 99)).toBe(10);
  });
});

describe('createProgressBar', () => {
  it('starts hidden with progressbar semantics', () => {
    const bar = createProgressBar();
    expect(bar.root.hidden).toBe(true);
    expect(bar.root.getAttribute('role')).toBe('progressbar');
    expect(bar.root.querySelector('.progress-bar__fill')).toBe(bar.fill);
  });
});

describe('syncProgressBar', () => {
  it('shows fill width and tooltip from the current word', () => {
    const bar = createProgressBar();
    document.body.append(bar.root);
    const pdf = mockPdf(100, 10);

    syncProgressBar(bar, pdf, 50);

    expect(bar.root.hidden).toBe(false);
    expect(bar.fill.style.width).toBe('51%');
    expect(bar.tooltip.textContent).toBe('Page 6 of 10');
    expect(bar.root.getAttribute('aria-valuenow')).toBe('51');

    bar.root.remove();
  });

  it('hides the bar when there is no readable text', () => {
    const bar = createProgressBar();
    syncProgressBar(bar, mockPdf(0, 5), 0);
    expect(bar.root.hidden).toBe(true);
    syncProgressBar(bar, null, 0);
    expect(bar.root.hidden).toBe(true);
  });
});
