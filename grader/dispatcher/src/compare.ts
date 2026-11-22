// Byte-exact comparison and `cat -e` rendering (DESIGN.md §6.4).
import type { FailureReason } from '@ceg/contract';

/** One byte as `cat -v` shows it, ignoring the `\n` → `$` rule. */
function renderByte(b: number): string {
  if (b >= 0x80) return 'M-' + renderByte(b - 0x80);
  if (b === 0x7f) return '^?';
  if (b < 0x20) return '^' + String.fromCharCode(b + 0x40);
  return String.fromCharCode(b);
}

/**
 * `cat -e`: `$` before each `\n`; 0x00–0x1F except `\t` and `\n` as `^@`…`^_`; 0x7F as `^?`;
 * bytes ≥ 0x80 as `M-` + the rendering of `byte - 0x80`. Tabs stay literal. Lines are joined
 * with `\n`, and the newline that ends the output is not repeated: `"abc\n"` → `"abc$"`.
 */
export function catE(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0x0a) out += i === buf.length - 1 ? '$' : '$\n';
    else if (b === 0x09) out += '\t';
    else out += renderByte(b);
  }
  return out;
}

/** Index of the first differing byte, the shorter length when one is a prefix, null if equal. */
export function firstDiffByte(a: Uint8Array, b: Uint8Array): number | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? null : n;
}

export interface Observed {
  stdout: Uint8Array;
  exit: number | null;
  signal: string | null;
  timed_out: boolean;
  truncated: boolean;
}

/** KO reason, first match wins: timeout > signal > truncated > exit_code > output. null = OK. */
export function koReason(got: Observed, expected: Uint8Array, expectedExit: number): FailureReason | null {
  if (got.timed_out) return 'timeout';
  if (got.signal !== null) return 'signal';
  if (got.truncated) return 'truncated';
  if (got.exit !== expectedExit) return 'exit_code';
  if (firstDiffByte(got.stdout, expected) !== null) return 'output';
  return null;
}

export function reasonText(reason: FailureReason, got: Observed): string {
  switch (reason) {
    case 'timeout': return 'timed out';
    case 'signal': return `crashed (${got.signal})`;
    case 'truncated': return 'output too long';
    case 'exit_code': return `wrong exit status (${got.exit})`;
    case 'output': return 'output differs';
  }
}
