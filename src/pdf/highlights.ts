import type { RenderedPage, WordEntity } from '../types';

function paintWordTargets(layer: HTMLElement, list: WordEntity[]): void {
  layer.replaceChildren();
  for (const w of list) {
    const d = document.createElement('div');
    d.className = 'word-highlight';
    d.dataset.wordIndex = String(w.wordIndex);
    d.style.left = `${w.left}px`;
    d.style.top = `${w.top}px`;
    d.style.width = `${w.width}px`;
    d.style.height = `${w.height}px`;
    layer.append(d);
  }
}

export function updateHighlightPositionsForPage(page: RenderedPage, words: WordEntity[]): void {
  const layer = page.root.querySelector<HTMLElement>('.highlight-layer');
  if (!layer) return;
  const list = words.filter((w) => w.pageIndex === page.pageIndex);
  paintWordTargets(layer, list);
}

export function updateHighlightPositions(pages: RenderedPage[], words: WordEntity[]): void {
  for (const p of pages) {
    const layer = p.root.querySelector<HTMLElement>('.highlight-layer');
    if (!layer) continue;
    updateHighlightPositionsForPage(p, words);
  }
}

export function setActiveHighlights(
  pages: RenderedPage[],
  activeWordIndex: number | null,
  words: WordEntity[],
): void {
  for (const p of pages) {
    const layer = p.root.querySelector('.highlight-layer');
    if (!layer) continue;
    for (const el of layer.querySelectorAll('.word-highlight')) {
      el.classList.remove('active');
    }
  }

  if (activeWordIndex === null) return;
  const w = words[activeWordIndex];
  if (!w) return;

  const page = pages[w.pageIndex];
  if (!page) return;
  const layer = page.root.querySelector('.highlight-layer');
  if (!layer) return;

  layer.querySelector(`.word-highlight[data-word-index="${CSS.escape(String(activeWordIndex))}"]`)?.classList.add(
    'active',
  );
}
