import {
  loadAndRenderPdf,
  renderPdfPages,
  rerasterizePages,
  updateHighlightPositions,
  setActiveHighlights,
} from '../pdf/renderPages';
import type { AppContext, LoadedBuffer } from './context';
import { setError, syncChrome } from './chrome';
import { scrollToWord, updateFollowArrow } from './scrollFollow';

export function prewarmSpeech(ctx: AppContext): void {
  if (ctx.session.getEngineId() === 'kokoro' && ctx.pdf && ctx.pdf.words.length > 0) {
    void ctx.session.prewarmFrom(0).catch(() => {});
  }
}

export function wirePdfFile(ctx: AppContext, file: File): void {
  void file.arrayBuffer().then((ab) => {
    void applyBuffer(ctx, { buffer: ab.slice(0), fileName: file.name });
  });
}

export async function applyBuffer(ctx: AppContext, next: LoadedBuffer): Promise<void> {
  const { overlay, statusEl, viewer, viewerInner } = ctx.shell;

  // A brand-new PDF supersedes everything in flight.
  ctx.loadCtrl?.abort();
  ctx.widthRenderCtrl?.abort();
  ctx.dprRenderCtrl?.abort();
  const ctrl = new AbortController();
  ctx.loadCtrl = ctrl;

  ctx.session.stop();
  ctx.currentWordIndex = 0;
  ctx.autoScroll = true;
  setError(ctx, null);
  statusEl.textContent = 'Loading…';
  const previousDoc = ctx.pdf?.doc ?? null;
  const previousVirtual = ctx.pdf?.virtual ?? null;
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
      ctx.pdf = loaded;
      setError(
        ctx,
        'No selectable text was found. This app does not run OCR on scanned or image-only PDFs.',
      );
      updateHighlightPositions(loaded.pages, []);
      setActiveHighlights(loaded.pages, null, []);
    } else {
      ctx.pdf = loaded;
      ctx.session.setContent(loaded.words, loaded.speakText);
      updateHighlightPositions(loaded.pages, loaded.words);
      setActiveHighlights(loaded.pages, 0, loaded.words);
      setError(ctx, null);
      prewarmSpeech(ctx);
    }
  } catch (e) {
    if (ctrl.signal.aborted) return;
    ctx.pdf = null;
    const msg = e instanceof Error ? e.message : String(e);
    setError(ctx, `Could not open PDF: ${msg}`);
    viewerInner.replaceChildren();
    overlay.style.display = '';
  } finally {
    if (ctx.loadCtrl === ctrl) ctx.loadCtrl = null;
  }
  ctx.state = 'idle';
  syncChrome(ctx);
}

/**
 * Re-layout every page at the current viewer width while preserving
 * playback state, scroll position, and the active-word highlight.
 */
export async function rerenderForWidth(ctx: AppContext): Promise<void> {
  if (!ctx.pdf) return;
  ctx.widthRenderCtrl?.abort();
  const ctrl = new AbortController();
  ctx.widthRenderCtrl = ctrl;

  const doc = ctx.pdf.doc;
  const fileName = ctx.pdf.fileName;
  const wasPlaying = ctx.state === 'playing';
  const scrollRatio =
    ctx.shell.viewer.scrollHeight > 0
      ? ctx.shell.viewer.scrollTop / ctx.shell.viewer.scrollHeight
      : 0;
  try {
    const reloaded = await renderPdfPages(doc, fileName, ctx.shell.viewer, {
      signal: ctrl.signal,
      existing: ctx.pdf,
    });
    if (ctrl.signal.aborted) return;
    ctx.pdf = reloaded;
    updateHighlightPositions(reloaded.pages, reloaded.words);
    const wordIdx = Math.min(ctx.currentWordIndex, Math.max(0, reloaded.words.length - 1));
    setActiveHighlights(
      reloaded.pages,
      reloaded.words.length === 0 ? null : wordIdx,
      reloaded.words,
    );
    if (wasPlaying) {
      scrollToWord(ctx, reloaded, wordIdx);
    } else {
      ctx.shell.viewer.scrollTop = scrollRatio * ctx.shell.viewer.scrollHeight;
    }
  } catch (e) {
    if (ctrl.signal.aborted || (e as Error | null)?.name === 'AbortError') return;
    const msg = e instanceof Error ? e.message : String(e);
    setError(ctx, `Could not re-render PDF: ${msg}`);
  } finally {
    if (ctx.widthRenderCtrl === ctrl) ctx.widthRenderCtrl = null;
  }
}

/**
 * Cheap path for browser zoom / DPR change. Each page is re-rendered into
 * a detached canvas and swapped in only after `render()` resolves.
 */
export async function rerasterizeForDpr(ctx: AppContext): Promise<void> {
  if (!ctx.pdf) return;
  ctx.dprRenderCtrl?.abort();
  const ctrl = new AbortController();
  ctx.dprRenderCtrl = ctrl;
  try {
    await rerasterizePages(ctx.pdf.doc, ctx.pdf.pages, {
      signal: ctrl.signal,
      virtual: ctx.pdf.virtual,
    });
  } catch (e) {
    if (ctrl.signal.aborted || (e as Error | null)?.name === 'AbortError') return;
    console.warn('rerasterize failed', e);
  } finally {
    if (ctx.dprRenderCtrl === ctrl) ctx.dprRenderCtrl = null;
  }
}

export function onResize(ctx: AppContext): void {
  const newDpr = window.devicePixelRatio || 1;
  const newWidth = window.innerWidth;
  const dprChanged = Math.abs(newDpr - ctx.lastDpr) > 0.005;
  const widthChanged = newWidth !== ctx.lastInnerWidth;
  ctx.lastDpr = newDpr;
  ctx.lastInnerWidth = newWidth;
  if (!ctx.pdf) return;

  if (dprChanged) {
    if (ctx.dprRenderTimer) clearTimeout(ctx.dprRenderTimer);
    ctx.dprRenderTimer = setTimeout(() => {
      ctx.dprRenderTimer = null;
      void rerasterizeForDpr(ctx);
    }, 250);
    return;
  }

  if (widthChanged) {
    if (ctx.widthRenderTimer) clearTimeout(ctx.widthRenderTimer);
    ctx.widthRenderTimer = setTimeout(() => {
      ctx.widthRenderTimer = null;
      void rerenderForWidth(ctx);
    }, 200);
  }
  if (!ctx.shell.followBtn.hidden) updateFollowArrow(ctx);
}
