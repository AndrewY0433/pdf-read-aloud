import { RATE_STEP } from '../speech/playback';
import { setActiveHighlights } from '../pdf/renderPages';
import type { EngineId } from '../speech/playback';
import type { AppContext } from './context';
import {
  bumpSpeed,
  syncChrome,
  syncEngineToggle,
  syncVoiceSelect,
  setError,
} from './chrome';
import {
  disableAutoScroll,
  scrollToWord,
  updateFollowArrow,
} from './scrollFollow';
import { onResize, prewarmSpeech, wirePdfFile } from './pdfLifecycle';

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function startPlayback(ctx: AppContext, fromBeginning: boolean): void {
  if (!ctx.pdf || ctx.pdf.words.length === 0) return;
  if (fromBeginning) ctx.autoScroll = true;
  ctx.session.play(fromBeginning);
  if (fromBeginning) {
    setActiveHighlights(ctx.pdf.pages, 0, ctx.pdf.words);
  }
  ctx.state = 'playing';
  syncChrome(ctx);
}

function pausePlayback(ctx: AppContext): void {
  ctx.session.pause();
  ctx.state = 'paused';
  syncChrome(ctx);
}

function togglePlayPause(ctx: AppContext): void {
  if (!ctx.pdf || ctx.pdf.words.length === 0) return;
  if (ctx.state === 'playing') pausePlayback(ctx);
  else startPlayback(ctx, ctx.state === 'idle');
}

export function wireEvents(ctx: AppContext): () => void {
  const {
    fileInput,
    pickBtn,
    playBtn,
    pauseBtn,
    speedDownBtn,
    speedUpBtn,
    voiceSelect,
    engineToggleEls,
    viewerInner,
    followBtn,
    viewer,
  } = ctx.shell;

  const onFileChange = (): void => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) wirePdfFile(ctx, f);
  };

  const onPick = (): void => fileInput.click();

  const onPlay = (): void => startPlayback(ctx, ctx.state === 'idle');

  const onPause = (): void => pausePlayback(ctx);

  const onSpeedDown = (): void => bumpSpeed(ctx, -RATE_STEP);

  const onSpeedUp = (): void => bumpSpeed(ctx, RATE_STEP);

  const onVoiceChange = (): void => {
    ctx.session.setVoiceId(voiceSelect.value);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingTarget(e.target)) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      togglePlayPause(ctx);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      bumpSpeed(ctx, -RATE_STEP);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      bumpSpeed(ctx, RATE_STEP);
    }
  };

  for (const btn of engineToggleEls) {
    btn.addEventListener('click', () => {
      const next = btn.dataset.engine as EngineId | undefined;
      if (!next || next === ctx.session.getEngineId()) return;
      const wasPlaying = ctx.state === 'playing' || ctx.state === 'paused';
      ctx.session.setEngine(next);
      ctx.state = 'idle';
      ctx.engineStatus = null;
      syncEngineToggle(ctx);
      syncVoiceSelect(ctx);
      syncChrome(ctx);
      if (next === 'kokoro') prewarmSpeech(ctx);
      if (wasPlaying && ctx.pdf) setActiveHighlights(ctx.pdf.pages, 0, ctx.pdf.words);
    });
  }

  const onWordClick = (e: Event): void => {
    if (!ctx.pdf || ctx.pdf.words.length === 0) return;
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('.word-highlight');
    if (!target) return;
    const idx = Number(target.dataset.wordIndex);
    if (!Number.isFinite(idx)) return;
    e.preventDefault();
    ctx.autoScroll = true;
    ctx.session.playFromWord(idx);
    ctx.state = 'playing';
    syncChrome(ctx);
    if (ctx.pdf) scrollToWord(ctx, ctx.pdf, idx);
  };

  const onFollow = (): void => {
    ctx.autoScroll = true;
    syncChrome(ctx);
    if (ctx.pdf) scrollToWord(ctx, ctx.pdf, ctx.currentWordIndex);
  };

  const onWheel = (): void => {
    if (ctx.state === 'playing' || ctx.state === 'paused') disableAutoScroll(ctx);
  };

  const onTouchMove = (): void => {
    if (ctx.state === 'playing' || ctx.state === 'paused') disableAutoScroll(ctx);
  };

  const onScroll = (): void => {
    if (!ctx.shell.followBtn.hidden) updateFollowArrow(ctx);
    if (ctx.state !== 'playing' && ctx.state !== 'paused') return;
    if (performance.now() < ctx.scrollSuppressUntil) return;
    disableAutoScroll(ctx);
  };

  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    viewer.classList.add('drag');
  };

  const onDragLeave = (): void => viewer.classList.remove('drag');

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    viewer.classList.remove('drag');
    const f = e.dataTransfer?.files?.[0];
    if (!f) {
      setError(ctx, 'Please drop a PDF file.');
      return;
    }
    if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      wirePdfFile(ctx, f);
    } else {
      setError(ctx, 'Please drop a PDF file.');
    }
  };

  const onWindowResize = (): void => onResize(ctx);

  const cleanup = (): void => {
    try {
      ctx.loadCtrl?.abort();
      ctx.widthRenderCtrl?.abort();
      ctx.dprRenderCtrl?.abort();
      ctx.session.stop();
      ctx.session.dispose();
      ctx.pdf?.virtual.destroy();
    } catch {
      /* best-effort */
    }
  };

  fileInput.addEventListener('change', onFileChange);
  pickBtn.addEventListener('click', onPick);
  playBtn.addEventListener('click', onPlay);
  pauseBtn.addEventListener('click', onPause);
  speedDownBtn.addEventListener('click', onSpeedDown);
  speedUpBtn.addEventListener('click', onSpeedUp);
  voiceSelect.addEventListener('change', onVoiceChange);
  window.addEventListener('keydown', onKeyDown);
  viewerInner.addEventListener('click', onWordClick);
  followBtn.addEventListener('click', onFollow);
  viewer.addEventListener('wheel', onWheel, { passive: true });
  viewer.addEventListener('touchmove', onTouchMove, { passive: true });
  viewer.addEventListener('scroll', onScroll, { passive: true });
  viewer.addEventListener('dragover', onDragOver);
  viewer.addEventListener('dragleave', onDragLeave);
  viewer.addEventListener('drop', onDrop);
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);

  if (import.meta.hot) {
    import.meta.hot.dispose(cleanup);
    import.meta.hot.accept(() => {
      window.location.reload();
    });
  }

  return cleanup;
}
