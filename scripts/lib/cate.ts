// `cat -e` rendering (DESIGN.md §6.4) and its best-effort inverse.
// The seed stores the output of `cmd | cat -e` in its .out files. Regen compares the raw output
// of the reference, rendered with catE(), against those bytes. uncatE() is only used at import
// to seed a provisional expected_stdout_b64 before regen overwrites it.

export function catE(buf: Uint8Array): Buffer {
  const out: number[] = [];
  const one = (b: number) => {
    if (b === 0x0a) { out.push(0x24, 0x0a); return; }
    if (b === 0x09) { out.push(0x09); return; }
    if (b < 0x20) { out.push(0x5e, b + 0x40); return; }
    if (b === 0x7f) { out.push(0x5e, 0x3f); return; }
    out.push(b);
  };
  for (const b of buf) {
    if (b >= 0x80) {
      out.push(0x4d, 0x2d);
      const c = b - 0x80;
      // cat -e renders 0x8a as "M-^J" (the $ marker is only for a real \n).
      if (c === 0x0a) out.push(0x5e, 0x4a);
      else one(c);
    } else {
      one(b);
    }
  }
  return Buffer.from(out);
}

/** Inverse of catE where unambiguous. A literal "^X" or "M-" in the original is not recoverable. */
export function uncatE(buf: Uint8Array): Buffer {
  const out: number[] = [];
  let i = 0;
  const ctl = (c: number): number | null => {
    if (c === 0x3f) return 0x7f;
    if (c >= 0x40 && c <= 0x5f) return c - 0x40;
    return null;
  };
  while (i < buf.length) {
    const b = buf[i]!;
    let hi = 0;
    let j = i;
    if (b === 0x4d && buf[i + 1] === 0x2d && i + 2 < buf.length) { hi = 0x80; j = i + 2; }
    const c = buf[j]!;
    if (c === 0x24 && buf[j + 1] === 0x0a && hi === 0) { out.push(0x0a); i = j + 2; continue; }
    if (c === 0x5e && j + 1 < buf.length) {
      const v = ctl(buf[j + 1]!);
      if (v !== null) { out.push(hi + v); i = j + 2; continue; }
    }
    if (hi) { out.push(hi + c); i = j + 1; continue; }
    if (c === 0x0a) { i++; continue; } // a bare \n can't come from cat -e; drop it defensively
    out.push(c);
    i++;
  }
  return Buffer.from(out);
}

/** Index of the first differing byte, or the shorter length; null when equal. */
export function firstDiff(a: Uint8Array, b: Uint8Array): number | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? null : n;
}
