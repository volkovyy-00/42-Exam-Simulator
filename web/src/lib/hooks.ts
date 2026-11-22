import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTOCOMPLETE_OFF_KEY, load, save } from './storage.ts';

/** Ticks every second; returns Date.now(). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** "Practice without autocomplete" toggle, remembered per browser. */
export function useAutocompleteSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => load(AUTOCOMPLETE_OFF_KEY) !== '1');
  const set = useCallback((v: boolean) => {
    setOn(v);
    save(AUTOCOMPLETE_OFF_KEY, v ? null : '1');
  }, []);
  return [on, set];
}

/**
 * Draft autosave under `key`: returns the stored draft (read once per key) and a change
 * handler. Writes are debounced and flushed on unmount and on pagehide.
 */
export function useDraft(key: string): { initial: string; onChange: (doc: string) => void; current: () => string } {
  const latest = useRef<{ key: string; doc: string } | null>(null);
  const [initial] = useState(() => new Map<string, string>());
  if (!initial.has(key)) initial.set(key, load(key) ?? '');
  const timer = useRef(0);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const l = latest.current;
    if (l) save(l.key, l.doc === '' ? null : l.doc);
  }, []);

  useEffect(() => {
    latest.current = { key, doc: initial.get(key) ?? '' };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [key, flush, initial]);

  const onChange = useCallback(
    (doc: string) => {
      latest.current = { key, doc };
      clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 400);
    },
    [key, flush],
  );

  return { initial: initial.get(key) ?? '', onChange, current: () => latest.current?.doc ?? '' };
}

export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
