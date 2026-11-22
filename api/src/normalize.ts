// Source normalization before the dispatcher (DESIGN.md §7).
import crypto from 'node:crypto';

export const MAX_SOURCE_BYTES = 64 * 1024;

export type NormalizeResult =
  | { ok: true; source: string; code_hash: string }
  | { ok: false; message: string };

/**
 * 1. Reject over 64 KiB. 2. CRLF and lone CR → LF. 3. Reject non-ASCII outside string/char
 * literals and comments, with line:col. 4. code_hash = sha256 of the normalized source with
 * trailing whitespace stripped per line.
 */
export function normalizeSource(input: string): NormalizeResult {
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    return { ok: false, message: `File too large: ${bytes} bytes (max ${MAX_SOURCE_BYTES}).` };
  }
  const source = input.replace(/\r\n?/g, '\n');
  const bad = findNonAsciiOutsideLiterals(source);
  if (bad) {
    const cp = bad.char.codePointAt(0) ?? 0;
    return {
      ok: false,
      message: `Non-ASCII character U+${cp.toString(16).toUpperCase().padStart(4, '0')} at line ${bad.line}, ` +
        `column ${bad.col}. Only string/char literals and comments may contain non-ASCII text.`,
    };
  }
  return { ok: true, source, code_hash: codeHash(source) };
}

export function codeHash(normalized: string): string {
  const stripped = normalized.split('\n').map((l) => l.replace(/[ \t\f\v]+$/, '')).join('\n');
  return crypto.createHash('sha256').update(stripped).digest('hex');
}

/** Small C lexer: tracks comments and string/char literals. Line and column are 1-based. */
export function findNonAsciiOutsideLiterals(src: string): { line: number; col: number; char: string } | null {
  type S = 'code' | 'line' | 'block' | 'str' | 'chr';
  let s: S = 'code';
  let line = 1;
  let col = 0;
  const chars = [...src]; // code points, so a column counts characters, not UTF-16 units
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    const n = chars[i + 1];
    if (c === '\n') {
      line++;
      col = 0;
      if (s === 'line') s = 'code';
      // An unterminated literal ends at the newline (the compiler reports it).
      if (s === 'str' || s === 'chr') s = 'code';
      continue;
    }
    col++;
    switch (s) {
      case 'code':
        if (c === '/' && n === '/') { s = 'line'; i++; col++; }
        else if (c === '/' && n === '*') { s = 'block'; i++; col++; }
        else if (c === '"') s = 'str';
        else if (c === "'") s = 'chr';
        else if ((c.codePointAt(0) ?? 0) > 0x7f) return { line, col, char: c };
        break;
      case 'block':
        if (c === '*' && n === '/') { s = 'code'; i++; col++; }
        break;
      case 'str':
      case 'chr':
        if (c === '\\' && n !== undefined && n !== '\n') { i++; col++; }
        else if ((s === 'str' && c === '"') || (s === 'chr' && c === "'")) s = 'code';
        break;
      case 'line':
        if (c === '\\' && n === '\n') { /* line splice: comment continues */ i++; line++; col = 0; }
        break;
    }
  }
  return null;
}
