// Exercise content loader (DESIGN.md §5). Reads CONTENT_DIR/exercises/<level>/<id>.json at
// startup; server.ts calls reload() on SIGHUP. Expected outputs and reference paths stay in
// here: toDetail() is the only mapping that leaves the server.
import fs from 'node:fs';
import path from 'node:path';
import type { Exercise, ExerciseDetail } from '@ceg/contract';

const C_WORDS_PROGRAM = ['main', 'argc', 'argv'];

export class ContentStore {
  readonly dir: string;
  private byId = new Map<string, Exercise>();
  private refCache = new Map<string, string>();

  constructor(dir: string) {
    this.dir = dir;
    this.reload();
  }

  /** Re-reads every exercise file. A broken file is skipped with a warning, never fatal. */
  reload(warn: (msg: string) => void = (m) => console.warn(m)): number {
    const next = new Map<string, Exercise>();
    const root = path.join(this.dir, 'exercises');
    let levels: string[] = [];
    try {
      levels = fs.readdirSync(root);
    } catch {
      warn(`content: no exercises directory at ${root}`);
    }
    for (const lvl of levels) {
      const ldir = path.join(root, lvl);
      if (!fs.statSync(ldir).isDirectory()) continue;
      for (const f of fs.readdirSync(ldir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const ex = JSON.parse(fs.readFileSync(path.join(ldir, f), 'utf8')) as Exercise;
          if (!ex.id || ex.id !== f.slice(0, -5) || !/^[a-z0-9_]+$/.test(ex.id)) {
            warn(`content: ${lvl}/${f}: id does not match the file name, skipped`);
            continue;
          }
          next.set(ex.id, ex);
        } catch (err) {
          warn(`content: ${lvl}/${f}: ${(err as Error).message}, skipped`);
        }
      }
    }
    this.byId = next;
    this.refCache.clear();
    return next.size;
  }

  get count(): number {
    return this.byId.size;
  }

  get(id: string): Exercise | undefined {
    return this.byId.get(id);
  }

  /** Sorted by level, then id. */
  list(level?: number): Exercise[] {
    return [...this.byId.values()]
      .filter((e) => level === undefined || e.level === level)
      .sort((a, b) => a.level - b.level || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Reference solution source. Server-only: solution reveal and the hint post-filter. */
  reference(id: string): string | null {
    const ex = this.byId.get(id);
    if (!ex) return null;
    const hit = this.refCache.get(id);
    if (hit !== undefined) return hit;
    const p = this.resolve(ex.reference_path);
    if (!p) return null;
    try {
      const src = fs.readFileSync(p, 'utf8');
      this.refCache.set(id, src);
      return src;
    } catch {
      return null;
    }
  }

  /** Optional hand-reviewed canned hints: content/hints/<id>.json { "1": "…", "2": "…", "3": "…" }. */
  cannedHint(id: string, level: number): string | null {
    const p = this.resolve(`hints/${id}.json`);
    if (!p) return null;
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      const v = obj[String(level)];
      return typeof v === 'string' && v.trim() ? v : null;
    } catch {
      return null;
    }
  }

  /** A path under the content root, or null if it would escape it. */
  private resolve(rel: string): string | null {
    const p = path.resolve(this.dir, rel);
    return p.startsWith(path.resolve(this.dir) + path.sep) ? p : null;
  }
}

/** The client view of an exercise: no expected output, no reference path, visible tests only. */
export function toDetail(ex: Exercise): ExerciseDetail {
  const words = new Set<string>();
  if (ex.prototype) {
    const m = /([A-Za-z_]\w*)\s*\(/.exec(ex.prototype);
    if (m?.[1]) words.add(m[1]);
  } else {
    for (const w of C_WORDS_PROGRAM) words.add(w);
  }
  for (const f of ex.allowed_functions) words.add(f);
  return {
    id: ex.id,
    level: ex.level,
    kind: ex.kind,
    expected_files: [...ex.expected_files],
    allowed_functions: [...ex.allowed_functions],
    prototype: ex.prototype,
    subject_md: ex.subject_md,
    subject_source: ex.subject_source,
    visible_tests: ex.tests.filter((t) => t.visible).map((t) => ({ id: t.id, argv: [...t.argv], stdin: t.stdin })),
    autocomplete_words: [...words],
  };
}
