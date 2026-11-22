// CodeMirror 6 setup with explicit extensions (no basicSetup). Every extension the editor uses
// is listed in buildExtensions(); see TASKS.md WP4 item 1.
import { Compartment, EditorState, Facet, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  ifNotIn,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { load } from '../lib/storage.ts';

// Android EditContext escape hatch: localStorage cm_edit_context=off makes CodeMirror fall back
// to its contenteditable input path. Must run before the first EditorView is created.
// EDIT_CONTEXT is a static the view reads at construction; it is not in the .d.ts.
if (load('cm_edit_context') === 'off') {
  (EditorView as unknown as { EDIT_CONTEXT: boolean | null }).EDIT_CONTEXT = false;
}

/** Words for this exercise (`autocomplete_words`), provided per editor through a compartment. */
export const exerciseWords = Facet.define<readonly string[], readonly string[]>({
  combine: (values) => values.flat(),
});

export const C_KEYWORDS: readonly string[] = [
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict',
  'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
  'unsigned', 'void', 'volatile', 'while', 'NULL', 'include', 'define',
];

/** Syntax nodes (lezer-cpp) inside which no completion is offered. */
const NO_COMPLETION_IN: readonly string[] = [
  'String', 'RawString', 'CharLiteral', 'SystemLibString', 'Comment', 'LineComment', 'BlockComment',
];

const WORD_BEFORE = /[A-Za-z_]\w*$/;

const KEYWORD_OPTIONS: readonly Completion[] = C_KEYWORDS.map((label) => ({ label, type: 'keyword' }));

/** Exercise words + C keywords + every word already in the document, de-duplicated. */
const exerciseAndWordSource: CompletionSource = (ctx) => {
  const word = ctx.matchBefore(WORD_BEFORE);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const options: Completion[] = [];
  const seen = new Set<string>();
  const add = (o: Completion) => {
    if (seen.has(o.label)) return;
    seen.add(o.label);
    options.push(o);
  };
  for (const w of ctx.state.facet(exerciseWords)) add({ label: w, type: 'function', boost: 2 });
  for (const o of KEYWORD_OPTIONS) add(o);
  // completeAnyWord is synchronous; staying synchronous avoids a "pending" completion state
  // in which Enter would neither accept nor insert a newline.
  const any = completeAnyWord(ctx) as CompletionResult | null;
  if (any && !('then' in any) && any.from === word.from) {
    for (const o of any.options) if (o.label !== word.text) add(o);
  }
  return { from: word.from, options, validFor: /^\w*$/ };
};

/** Module-level constant: the only completion sources the editor ever uses. */
export const COMPLETION_SOURCES: readonly CompletionSource[] = [
  ifNotIn(NO_COMPLETION_IN, exerciseAndWordSource),
];

const AUTOCOMPLETE: Extension = autocompletion({
  override: [...COMPLETION_SOURCES],
  activateOnTyping: true,
  icons: false,
});

export interface EditorCompartments {
  autocomplete: Compartment;
  words: Compartment;
  scrollMargin: Compartment;
}

export function newCompartments(): EditorCompartments {
  return { autocomplete: new Compartment(), words: new Compartment(), scrollMargin: new Compartment() };
}

export const autocompleteExt = (on: boolean): Extension => (on ? AUTOCOMPLETE : []);
export const wordsExt = (words: readonly string[]): Extension => exerciseWords.of(words);
/** Keeps the caret above the fixed bottom bar: bar height + 8 px. */
export const scrollMarginExt = (barHeight: number): Extension =>
  EditorView.cursorScrollMargin.of({ x: 8, y: Math.round(barHeight) + 8 });

export interface BuildOptions {
  words: readonly string[];
  autocomplete: boolean;
  barHeight: number;
  compartments: EditorCompartments;
  onDocChanged: (doc: string) => void;
}

export function buildExtensions(o: BuildOptions): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    cpp(),
    indentUnit.of('\t'),
    EditorState.tabSize.of(4),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.contentAttributes.of({
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'enter',
      'aria-label': 'C source editor',
    }),
    o.compartments.autocomplete.of(autocompleteExt(o.autocomplete)),
    o.compartments.words.of(wordsExt(o.words)),
    o.compartments.scrollMargin.of(scrollMarginExt(o.barHeight)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) o.onDocChanged(u.state.doc.toString());
    }),
  ];
}
