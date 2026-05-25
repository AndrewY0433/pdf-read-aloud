import './styles.css';
import { ReadAloudSession } from './speech/playback';
import { syncProgressBar } from './progressBar';
import { setActiveHighlights } from './pdf/renderPages';
import { createAppContext } from './app/context';
import { createAppShell } from './app/shell';
import {
  syncChrome,
  syncEngineToggle,
  syncSpeed,
  syncVoiceSelect,
} from './app/chrome';
import { scrollToWord, updateFollowArrow } from './app/scrollFollow';
import { wireEvents } from './app/events';

export function mount(root: HTMLElement): void {
  const shell = createAppShell(root);
  const ctx = createAppContext(shell, shell.progressBar);

  ctx.session = new ReadAloudSession([], '', {
    onWordIndex: (i) => {
      ctx.currentWordIndex = i;
      syncProgressBar(ctx.progressBar, ctx.pdf, i);
      if (!ctx.pdf) return;
      void (async () => {
        const w = ctx.pdf!.words[i];
        if (w) await ctx.pdf!.virtual.ensurePageRendered(w.pageIndex);
        if (!ctx.pdf) return;
        setActiveHighlights(ctx.pdf.pages, i, ctx.pdf.words);
        scrollToWord(ctx, ctx.pdf, i);
        if (!ctx.autoScroll) updateFollowArrow(ctx);
      })();
    },
    onIdle: () => {
      ctx.state = 'idle';
      syncChrome(ctx);
    },
    onStatus: (msg) => {
      ctx.engineStatus = msg;
      syncChrome(ctx);
    },
    onVoicesChanged: () => {
      syncVoiceSelect(ctx);
    },
    onEngineReady: () => {
      syncVoiceSelect(ctx);
    },
  });

  syncEngineToggle(ctx);
  syncSpeed(ctx);
  syncVoiceSelect(ctx);
  wireEvents(ctx);

  if (ctx.session.getEngineId() === 'kokoro') {
    void ctx.session.prepare().catch(() => {});
  }

  syncChrome(ctx);
}
