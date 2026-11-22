// Rendering helpers for grader output (DESIGN.md §6.4).

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hex = (b: number) => `\\x${b.toString(16).padStart(2, '0')}`;

/**
 * "Visible whitespace" view, re-rendered from the raw bytes: `·` for a space, `\t` for a tab,
 * `\n` for a newline (followed by a real line break so lines stay readable), `\xNN` for every
 * other byte outside printable ASCII. A literal backslash is shown as `\\` so it cannot be
 * confused with an escape.
 */
export function visibleWhitespace(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b === 0x20) s += '·';
    else if (b === 0x09) s += '\\t';
    else if (b === 0x0a) s += '\\n\n';
    else if (b === 0x5c) s += '\\\\';
    else if (b > 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += hex(b);
  }
  return s;
}

/** Shows a multi-line value after a label, indenting continuation lines under the first one. */
export function labelled(label: string, value: string, width: number): string {
  const pad = ' '.repeat(width);
  const head = label.padEnd(width, ' ');
  return head + value.split('\n').join('\n' + pad);
}
