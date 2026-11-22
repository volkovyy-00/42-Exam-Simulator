// Parses the header of a seed subject (pool/level*/<name>/subject.en.txt): three
// `<label> : <value>` lines (the assignment name, "Expected files", "Allowed functions", the
// last one possibly empty, "-" or "None") followed by a `-----` rule.
//
// Lines before the first `---` rule count as the header. Leading junk on a line (one seed subject
// starts with a stray "[") is ignored.

export interface SubjectHeader {
  name: string | null;
  expected_files: string[];
  allowed_functions: string[];
}

const NONE = new Set(['', '-', 'none', 'n/a']);

export function parseSubjectHeader(text: string): SubjectHeader {
  const fields = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('---')) break;
    const m = /^[^A-Za-z]*([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/.exec(raw);
    if (m) fields.set(m[1]!.trim().toLowerCase(), m[2]!.trim());
  }
  const name = fields.get('assignment name') ?? null;
  const files = (fields.get('expected files') ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allowedRaw = fields.get('allowed functions') ?? fields.get('allowed function') ?? '';
  const allowed = NONE.has(allowedRaw.toLowerCase())
    ? []
    : allowedRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0 && !NONE.has(s.toLowerCase()));
  return {
    name: name && name.length > 0 ? name : null,
    expected_files: files,
    allowed_functions: [...new Set(allowed)],
  };
}

/**
 * Finds the C prototype of `name` in a subject or a harness main: the first line that declares
 * `name(` and ends with `;` (after optional trailing blanks). Returns it trimmed, or null.
 */
export function findPrototype(text: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*([A-Za-z_][A-Za-z0-9_\\s\\*]*?[\\s\\*]\\**${esc}\\s*\\([^;{}]*\\)\\s*;)\\s*$`);
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m && !/^\s*return\b/.test(line)) return m[1]!.trim();
  }
  return null;
}
