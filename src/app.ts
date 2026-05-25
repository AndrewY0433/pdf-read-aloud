import './styles.css';
import {
  loadAndRenderPdf,
  renderPdfPages,
  rerasterizePages,
  updateHighlightPositions,
  setActiveHighlights,
  type LoadedPdf,
} from './pdf/renderPages';
import {
  ReadAloudSession,
  formatRate,
  RATE_MIN,
  RATE_MAX,
  RATE_STEP,
  type EngineId,
} from './speech/playback';
import type { AppState } from './types';

type LoadedBuffer = { buffer: ArrayBuffer; fileName: string };

const ENGINE_LABEL: Record<EngineId, string> = {
  kokoro: 'Neural (Kokoro)',
  'web-speech': 'Browser',
};

export function mount(root: HTMLElement): void {
  let pdf: LoadedPdf | null = null;
  let state: AppState = 'idle';
  let engineStatus: string | null = null;
  let currentWordIndex = 0;
  let lastInnerWidth = window.innerWidth;
  let lastDpr = window.devicePixelRatio || 1;
  let widthRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let dprRenderTimer: ReturnType<typeof setTimeout> | null = null;
  // Only ever ONE render of each flavour may be in flight; starting a new
  // one aborts the old. Atomic swap on the renderPages side means an aborted
  // render leaves the viewer untouched, so the user never sees half-state.
  let loadCtrl: AbortController | null = null;
  let widthRenderCtrl: AbortController | null = null;
  let dprRenderCtrl: AbortController | null = null;
  let autoScroll = true;
  let scrollSuppressUntil = 0;

  const shell = document.createElement('div');
  shell.className = 'shell';

  const errEl = document.createElement('div');
  errEl.className = 'error-banner';
  errEl.hidden = true;

  const viewerFrame = document.createElement('div');
  viewerFrame.className = 'viewer-frame';

  const viewer = document.createElement('div');
  viewer.className = 'viewer';

  const viewerInner = document.createElement('div');
  viewerInner.className = 'viewer-inner';
  viewer.append(viewerInner);

  const followBtn = document.createElement('button');
  followBtn.type = 'button';
  followBtn.className = 'follow-btn';
  followBtn.dataset.act = 'follow';
  followBtn.textContent = '↓';
  followBtn.title = 'Follow reading';
  followBtn.setAttribute('aria-label', 'Follow reading');
  followBtn.hidden = true;

  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.innerHTML = `
    <div class="card">
      <h1>PDF read-aloud</h1>
      <p>Drag a PDF here or choose a file. Text-only PDFs work best; scanned pages need OCR (not in this version).</p>
      <label class="btn">Choose PDF<input type="file" accept="application/pdf,.pdf" /></label>
    </div>
  `;

  viewerFrame.append(viewer, followBtn, overlay);

  const bar = document.createElement('div');
  bar.className = 'bottom-bar';
  bar.innerHTML = `
    <span class="filename"></span>
    <span class="status"></span>
    <div class="speed-control" role="group" aria-label="Playback speed">
      <button type="button" class="speed-btn" data-act="speed-down" title="Slower (-${RATE_STEP}x)" aria-label="Slower">&laquo;</button>
      <span class="speed-value" aria-live="polite">1.0x</span>
      <button type="button" class="speed-btn" data-act="speed-up" title="Faster (+${RATE_STEP}x)" aria-label="Faster">&raquo;</button>
    </div>
    <div class="engine-toggle" role="group" aria-label="Speech engine">
      <button type="button" class="toggle-btn" data-engine="kokoro" title="High-quality neural voice. ~85 MB model, cached locally.">Neural</button>
      <button type="button" class="toggle-btn" data-engine="web-speech" title="Built-in browser voices. Instant, lower quality.">Browser</button>
    </div>
    <button type="button" class="btn secondary" data-act="pick" title="Open another PDF">Upload</button>
    <button type="button" class="btn" data-act="play" disabled>Play</button>
    <button type="button" class="btn secondary" data-act="pause" disabled>Pause</button>
  `;

  shell.append(errEl, viewerFrame, bar);
  root.append(shell);

  const fileInput = overlay.querySelector<HTMLInputElement>('input[type=file]')!;
  const pickBtn = bar.querySelector<HTMLButtonElement>('[data-act=pick]')!;
  const playBtn = bar.querySelector<HTMLButtonElement>('[data-act=play]')!;
  const pauseBtn = bar.querySelector<HTMLButtonElement>('[data-act=pause]')!;
  const filenameEl = bar.querySelector<HTMLSpanElement>('.filename')!;
  const statusEl = bar.querySelector<HTMLSpanElement>('.status')!;
  const engineToggleEls = bar.querySelectorAll<HTMLButtonElement>('.toggle-btn');
  const speedDownBtn = bar.querySelector<HTMLButtonElement>('[data-act=speed-down]')!;
  const speedUpBtn = bar.querySelector<HTMLButtonElement>('[data-act=speed-up]')!;
  const speedValueEl = bar.querySelector<HTMLSpanElement>('.speed-value')!;

  const session = new ReadAloudSession([], '', {
    onWordIndex: (i) => {
      currentWordIndex = i;
      if (!pdf) return;
      void (async () => {
        const w = pdf!.words[i];
        if (w) await pdf!.virtual.ensurePageRendered(w.pageIndex);
        if (!pdf) return;
        setActiveHighlights(pdf.pages, i, pdf.words);
        scrollToWord(pdf, i);
        if (!autoScroll) updateFollowArrow();
      })();
    },
    onIdle: () => {
      state = 'idle';
      syncChrome();
    },
    onStatus: (msg) => {
      engineStatus = msg;
      syncChrome();
    },
  });

  syncEngineToggle();
  syncSpeed();

  function setError(msg: string | null): void {
    if (!msg) {
      errEl.hidden = true;
      errEl.textContent = '';
      return;
    }
    errEl.hidden = false;
    errEl.textContent = msg;
  }

  function syncEngineToggle(): void {
    const active = session.getEngineId();
    for (const btn of engineToggleEls) {
      btn.classList.toggle('active', btn.dataset.engine === active);
      btn.setAttribute('aria-pressed', btn.dataset.engine === active ? 'true' : 'false');
    }
  }

  function syncSpeed(): void {
    const rate = session.getRate();
    speedValueEl.textContent = formatRate(rate);
    speedDownBtn.disabled = rate <= RATE_MIN + 1e-6;
    speedUpBtn.disabled = rate >= RATE_MAX - 1e-6;
  }

  function syncFollowBtn(): void {
    const show =
      !autoScroll && (state === 'playing' || state === 'paused') && !!pdf && pdf.words.length > 0;
    followBtn.hidden = !show;
    if (show) updateFollowArrow();
  }

  function updateFollowArrow(): void {
    if (!pdf || followBtn.hidden) return;
    const w = pdf.words[currentWordIndex];
    if (!w) return;
    const page = pdf.pages[w.pageIndex];
    if (!page) return;

    const viewRect = viewer.getBoundingClientRect();
    const wordEl = page.root.querySelector<HTMLElement>(
      `.word-highlight[data-word-index="${CSS.escape(String(currentWordIndex))}"]`,
    );
    const targetRect = wordEl?.getBoundingClientRect() ?? page.root.getBoundingClientRect();

    const readingAbove = targetRect.bottom < viewRect.top;
    followBtn.textContent = readingAbove ? '↑' : '↓';
    followBtn.classList.toggle('at-top', readingAbove);
  }

  function syncChrome(): void {
    playBtn.disabled = !pdf || pdf.words.length === 0;
    pauseBtn.disabled = state !== 'playing';
    filenameEl.textContent = pdf?.fileName ?? '';
    const engineLabel = ENGINE_LABEL[session.getEngineId()];
    const stateLabel =
      !pdf
        ? ''
        : pdf.words.length === 0
        ? 'No selectable text in this PDF.'
        : state === 'playing'
        ? 'Playing'
        : state === 'paused'
        ? 'Paused'
        : `Ready · ${engineLabel}`;
    statusEl.textContent = engineStatus ?? stateLabel;
    syncFollowBtn();
  }

  function disableAutoScroll(): void {
    if (!autoScroll) return;
    autoScroll = false;
    syncFollowBtn();
  }

  function scrollToWord(loaded: LoadedPdf, wordIndex: number): void {
    if (!autoScroll) return;
    const w = loaded.words[wordIndex];
    if (!w) return;
    const page = loaded.pages[w.pageIndex];
    if (!page) return;
    const el = page.root.querySelector<HTMLElement>(
      `.word-highlight[data-word-index="${CSS.escape(String(wordIndex))}"]`,
    );
    if (!el) return;

    const viewRect = viewer.getBoundingClientRect();
    const wordRect = el.getBoundingClientRect();
    const wordCenter = wordRect.top + wordRect.height / 2;
    const viewCenter = viewRect.top + viewRect.height / 2;
    // Only scroll when the word drifts outside the middle third of the viewport.
    const deadZone = viewRect.height * 0.17;
    if (Math.abs(wordCenter - viewCenter) <= deadZone) return;

    scrollSuppressUntil = performance.now() + 150;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  async function applyBuffer(next: LoadedBuffer): Promise<void> {
    // A brand-new PDF supersedes everything in flight.
    loadCtrl?.abort();
    widthRenderCtrl?.abort();
    dprRenderCtrl?.abort();
    const ctrl = new AbortController();
    loadCtrl = ctrl;

    session.stop();
    currentWordIndex = 0;
    autoScroll = true;
    setError(null);
    statusEl.textContent = 'Loading…';
    const previousDoc = pdf?.doc ?? null;
    const previousVirtual = pdf?.virtual ?? null;
    try {
      const loaded = await loadAndRenderPdf(next.buffer, next.fileName, viewer, {
        signal: ctrl.signal,
        onShellsReady: () => {
          overlay.style.display = 'none';
        },
        onProgress: (msg) => {
          if (msg) statusEl.textContent = msg;
        },
      });
      if (ctrl.signal.aborted) return;
      previousVirtual?.destroy();
      if (previousDoc && previousDoc !== loaded.doc) {
        // Free the worker-side resources for the PDF we just replaced.
        void previousDoc.destroy().catch(() => {});
      }
      if (loaded.words.length === 0) {
        pdf = loaded;
        setError('No selectable text was found. This app does not run OCR on scanned or image-only PDFs.');
        updateHighlightPositions(loaded.pages, []);
        setActiveHighlights(loaded.pages, null, []);
      } else {
        pdf = loaded;
        session.setContent(loaded.words, loaded.speakText);
        updateHighlightPositions(loaded.pages, loaded.words);
        setActiveHighlights(loaded.pages, 0, loaded.words);
        setError(null);
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      pdf = null;
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not open PDF: ${msg}`);
      viewerInner.replaceChildren();
      overlay.style.display = '';
    } finally {
      if (loadCtrl === ctrl) loadCtrl = null;
    }
    state = 'idle';
    syncChrome();
  }

  /**
   * Re-layout every page at the current viewer width while preserving
   * playback state, scroll position, and the active-word highlight. Used
   * when the container width changes (window resize, sidebar toggle, etc.).
   *
   * The render itself is atomic (see `renderPdfPages`): if a second width
   * change interrupts us, we abort, the staging tree is discarded, and the
   * user keeps interacting with the previous fully-rendered layout.
   */
  async function rerenderForWidth(): Promise<void> {
    if (!pdf) return;
    widthRenderCtrl?.abort();
    const ctrl = new AbortController();
    widthRenderCtrl = ctrl;

    const doc = pdf.doc;
    const fileName = pdf.fileName;
    const wasPlaying = state === 'playing';
    const scrollRatio = viewer.scrollHeight > 0 ? viewer.scrollTop / viewer.scrollHeight : 0;
    try {
      const reloaded = await renderPdfPages(doc, fileName, viewer, {
        signal: ctrl.signal,
        existing: pdf,
      });
      if (ctrl.signal.aborted) return;
      pdf = reloaded;
      updateHighlightPositions(reloaded.pages, reloaded.words);
      const wordIdx = Math.min(currentWordIndex, Math.max(0, reloaded.words.length - 1));
      setActiveHighlights(
        reloaded.pages,
        reloaded.words.length === 0 ? null : wordIdx,
        reloaded.words,
      );
      if (wasPlaying) {
        scrollToWord(reloaded, wordIdx);
      } else {
        viewer.scrollTop = scrollRatio * viewer.scrollHeight;
      }
    } catch (e) {
      if (ctrl.signal.aborted || (e as Error | null)?.name === 'AbortError') return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not re-render PDF: ${msg}`);
    } finally {
      if (widthRenderCtrl === ctrl) widthRenderCtrl = null;
    }
  }

  /**
   * Cheap path for browser zoom / DPR change. Each page is re-rendered into
   * a detached canvas and swapped in only after `render()` resolves, so the
   * visible canvas never goes blank even if the render is aborted or fails.
   */
  async function rerasterizeForDpr(): Promise<void> {
    if (!pdf) return;
    dprRenderCtrl?.abort();
    const ctrl = new AbortController();
    dprRenderCtrl = ctrl;
    try {
      await rerasterizePages(pdf.doc, pdf.pages, { signal: ctrl.signal, virtual: pdf.virtual });
    } catch (e) {
      if (ctrl.signal.aborted || (e as Error | null)?.name === 'AbortError') return;
      console.warn('rerasterize failed', e);
    } finally {
      if (dprRenderCtrl === ctrl) dprRenderCtrl = null;
    }
  }

  function onResize(): void {
    const newDpr = window.devicePixelRatio || 1;
    const newWidth = window.innerWidth;
    const dprChanged = Math.abs(newDpr - lastDpr) > 0.005;
    const widthChanged = newWidth !== lastInnerWidth;
    lastDpr = newDpr;
    lastInnerWidth = newWidth;
    if (!pdf) return;

    if (dprChanged) {
      // Browser zoom. innerWidth shifts too because zoom remaps CSS pixels,
      // but we intentionally do NOT re-fit pages to that new width — that
      // would silently cancel the user's zoom. Just re-rasterise canvases.
      if (dprRenderTimer) clearTimeout(dprRenderTimer);
      dprRenderTimer = setTimeout(() => {
        dprRenderTimer = null;
        void rerasterizeForDpr();
      }, 250);
      return;
    }

    if (widthChanged) {
      if (widthRenderTimer) clearTimeout(widthRenderTimer);
      widthRenderTimer = setTimeout(() => {
        widthRenderTimer = null;
        void rerenderForWidth();
      }, 200);
    }
    if (!followBtn.hidden) updateFollowArrow();
  }

  function wirePdfFile(file: File): void {
    void file.arrayBuffer().then((ab) => {
      void applyBuffer({ buffer: ab.slice(0), fileName: file.name });
    });
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) wirePdfFile(f);
  });

  pickBtn.addEventListener('click', () => fileInput.click());

  playBtn.addEventListener('click', () => {
    if (!pdf || pdf.words.length === 0) return;
    const fromStart = state === 'idle';
    if (fromStart) autoScroll = true;
    session.play(fromStart);
    if (fromStart) {
      setActiveHighlights(pdf.pages, 0, pdf.words);
    }
    state = 'playing';
    syncChrome();
  });

  pauseBtn.addEventListener('click', () => {
    session.pause();
    state = 'paused';
    syncChrome();
  });

  speedDownBtn.addEventListener('click', () => {
    session.bumpRate(-RATE_STEP);
    syncSpeed();
  });

  speedUpBtn.addEventListener('click', () => {
    session.bumpRate(RATE_STEP);
    syncSpeed();
  });

  for (const btn of engineToggleEls) {
    btn.addEventListener('click', () => {
      const next = btn.dataset.engine as EngineId | undefined;
      if (!next || next === session.getEngineId()) return;
      const wasPlaying = state === 'playing' || state === 'paused';
      session.setEngine(next);
      state = 'idle';
      engineStatus = null;
      syncEngineToggle();
      syncChrome();
      // Kick off model warm-up so the first Play is responsive.
      if (next === 'kokoro') void session.prepare().catch(() => {});
      if (wasPlaying && pdf) setActiveHighlights(pdf.pages, 0, pdf.words);
    });
  }

  viewerInner.addEventListener('click', (e) => {
    if (!pdf || pdf.words.length === 0) return;
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('.word-highlight');
    if (!target) return;
    const idx = Number(target.dataset.wordIndex);
    if (!Number.isFinite(idx)) return;
    e.preventDefault();
    autoScroll = true;
    session.playFromWord(idx);
    state = 'playing';
    syncChrome();
    if (pdf) scrollToWord(pdf, idx);
  });

  followBtn.addEventListener('click', () => {
    autoScroll = true;
    syncFollowBtn();
    if (pdf) scrollToWord(pdf, currentWordIndex);
  });

  viewer.addEventListener(
    'wheel',
    () => {
      if (state === 'playing' || state === 'paused') disableAutoScroll();
    },
    { passive: true },
  );

  viewer.addEventListener(
    'touchmove',
    () => {
      if (state === 'playing' || state === 'paused') disableAutoScroll();
    },
    { passive: true },
  );

  viewer.addEventListener(
    'scroll',
    () => {
      if (!followBtn.hidden) updateFollowArrow();
      if (state !== 'playing' && state !== 'paused') return;
      if (performance.now() < scrollSuppressUntil) return;
      disableAutoScroll();
    },
    { passive: true },
  );

  viewer.addEventListener('dragover', (e) => {
    e.preventDefault();
    viewer.classList.add('drag');
  });
  viewer.addEventListener('dragleave', () => viewer.classList.remove('drag'));
  viewer.addEventListener('drop', (e) => {
    e.preventDefault();
    viewer.classList.remove('drag');
    const f = e.dataTransfer?.files?.[0];
    if (!f) {
      setError('Please drop a PDF file.');
      return;
    }
    if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      wirePdfFile(f);
    } else {
      setError('Please drop a PDF file.');
    }
  });

  window.addEventListener('resize', onResize);

  // Ensure the OS-level speechSynthesis queue is cancelled when the tab is
  // closed, reloaded, or hot-replaced. Without this, Web Speech keeps reading
  // queued utterances long after the JS context dies — exactly the "another
  // browser started reading from where I left off" symptom.
  const cleanup = (): void => {
    try {
      loadCtrl?.abort();
      widthRenderCtrl?.abort();
      dprRenderCtrl?.abort();
      session.stop();
      session.dispose();
      pdf?.virtual.destroy();
    } catch {
      /* best-effort */
    }
  };
  window.addEventListener('pagehide', cleanup);
  // `pagehide` doesn't fire reliably on some Firefox versions; belt and braces.
  window.addEventListener('beforeunload', cleanup);
  // Vite HMR triggers a full reload for files that don't accept HMR (which is
  // all of ours). Cancel speech BEFORE the new module instance ever runs.
  if (import.meta.hot) {
    import.meta.hot.dispose(cleanup);
    import.meta.hot.accept(() => {
      window.location.reload();
    });
  }

  // Warm up the neural model in the background if it's the user's preference,
  // so the first click on Play feels snappy.
  if (session.getEngineId() === 'kokoro') {
    void session.prepare().catch(() => {});
  }

  syncChrome();
}
