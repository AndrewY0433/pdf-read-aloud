import type { LoadedPdf } from '../pdf/renderPages';
import type { AppContext } from './context';

export function syncFollowBtn(ctx: AppContext): void {
  const show =
    !ctx.autoScroll &&
    (ctx.state === 'playing' || ctx.state === 'paused') &&
    !!ctx.pdf &&
    ctx.pdf.words.length > 0;
  ctx.shell.followBtn.hidden = !show;
  if (show) updateFollowArrow(ctx);
}

export function updateFollowArrow(ctx: AppContext): void {
  const { followBtn, viewer } = ctx.shell;
  if (!ctx.pdf || followBtn.hidden) return;
  const w = ctx.pdf.words[ctx.currentWordIndex];
  if (!w) return;
  const page = ctx.pdf.pages[w.pageIndex];
  if (!page) return;

  const viewRect = viewer.getBoundingClientRect();
  const wordEl = page.root.querySelector<HTMLElement>(
    `.word-highlight[data-word-index="${CSS.escape(String(ctx.currentWordIndex))}"]`,
  );
  const targetRect = wordEl?.getBoundingClientRect() ?? page.root.getBoundingClientRect();

  const readingAbove = targetRect.bottom < viewRect.top;
  followBtn.textContent = readingAbove ? '↑' : '↓';
  followBtn.classList.toggle('at-top', readingAbove);
}

export function disableAutoScroll(ctx: AppContext): void {
  if (!ctx.autoScroll) return;
  ctx.autoScroll = false;
  syncFollowBtn(ctx);
}

export function scrollToWord(ctx: AppContext, loaded: LoadedPdf, wordIndex: number): void {
  if (!ctx.autoScroll) return;
  const w = loaded.words[wordIndex];
  if (!w) return;
  const page = loaded.pages[w.pageIndex];
  if (!page) return;
  const el = page.root.querySelector<HTMLElement>(
    `.word-highlight[data-word-index="${CSS.escape(String(wordIndex))}"]`,
  );
  if (!el) return;

  const viewRect = ctx.shell.viewer.getBoundingClientRect();
  const wordRect = el.getBoundingClientRect();
  const wordCenter = wordRect.top + wordRect.height / 2;
  const viewCenter = viewRect.top + viewRect.height / 2;
  // Only scroll when the word drifts outside the middle third of the viewport.
  const deadZone = viewRect.height * 0.17;
  if (Math.abs(wordCenter - viewCenter) <= deadZone) return;

  ctx.scrollSuppressUntil = performance.now() + 150;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
}
