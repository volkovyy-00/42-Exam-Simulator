// Content loader (DESIGN.md §5.2): exercises, harness files, toolchain ignore list.
// Reloaded on SIGHUP (server.ts). References are never read here: they never reach the sandbox.
import fs from 'node:fs';
import path from 'node:path';
import type { ContentManifest, Exercise } from '@ceg/contract';

export interface Content {
  dir: string;
  exercises: Map<string, Exercise>;
  /** manifest.ignore_symbols ∪ toolchain-ignore.txt */
  ignoreSymbols: string[];
}

/** Resolve a content-relative path, refusing anything that escapes the content root. */
export function contentPath(dir: string, rel: string): string {
  const p = path.resolve(dir, rel);
  if (p !== dir && !p.startsWith(dir + path.sep)) throw new Error(`path escapes content root: ${rel}`);
  return p;
}

export function loadContent(dir: string): Content {
  const root = path.resolve(dir);
  const exercises = new Map<string, Exercise>();
  const exDir = path.join(root, 'exercises');
  for (const level of fs.existsSync(exDir) ? fs.readdirSync(exDir).sort() : []) {
    const levelDir = path.join(exDir, level);
    if (!fs.statSync(levelDir).isDirectory()) continue;
    for (const f of fs.readdirSync(levelDir).sort()) {
      if (!f.endsWith('.json')) continue;
      const ex = JSON.parse(fs.readFileSync(path.join(levelDir, f), 'utf8')) as Exercise;
      if (ex.id !== f.slice(0, -5)) throw new Error(`${f}: id ${ex.id} does not match the file name`);
      if (exercises.has(ex.id)) throw new Error(`duplicate exercise id ${ex.id}`);
      exercises.set(ex.id, ex);
    }
  }
  const ignore = new Set<string>();
  const manifestPath = path.join(root, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ContentManifest;
    for (const s of m.ignore_symbols ?? []) ignore.add(s);
  }
  const tiPath = path.join(root, 'toolchain-ignore.txt');
  if (fs.existsSync(tiPath)) {
    for (const l of fs.readFileSync(tiPath, 'utf8').split('\n')) if (l.trim()) ignore.add(l.trim());
  }
  return { dir: root, exercises, ignoreSymbols: [...ignore].sort() };
}
