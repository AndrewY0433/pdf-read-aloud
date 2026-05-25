import {
  TextLayer,
  setLayerDimensions,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PageViewport,
} from 'pdfjs-dist';
import { buildWordsFromTextLayer, assignCharOffsets } from './textModel';
import { updateHighlightPositionsForPage } from './highlights';
import type { RenderedPage, WordEntity } from '../types';

/** Pages rendered above/below the viewport. */
export const VIEWPORT_BUFFER = 2;
/** Tear down canvas/text for pages this far outside the buffered range. */
export const UNRENDER_DISTANCE = 4;
/** Max concurrent full page renders. */
const MAX_CONCURRENT_RENDERS = 2;

export type PageSlot = RenderedPage & {
  scale: number;
  renderState: 'placeholder' | 'words' | 'full';
};

export type VirtualPageOptions = {
  signal?: AbortSignal;
  onProgress?: (message: string | null) => void;
};

function pickScale(page: PDFPageProxy, maxWidth: number): number {
  const base = page.getViewport({ scale: 1 });
  if (base.width <= maxWidth) return 1;
  return maxWidth / base.width;
}

function throwAbort(): never {
  throw new DOMException('Render cancelled', 'AbortError');
}

function createShell(pageIndex: number, viewport: PageViewport, scale: number): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'pdf-page pdf-page-placeholder';
  root.dataset.pageIndex = String(pageIndex);
  root.style.width = `${viewport.width}px`;
  root.style.height = `${viewport.height}px`;
  root.style.setProperty('--scale-factor', String(scale));
  return root;
}

function updateShellDimensions(root: HTMLDivElement, viewport: PageViewport, scale: number): void {
  root.style.width = `${viewport.width}px`;
  root.style.height = `${viewport.height}px`;
  root.style.setProperty('--scale-factor', String(scale));
}

function clearVisuals(root: HTMLDivElement): void {
  for (const el of root.querySelectorAll('canvas, .textLayer, .highlight-layer')) {
    el.remove();
  }
  root.classList.add('pdf-page-placeholder');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Manages lazy PDF page rendering: placeholder shells for every page keep
 * scroll height correct while only nearby pages get canvas + text layers.
 */
export class VirtualPageRenderer {
  private slots: PageSlot[] = [];
  private wordParts: Omit<WordEntity, 'charStart' | 'charEnd' | 'wordIndex'>[][] = [];
  private words: WordEntity[] = [];
  private speakText = '';

  private scrollHost: HTMLElement;
  private innerHost: HTMLElement;
  private doc: PDFDocumentProxy;
  private signal?: AbortSignal;
  private onProgress?: (message: string | null) => void;

  private io: IntersectionObserver | null = null;
  private scrollListener: (() => void) | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private renderQueue: number[] = [];
  private activeRenders = 0;
  private scheduledFlush = false;
  private visiblePages = new Set<number>();
  private destroyed = false;

  constructor(
    scrollHost: HTMLElement,
    innerHost: HTMLElement,
    doc: PDFDocumentProxy,
    opts: VirtualPageOptions = {},
  ) {
    this.scrollHost = scrollHost;
    this.innerHost = innerHost;
    this.doc = doc;
    this.signal = opts.signal;
    this.onProgress = opts.onProgress;
  }

  getPages(): RenderedPage[] {
    return this.slots;
  }

  getSlots(): PageSlot[] {
    return this.slots;
  }

  getWords(): WordEntity[] {
    return this.words;
  }

  getSpeakText(): string {
    return this.speakText;
  }

  /** Create empty shells for every page and mount them into the viewer. */
  async createShells(maxWidth: number): Promise<void> {
    const slots: PageSlot[] = [];
    for (let i = 1; i <= this.doc.numPages; i++) {
      if (this.signal?.aborted) throwAbort();
      const pdfPage = await this.doc.getPage(i);
      if (this.signal?.aborted) throwAbort();
      const pageIndex = i - 1;
      const scale = pickScale(pdfPage, maxWidth);
      const viewport = pdfPage.getViewport({ scale });
      slots.push({
        pageIndex,
        root: createShell(pageIndex, viewport, scale),
        viewport,
        scale,
        renderState: 'placeholder',
      });
    }
    this.slots = slots;
    this.wordParts = slots.map(() => []);
    this.innerHost.replaceChildren(...slots.map((s) => s.root));
  }

  /** Render pages near the viewport and extract words for the rest. */
  async initializeContent(): Promise<void> {
    await this.prepareVisible();
    await this.finishWords();
  }

  async prepareVisible(): Promise<void> {
    this.refreshVisibleSet();
    await this.renderVisibleRange(true);
  }

  async finishWords(): Promise<void> {
    await this.extractRemainingWords();
    this.rebuildWordIndex();
  }

  /** Attach scroll/visibility listeners and keep the viewport window updated. */
  start(): void {
    if (this.destroyed || this.io) return;

    this.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (!Number.isFinite(idx)) continue;
          if (entry.isIntersecting) this.visiblePages.add(idx);
          else this.visiblePages.delete(idx);
        }
        this.scheduleViewportUpdate();
      },
      { root: this.scrollHost, rootMargin: `${VIEWPORT_BUFFER * 120}px 0px` },
    );

    for (const slot of this.slots) {
      this.io.observe(slot.root);
    }

    this.scrollListener = () => this.scheduleViewportUpdate();
    this.scrollHost.addEventListener('scroll', this.scrollListener, { passive: true });
    this.scheduleViewportUpdate();
  }

  stop(): void {
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    if (this.io) {
      this.io.disconnect();
      this.io = null;
    }
    if (this.scrollListener) {
      this.scrollHost.removeEventListener('scroll', this.scrollListener);
      this.scrollListener = null;
    }
    this.renderQueue = [];
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.slots = [];
    this.wordParts = [];
    this.words = [];
    this.visiblePages.clear();
  }

  /** Ensure a page is fully rendered (e.g. before scrolling to an active word). */
  async ensurePageRendered(pageIndex: number): Promise<void> {
    const slot = this.slots[pageIndex];
    if (!slot || slot.renderState === 'full') return;
    await this.renderPageFull(slot);
    if (this.words.length > 0) {
      updateHighlightPositionsForPage(slot, this.words);
    }
  }

  /** Recompute layout widths and invalidate visuals after a container resize. */
  async relayout(maxWidth: number): Promise<void> {
    this.stop();
    this.renderQueue = [];

    for (const slot of this.slots) {
      if (this.signal?.aborted) throwAbort();
      const pdfPage = await this.doc.getPage(slot.pageIndex + 1);
      const scale = pickScale(pdfPage, maxWidth);
      const viewport = pdfPage.getViewport({ scale });
      slot.scale = scale;
      slot.viewport = viewport;
      updateShellDimensions(slot.root, viewport, scale);
      clearVisuals(slot.root);
      slot.renderState = 'placeholder';
      this.wordParts[slot.pageIndex] = [];
    }

    this.words = [];
    this.speakText = '';
    await this.initializeContent();
    this.start();
  }

  /** Re-rasterise canvases at the current devicePixelRatio for rendered pages. */
  async rerasterize(opts: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = opts.signal ?? this.signal;
    const dpr = window.devicePixelRatio || 1;
    for (const slot of this.slots) {
      if (signal?.aborted) return;
      if (slot.renderState !== 'full') continue;

      const visible = slot.root.querySelector<HTMLCanvasElement>('canvas');
      if (!visible) continue;

      const next = document.createElement('canvas');
      next.width = Math.floor(slot.viewport.width * dpr);
      next.height = Math.floor(slot.viewport.height * dpr);
      next.style.width = `${slot.viewport.width}px`;
      next.style.height = `${slot.viewport.height}px`;
      next.style.display = 'block';
      const ctx = next.getContext('2d');
      if (!ctx) continue;

      try {
        const pdfPage = await this.doc.getPage(slot.pageIndex + 1);
        if (signal?.aborted) return;
        const renderContext = {
          canvasContext: ctx,
          viewport: slot.viewport,
          transform: dpr !== 1 ? ([dpr, 0, 0, dpr, 0, 0] as const) : undefined,
        };
        await pdfPage.render(renderContext as Parameters<PDFPageProxy['render']>[0]).promise;
        if (signal?.aborted) return;
        visible.replaceWith(next);
      } catch (e) {
        if ((e as Error | null)?.name === 'AbortError') return;
        console.warn(`Failed to rerasterize page ${slot.pageIndex}; keeping previous canvas.`, e);
      }
    }
  }

  private scheduleViewportUpdate(): void {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      this.refreshVisibleSet();
      void this.applyViewportWindow();
    }, 80);
  }

  private refreshVisibleSet(): void {
    if (this.visiblePages.size > 0) return;
    const hostRect = this.scrollHost.getBoundingClientRect();
    const margin = VIEWPORT_BUFFER * 200;
    for (const slot of this.slots) {
      const rect = slot.root.getBoundingClientRect();
      if (rect.bottom >= hostRect.top - margin && rect.top <= hostRect.bottom + margin) {
        this.visiblePages.add(slot.pageIndex);
      }
    }
  }

  private getTargetPageSet(): Set<number> {
    const target = new Set<number>();
    for (const idx of this.visiblePages) {
      for (let d = -VIEWPORT_BUFFER; d <= VIEWPORT_BUFFER; d++) {
        const page = idx + d;
        if (page >= 0 && page < this.slots.length) target.add(page);
      }
    }
    if (target.size === 0 && this.slots.length > 0) {
      for (let i = 0; i <= Math.min(VIEWPORT_BUFFER, this.slots.length - 1); i++) {
        target.add(i);
      }
    }
    return target;
  }

  private async applyViewportWindow(): Promise<void> {
    const target = this.getTargetPageSet();
    for (const idx of target) {
      this.enqueueRender(idx);
    }

    for (const slot of this.slots) {
      let nearest = Infinity;
      for (const idx of target) {
        nearest = Math.min(nearest, Math.abs(slot.pageIndex - idx));
      }
      if (nearest > UNRENDER_DISTANCE && slot.renderState === 'full') {
        this.unrenderPage(slot);
      }
    }

    this.flushRenderQueue();
  }

  private async renderVisibleRange(priority = false): Promise<void> {
    this.refreshVisibleSet();
    const target = this.getTargetPageSet();
    const indices = [...target].sort((a, b) => a - b);
    if (priority) {
      for (const idx of indices) {
        const slot = this.slots[idx];
        if (slot) await this.renderPageFull(slot);
      }
      return;
    }
    for (const idx of indices) this.enqueueRender(idx);
    await this.waitForQueueDrain();
  }

  private enqueueRender(pageIndex: number): void {
    const slot = this.slots[pageIndex];
    if (!slot || slot.renderState === 'full') return;
    if (this.renderQueue.includes(pageIndex)) return;
    this.renderQueue.push(pageIndex);
    this.flushRenderQueue();
  }

  private flushRenderQueue(): void {
    if (this.scheduledFlush) return;
    this.scheduledFlush = true;
    void this.drainRenderQueue();
  }

  private async drainRenderQueue(): Promise<void> {
    this.scheduledFlush = false;
    while (this.renderQueue.length > 0 && this.activeRenders < MAX_CONCURRENT_RENDERS) {
      const pageIndex = this.renderQueue.shift()!;
      const slot = this.slots[pageIndex];
      if (!slot || slot.renderState === 'full') continue;
      this.activeRenders++;
      void this.renderPageFull(slot)
        .catch((e) => {
          if ((e as Error | null)?.name !== 'AbortError') {
            console.warn(`Failed to render page ${pageIndex}`, e);
          }
        })
        .finally(() => {
          this.activeRenders--;
          this.flushRenderQueue();
        });
    }
  }

  private waitForQueueDrain(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.renderQueue.length === 0 && this.activeRenders === 0) resolve();
        else setTimeout(check, 40);
      };
      check();
    });
  }

  private unrenderPage(slot: PageSlot): void {
    clearVisuals(slot.root);
    slot.renderState = this.wordParts[slot.pageIndex]!.length > 0 ? 'words' : 'placeholder';
  }

  private async renderPageFull(slot: PageSlot): Promise<void> {
    if (this.signal?.aborted) throwAbort();
    if (slot.renderState === 'full') return;

    const pdfPage = await this.doc.getPage(slot.pageIndex + 1);
    if (this.signal?.aborted) throwAbort();

    clearVisuals(slot.root);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not supported');

    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(slot.viewport.width * outputScale);
    canvas.height = Math.floor(slot.viewport.height * outputScale);
    canvas.style.width = `${slot.viewport.width}px`;
    canvas.style.height = `${slot.viewport.height}px`;

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.setProperty('--scale-factor', String(slot.scale));
    setLayerDimensions(textLayerDiv, slot.viewport);

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';

    slot.root.append(canvas, highlightLayer, textLayerDiv);
    slot.root.classList.remove('pdf-page-placeholder');

    const renderContext = {
      canvasContext: ctx,
      viewport: slot.viewport,
      transform:
        outputScale !== 1 ? ([outputScale, 0, 0, outputScale, 0, 0] as const) : undefined,
    };
    await pdfPage.render(renderContext as Parameters<PDFPageProxy['render']>[0]).promise;
    if (this.signal?.aborted) throwAbort();

    const textContent = await pdfPage.getTextContent();
    if (this.signal?.aborted) throwAbort();
    const textLayer = new TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport: slot.viewport,
    });
    await textLayer.render();
    if (this.signal?.aborted) throwAbort();

    const parts = buildWordsFromTextLayer(
      textLayerDiv,
      slot.pageIndex,
      slot.pageIndex * 50_000,
    );
    this.wordParts[slot.pageIndex] = parts;
    slot.renderState = 'full';

    this.rebuildWordIndex();
    if (this.words.length > 0) {
      updateHighlightPositionsForPage(slot, this.words);
    }
  }

  private async extractRemainingWords(): Promise<void> {
    const staging = document.createElement('div');
    staging.setAttribute('aria-hidden', 'true');
    staging.style.cssText =
      'position:absolute;left:-99999px;top:0;visibility:hidden;contain:layout style;';
    staging.style.width = `${this.innerHost.clientWidth}px`;
    document.body.append(staging);

    try {
      for (const slot of this.slots) {
        if (this.signal?.aborted) throwAbort();
        if (slot.renderState === 'full' || this.wordParts[slot.pageIndex]!.length > 0) continue;

        this.onProgress?.(`Extracting text… page ${slot.pageIndex + 1}/${this.slots.length}`);
        await this.extractWordsForSlot(slot, staging);
        // Yield so the UI stays responsive during long books.
        await delay(0);
      }
    } finally {
      staging.remove();
    }
    this.onProgress?.(null);
  }

  private async extractWordsForSlot(slot: PageSlot, staging: HTMLElement): Promise<void> {
    const pdfPage = await this.doc.getPage(slot.pageIndex + 1);
    if (this.signal?.aborted) throwAbort();

    const shell = createShell(slot.pageIndex, slot.viewport, slot.scale);
    staging.append(shell);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.setProperty('--scale-factor', String(slot.scale));
    setLayerDimensions(textLayerDiv, slot.viewport);
    shell.append(textLayerDiv);

    const textContent = await pdfPage.getTextContent();
    if (this.signal?.aborted) throwAbort();
    const textLayer = new TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport: slot.viewport,
    });
    await textLayer.render();
    if (this.signal?.aborted) throwAbort();

    this.wordParts[slot.pageIndex] = buildWordsFromTextLayer(
      textLayerDiv,
      slot.pageIndex,
      slot.pageIndex * 50_000,
    );
    slot.renderState = 'words';
    shell.remove();
  }

  private rebuildWordIndex(): void {
    const flat = this.wordParts.flat();
    this.words = assignCharOffsets(flat);
    this.speakText = this.words.map((w) => w.text).join(' ');
  }
}

export { pickScale, createShell, updateShellDimensions, clearVisuals };
