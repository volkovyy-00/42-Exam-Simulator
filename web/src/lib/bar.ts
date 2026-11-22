// Height of the fixed bottom bar, shared with the editor (cursorScrollMargin) and the layout.

let height = 0;
const listeners = new Set<() => void>();

export function getBarHeight(): number {
  return height;
}

export function setBarHeight(h: number): void {
  if (h === height) return;
  height = h;
  document.documentElement.style.setProperty('--bar-h', `${h}px`);
  for (const l of listeners) l();
}

export function subscribeBarHeight(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
