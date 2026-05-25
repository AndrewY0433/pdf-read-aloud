import type { PageViewport } from 'pdfjs-dist';

export type AppState = 'idle' | 'playing' | 'paused';

export type WordEntity = {
  pageIndex: number;
  wordIndex: number;
  sentenceId: number;
  text: string;
  charStart: number;
  charEnd: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type RenderedPage = {
  pageIndex: number;
  root: HTMLDivElement;
  viewport: PageViewport;
};
