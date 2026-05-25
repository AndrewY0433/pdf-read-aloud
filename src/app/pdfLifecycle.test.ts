import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pdf/renderPages', () => ({
  loadAndRenderPdf: vi.fn(),
  renderPdfPages: vi.fn().mockResolvedValue({}),
  rerasterizePages: vi.fn().mockResolvedValue(undefined),
  updateHighlightPositions: vi.fn(),
  setActiveHighlights: vi.fn(),
}));

import { createAppShell } from './shell';
import { createAppContext } from './context';
import { onResize } from './pdfLifecycle';
import { renderPdfPages } from '../pdf/renderPages';

describe('onResize', () => {
  let root: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.mocked(renderPdfPages).mockClear();
  });

  it('tracks viewer clientWidth and schedules a width re-layout', () => {
    const shell = createAppShell(root);
    const ctx = createAppContext(shell, shell.progressBar);
    Object.defineProperty(shell.viewer, 'clientWidth', { value: 640, configurable: true });
    ctx.lastViewerWidth = 640;

    ctx.pdf = {
      doc: { numPages: 1, destroy: vi.fn() },
      fileName: 'test.pdf',
      pages: [],
      words: [],
      speakText: '',
      virtual: {
        destroy: vi.fn(),
        relayout: vi.fn(),
      },
    } as unknown as NonNullable<typeof ctx.pdf>;

    Object.defineProperty(shell.viewer, 'clientWidth', { value: 700, configurable: true });
    onResize(ctx);
    expect(ctx.lastViewerWidth).toBe(700);

    vi.advanceTimersByTime(200);
    expect(renderPdfPages).toHaveBeenCalled();
  });
});
