import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist', () => ({
  TextLayer: class {
    async render(): Promise<void> {
      /* noop */
    }
  },
  setLayerDimensions: vi.fn(),
}));

import { VirtualPageRenderer, clearVisuals, createShell } from './virtualPages';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';

function makeViewport(w = 400, h = 600): PageViewport {
  return { width: w, height: h } as PageViewport;
}

function makeDoc(numPages: number): PDFDocumentProxy {
  return {
    numPages,
    getPage: vi.fn((_i: number) =>
      Promise.resolve({
        getViewport: () => makeViewport(),
        getTextContent: () => Promise.resolve({ items: [] }),
        render: () => ({ promise: Promise.resolve() }),
      }),
    ),
  } as unknown as PDFDocumentProxy;
}

function setupHosts(): { scroll: HTMLDivElement; inner: HTMLDivElement } {
  const scroll = document.createElement('div');
  scroll.style.height = '600px';
  scroll.style.overflow = 'auto';
  const inner = document.createElement('div');
  inner.className = 'viewer-inner';
  scroll.append(inner);
  document.body.append(scroll);
  Object.defineProperty(scroll, 'clientWidth', { value: 800, configurable: true });
  return { scroll, inner };
}

beforeEach(() => {
  document.body.innerHTML = '';
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as HTMLCanvasElement['getContext'];
});

describe('VirtualPageRenderer', () => {
  it('creates a placeholder shell per page without canvas', async () => {
    const { scroll, inner } = setupHosts();
    const virtual = new VirtualPageRenderer(scroll, inner, makeDoc(3));
    await virtual.createShells(780);
    expect(inner.querySelectorAll('.pdf-page')).toHaveLength(3);
    expect(inner.querySelectorAll('canvas')).toHaveLength(0);
    virtual.destroy();
  });

  it('clears visuals but keeps shell dimensions when unrendering', () => {
    const root = createShell(0, makeViewport(), 1);
    root.style.width = '400px';
    root.style.height = '600px';
    const canvas = document.createElement('canvas');
    root.append(canvas);
    clearVisuals(root);
    expect(root.querySelector('canvas')).toBeNull();
    expect(root.style.width).toBe('400px');
    expect(root.classList.contains('pdf-page-placeholder')).toBe(true);
  });

  it('destroys observers and clears state', async () => {
    const { scroll, inner } = setupHosts();
    const virtual = new VirtualPageRenderer(scroll, inner, makeDoc(2));
    await virtual.createShells(780);
    virtual.start();
    virtual.destroy();
    expect(virtual.getPages()).toEqual([]);
  });
});
