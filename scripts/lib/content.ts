// Content root helpers (DESIGN.md §5.2). The root is `--content <dir>`, else $CONTENT_DIR, else
// <repo>/content, so the scripts behave the same from the repo root and from scripts/.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentManifest, Exercise } from '@ceg/contract';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCHEMA_PATH = join(REPO_ROOT, 'contract', 'schemas', 'exercise.schema.json');
export const GRADER_IMAGE_DIR = join(REPO_ROOT, 'grader', 'image');

export interface CliArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Minimal `--flag value` / `--flag=value` / `--switch` parser. */
export function parseArgs(argv: string[], switches: string[] = []): CliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { flags.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const name = a.slice(2);
    if (switches.includes(name)) { flags.set(name, true); continue; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, v);
    i++;
  }
  return { positional, flags };
}

export function flagStr(args: CliArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function contentRoot(args?: CliArgs): string {
  const fromFlag = args ? flagStr(args, 'content') : undefined;
  return resolve(fromFlag ?? process.env.CONTENT_DIR ?? join(REPO_ROOT, 'content'));
}

/** Stable JSON: 2-space indent, trailing newline. Key order is the insertion order. */
export function toJson(v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n';
}

export function writeFileEnsured(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export interface ExerciseFile {
  path: string;
  /** The level directory name. */
  levelDir: string;
  exercise: Exercise;
}

/** Every content/exercises/<level>/<id>.json, sorted by level then id. */
export function listExerciseFiles(root: string): { path: string; levelDir: string; raw: unknown }[] {
  const dir = join(root, 'exercises');
  if (!existsSync(dir)) return [];
  const out: { path: string; levelDir: string; raw: unknown }[] = [];
  const levels = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  for (const lv of levels) {
    for (const f of readdirSync(join(dir, lv)).filter((x) => x.endsWith('.json')).sort()) {
      const path = join(dir, lv, f);
      out.push({ path, levelDir: lv, raw: readJson<unknown>(path) });
    }
  }
  return out;
}

export function loadExercises(root: string): ExerciseFile[] {
  return listExerciseFiles(root).map((f) => ({ path: f.path, levelDir: f.levelDir, exercise: f.raw as Exercise }));
}

export function readManifest(root: string): ContentManifest | null {
  const p = join(root, 'manifest.json');
  return existsSync(p) ? readJson<ContentManifest>(p) : null;
}

export function writeManifest(root: string, m: ContentManifest): void {
  writeFileEnsured(join(root, 'manifest.json'), toJson({
    repo: m.repo, commit: m.commit, generated_at: m.generated_at, count: m.count,
    ignore_symbols: m.ignore_symbols,
  }));
}

/** The seed's raw case files, kept by import for regen's diff log (content/seed-cases/<id>/). */
export function seedCasesDir(root: string, id: string): string {
  return join(root, 'seed-cases', id);
}
