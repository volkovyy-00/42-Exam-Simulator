// Dispatcher-side `file` and `static` stages (DESIGN.md §6.1). No container is started for these.
import type { Exercise } from '@ceg/contract';

export const MAX_SOURCE_BYTES = 64 * 1024;

export function checkFile(ex: Exercise, filename: string): string | null {
  if (ex.expected_files.includes(filename)) return null;
  return `expected file ${ex.expected_files.join(', ')}, got ${filename}`;
}

const FORBIDDEN_IDENTS = new Set(['asm', '__asm__', '__asm']);

/**
 * Size, non-ASCII bytes outside string/char literals and comments, and asm / syscall( unless
 * allow_asm. Returns the failure message or null. A lexer, not a parser: good enough to skip
 * comments and literals; the sandbox is the real boundary.
 */
export function checkStatic(ex: Exercise, source: string): string | null {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) return 'source is larger than 64 KiB';
  let line = 1;
  let col = 1;
  let i = 0;
  const n = source.length;
  const adv = () => {
    if (source[i] === '\n') { line++; col = 1; } else col++;
    i++;
  };
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') adv();
      continue;
    }
    if (c === '/' && next === '*') {
      adv(); adv();
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) adv();
      if (i < n) { adv(); adv(); }
      continue;
    }
    if (c === '"' || c === "'") {
      adv();
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\' && i + 1 < n) adv();
        adv();
      }
      if (i < n) adv();
      continue;
    }
    if (c.charCodeAt(0) > 0x7f) {
      return `non-ASCII character outside a string or comment at line ${line}, column ${col}`;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(source[j]!)) j++;
      const word = source.slice(i, j);
      if (!ex.allow_asm) {
        if (FORBIDDEN_IDENTS.has(word)) return 'forbidden construct: asm';
        if (word === 'syscall' && /^\s*\(/.test(source.slice(j))) return 'forbidden construct: syscall';
      }
      while (i < j) adv();
      continue;
    }
    adv();
  }
  return null;
}
