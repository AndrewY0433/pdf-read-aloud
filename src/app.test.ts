import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the heavy modules that app.ts pulls in. The full PDF render pipeline
// and the Kokoro neural model aren't relevant to the UI shape tests.
vi.mock('./pdf/renderPages', () => ({
  loadAndRenderPdf: vi.fn(),
  renderPdfPages: vi.fn(),
  rerasterizePages: vi.fn().mockResolvedValue(undefined),
  updateHighlightPositions: vi.fn(),
  setActiveHighlights: vi.fn(),
}));

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: vi.fn().mockResolvedValue({
      generate: vi.fn().mockResolvedValue({
        audio: new Float32Array(0),
        sampling_rate: 24000,
      }),
    }),
  },
}));

import { mount } from './app';

function setup(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  mount(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // Default to the browser engine so mounting doesn't trigger a Kokoro
  // warm-up. The kokoro path is exercised by its own engine tests.
  localStorage.setItem('pdf-read-aloud.engine', 'web-speech');
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('mount() — initial UI', () => {
  it('renders the shell, bottom bar, drop overlay, and viewer', () => {
    const root = setup();
    expect(root.querySelector('.shell')).toBeTruthy();
    expect(root.querySelector('.viewer')).toBeTruthy();
    expect(root.querySelector('.bottom-bar')).toBeTruthy();
    expect(root.querySelector('.drop-overlay')).toBeTruthy();
    expect(root.querySelector('input[type=file]')).toBeTruthy();
  });

  it('exposes Upload / Play / Pause buttons; Play and Pause start disabled', () => {
    const root = setup();
    const upload = root.querySelector<HTMLButtonElement>('[data-act=pick]');
    const play = root.querySelector<HTMLButtonElement>('[data-act=play]');
    const pause = root.querySelector<HTMLButtonElement>('[data-act=pause]');
    expect(upload).toBeTruthy();
    expect(play?.disabled).toBe(true);
    expect(pause?.disabled).toBe(true);
  });

  it('exposes the engine toggle with the persisted choice active', () => {
    const root = setup();
    const buttons = root.querySelectorAll<HTMLButtonElement>('.engine-toggle .toggle-btn');
    expect(buttons).toHaveLength(2);
    const active = Array.from(buttons).find((b) => b.classList.contains('active'));
    expect(active?.dataset.engine).toBe('web-speech');
  });

  it('exposes the speed control and starts at 1.0x', () => {
    const root = setup();
    const value = root.querySelector('.speed-value')?.textContent;
    expect(value).toBe('1.0x');
    const down = root.querySelector<HTMLButtonElement>('[data-act=speed-down]');
    const up = root.querySelector<HTMLButtonElement>('[data-act=speed-up]');
    expect(down).toBeTruthy();
    expect(up).toBeTruthy();
  });

  it('includes a hidden progress bar before a PDF is loaded', () => {
    const root = setup();
    const bar = root.querySelector<HTMLElement>('.progress-bar');
    expect(bar).toBeTruthy();
    expect(bar?.hidden).toBe(true);
  });
});

describe('mount() — speed control', () => {
  it('»  increments the rate by 0.25x', () => {
    const root = setup();
    const up = root.querySelector<HTMLButtonElement>('[data-act=speed-up]')!;
    up.click();
    expect(root.querySelector('.speed-value')?.textContent).toBe('1.25x');
    up.click();
    expect(root.querySelector('.speed-value')?.textContent).toBe('1.5x');
  });

  it('« decrements the rate by 0.25x', () => {
    const root = setup();
    const down = root.querySelector<HTMLButtonElement>('[data-act=speed-down]')!;
    down.click();
    expect(root.querySelector('.speed-value')?.textContent).toBe('0.75x');
  });

  it('disables » at the maximum rate', () => {
    const root = setup();
    const up = root.querySelector<HTMLButtonElement>('[data-act=speed-up]')!;
    // 1.0 -> 1.25 -> 1.5 -> ... -> 3.0 = 8 increments
    for (let i = 0; i < 8; i++) up.click();
    expect(root.querySelector('.speed-value')?.textContent).toBe('3.0x');
    expect(up.disabled).toBe(true);
  });

  it('disables « at the minimum rate', () => {
    const root = setup();
    const down = root.querySelector<HTMLButtonElement>('[data-act=speed-down]')!;
    // 1.0 -> 0.75 -> 0.5 = 2 decrements
    down.click();
    down.click();
    expect(root.querySelector('.speed-value')?.textContent).toBe('0.5x');
    expect(down.disabled).toBe(true);
  });

  it('persists the rate to localStorage', () => {
    const root = setup();
    root.querySelector<HTMLButtonElement>('[data-act=speed-up]')!.click();
    expect(localStorage.getItem('pdf-read-aloud.rate')).toBe('1.25');
  });

  it('+ and − keys step the rate by 0.25x', () => {
    const root = setup();
    const value = () => root.querySelector('.speed-value')?.textContent;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true }));
    expect(value()).toBe('1.25x');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    expect(value()).toBe('1.5x');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }));
    expect(value()).toBe('1.25x');
  });
});

describe('mount() — play / pause', () => {
  it('Space toggles play and pause when a PDF is loaded', async () => {
    const { loadAndRenderPdf } = await import('./pdf/renderPages');
    vi.mocked(loadAndRenderPdf).mockResolvedValue({
      doc: { destroy: vi.fn(), numPages: 5 },
      fileName: 'test.pdf',
      pages: [],
      words: [
        {
          pageIndex: 0,
          wordIndex: 0,
          sentenceId: 0,
          text: 'Hello',
          charStart: 0,
          charEnd: 5,
          left: 0,
          top: 0,
          width: 10,
          height: 10,
        },
      ],
      speakText: 'Hello',
      virtual: {
        destroy: vi.fn(),
        ensurePageRendered: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Awaited<ReturnType<typeof loadAndRenderPdf>>);

    const root = setup();
    const fileInput = root.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = new File(['%PDF'], 'test.pdf', { type: 'application/pdf' });
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(root.querySelector<HTMLButtonElement>('[data-act=play]')?.disabled).toBe(false);
    });

    const progressBar = root.querySelector<HTMLElement>('.progress-bar')!;
    expect(progressBar.hidden).toBe(false);
    expect(progressBar.querySelector('.progress-bar__tooltip')?.textContent).toBe('Page 1 of 5');

    const playBtn = () => root.querySelector<HTMLButtonElement>('[data-act=play]')!;
    const pauseBtn = () => root.querySelector<HTMLButtonElement>('[data-act=pause]')!;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    expect(pauseBtn().disabled).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    expect(playBtn().disabled).toBe(false);
    expect(pauseBtn().disabled).toBe(true);
  });
});

describe('mount() — engine toggle', () => {
  it('clicking the other engine flips the active class and persists', () => {
    const root = setup();
    const neuralBtn = root.querySelector<HTMLButtonElement>(
      '.engine-toggle .toggle-btn[data-engine="kokoro"]',
    )!;
    const browserBtn = root.querySelector<HTMLButtonElement>(
      '.engine-toggle .toggle-btn[data-engine="web-speech"]',
    )!;
    expect(browserBtn.classList.contains('active')).toBe(true);
    neuralBtn.click();
    expect(neuralBtn.classList.contains('active')).toBe(true);
    expect(browserBtn.classList.contains('active')).toBe(false);
    expect(localStorage.getItem('pdf-read-aloud.engine')).toBe('kokoro');
  });

  it('clicking the already-active engine is a noop', () => {
    const root = setup();
    const browserBtn = root.querySelector<HTMLButtonElement>(
      '.engine-toggle .toggle-btn[data-engine="web-speech"]',
    )!;
    browserBtn.click();
    expect(browserBtn.classList.contains('active')).toBe(true);
    expect(localStorage.getItem('pdf-read-aloud.engine')).toBe('web-speech');
  });
});

describe('mount() — drag and drop', () => {
  it('toggles the drag class on dragover/dragleave', () => {
    const root = setup();
    const viewer = root.querySelector<HTMLElement>('.viewer')!;
    const dragOver = new Event('dragover', { bubbles: true, cancelable: true });
    viewer.dispatchEvent(dragOver);
    expect(viewer.classList.contains('drag')).toBe(true);
    viewer.dispatchEvent(new Event('dragleave', { bubbles: true }));
    expect(viewer.classList.contains('drag')).toBe(false);
  });
});

describe('mount() — tab lifecycle', () => {
  it('cancels speech on pagehide so the OS speech queue never outlives the tab', () => {
    setup();
    const speech = globalThis.speechSynthesis as unknown as {
      cancel: { mock: { calls: unknown[] } };
    };
    const beforeCount = speech.cancel.mock.calls.length;
    window.dispatchEvent(new Event('pagehide'));
    expect(speech.cancel.mock.calls.length).toBeGreaterThan(beforeCount);
  });

  it('cancels speech on beforeunload as well (Firefox compat fallback)', () => {
    setup();
    const speech = globalThis.speechSynthesis as unknown as {
      cancel: { mock: { calls: unknown[] } };
    };
    const beforeCount = speech.cancel.mock.calls.length;
    window.dispatchEvent(new Event('beforeunload'));
    expect(speech.cancel.mock.calls.length).toBeGreaterThan(beforeCount);
  });
});
