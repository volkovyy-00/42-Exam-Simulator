// npm run content:check -- [--content <dir>] [--image <tag>] [--only <id,id>] [--no-write]
//
// For every exercise file:
//   schema   passes contract/schemas/exercise.schema.json (+ id = file name, level = folder,
//            unique ids, referenced files exist)
//   compile  the reference compiles with the graded flags in the grader image
//   nm       its `nm -u` (built with -fno-builtin, one leading `_` stripped) ⊆
//            allowed_functions ∪ toolchain ignore list
//   link     it links (alone, or with the harness main)
//   tests    its output equals expected_stdout_b64 / expected_exit for every test
//   mutant   an auto-mutant (each test's output without its final newline; if no output ends in
//            a newline, with one appended) differs from the expected output
// The toolchain ignore list is built ONLY from symbols the references trigger: a symbol a
// reference needs outside its allowlist is tolerated only if it is a toolchain symbol
// (`__*` or `_GLOBAL_OFFSET_TABLE_`); anything else is a reference failure. The list is
// printed and written to content/toolchain-ignore.txt and manifest.ignore_symbols.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Exercise } from '@ceg/contract';
import {
  SCHEMA_PATH, contentRoot, flagStr, listExerciseFiles, parseArgs, readManifest, writeManifest,
} from './lib/content.ts';
import { DEFAULT_IMAGE, ensureImage, runReference, type RefRun } from './lib/sandbox.ts';

export interface Failure { id: string; stage: string; detail: string }
export interface ValidateResult {
  total: number;
  passing: string[];
  failures: Failure[];
  ignore_symbols: string[];
}

/** Symbols (after stripping one leading `_`) that may come from the toolchain, not the code. */
export function isToolchainSymbol(sym: string): boolean {
  return sym.startsWith('_') || sym === 'GLOBAL_OFFSET_TABLE_';
}

/** Splits a reference's nm symbols into allowed, toolchain-tolerated and forbidden. */
export function classifySymbols(nm: string[], allowed: string[]): { toolchain: string[]; forbidden: string[] } {
  const allow = new Set(allowed);
  const extra = nm.filter((s) => !allow.has(s));
  return { toolchain: extra.filter(isToolchainSymbol), forbidden: extra.filter((s) => !isToolchainSymbol(s)) };
}

/** Auto-mutant of DESIGN/TASKS WP2: does a missing (or extra) final newline change any output? */
export function mutantDiffers(outputsB64: string[]): { differs: boolean; kind: 'drop-final-newline' | 'add-final-newline' } {
  const outs = outputsB64.map((b) => Buffer.from(b, 'base64'));
  if (outs.some((o) => o.length > 0 && o[o.length - 1] === 0x0a)) {
    // At least one test ends in \n, so dropping it is caught by a byte-exact compare.
    const differs = outs.some((o) => {
      const m = o.length > 0 && o[o.length - 1] === 0x0a ? o.subarray(0, -1) : o;
      return !m.equals(o);
    });
    return { differs, kind: 'drop-final-newline' };
  }
  const differs = outs.some((o) => !Buffer.concat([o, Buffer.from('\n')]).equals(o));
  return { differs, kind: 'add-final-newline' };
}

export function schemaValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object;
  return ajv.compile(schema);
}

export interface ValidateOptions {
  root: string;
  image: string;
  only?: string[];
  write?: boolean;
  log?: (s: string) => void;
}

export function validate(opts: ValidateOptions): ValidateResult {
  const log = opts.log ?? console.log;
  const check = schemaValidator();
  const files = listExerciseFiles(opts.root);
  const failures: Failure[] = [];
  const seen = new Map<string, string>();
  const good: Exercise[] = [];
  const fail = (id: string, stage: string, detail: string) => {
    failures.push({ id, stage, detail });
    log(`FAIL ${id} [${stage}] ${detail.trim().split('\n').slice(0, 3).join(' | ')}`);
  };

  // 1. Schema and structure, without docker.
  for (const f of files) {
    const id = basename(f.path, '.json');
    if (!check(f.raw)) {
      fail(id, 'schema', (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; '));
      continue;
    }
    const ex = f.raw as Exercise;
    const problems: string[] = [];
    if (ex.id !== id) problems.push(`id "${ex.id}" ≠ file name "${id}"`);
    if (String(ex.level) !== f.levelDir) problems.push(`level ${ex.level} ≠ folder ${f.levelDir}`);
    if (seen.has(ex.id)) problems.push(`duplicate id (also in ${seen.get(ex.id)})`);
    seen.set(ex.id, f.path);
    if (ex.kind === 'program' && ex.harness.main !== null) problems.push('program with a harness main');
    for (const p of [ex.reference_path, ...(ex.harness.main ? [ex.harness.main] : []), ...ex.harness.includes]) {
      if (!existsSync(join(opts.root, p))) problems.push(`missing file ${p}`);
    }
    const ids = ex.tests.map((t) => t.id);
    if (new Set(ids).size !== ids.length) problems.push('duplicate test ids');
    if (problems.length > 0) { fail(id, 'schema', problems.join('; ')); continue; }
    if (!opts.only || opts.only.includes(ex.id)) good.push(ex);
  }

  // 2. References in the grader image.
  ensureImage(opts.image, log);
  const runs = new Map<string, RefRun>();
  for (const ex of good) runs.set(ex.id, runReference(ex, opts.root, opts.image));

  // 3. Ignore list from what the references trigger.
  const ignore = new Set<string>();
  for (const ex of good) {
    const r = runs.get(ex.id)!;
    if (r.compile_ok && r.nm_ok) for (const s of classifySymbols(r.nm_symbols, ex.allowed_functions).toolchain) ignore.add(s);
  }
  const ignore_symbols = [...ignore].sort();

  // 4. Per-exercise stages.
  const passing: string[] = [];
  for (const ex of good) {
    const r = runs.get(ex.id)!;
    if (r.error) { fail(ex.id, 'docker', r.error); continue; }
    if (!r.compile_ok) { fail(ex.id, 'compile', r.compile_stderr); continue; }
    if (!r.nm_ok) { fail(ex.id, 'nm', `compile with -fno-builtin failed: ${r.compile_stderr}`); continue; }
    const forbidden = r.nm_symbols.filter((s) => !ex.allowed_functions.includes(s) && !ignore.has(s));
    if (forbidden.length > 0) { fail(ex.id, 'nm', `forbidden: ${forbidden.join(', ')} (allowed: ${ex.allowed_functions.join(', ') || 'none'})`); continue; }
    if (!r.link_ok) { fail(ex.id, 'link', r.link_stderr); continue; }
    const bad: string[] = [];
    for (const t of ex.tests) {
      const got = r.tests.find((x) => x.id === t.id);
      if (!got) { bad.push(`${t.id}: no result`); continue; }
      if (got.timed_out) { bad.push(`${t.id}: timeout`); continue; }
      if (got.signal !== null) { bad.push(`${t.id}: signal ${got.signal}`); continue; }
      if (got.truncated) { bad.push(`${t.id}: truncated`); continue; }
      if (got.exit !== t.expected_exit) { bad.push(`${t.id}: exit ${got.exit}, expected ${t.expected_exit}`); continue; }
      if (got.stdout.toString('base64') !== t.expected_stdout_b64) bad.push(`${t.id}: output differs (run content:regen?)`);
    }
    if (bad.length > 0) { fail(ex.id, 'tests', bad.join('; ')); continue; }
    const m = mutantDiffers(ex.tests.map((t) => t.expected_stdout_b64));
    if (!m.differs) { fail(ex.id, 'mutant', `${m.kind} mutant is indistinguishable from the expected output`); continue; }
    passing.push(ex.id);
  }

  const total = files.length;
  log('');
  log(`toolchain ignore list (${ignore_symbols.length}, built only from symbols the references trigger): ${ignore_symbols.length > 0 ? ignore_symbols.join(' ') : '(empty)'}`);
  for (const s of ignore_symbols) {
    const who = good.filter((ex) => runs.get(ex.id)?.nm_symbols.includes(s) && !ex.allowed_functions.includes(s)).map((ex) => ex.id);
    log(`  ${s}: ${who.join(', ')}`);
  }
  if (failures.length > 0) {
    log(`failures (${failures.length}):`);
    for (const f of failures) log(`  ${f.id} [${f.stage}]`);
  }
  log(`content:check: ${passing.length}/${total} references passing (${opts.image})`);

  if (opts.write !== false) {
    writeFileSync(join(opts.root, 'toolchain-ignore.txt'), ignore_symbols.map((s) => s + '\n').join(''));
    const m = readManifest(opts.root);
    if (m) writeManifest(opts.root, { ...m, ignore_symbols });
  }
  return { total, passing, failures, ignore_symbols };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2), ['no-write']);
  const res = validate({
    root: contentRoot(args),
    image: flagStr(args, 'image') ?? process.env.GRADER_IMAGE ?? DEFAULT_IMAGE,
    only: flagStr(args, 'only')?.split(',').filter(Boolean),
    write: args.flags.get('no-write') !== true,
  });
  if (res.failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(`content:check: ${(e as Error).message}`); process.exit(1); }
}
