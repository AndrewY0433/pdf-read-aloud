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
  // Bumped every time we kick off a (re-)render; awaited workers compare
  // against this so a newer request can abandon the stale one safely.
  let renderEpoch = 0;
  let lastInnerWidth = window.innerWidth;
  let lastDpr = window.devicePixelRatio || 1;
  let widthRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let dprRenderTimer: ReturnType<typeof setTimeout> | null = null;

  const shell = document.createElement('div');
  shell.className = 'shell';

  const errEl = document.createElement('div');
  errEl.className = 'error-banner';
  errEl.hidden = true;

  const viewer = document.createElement('div');
  viewer.className = 'viewer';

  const viewerInner = document.createElement('div');
  viewerInner.className = 'viewer-inner';
  viewer.append(viewerInner);

  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.innerHTML = `
    <div class="card">
      <h1>PDF read-aloud</h1>
      <p>Drag a PDF here or choose a file. Text-only PDFs work best; scanned pages need OCR (not in this version).</p>
      <label class="btn">Choose PDF<input type="file" accept="application/pdf,.pdf" /></label>
    </div>
  `;

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

  shell.append(errEl, viewer, bar);
  viewer.append(overlay);
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
      setActiveHighlights(pdf.pages, i, pdf.words);
      scrollToWord(pdf, i);
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
  }

  function scrollToWord(loaded: LoadedPdf, wordIndex: number): void {
    const w = loaded.words[wordIndex];
    if (!w) return;
    const page = loaded.pages[w.pageIndex];
    if (!page) return;
    const el = page.root.querySelector<HTMLElement>(`.word-highlight[data-word-index="${CSS.escape(String(wordIndex))}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function applyBuffer(next: LoadedBuffer): Promise<void> {
    const epoch = ++renderEpoch;
    session.stop();
    currentWordIndex = 0;
    setError(null);
    overlay.style.display = 'none';
    statusEl.textContent = 'Loading…';
    const previousDoc = pdf?.doc ?? null;
    try {
      const loaded = await loadAndRenderPdf(next.buffer, next.fileName, viewerInner);
      if (epoch !== renderEpoch) return;
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
      if (epoch !== renderEpoch) return;
      pdf = null;
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not open PDF: ${msg}`);
      viewerInner.replaceChildren();
      overlay.style.display = '';
    }
    state = 'idle';
    syncChrome();
  }

  /**
   * Re-layout every page at the current viewer width while preserving
   * playback state, scroll position, and the active-word highlight. Used
   * when the container width changes (window resize, sidebar toggle, etc.).
   */
  async function rerenderForWidth(): Promise<void> {
    if (!pdf) return;
    const epoch = ++renderEpoch;
    const doc = pdf.doc;
    const fileName = pdf.fileName;
    const wasPlaying = state === 'playing';
    const scrollRatio = viewer.scrollHeight > 0 ? viewer.scrollTop / viewer.scrollHeight : 0;
    try {
      const reloaded = await renderPdfPages(doc, fileName, viewerInner);
      if (epoch !== renderEpoch) return;
      pdf = reloaded;
      updateHighlightPositions(reloaded.pages, reloaded.words);
      // Re-attach the highlight to wherever playback has reached by now.
      const wordIdx = Math.min(currentWordIndex, Math.max(0, reloaded.words.length - 1));
      setActiveHighlights(reloaded.pages, reloaded.words.length === 0 ? null : wordIdx, reloaded.words);
      if (wasPlaying) {
        scrollToWord(reloaded, wordIdx);
      } else {
        viewer.scrollTop = scrollRatio * viewer.scrollHeight;
      }
    } catch (e) {
      if (epoch !== renderEpoch) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not re-render PDF: ${msg}`);
    }
  }

  /**
   * Cheap path for browser zoom: keep the existing layout (CSS handles the
   * visual scaling) and just re-rasterise each canvas at the new device
   * pixel ratio so glyphs stay crisp instead of upscaling blurrily.
   */
  async function rerasterizeForDpr(): Promise<void> {
    if (!pdf) return;
    const epoch = ++renderEpoch;
    try {
      await rerasterizePages(pdf.doc, pdf.pages);
      if (epoch !== renderEpoch) return;
    } catch {
      // Best-effort — if it fails, canvases stay at the old DPR and look
      // slightly blurry until the next resize. Not user-blocking.
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
    session.playFromWord(idx);
    state = 'playing';
    syncChrome();
  });

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

  // Warm up the neural model in the background if it's the user's preference,
  // so the first click on Play feels snappy.
  if (session.getEngineId() === 'kokoro') {
    void session.prepare().catch(() => {});
  }

  syncChrome();
}
