// npm run content:import -- <seed-clone> [--content <dir>]
//
// Turns a local clone of tomascoutotech/42-piscine-exam-trainer into the private content/ tree
// (DESIGN.md §5.2). The exercise list comes from disk (pool/level*/<name>/), never from a
// hard-coded list. Expected outputs written here are provisional (decoded from the seed's .out
// files); `content:regen` replaces them with output generated in grader:pinned.
//
// Idempotent: the generated directories are rebuilt from scratch and generated_at is the seed
// commit's date, so two runs on the same seed commit produce identical bytes.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContentManifest, Exercise, ExerciseTest } from '@ceg/contract';
import { uncatE } from './lib/cate.ts';
import { CmdParseError, parseCmd } from './lib/cmd.ts';
import {
  contentRoot, parseArgs, seedCasesDir, toJson, writeFileEnsured, writeManifest,
} from './lib/content.ts';
import { findPrototype, parseSubjectHeader } from './lib/subject.ts';

export const SUBJECT_SOURCE = '42-derived-private';
export const LICENSE_SUBJECT = '© 42 / École 42, private use only, never committed';
export const VISIBLE_TESTS = 2;
const ID_RE = /^[a-z0-9_]+$/;
const FILE_RE = /^[A-Za-z0-9_]+\.c$/;
/** Directories import owns and rebuilds. hints/ and fingerprints/ are left alone. */
const GENERATED = ['exercises', 'refs', 'harness', 'seed-cases'];

export interface ImportNote { id: string; note: string }
export interface ImportResult {
  count: number;
  commit: string | null;
  levels: Record<string, number>;
  notes: ImportNote[];
  skipped: ImportNote[];
}

function git(seed: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', seed, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function repoName(seed: string): string {
  const url = git(seed, ['remote', 'get-url', 'origin']);
  const m = url ? /([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url) : null;
  return m ? m[1]! : basename(resolve(seed));
}

function readText(p: string): string {
  return readFileSync(p, 'utf8');
}

/** `#include "x.h"` names in a C source. */
export function localIncludes(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) out.push(m[1]!);
  return out;
}

/** Replaces `#include "h"` lines with the header text, for headers only the reference uses. */
export function inlineHeaders(src: string, headers: Map<string, string>): string {
  return src.replace(/^[ \t]*#[ \t]*include[ \t]+"([^"]+)"[^\n]*$/gm, (line, name: string) => {
    const h = headers.get(name);
    return h === undefined ? line : `/* ---- ${name} (inlined by import) ---- */\n${h.replace(/\n$/, '')}\n/* ---- end ${name} ---- */`;
  });
}

function subjectMd(subject: string, examples: string | null): string {
  const fence = (t: string) => '```text\n' + t.replace(/\s+$/, '') + '\n```';
  let md = fence(subject);
  if (examples !== null && examples.trim().length > 0) md += '\n\nMore examples:\n\n' + fence(examples);
  return md;
}

function listDirs(p: string): string[] {
  return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function importTrainer(seedArg: string, root: string, log: (s: string) => void = console.log): ImportResult {
  const seed = resolve(seedArg);
  const pool = join(seed, 'pool');
  if (!existsSync(pool)) throw new Error(`${seed} has no pool/ directory: not a seed clone?`);
  const commit = git(seed, ['rev-parse', 'HEAD']);
  const commitDate = git(seed, ['log', '-1', '--format=%cI']);
  const repo = repoName(seed);

  for (const d of GENERATED) rmSync(join(root, d), { recursive: true, force: true });

  const notes: ImportNote[] = [];
  const skipped: ImportNote[] = [];
  const levels: Record<string, number> = {};
  const sharedHeadersDir = join(seed, 'tests', 'include');
  const sharedHeaders = existsSync(sharedHeadersDir)
    ? readdirSync(sharedHeadersDir).filter((f) => f.endsWith('.h')).sort()
    : [];
  for (const h of sharedHeaders) {
    copyFileSync(join(sharedHeadersDir, h), ensureParent(join(root, 'harness', 'include', h)));
  }

  const levelDirs = listDirs(pool).filter((d) => /^level\d+$/.test(d))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  let count = 0;
  for (const levelDir of levelDirs) {
    const level = Number(levelDir.slice(5));
    for (const name of listDirs(join(pool, levelDir))) {
      const res = importOne({ seed, root, level, levelDir, name, commit, repo, sharedHeaders, notes });
      if (typeof res === 'string') {
        skipped.push({ id: name, note: res });
        log(`SKIP ${levelDir}/${name}: ${res}`);
        continue;
      }
      count++;
      levels[String(level)] = (levels[String(level)] ?? 0) + 1;
    }
  }

  if (existsSync(join(seed, 'LICENSE'))) copyFileSync(join(seed, 'LICENSE'), ensureParent(join(root, 'LICENSE-seed')));
  else notes.push({ id: '-', note: 'seed has no LICENSE file' });

  const manifest: ContentManifest = {
    repo, commit, generated_at: commitDate ?? '1970-01-01T00:00:00Z', count, ignore_symbols: [],
  };
  writeManifest(root, manifest);
  for (const n of notes) log(`note ${n.id}: ${n.note}`);
  log(`imported ${count} exercises from ${repo}@${commit ?? 'unknown'} into ${root}`);
  log(`per level: ${Object.entries(levels).map(([l, n]) => `L${l}=${n}`).join(' ')}`);
  return { count, commit, levels, notes, skipped };
}

function ensureParent(p: string): string {
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

interface OneCtx {
  seed: string; root: string; level: number; levelDir: string; name: string;
  commit: string | null; repo: string; sharedHeaders: string[]; notes: ImportNote[];
}

function importOne(c: OneCtx): Exercise | string {
  const { seed, root, name: id, notes } = c;
  if (!ID_RE.test(id)) return `id "${id}" does not match ${ID_RE}`;
  if (c.level < 0 || c.level > 5) return `level ${c.level} outside 0–5`;
  const exDir = join(seed, 'pool', c.levelDir, id);
  const subjectPath = join(exDir, 'subject.en.txt');
  if (!existsSync(subjectPath)) return 'no subject.en.txt';
  const subject = readText(subjectPath);
  const examplesPath = join(exDir, 'examples.txt');
  const examples = existsSync(examplesPath) ? readText(examplesPath) : null;
  const header = parseSubjectHeader(subject);
  if (header.name !== null && header.name !== id) notes.push({ id, note: `subject says "${header.name}"` });

  // Reference solution (+ local headers).
  const solDir = join(seed, 'solucoes', id);
  const refSrcPath = join(solDir, `${id}.c`);
  if (!existsSync(refSrcPath)) return `no reference solucoes/${id}/${id}.c`;
  const solFiles = readdirSync(solDir).sort();
  const extraC = solFiles.filter((f) => f.endsWith('.c') && f !== `${id}.c`);
  if (extraC.length > 0) return `reference has more than one .c file (${extraC.join(', ')})`;
  const localHeaders = new Map<string, string>();
  for (const f of solFiles.filter((x) => x.endsWith('.h'))) localHeaders.set(f, readText(join(solDir, f)));

  // Kind: function iff the seed has a test main.
  const mainPath = join(seed, 'tests', 'mains', `${id}.c`);
  const isFunction = existsSync(mainPath);
  const mainSrc = isFunction ? readText(mainPath) : null;
  let refSrc = readText(refSrcPath);

  // Headers the harness main needs are shipped as harness includes; headers only the reference
  // uses are inlined so the reference stays one self-contained file, like a submission.
  const includes: string[] = [];
  const mainIncl = new Set(mainSrc ? localIncludes(mainSrc) : []);
  const refIncl = new Set(localIncludes(refSrc));
  for (const h of [...new Set([...mainIncl, ...refIncl])].sort()) {
    if (c.sharedHeaders.includes(h)) { includes.push(`harness/include/${h}`); continue; }
    const body = localHeaders.get(h);
    if (body === undefined) { notes.push({ id, note: `#include "${h}" not found in the seed` }); continue; }
    if (mainIncl.has(h)) {
      writeFileEnsured(join(root, 'harness', id, h), body);
      includes.push(`harness/${id}/${h}`);
    } else {
      refSrc = inlineHeaders(refSrc, new Map([[h, body]]));
      notes.push({ id, note: `inlined ${h} into the reference` });
    }
  }
  writeFileEnsured(join(root, 'refs', `${id}.c`), refSrc);
  let harnessMain: string | null = null;
  if (mainSrc !== null) {
    harnessMain = `harness/${id}/main.c`;
    writeFileEnsured(join(root, harnessMain), mainSrc);
  }

  // Expected files: v1 grades one file named after the exercise.
  const cFiles = header.expected_files.filter((f) => FILE_RE.test(f));
  let expected = cFiles.length === 1 ? cFiles : [`${id}.c`];
  if (expected[0] !== `${id}.c` || header.expected_files.length !== 1) {
    notes.push({ id, note: `expected files "${header.expected_files.join(' ')}" → ${id}.c (v1: one file)` });
    expected = [`${id}.c`];
  }

  let prototype: string | null = null;
  if (isFunction) {
    prototype = findPrototype(subject, id) ?? (mainSrc ? findPrototype(mainSrc, id) : null);
    if (prototype === null) notes.push({ id, note: 'no prototype found in subject or main' });
  }

  // Tests.
  const casesDir = join(seed, 'tests', 'cases', id);
  if (!existsSync(casesDir)) return `no tests/cases/${id}/`;
  const cmdFiles = readdirSync(casesDir).filter((f) => /^\d{2}\.cmd$/.test(f)).sort();
  if (cmdFiles.length === 0) return 'no .cmd files';
  const tests: ExerciseTest[] = [];
  for (const [idx, f] of cmdFiles.entries()) {
    const tid = f.slice(0, 2);
    const cmdText = readText(join(casesDir, f));
    let parsed;
    try {
      parsed = parseCmd(cmdText);
    } catch (e) {
      if (e instanceof CmdParseError) return `test ${tid}: ${e.message}`;
      throw e;
    }
    let stdin: string | null = null;
    if (parsed.stdin_file !== null) {
      const sp = resolve(casesDir, parsed.stdin_file);
      if (!existsSync(sp) || !statSync(sp).isFile()) return `test ${tid}: stdin file ${parsed.stdin_file} not found`;
      stdin = readText(sp);
    }
    const outPath = join(casesDir, `${tid}.out`);
    const seedOut = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0);
    if (!existsSync(outPath)) notes.push({ id, note: `test ${tid}: no .out in the seed` });
    const provisional = parsed.cat_e ? uncatE(seedOut) : seedOut;
    const sc = seedCasesDir(root, id);
    writeFileEnsured(join(sc, `${tid}.cmd`), cmdText);
    writeFileEnsured(join(sc, `${tid}.out`), seedOut);
    writeFileEnsured(join(sc, `${tid}.json`), toJson({ argv: parsed.argv, cat_e: parsed.cat_e, stdin_file: parsed.stdin_file }));
    tests.push({
      id: tid,
      visible: idx < VISIBLE_TESTS,
      argv: parsed.argv,
      stdin,
      expected_stdout_b64: provisional.toString('base64'),
      expected_exit: 0,
    });
  }

  const exercise: Exercise = {
    id,
    level: c.level,
    kind: isFunction ? 'function' : 'program',
    expected_files: expected,
    allowed_functions: header.allowed_functions,
    prototype,
    subject_md: subjectMd(subject, examples),
    subject_source: SUBJECT_SOURCE,
    harness: { main: harnessMain, includes, cflags_extra: ['-std=gnu17'] },
    tests,
    limits: { timeout_ms: 2000, max_output_bytes: 65536 },
    reference_path: `refs/${id}.c`,
    provenance: { repo: c.repo, commit: c.commit, license_code: 'MIT', license_subject: LICENSE_SUBJECT },
    hint_tags: [isFunction ? 'function' : 'program', ...header.allowed_functions],
  };
  writeFileEnsured(join(root, 'exercises', String(c.level), `${id}.json`), toJson(exercise));
  return exercise;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const seed = args.positional[0];
  if (!seed) {
    console.error('usage: npm run content:import -- <seed-clone> [--content <dir>]');
    process.exit(2);
  }
  const res = importTrainer(seed, contentRoot(args));
  if (res.count !== 73) {
    console.log(`NOTE: ${res.count} exercises, not 73.`);
    for (const s of res.skipped) console.log(`  skipped ${s.id}: ${s.note}`);
  }
  if (res.skipped.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
