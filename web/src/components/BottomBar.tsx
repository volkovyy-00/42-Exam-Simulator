import { useEffect, useRef, type ReactNode } from 'react';
import { setBarHeight } from '../lib/bar.ts';

/**
 * Fixed bottom bar (key bar + Grade). iOS Safari overlays the soft keyboard on the layout
 * viewport, so a plain `position: fixed; bottom: 0` ends up behind the keyboard. The bar is
 * re-anchored to the bottom of the visual viewport on visualViewport resize and scroll, and
 * after focus leaves an element (keyboard closing).
 */
export function BottomBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current!;
    const vv = window.visualViewport;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const offset = vv ? Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)) : 0;
        el.style.transform = offset > 0.5 ? `translate3d(0, ${-offset}px, 0)` : '';
      });
    };
    // The keyboard animates closed after focusout; check again once it has settled.
    const timers: number[] = [];
    const onFocusOut = () => {
      place();
      timers.push(window.setTimeout(place, 120), window.setTimeout(place, 400));
    };
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    document.addEventListener('focusout', onFocusOut);
    const ro = new ResizeObserver(() => setBarHeight(el.offsetHeight));
    ro.observe(el);
    setBarHeight(el.offsetHeight);
    place();
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach((t) => clearTimeout(t));
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      document.removeEventListener('focusout', onFocusOut);
      ro.disconnect();
      setBarHeight(0);
    };
  }, []);

  return (
    <div className="bottombar" ref={ref} data-testid="bottombar">
      {children}
    </div>
  );
}
