import type { RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { indentMore } from '@codemirror/commands';
import { closeCompletion, insertBracket } from '@codemirror/autocomplete';

export const KEYS: readonly string[] = [
  'Tab', '{', '}', '(', ')', ';', '*', '&', '"', "'", '[', ']', '<', '>', '=', '!', '\\',
];

/** Keys that go through closeBrackets' insertBracket (auto-pair / skip over a closer). */
const BRACKET_KEYS = new Set(['{', '}', '(', ')', '[', ']', '"', "'"]);

/** Applies one key-bar key to the editor. Exported for tests and for hardware fallbacks. */
export function pressKey(view: EditorView, key: string): void {
  closeCompletion(view);
  const { state } = view;
  if (key === 'Tab') {
    if (state.selection.ranges.some((r) => !r.empty)) indentMore(view);
    else view.dispatch(state.update(state.replaceSelection('\t'), { scrollIntoView: true, userEvent: 'input.type' }));
  } else {
    const tr = BRACKET_KEYS.has(key) ? insertBracket(state, key) : null;
    view.dispatch(tr ?? state.update(state.replaceSelection(key), { scrollIntoView: true, userEvent: 'input.type' }));
  }
  if (!view.hasFocus) view.focus();
}

// Keep focus (and the soft keyboard) in the editor: the button must never take focus.
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

export function KeyBar({ viewRef }: { viewRef: RefObject<EditorView | null> }) {
  return (
    <div className="keybar" role="toolbar" aria-label="C symbols">
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          tabIndex={-1}
          className={k === 'Tab' ? 'key key-wide' : 'key'}
          aria-label={k === 'Tab' ? 'Tab' : `Insert ${k}`}
          data-key={k}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => {
            const view = viewRef.current;
            if (view) pressKey(view, k);
          }}
        >
          {k === 'Tab' ? '⇥' : k}
        </button>
      ))}
    </div>
  );
}
