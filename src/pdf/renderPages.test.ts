import { beforeEach, describe, expect, it, vi } from 'vitest';

// `pdfjs-dist` and the worker shim are heavy and irrelevant here — stub
// them so we can test the pure orchestration logic of `rerasterizePages`.
vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
  TextLayer: class {
    async render(): Promise<void> {
      /* noop */
    }
  },
  setLayerDimensions: vi.fn(),
}));
vi.mock('./worker', () => ({}));

import { rerasterizePages } from './renderPages';
import type { RenderedPage } from '../types';
import type { PDFDocumentProxy } from 'pdfjs-dist';

// happy-dom returns null from canvas.getContext, which would short-circuit
// the swap inside rerasterizePages. Patch it to return a truthy stub; the
// mocked pdfPage.render() never actually draws to the context anyway.
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as HTMLCanvasElement['getContext'];
});

type FakePage = {
  render: ReturnType<typeof vi.fn>;
};

function makeFakeDoc(pageFactory: (i: number) => FakePage): PDFDocumentProxy {
  return {
    getPage: vi.fn((i: number) => Promise.resolve(pageFactory(i))),
    numPages: 1,
  } as unknown as PDFDocumentProxy;
}

function makeRenderedPage(): { page: RenderedPage; originalCanvas: HTMLCanvasElement } {
  const root = document.createElement('div');
  root.className = 'pdf-page';
  const canvas = document.createElement('canvas');
  canvas.width = 100;
  canvas.height = 100;
  // Stamp the canvas so we can detect whether it's still the SAME element
  // after rerasterize, not just "a canvas exists".
  canvas.dataset.original = 'true';
  root.append(canvas);
  document.body.append(root);
  const viewport = {
    width: 100,
    height: 100,
  } as unknown as RenderedPage['viewport'];
  return { page: { pageIndex: 0, root, viewport }, originalCanvas: canvas };
}

describe('rerasterizePages — double-buffered redraw', () => {
  it('swaps in a freshly rendered canvas only after render() resolves', async () => {
    const { page, originalCanvas } = makeRenderedPage();
    const doc = makeFakeDoc(() => ({
      render: vi.fn(() => ({ promise: Promise.resolve() })),
    }));
    await rerasterizePages(doc, [page]);
    // The visible canvas is replaced with a new one (no longer marked original).
    const visible = page.root.querySelector<HTMLCanvasElement>('canvas');
    expect(visible).toBeTruthy();
    expect(visible).not.toBe(originalCanvas);
    expect(visible?.dataset.original).toBeUndefined();
  });

  it("keeps the visible canvas intact when render() fails — never blanks the page", async () => {
    const { page, originalCanvas } = makeRenderedPage();
    const doc = makeFakeDoc(() => ({
      render: vi.fn(() => ({ promise: Promise.reject(new Error('worker died')) })),
    }));
    await rerasterizePages(doc, [page]);
    const visible = page.root.querySelector<HTMLCanvasElement>('canvas');
    expect(visible).toBe(originalCanvas);
    // The original canvas must still have its pixel dimensions (the old buggy
    // path would have set width/height before rendering, blanking it).
    expect(originalCanvas.width).toBe(100);
    expect(originalCanvas.height).toBe(100);
  });

  it('bails out cleanly when the signal is aborted mid-flight', async () => {
    const { page, originalCanvas } = makeRenderedPage();
    const ctrl = new AbortController();
    let resolveRender: (() => void) | undefined;
    const doc = makeFakeDoc(() => ({
      render: vi.fn(() => ({
        promise: new Promise<void>((res) => {
          resolveRender = res;
        }),
      })),
    }));
    const job = rerasterizePages(doc, [page], { signal: ctrl.signal });
    ctrl.abort();
    resolveRender?.();
    await job;
    const visible = page.root.querySelector<HTMLCanvasElement>('canvas');
    expect(visible).toBe(originalCanvas);
  });
});
