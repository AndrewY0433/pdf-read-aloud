import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import type { RenderedPage, WordEntity } from '../types';
import { VirtualPageRenderer } from './virtualPages';

export {
  updateHighlightPositions,
  updateHighlightPositionsForPage,
  setActiveHighlights,
} from './highlights';

import './worker';

export type LoadedPdf = {
  doc: PDFDocumentProxy;
  fileName: string;
  pages: RenderedPage[];
  words: WordEntity[];
  speakText: string;
  virtual: VirtualPageRenderer;
};

export type RenderOptions = {
  /**
   * Aborts the render at the next checkpoint. The currently visible viewer
   * is left untouched when an abort wins the race.
   */
  signal?: AbortSignal;
  onProgress?: (message: string | null) => void;
  /** Called once placeholder shells are mounted so the viewer can be shown early. */
  onShellsReady?: () => void;
};

function throwAbort(): never {
  throw new DOMException('Render cancelled', 'AbortError');
}

function hostMaxWidth(scrollHost: HTMLElement): number {
  return Math.max(320, scrollHost.clientWidth - 8);
}

export async function loadAndRenderPdf(
  data: ArrayBuffer,
  fileName: string,
  scrollHost: HTMLElement,
  opts: RenderOptions = {},
): Promise<LoadedPdf> {
  const loadingTask = getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await loadingTask.promise;
  if (opts.signal?.aborted) {
    void doc.destroy().catch(() => {});
    throwAbort();
  }
  return mountVirtualPdf(doc, fileName, scrollHost, opts);
}

/**
 * Mount a parsed PDF with lazy page rendering. Placeholder shells appear
 * immediately; nearby pages rasterise on demand while word positions are
 * extracted in the background for the whole document.
 */
export async function mountVirtualPdf(
  doc: PDFDocumentProxy,
  fileName: string,
  scrollHost: HTMLElement,
  opts: RenderOptions = {},
): Promise<LoadedPdf> {
  const innerHost =
    scrollHost.querySelector<HTMLElement>('.viewer-inner') ??
    (() => {
      const el = document.createElement('div');
      el.className = 'viewer-inner';
      scrollHost.append(el);
      return el;
    })();

  const virtual = new VirtualPageRenderer(scrollHost, innerHost, doc, {
    signal: opts.signal,
    onProgress: opts.onProgress,
  });

  await virtual.createShells(hostMaxWidth(scrollHost));
  if (opts.signal?.aborted) throwAbort();

  opts.onShellsReady?.();
  virtual.start();

  await virtual.prepareVisible();
  if (opts.signal?.aborted) throwAbort();

  await virtual.finishWords();
  if (opts.signal?.aborted) throwAbort();

  return {
    doc,
    fileName,
    pages: virtual.getPages(),
    words: virtual.getWords(),
    speakText: virtual.getSpeakText(),
    virtual,
  };
}

/**
 * Re-layout every page at the current viewer width. Only pages near the
 * viewport are rasterised; word positions are re-extracted in the background.
 */
export async function renderPdfPages(
  doc: PDFDocumentProxy,
  fileName: string,
  scrollHost: HTMLElement,
  opts: RenderOptions & { existing?: LoadedPdf } = {},
): Promise<LoadedPdf> {
  const innerHost = scrollHost.querySelector<HTMLElement>('.viewer-inner');
  if (!innerHost) {
    return mountVirtualPdf(doc, fileName, scrollHost, opts);
  }

  if (opts.existing && opts.existing.doc === doc) {
    await opts.existing.virtual.relayout(hostMaxWidth(scrollHost));
    if (opts.signal?.aborted) throwAbort();
    return {
      doc,
      fileName,
      pages: opts.existing.virtual.getPages(),
      words: opts.existing.virtual.getWords(),
      speakText: opts.existing.virtual.getSpeakText(),
      virtual: opts.existing.virtual,
    };
  }

  innerHost.replaceChildren();
  return mountVirtualPdf(doc, fileName, scrollHost, opts);
}

/**
 * Re-rasterise rendered canvases at the current devicePixelRatio.
 */
export async function rerasterizePages(
  doc: PDFDocumentProxy,
  pages: RenderedPage[],
  opts: RenderOptions & { virtual?: VirtualPageRenderer } = {},
): Promise<void> {
  if (opts.virtual) {
    await opts.virtual.rerasterize({ signal: opts.signal });
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const signal = opts.signal;
  for (const p of pages) {
    if (signal?.aborted) return;
    const visible = p.root.querySelector<HTMLCanvasElement>('canvas');
    if (!visible) continue;

    const next = document.createElement('canvas');
    next.width = Math.floor(p.viewport.width * dpr);
    next.height = Math.floor(p.viewport.height * dpr);
    next.style.width = `${p.viewport.width}px`;
    next.style.height = `${p.viewport.height}px`;
    next.style.display = 'block';
    const ctx = next.getContext('2d');
    if (!ctx) continue;

    try {
      const pdfPage = await doc.getPage(p.pageIndex + 1);
      if (signal?.aborted) return;
      const renderContext = {
        canvasContext: ctx,
        viewport: p.viewport,
        transform: dpr !== 1 ? ([dpr, 0, 0, dpr, 0, 0] as const) : undefined,
      };
      await pdfPage.render(renderContext as Parameters<PDFPageProxy['render']>[0]).promise;
      if (signal?.aborted) return;
      visible.replaceWith(next);
    } catch (e) {
      if ((e as Error | null)?.name === 'AbortError') return;
      console.warn(`Failed to rerasterize page ${p.pageIndex}; keeping previous canvas.`, e);
    }
  }
}
