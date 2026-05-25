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
  sidebar: HTMLElement;
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

  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <header class="sidebar__header">
      <h1 class="sidebar__title">PDF read-aloud</h1>
      <span class="filename"></span>
      <span class="status"></span>
    </header>

    <section class="sidebar__section" aria-label="Playback">
      <h2 class="sidebar__label">Playback</h2>
      <div class="sidebar__transport">
        <button type="button" class="btn" data-act="play" title="Play (Space)" disabled>Play</button>
        <button type="button" class="btn secondary" data-act="pause" title="Pause (Space)" disabled>Pause</button>
      </div>
      <div class="speed-control" role="group" aria-label="Playback speed">
        <button type="button" class="speed-btn" data-act="speed-down" title="Slower (−${RATE_STEP}x, − key)" aria-label="Slower">&laquo;</button>
        <span class="speed-value" aria-live="polite">1.0x</span>
        <button type="button" class="speed-btn" data-act="speed-up" title="Faster (+${RATE_STEP}x, + key)" aria-label="Faster">&raquo;</button>
      </div>
    </section>

    <section class="sidebar__section" aria-label="Speech">
      <h2 class="sidebar__label">Speech</h2>
      <div class="engine-toggle" role="group" aria-label="Speech engine">
        <button type="button" class="toggle-btn" data-engine="kokoro" title="High-quality neural voice. ~85 MB model, cached locally.">Neural</button>
        <button type="button" class="toggle-btn" data-engine="web-speech" title="Built-in browser voices. Instant, lower quality.">Browser</button>
      </div>
      <label class="voice-control">
        <span class="voice-label">Voice</span>
        <select class="voice-select" aria-label="Voice"></select>
      </label>
    </section>

    <footer class="sidebar__footer">
      <button type="button" class="btn secondary sidebar__upload" data-act="pick" title="Open another PDF">Upload</button>
    </footer>
  `;

  const main = document.createElement('div');
  main.className = 'shell-main';

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
  main.append(errEl, viewerFrame);
  shell.append(sidebar, main);
  root.append(shell);

  return {
    shell,
    errEl,
    viewerFrame,
    viewer,
    viewerInner,
    followBtn,
    overlay,
    sidebar,
    fileInput: overlay.querySelector<HTMLInputElement>('input[type=file]')!,
    pickBtn: sidebar.querySelector<HTMLButtonElement>('[data-act=pick]')!,
    playBtn: sidebar.querySelector<HTMLButtonElement>('[data-act=play]')!,
    pauseBtn: sidebar.querySelector<HTMLButtonElement>('[data-act=pause]')!,
    filenameEl: sidebar.querySelector<HTMLSpanElement>('.filename')!,
    statusEl: sidebar.querySelector<HTMLSpanElement>('.status')!,
    engineToggleEls: sidebar.querySelectorAll<HTMLButtonElement>('.toggle-btn'),
    speedDownBtn: sidebar.querySelector<HTMLButtonElement>('[data-act=speed-down]')!,
    speedUpBtn: sidebar.querySelector<HTMLButtonElement>('[data-act=speed-up]')!,
    speedValueEl: sidebar.querySelector<HTMLSpanElement>('.speed-value')!,
    voiceSelect: sidebar.querySelector<HTMLSelectElement>('.voice-select')!,
    progressBar,
  };
}
