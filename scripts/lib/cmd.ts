// Converts one seed test command (tests/cases/<name>/NN.cmd) into an explicit argv array, once,
// at import time. The grader never runs a shell (DESIGN.md §5.1 tests[].argv), so this parser
// accepts only the small POSIX sh subset the seed uses and rejects anything that a shell would
// have expanded, so that a silently different argv can't slip through.
//
// Supported: words split on blanks; '…' (literal); "…" (backslash escapes only $ ` " \ and
// newline); backslash outside quotes; a trailing `| cat -e` (stripped, recorded as cat_e: the
// seed's .out is then cat -e rendered); `< file` stdin redirection (recorded as stdin_file).

export interface ParsedCmd {
  /** The program word as written, e.g. "./aff_a". */
  program: string;
  /** argv[1..]. */
  argv: string[];
  /** True when the command ended in `| cat -e`. */
  cat_e: boolean;
  /** Path from a `< file` redirection, as written, or null. */
  stdin_file: string | null;
}

export class CmdParseError extends Error {}

type Tok = { t: 'word'; v: string } | { t: 'op'; v: '|' | '<' };

const BLANK = new Set([' ', '\t', '\n']);
const UNSUPPORTED_OPS = new Set([';', '&', '>', '(', ')', '`']);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let word: string | null = null;
  const flush = () => {
    if (word !== null) toks.push({ t: 'word', v: word });
    word = null;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (BLANK.has(c)) { flush(); i++; continue; }
    if (c === '|' || c === '<') {
      flush();
      if (src[i + 1] === c || (c === '|' && src[i + 1] === '&')) {
        throw new CmdParseError(`unsupported operator ${c}${src[i + 1]}`);
      }
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (UNSUPPORTED_OPS.has(c)) throw new CmdParseError(`unsupported shell syntax: ${c}`);
    if (word === null && (c === '#' || c === '~')) {
      throw new CmdParseError(`unsupported shell syntax at word start: ${c}`);
    }
    if (c === '$') throw new CmdParseError('unsupported shell expansion: $');
    if (c === '*' || c === '?' || c === '[') {
      throw new CmdParseError(`unquoted glob character: ${c}`);
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new CmdParseError('unterminated single quote');
      word = (word ?? '') + src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let v = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new CmdParseError('unterminated double quote');
        const d = src[i]!;
        if (d === '"') { i++; break; }
        if (d === '\\') {
          const n = src[i + 1];
          if (n === undefined) throw new CmdParseError('unterminated double quote');
          if (n === '\n') { i += 2; continue; }
          if (n === '$' || n === '`' || n === '"' || n === '\\') { v += n; i += 2; continue; }
          v += '\\';
          i++;
          continue;
        }
        if (d === '`') throw new CmdParseError('unsupported command substitution');
        if (d === '$' && /[A-Za-z0-9_{(@*#?$!-]/.test(src[i + 1] ?? '')) {
          throw new CmdParseError('unsupported shell expansion inside double quotes');
        }
        v += d;
        i++;
      }
      word = (word ?? '') + v;
      continue;
    }
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) throw new CmdParseError('trailing backslash');
      if (n !== '\n') word = (word ?? '') + n;
      i += 2;
      continue;
    }
    word = (word ?? '') + c;
    i++;
  }
  flush();
  return toks;
}

/** Parses the contents of a .cmd file. A single trailing newline (the line end) is dropped. */
export function parseCmd(text: string): ParsedCmd {
  const src = text.endsWith('\n') ? text.slice(0, -1) : text;
  const toks = tokenize(src);
  let cat_e = false;
  // A trailing `| cat -e`.
  const n = toks.length;
  const pipeAt = toks.findIndex((t) => t.t === 'op' && t.v === '|');
  if (pipeAt >= 0) {
    const tail = toks.slice(pipeAt + 1);
    const ok = tail.length === 2 && tail[0]!.t === 'word' && tail[0]!.v === 'cat'
      && tail[1]!.t === 'word' && tail[1]!.v === '-e';
    if (!ok || pipeAt !== n - 3) throw new CmdParseError('only a trailing `| cat -e` pipe is supported');
    cat_e = true;
  }
  const main = pipeAt >= 0 ? toks.slice(0, pipeAt) : toks;
  let stdin_file: string | null = null;
  const words: string[] = [];
  for (let i = 0; i < main.length; i++) {
    const t = main[i]!;
    if (t.t === 'op') {
      // Only '<' can be left here.
      const f = main[i + 1];
      if (!f || f.t !== 'word') throw new CmdParseError('`<` without a file name');
      if (stdin_file !== null) throw new CmdParseError('more than one stdin redirection');
      stdin_file = f.v;
      i++;
      continue;
    }
    words.push(t.v);
  }
  const program = words.shift();
  if (program === undefined) throw new CmdParseError('empty command');
  return { program, argv: words, cat_e, stdin_file };
}
