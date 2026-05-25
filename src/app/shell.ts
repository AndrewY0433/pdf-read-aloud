import { RATE_STEP } from '../speech/playback';
import { createProgressBar, type ProgressBar } from '../progressBar';

export type AppShell = {
  shell: HTMLElement;
  errEl: HTMLElement;
  viewerFrame: HTMLElement;
  viewer: HTMLElement;
  viewerInner: HTMLElement;
  followBtn: HTMLButtonElement;
  overlay: HTMLElement;
  bar: HTMLElement;
  fileInput: HTMLInputElement;
  pickBtn: HTMLButtonElement;
  playBtn: HTMLButtonElement;
  pauseBtn: HTMLButtonElement;
  filenameEl: HTMLSpanElement;
  statusEl: HTMLSpanElement;
  engineToggleEls: NodeListOf<HTMLButtonElement>;
  speedDownBtn: HTMLButtonElement;
  speedUpBtn: HTMLButtonElement;
  speedValueEl: HTMLSpanElement;
  voiceSelect: HTMLSelectElement;
  progressBar: ProgressBar;
};

export function createAppShell(root: HTMLElement): AppShell {
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

  const progressBar = createProgressBar();

  viewerFrame.append(viewer, progressBar.root, followBtn, overlay);

  const bar = document.createElement('div');
  bar.className = 'bottom-bar';
  bar.innerHTML = `
    <span class="filename"></span>
    <span class="status"></span>
    <div class="speed-control" role="group" aria-label="Playback speed">
      <button type="button" class="speed-btn" data-act="speed-down" title="Slower (−${RATE_STEP}x, − key)" aria-label="Slower">&laquo;</button>
      <span class="speed-value" aria-live="polite">1.0x</span>
      <button type="button" class="speed-btn" data-act="speed-up" title="Faster (+${RATE_STEP}x, + key)" aria-label="Faster">&raquo;</button>
    </div>
    <div class="engine-toggle" role="group" aria-label="Speech engine">
      <button type="button" class="toggle-btn" data-engine="kokoro" title="High-quality neural voice. ~85 MB model, cached locally.">Neural</button>
      <button type="button" class="toggle-btn" data-engine="web-speech" title="Built-in browser voices. Instant, lower quality.">Browser</button>
    </div>
    <label class="voice-control">
      <span class="voice-label">Voice</span>
      <select class="voice-select" aria-label="Voice"></select>
    </label>
    <button type="button" class="btn secondary" data-act="pick" title="Open another PDF">Upload</button>
    <button type="button" class="btn" data-act="play" title="Play (Space)" disabled>Play</button>
    <button type="button" class="btn secondary" data-act="pause" title="Pause (Space)" disabled>Pause</button>
  `;

  shell.append(errEl, viewerFrame, bar);
  root.append(shell);

  return {
    shell,
    errEl,
    viewerFrame,
    viewer,
    viewerInner,
    followBtn,
    overlay,
    bar,
    fileInput: overlay.querySelector<HTMLInputElement>('input[type=file]')!,
    pickBtn: bar.querySelector<HTMLButtonElement>('[data-act=pick]')!,
    playBtn: bar.querySelector<HTMLButtonElement>('[data-act=play]')!,
    pauseBtn: bar.querySelector<HTMLButtonElement>('[data-act=pause]')!,
    filenameEl: bar.querySelector<HTMLSpanElement>('.filename')!,
    statusEl: bar.querySelector<HTMLSpanElement>('.status')!,
    engineToggleEls: bar.querySelectorAll<HTMLButtonElement>('.toggle-btn'),
    speedDownBtn: bar.querySelector<HTMLButtonElement>('[data-act=speed-down]')!,
    speedUpBtn: bar.querySelector<HTMLButtonElement>('[data-act=speed-up]')!,
    speedValueEl: bar.querySelector<HTMLSpanElement>('.speed-value')!,
    voiceSelect: bar.querySelector<HTMLSelectElement>('.voice-select')!,
    progressBar,
  };
}
