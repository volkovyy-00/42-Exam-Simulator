import type { MouseEvent, PointerEvent, TouchEvent } from 'react';

/**
 * Event handlers for a button that must never take focus (the key bar keys, Grade, grademe):
 * the editor keeps focus and the soft keyboard stays open.
 *
 * pointerdown and mousedown are preventDefault()ed so focus stays in `.cm-content`. On WebKit
 * (iOS, and Playwright's WebKit) a touch whose pointerdown was preventDefault()ed may then fire
 * no click at all, so for touch and pen the action runs on pointerup instead, if the pointer
 * stayed within TAP_SLOP_PX of where it went down. The click that may still follow (Chromium,
 * older WebKit) is cancelled by preventDefault() on touchend; without that, a tap that opens a
 * dialog (grademe) has its click land on the new dialog's backdrop and close it again. As a
 * backstop, a click on the same button within GHOST_CLICK_MS of the tap is ignored. One tap acts
 * exactly once. Mouse and keyboard keep using click.
 */
export const TAP_SLOP_PX = 10;
export const GHOST_CLICK_MS = 500;

interface TapState {
  pointerId: number | null;
  x: number;
  y: number;
  moved: boolean;
  firedAt: number;
}

// Per element, so the state survives re-renders between pointerdown and pointerup.
const states = new WeakMap<Element, TapState>();

function stateOf(el: Element): TapState {
  let s = states.get(el);
  if (!s) {
    s = { pointerId: null, x: 0, y: 0, moved: false, firedAt: -Infinity };
    states.set(el, s);
  }
  return s;
}

const isTouchLike = (e: PointerEvent) => e.pointerType === 'touch' || e.pointerType === 'pen';
const isDisabled = (el: Element) => (el as HTMLButtonElement).disabled === true;

export interface TapHandlers<T extends HTMLElement> {
  onPointerDown: (e: PointerEvent<T>) => void;
  onPointerMove: (e: PointerEvent<T>) => void;
  onPointerUp: (e: PointerEvent<T>) => void;
  onPointerCancel: (e: PointerEvent<T>) => void;
  onTouchEnd: (e: TouchEvent<T>) => void;
  onMouseDown: (e: MouseEvent<T>) => void;
  onClick: (e: MouseEvent<T>) => void;
}

export function tapHandlers<T extends HTMLElement = HTMLButtonElement>(action: () => void): TapHandlers<T> {
  return {
    onPointerDown(e) {
      e.preventDefault();
      if (!isTouchLike(e)) return;
      const s = stateOf(e.currentTarget);
      s.pointerId = e.pointerId;
      s.x = e.clientX;
      s.y = e.clientY;
      s.moved = false;
    },
    onPointerMove(e) {
      const s = states.get(e.currentTarget);
      if (!s || s.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_SLOP_PX) s.moved = true;
    },
    onPointerUp(e) {
      const s = states.get(e.currentTarget);
      if (!s || s.pointerId !== e.pointerId || !isTouchLike(e)) return;
      s.pointerId = null;
      if (s.moved || Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_SLOP_PX) return;
      if (isDisabled(e.currentTarget)) return;
      s.firedAt = performance.now();
      action();
    },
    onPointerCancel(e) {
      const s = states.get(e.currentTarget);
      if (s && s.pointerId === e.pointerId) s.pointerId = null;
    },
    onTouchEnd(e) {
      // pointerup came first; if it acted, cancel the compatibility mouse events and click.
      const s = states.get(e.currentTarget);
      if (s && performance.now() - s.firedAt < GHOST_CLICK_MS && e.cancelable) e.preventDefault();
    },
    onMouseDown(e) {
      e.preventDefault();
    },
    onClick(e) {
      const s = states.get(e.currentTarget);
      if (s && performance.now() - s.firedAt < GHOST_CLICK_MS) return;
      action();
    },
  };
}
