import {
  getDocument,
  TextLayer,
  setLayerDimensions,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
import { buildWordsFromTextLayer, assignCharOffsets } from './textModel';
import type { RenderedPage, WordEntity } from '../types';

import './worker';

export type LoadedPdf = {
  doc: PDFDocumentProxy;
  fileName: string;
  pages: RenderedPage[];
  words: WordEntity[];
  speakText: string;
};

function pickScale(page: PDFPageProxy, maxWidth: number): number {
  const base = page.getViewport({ scale: 1 });
  if (base.width <= maxWidth) return 1;
  return maxWidth / base.width;
}

export async function loadAndRenderPdf(
  data: ArrayBuffer,
  fileName: string,
  scrollHost: HTMLElement,
): Promise<LoadedPdf> {
  // PDF.js transfers the underlying buffer to its worker (which detaches the
  // ArrayBuffer on the main thread). Clone so callers can re-use `data` for
  // subsequent re-renders, e.g. when the viewport resizes after Ctrl+/Ctrl-.
  const loadingTask = getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await loadingTask.promise;
  return renderPdfPages(doc, fileName, scrollHost);
}

/**
 * Render every page of an already-parsed `PDFDocumentProxy` into `scrollHost`,
 * (re)building the canvas, text layer, and per-word geometries. Reuses the
 * existing worker-side document, so subsequent calls (e.g. after a window
 * resize) are dramatically faster than `loadAndRenderPdf`.
 */
export async function renderPdfPages(
  doc: PDFDocumentProxy,
  fileName: string,
  scrollHost: HTMLElement,
): Promise<LoadedPdf> {
  const maxWidth = Math.max(320, scrollHost.clientWidth - 8);
  const pages: RenderedPage[] = [];
  const wordParts: Omit<WordEntity, 'charStart' | 'charEnd' | 'wordIndex'>[] = [];

  scrollHost.replaceChildren();

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const pageIndex = i - 1;
    const scale = pickScale(page, maxWidth);
    const viewport = page.getViewport({ scale });

    const root = document.createElement('div');
    root.className = 'pdf-page';
    root.dataset.pageIndex = String(pageIndex);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not supported');

    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    // PDF.js's TextLayer uses `calc(var(--scale-factor) * Xpx)` for span
    // font-size and layer dimensions, so this MUST be set before render().
    // Without it, span fonts fall back to inherited sizes and word rects
    // drift relative to the canvas-rendered glyphs.
    textLayerDiv.style.setProperty('--scale-factor', String(scale));
    root.style.setProperty('--scale-factor', String(scale));
    setLayerDimensions(textLayerDiv, viewport);

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';

    root.style.width = `${viewport.width}px`;
    root.style.height = `${viewport.height}px`;
    root.append(canvas, highlightLayer, textLayerDiv);
    scrollHost.append(root);

    const renderContext = {
      canvasContext: ctx,
      viewport,
      transform: outputScale !== 1 ? ([outputScale, 0, 0, outputScale, 0, 0] as const) : undefined,
    };
    await page.render(renderContext as Parameters<PDFPageProxy['render']>[0]).promise;

    const textContent = await page.getTextContent();
    const textLayer = new TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();

    wordParts.push(...buildWordsFromTextLayer(textLayerDiv, pageIndex, pageIndex * 50_000));

    pages.push({ pageIndex, root, viewport });
  }

  const words = assignCharOffsets(wordParts);
  const speakText = words.map((w) => w.text).join(' ');

  return { doc, fileName, pages, words, speakText };
}

/**
 * Re-rasterise the canvas of each already-rendered page at the current
 * `devicePixelRatio`, leaving the CSS layout, text layer, and highlight
 * positions untouched. This is the cheap path for browser-zoom changes:
 * CSS handles the visual scaling, and we just resync canvas pixel density
 * so glyphs stay crisp at higher zoom levels.
 */
export async function rerasterizePages(
  doc: PDFDocumentProxy,
  pages: RenderedPage[],
): Promise<void> {
  const dpr = window.devicePixelRatio || 1;
  await Promise.all(
    pages.map(async (p) => {
      const canvas = p.root.querySelector<HTMLCanvasElement>('canvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const pdfPage = await doc.getPage(p.pageIndex + 1);
      canvas.width = Math.floor(p.viewport.width * dpr);
      canvas.height = Math.floor(p.viewport.height * dpr);
      const renderContext = {
        canvasContext: ctx,
        viewport: p.viewport,
        transform: dpr !== 1 ? ([dpr, 0, 0, dpr, 0, 0] as const) : undefined,
      };
      await pdfPage.render(renderContext as Parameters<PDFPageProxy['render']>[0]).promise;
    }),
  );
}

/**
 * Group a sentence's words into visual lines. Two words are on the same line
 * if their vertical centers are within half a glyph height of each other.
 * This lets us draw one tight sentence-highlight per wrapped line instead of
 * a single bounding rectangle that spans the empty space at line ends.
 */
function groupWordsByLine(words: WordEntity[]): WordEntity[][] {
  if (words.length === 0) return [];
  const sorted = [...words].sort(
    (a, b) => a.top + a.height / 2 - (b.top + b.height / 2) || a.left - b.left,
  );
  const lines: WordEntity[][] = [];
  let current: WordEntity[] = [];
  let currentCenter = 0;

  for (const w of sorted) {
    const center = w.top + w.height / 2;
    if (current.length === 0) {
      current = [w];
      currentCenter = center;
      continue;
    }
    const tol = Math.max(2, w.height * 0.5);
    if (Math.abs(center - currentCenter) <= tol) {
      current.push(w);
      currentCenter = (currentCenter * (current.length - 1) + center) / current.length;
    } else {
      lines.push(current);
      current = [w];
      currentCenter = center;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export function updateHighlightPositions(pages: RenderedPage[], words: WordEntity[]): void {
  for (const p of pages) {
    const layer = p.root.querySelector<HTMLElement>('.highlight-layer');
    if (!layer) continue;
    layer.replaceChildren();
  }

  const byPage = new Map<number, WordEntity[]>();
  for (const w of words) {
    const list = byPage.get(w.pageIndex) ?? [];
    list.push(w);
    byPage.set(w.pageIndex, list);
  }

  for (const [pageIndex, list] of byPage) {
    const page = pages[pageIndex];
    if (!page) continue;
    const layer = page.root.querySelector<HTMLElement>('.highlight-layer');
    if (!layer) continue;

    const bySentence = new Map<number, WordEntity[]>();
    for (const w of list) {
      const g = bySentence.get(w.sentenceId) ?? [];
      g.push(w);
      bySentence.set(w.sentenceId, g);
    }

    for (const [sentenceId, group] of bySentence) {
      for (const lineWords of groupWordsByLine(group)) {
        let minL = Infinity;
        let minT = Infinity;
        let maxR = -Infinity;
        let maxB = -Infinity;
        for (const w of lineWords) {
          minL = Math.min(minL, w.left);
          minT = Math.min(minT, w.top);
          maxR = Math.max(maxR, w.left + w.width);
          maxB = Math.max(maxB, w.top + w.height);
        }
        if (!Number.isFinite(minL)) continue;
        const s = document.createElement('div');
        s.className = 'sentence-highlight';
        s.dataset.sentenceId = String(sentenceId);
        s.style.left = `${minL}px`;
        s.style.top = `${minT}px`;
        s.style.width = `${maxR - minL}px`;
        s.style.height = `${maxB - minT}px`;
        layer.append(s);
      }
    }

    for (const w of list) {
      const d = document.createElement('div');
      d.className = 'word-highlight';
      d.dataset.wordIndex = String(w.wordIndex);
      d.style.left = `${w.left}px`;
      d.style.top = `${w.top}px`;
      d.style.width = `${w.width}px`;
      d.style.height = `${w.height}px`;
      layer.append(d);
    }
  }
}

export function setActiveHighlights(
  pages: RenderedPage[],
  activeWordIndex: number | null,
  words: WordEntity[],
): void {
  for (const p of pages) {
    const layer = p.root.querySelector('.highlight-layer');
    if (!layer) continue;
    for (const el of layer.querySelectorAll('.sentence-highlight, .word-highlight')) {
      el.classList.remove('active');
    }
  }

  if (activeWordIndex === null) return;
  const w = words[activeWordIndex];
  if (!w) return;

  const page = pages[w.pageIndex];
  if (!page) return;
  const layer = page.root.querySelector('.highlight-layer');
  if (!layer) return;

  const sid = String(w.sentenceId);
  for (const el of layer.querySelectorAll(
    `.sentence-highlight[data-sentence-id="${CSS.escape(sid)}"]`,
  )) {
    el.classList.add('active');
  }
  layer.querySelector(`.word-highlight[data-word-index="${CSS.escape(String(activeWordIndex))}"]`)?.classList.add(
    'active',
  );
}
