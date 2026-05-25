import type { LoadedPdf } from '../pdf/renderPages';
import type { ProgressBar } from '../progressBar';
import type { ReadAloudSession } from '../speech/playback';
import type { AppState } from '../types';
import type { AppShell } from './shell';

export type LoadedBuffer = { buffer: ArrayBuffer; fileName: string };

export type AppContext = {
  shell: AppShell;
  progressBar: ProgressBar;
  session: ReadAloudSession;

  pdf: LoadedPdf | null;
  state: AppState;
  engineStatus: string | null;
  currentWordIndex: number;
  autoScroll: boolean;
  scrollSuppressUntil: number;

  loadCtrl: AbortController | null;
  widthRenderCtrl: AbortController | null;
  dprRenderCtrl: AbortController | null;
  widthRenderTimer: ReturnType<typeof setTimeout> | null;
  dprRenderTimer: ReturnType<typeof setTimeout> | null;
  lastViewerWidth: number;
  lastDpr: number;
};

export function createAppContext(shell: AppShell, progressBar: ProgressBar): AppContext {
  return {
    shell,
    progressBar,
    session: null!,

    pdf: null,
    state: 'idle',
    engineStatus: null,
    currentWordIndex: 0,
    autoScroll: true,
    scrollSuppressUntil: 0,

    loadCtrl: null,
    widthRenderCtrl: null,
    dprRenderCtrl: null,
    widthRenderTimer: null,
    dprRenderTimer: null,
    lastViewerWidth: shell.viewer.clientWidth,
    lastDpr: window.devicePixelRatio || 1,
  };
}
