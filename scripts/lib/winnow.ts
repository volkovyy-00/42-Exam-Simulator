// Winnowing fingerprints (Schleimer, Wilkerson, Aiken 2003) over normalized C tokens, used by the
// hint post-filter to reject an L3 skeleton that copies the reference (containment ≥ 0.35).
//
// Normalization ("c-tokens-v1"):
//   - comments and `#include` lines are dropped; other preprocessor lines are tokenized
//   - identifiers → "I", except C keywords (kept as written)
//   - numbers → "N", string literals → "S", char literals → "C"
//   - punctuators kept as written (longest match: "->", "++", "<<=", …)
// Then every k-gram of tokens is hashed (FNV-1a 32-bit over the tokens joined by U+0001) and in
// every window of w consecutive hashes the minimum is selected (rightmost on ties). The
// fingerprint is the set of selected hashes.

export const NORMALIZATION = 'c-tokens-v1';

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict',
  'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
  'unsigned', 'void', 'volatile', 'while', '_Bool', 'bool',
]);

const PUNCT = [
  '<<=', '>>=', '...', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=',
  '-=', '*=', '/=', '%=', '&=', '^=', '|=', '##',
];

export function normalizeTokens(src: string): string[] {
  const out: string[] = [];
  const s = src.replace(/\r\n?/g, '\n');
  let i = 0;
  let lineStart = true;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\n') { lineStart = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\v' || c === '\f') { i++; continue; }
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (lineStart && c === '#') {
      const m = /^#\s*include\b[^\n]*/.exec(s.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    lineStart = false;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      out.push(c === '"' ? 'S' : 'C');
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
      const w = s.slice(i, j);
      out.push(KEYWORDS.has(w) ? w : 'I');
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_.]/.test(s[j]!)) j++;
      out.push('N');
      i = j;
      continue;
    }
    const p = PUNCT.find((x) => s.startsWith(x, i));
    if (p) { out.push(p); i += p.length; continue; }
    out.push(c);
    i++;
  }
  return out;
}

export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function kgramHashes(tokens: string[], k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + k <= tokens.length; i++) out.push(fnv1a(tokens.slice(i, i + k).join('\u0001')));
  return out;
}

/** Selected (hash, position) pairs; positions are k-gram indexes. */
export function winnow(hashes: number[], w: number): { hash: number; pos: number }[] {
  const picked: { hash: number; pos: number }[] = [];
  if (hashes.length === 0) return picked;
  if (hashes.length < w) {
    // Shorter than one window: take its minimum.
    let mi = 0;
    for (let i = 0; i < hashes.length; i++) if (hashes[i]! <= hashes[mi]!) mi = i;
    return [{ hash: hashes[mi]!, pos: mi }];
  }
  let last = -1;
  for (let start = 0; start + w <= hashes.length; start++) {
    let mi = start;
    for (let i = start; i < start + w; i++) if (hashes[i]! <= hashes[mi]!) mi = i;
    if (mi !== last) { picked.push({ hash: hashes[mi]!, pos: mi }); last = mi; }
  }
  return picked;
}

export interface Fingerprint {
  id: string;
  k: number;
  w: number;
  normalization: string;
  token_count: number;
  /** Unique selected hashes, ascending. */
  hashes: number[];
}

export function fingerprint(id: string, src: string, k = 5, w = 4): Fingerprint {
  const tokens = normalizeTokens(src);
  const hashes = [...new Set(winnow(kgramHashes(tokens, k), w).map((p) => p.hash))].sort((a, b) => a - b);
  return { id, k, w, normalization: NORMALIZATION, token_count: tokens.length, hashes };
}

/** |A ∩ B| / |A|: how much of `candidate` is contained in `reference`. 0 for an empty candidate. */
export function containment(candidate: number[], reference: number[]): number {
  if (candidate.length === 0) return 0;
  const ref = new Set(reference);
  return candidate.filter((h) => ref.has(h)).length / candidate.length;
}
