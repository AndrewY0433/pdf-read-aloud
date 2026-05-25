import { syncProgressBar } from '../progressBar';
import {
  formatRate,
  RATE_MIN,
  RATE_MAX,
  type EngineId,
} from '../speech/playback';
import { populateVoiceSelect } from '../speech/voices';
import type { AppContext } from './context';
import { syncFollowBtn } from './scrollFollow';

const ENGINE_LABEL: Record<EngineId, string> = {
  kokoro: 'Neural (Kokoro)',
  'web-speech': 'Browser',
};

export function setError(ctx: AppContext, msg: string | null): void {
  const { errEl } = ctx.shell;
  if (!msg) {
    errEl.hidden = true;
    errEl.textContent = '';
    return;
  }
  errEl.hidden = false;
  errEl.textContent = msg;
}

export function syncVoiceSelect(ctx: AppContext): void {
  const { voiceSelect } = ctx.shell;
  populateVoiceSelect(voiceSelect, ctx.session.listVoices(), ctx.session.getVoiceId());
}

export function syncEngineToggle(ctx: AppContext): void {
  const active = ctx.session.getEngineId();
  for (const btn of ctx.shell.engineToggleEls) {
    btn.classList.toggle('active', btn.dataset.engine === active);
    btn.setAttribute('aria-pressed', btn.dataset.engine === active ? 'true' : 'false');
  }
}

export function syncSpeed(ctx: AppContext): void {
  const rate = ctx.session.getRate();
  ctx.shell.speedValueEl.textContent = formatRate(rate);
  ctx.shell.speedDownBtn.disabled = rate <= RATE_MIN + 1e-6;
  ctx.shell.speedUpBtn.disabled = rate >= RATE_MAX - 1e-6;
}

export function syncChrome(ctx: AppContext): void {
  const { playBtn, pauseBtn, filenameEl, statusEl } = ctx.shell;
  playBtn.disabled = !ctx.pdf || ctx.pdf.words.length === 0;
  pauseBtn.disabled = ctx.state !== 'playing';
  filenameEl.textContent = ctx.pdf?.fileName ?? '';
  const engineLabel = ENGINE_LABEL[ctx.session.getEngineId()];
  const stateLabel =
    !ctx.pdf
      ? ''
      : ctx.pdf.words.length === 0
        ? 'No selectable text in this PDF.'
        : ctx.state === 'playing'
          ? 'Playing'
          : ctx.state === 'paused'
            ? 'Paused'
            : `Ready · ${engineLabel}`;
  statusEl.textContent = ctx.engineStatus ?? stateLabel;
  syncProgressBar(ctx.progressBar, ctx.pdf, ctx.currentWordIndex);
  syncFollowBtn(ctx);
}

export function bumpSpeed(ctx: AppContext, delta: number): void {
  ctx.session.bumpRate(delta);
  syncSpeed(ctx);
}
