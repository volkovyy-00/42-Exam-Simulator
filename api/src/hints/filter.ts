// Hint post-filter (DESIGN.md §8, brief §6). Pure functions; the L3 skeleton run through the
// dispatcher lives in service.ts because it needs the grader.

export const FILTER = {
  l2MaxCodeLines: 1,
  l2MaxLineChars: 100,
  l3StatementRatio: 0.4,
  containmentReject: 0.35,
  /** Below this many normalized tokens (function headers removed) containment is noise: skipped. */
  containmentMinTokens: 15,
  k: 5,
  w: 4,
} as const;

export const REFUSAL = "I can't do that — but here's where to look:";

const INJECTION = [
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)/i,
  /ignore\s+previous/i,
  /disregard\s+(all\s+)?(the\s+)?(previous|prior|above|your)\s+(instructions|rules)/i,
  /forget\s+(all\s+)?(your|the)\s+(instructions|rules)/i,
  /(give|show|tell|write|send)\s+(me\s+)?(the\s+)?(full\s+|complete\s+|whole\s+)?(solution|answer|reference)/i,
  /system\s+prompt/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions\s*:/i,
  /(change|set|switch)\s+(the\s+)?(hint\s+)?level/i,
];

export function hasInjection(text: string): boolean {
  return INJECTION.some((re) => re.test(text));
}

const C_KEYWORDS = new Set(['if', 'else', 'while', 'for', 'do', 'switch', 'case', 'return', 'sizeof', 'break',
  'continue', 'goto', 'default', 'typedef', 'struct', 'union', 'enum', 'static', 'const', 'unsigned', 'signed',
  'int', 'char', 'long', 'short', 'void', 'float', 'double', 'main', 'NULL']);

/** Well-known libc/POSIX names; mentioning one outside the allowlist is a reject, even in prose. */
const LIBC = new Set(['printf', 'fprintf', 'sprintf', 'snprintf', 'dprintf', 'puts', 'putchar', 'fputs', 'putc',
  'scanf', 'getchar', 'gets', 'fgets', 'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp',
  'strdup', 'strndup', 'strchr', 'strrchr', 'strstr', 'strtok', 'atoi', 'atol', 'strtol', 'itoa', 'memset',
  'memcpy', 'memmove', 'memcmp', 'calloc', 'realloc', 'malloc', 'free', 'write', 'read', 'open', 'close',
  'exit', 'abort', 'qsort', 'isalpha', 'isdigit', 'isspace', 'isupper', 'islower', 'isalnum', 'isprint',
  'toupper', 'tolower', 'abs', 'labs', 'pow', 'sqrt', 'rand', 'srand', 'fflush', 'perror', 'system']);

export interface Extracted {
  /** All code lines: fenced blocks plus C-statement-like lines in prose. */
  lines: string[];
  /** Code from fenced blocks only, joined. */
  fenced: string;
  /** Prose without fenced blocks. */
  prose: string;
}

const STATEMENT_LIKE = /(;\s*$)|(^\s*[{}]\s*$)|(^\s*(if|while|for|switch)\s*\()|(^\s*(else|return)\b[^.]*;)|(^\s*#\s*include)|(\w+\s*\([^)]*\)\s*[;{])|(\b\w+\s*(\[[^\]]*\])?\s*[+\-*/%|&^]?=\s*[^=])/;

export function extractCode(text: string): Extracted {
  const lines: string[] = [];
  const fenced: string[] = [];
  const prose: string[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) {
      if (raw.trim()) { lines.push(raw); fenced.push(raw); }
      continue;
    }
    prose.push(raw);
    // Inline code spans that look like statements count as code too.
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const span = m[1] as string;
      if (/[;{}]|[^=!<>]=[^=]/.test(span)) lines.push(span);
    }
    const noSpans = raw.replace(/`[^`]*`/g, '');
    if (noSpans.trim() && looksLikeCodeLine(noSpans)) lines.push(raw);
  }
  return { lines, fenced: fenced.join('\n'), prose: prose.join('\n') };
}

function looksLikeCodeLine(line: string): boolean {
  const t = line.trim();
  // Prose sentences end in a period / question mark and contain several plain words.
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z,.'?!:]+$/.test(w)).length;
  if (words >= 6 && !/;\s*$/.test(t)) return false;
  return STATEMENT_LIKE.test(t);
}

/** Strips comments and string/char literals, for statement counting and tokenizing. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** "Real" statements: semicolons outside comments, plus control-flow heads. for(;;) counts once. */
export function countStatements(src: string): number {
  let s = stripComments(src).replace(/"(\\.|[^"\\\n])*"/g, '""').replace(/'(\\.|[^'\\\n])*'/g, "''");
  s = s.replace(/\bfor\s*\(([^)]*)\)/g, 'for()');
  const semis = (s.match(/;/g) ?? []).length;
  const ctrl = (s.match(/\b(if|while|for|switch|do)\b/g) ?? []).length;
  return semis + ctrl;
}

// ---- winnowing (k-grams of normalized tokens, window w) ---------------------------------

const TOKEN_RE = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[A-Za-z_]\w*|0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?|==|!=|<=|>=|&&|\|\||\+\+|--|->|<<|>>|[+\-*/%=<>!&|^~?:;,.(){}[\]]/g;

/** Tokens with identifiers → ID and literals → LIT; keywords and operators kept. */
export function normTokens(src: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(src).matchAll(TOKEN_RE)) {
    const t = m[0];
    if (/^["']/.test(t) || /^\d|^0[xX]/.test(t)) out.push('LIT');
    else if (/^[A-Za-z_]/.test(t)) out.push(C_KEYWORDS.has(t) ? t : 'ID');
    else out.push(t);
  }
  return out;
}

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function fingerprint(src: string, k: number = FILTER.k, w: number = FILTER.w): Set<number> {
  const toks = normTokens(src);
  const grams: number[] = [];
  for (let i = 0; i + k <= toks.length; i++) grams.push(hash32(toks.slice(i, i + k).join(' ')));
  const fp = new Set<number>();
  if (grams.length === 0) return fp;
  if (grams.length <= w) {
    fp.add(Math.min(...grams));
    return fp;
  }
  for (let i = 0; i + w <= grams.length; i++) {
    const win = grams.slice(i, i + w);
    // Rightmost minimum (standard winnowing tie-break).
    let mi = 0;
    for (let j = 1; j < win.length; j++) if ((win[j] as number) <= (win[mi] as number)) mi = j;
    fp.add(win[mi] as number);
  }
  return fp;
}

/** |fp(candidate) ∩ fp(reference)| / |fp(candidate)|; 0 when the candidate is too short. */
export function containment(candidate: Set<number>, reference: Set<number>): number {
  if (candidate.size === 0) return 0;
  let n = 0;
  for (const h of candidate) if (reference.has(h)) n++;
  return n / candidate.size;
}

// ---- the filter ---------------------------------------------------------------------------

export interface FilterInput {
  level: 1 | 2 | 3;
  text: string;
  reference: string | null;
  /** allowed_functions ∪ prototype name ∪ functions the student defines. */
  allowed: Set<string>;
}

export interface FilterVerdict {
  ok: boolean;
  /** 'ok' or 'reject:<rule>' (hint_log.filter_verdict). */
  verdict: string;
  containment: number | null;
  /** The L3 skeleton (fenced code), for the sandbox check in service.ts. */
  skeleton: string | null;
}

const reject = (rule: string, c: number | null = null): FilterVerdict =>
  ({ ok: false, verdict: `reject:${rule}`, containment: c, skeleton: null });

export function postFilter(inp: FilterInput): FilterVerdict {
  const { level, text } = inp;
  if (!text.trim()) return reject('empty');
  if (hasInjection(text)) return reject('injection');
  const code = extractCode(text);

  if (level === 1 && code.lines.length > 0) return reject('code_in_l1');
  if (level === 2) {
    if (code.lines.length > FILTER.l2MaxCodeLines) return reject('l2_code_lines');
    if (code.lines.some((l) => l.length > FILTER.l2MaxLineChars)) return reject('l2_line_length');
  }

  let c: number | null = null;
  const codeText = code.lines.join('\n');
  // The skeleton must keep the student's prototype, so function headers do not count as copying.
  const body = withoutFunctionHeaders(codeText);
  if (inp.reference && normTokens(body).length >= FILTER.containmentMinTokens) {
    c = containment(fingerprint(body), fingerprint(withoutFunctionHeaders(inp.reference)));
    if (c >= FILTER.containmentReject) return reject('containment', c);
  }

  if (level === 3 && inp.reference) {
    const refCount = countStatements(inp.reference);
    const got = countStatements(codeText);
    if (refCount > 0 && got > FILTER.l3StatementRatio * refCount) return reject('l3_statements', c);
  }

  const bad = foreignFunctions(text, inp.allowed);
  if (bad) return reject(`function:${bad}`, c);

  return { ok: true, verdict: 'ok', containment: c, skeleton: level === 3 ? (code.fenced || null) : null };
}

/** The first called or named library function outside the allowlist, or null. */
export function foreignFunctions(text: string, allowed: Set<string>): string | null {
  const code = extractCode(text);
  const scan = [code.lines.join('\n'), code.prose].join('\n');
  for (const m of stripComments(code.lines.join('\n')).matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const f = m[1] as string;
    if (!C_KEYWORDS.has(f) && !allowed.has(f)) return f;
  }
  for (const m of code.prose.matchAll(/\b([A-Za-z_]\w*)\((?!s\))/g)) {
    const f = m[1] as string;
    if (!C_KEYWORDS.has(f) && !allowed.has(f)) return f;
  }
  for (const m of scan.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
    const f = m[1] as string;
    if (LIBC.has(f) && !allowed.has(f)) return f;
  }
  return null;
}

/** Drops `type name(params)` definition header lines (and a lone `{` right after). */
export function withoutFunctionHeaders(src: string): string {
  return src.replace(/^[ \t]*[A-Za-z_][\w \t*]*?\b[A-Za-z_]\w*[ \t]*\([^;{)]*\)[ \t]*(\{[ \t]*)?$/gm, '');
}

/** Function names the student defines (so the model may name them). */
export function definedFunctions(src: string): string[] {
  const out = new Set<string>();
  for (const m of stripComments(src).matchAll(/^[A-Za-z_][\w \t*]*?\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/gm)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}
