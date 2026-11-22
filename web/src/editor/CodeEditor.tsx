import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { autocompleteExt, buildExtensions, newCompartments, scrollMarginExt, wordsExt } from './setup.ts';
import { getBarHeight, subscribeBarHeight } from '../lib/bar.ts';

interface Props {
  /** Document the editor starts with. Read once, when the editor mounts. */
  initialDoc: string;
  words: readonly string[];
  autocomplete: boolean;
  onChange: (doc: string) => void;
  viewRef: RefObject<EditorView | null>;
}

/** CodeMirror 6 editor. Remount it (React `key`) to load another exercise. */
export function CodeEditor({ initialDoc, words, autocomplete, onChange, viewRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const compartments = useRef(newCompartments());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const barHeight = useSyncExternalStore(subscribeBarHeight, getBarHeight);

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialDoc,
        extensions: buildExtensions({
          words,
          autocomplete,
          barHeight: getBarHeight(),
          compartments: compartments.current,
          onDocChanged: (doc) => onChangeRef.current(doc),
        }),
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
    // The document is only read on mount; the other settings are reconfigured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.autocomplete.reconfigure(autocompleteExt(autocomplete)) });
  }, [autocomplete, viewRef]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.words.reconfigure(wordsExt(words)) });
  }, [words, viewRef]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.scrollMargin.reconfigure(scrollMarginExt(barHeight)) });
  }, [barHeight, viewRef]);

  return <div className="editor" ref={host} />;
}
