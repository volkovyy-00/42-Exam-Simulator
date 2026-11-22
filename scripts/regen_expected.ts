// npm run content:regen -- [--content <dir>] [--image <tag>] [--only <id,id>] [--check]
//
// Compiles every reference in the grader image (default grader:pinned, built from grader/image
// if missing) with the DESIGN.md §6.3 `docker run` flags and the graded compile flags, runs
// every test, and overwrites tests[].expected_stdout_b64 / expected_exit. Every difference
// from the seed's .out files (content/seed-cases/, written by import) goes to
// content/regen-diff.log. --check writes nothing and exits 1 if any value would change
// (used to prove that regen reproduces fixtures/ exactly).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catE, firstDiff } from './lib/cate.ts';
import { contentRoot, flagStr, loadExercises, parseArgs, seedCasesDir, toJson } from './lib/content.ts';
import { DEFAULT_IMAGE, ensureImage, runReference } from './lib/sandbox.ts';

export interface RegenOptions {
  root: string;
  image: string;
  only?: string[];
  check?: boolean;
  log?: (s: string) => void;
}

export interface RegenResult {
  exercises: number;
  failed: { id: string; stage: string; detail: string }[];
  changed: { id: string; test: string }[];
  seedDiffs: number;
}

function show(b: Uint8Array, max = 200): string {
  const s = JSON.stringify(Buffer.from(b).toString('latin1'));
  return s.length > max ? s.slice(0, max) + '…"' : s;
}

export function regen(opts: RegenOptions): RegenResult {
  const log = opts.log ?? console.log;
  ensureImage(opts.image, log);
  const files = loadExercises(opts.root).filter((f) => !opts.only || opts.only.includes(f.exercise.id));
  const res: RegenResult = { exercises: files.length, failed: [], changed: [], seedDiffs: 0 };
  const diffLog: string[] = [];

  for (const f of files) {
    const ex = f.exercise;
    const run = runReference(ex, opts.root, opts.image);
    const fail = (stage: string, detail: string) => {
      res.failed.push({ id: ex.id, stage, detail });
      log(`FAIL ${ex.id} [${stage}] ${detail.split('\n')[0]}`);
      diffLog.push(`${ex.id}: reference failed at ${stage}: ${detail.trim()}`, '');
    };
    if (run.error) { fail('docker', run.error); continue; }
    if (!run.compile_ok) { fail('compile', run.compile_stderr); continue; }
    if (!run.nm_ok) { fail('nm', run.compile_stderr); continue; }
    if (!run.link_ok) { fail('link', run.link_stderr); continue; }

    let dirty = false;
    for (const t of ex.tests) {
      const got = run.tests.find((x) => x.id === t.id);
      if (!got) { fail('tests', `test ${t.id}: no result`); continue; }
      if (got.timed_out || got.signal !== null || got.truncated) {
        fail('tests', `test ${t.id}: ${got.timed_out ? 'timeout' : got.signal !== null ? `signal ${got.signal}` : 'truncated'}`);
        continue;
      }
      const b64 = got.stdout.toString('base64');
      if (b64 !== t.expected_stdout_b64 || got.exit !== t.expected_exit) {
        res.changed.push({ id: ex.id, test: t.id });
        if (opts.check) {
          log(`DIFF ${ex.id}/${t.id}: committed ${show(Buffer.from(t.expected_stdout_b64, 'base64'))} exit ${t.expected_exit}`
            + ` vs regen ${show(got.stdout)} exit ${got.exit}`);
        }
        t.expected_stdout_b64 = b64;
        t.expected_exit = got.exit;
        dirty = true;
      }
      // Diff against the seed's own .out (rendered the way the seed captured it).
      const sc = seedCasesDir(opts.root, ex.id);
      const metaPath = join(sc, `${t.id}.json`);
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { cat_e: boolean };
        const seedOut = readFileSync(join(sc, `${t.id}.out`));
        const mine = meta.cat_e ? catE(got.stdout) : got.stdout;
        const at = firstDiff(seedOut, mine);
        if (at !== null) {
          res.seedDiffs++;
          const cmd = readFileSync(join(sc, `${t.id}.cmd`), 'utf8').trimEnd();
          diffLog.push(
            `${ex.id}/${t.id}: ${cmd}`,
            `  first differing byte: ${at} (seed ${seedOut.length} bytes, regen ${mine.length} bytes${meta.cat_e ? ', compared as cat -e' : ''})`,
            `  seed : ${show(seedOut.subarray(Math.max(0, at - 20), at + 40))}`,
            `  regen: ${show(mine.subarray(Math.max(0, at - 20), at + 40))}`,
            '',
          );
        }
      }
    }
    if (dirty && !opts.check) writeFileSync(f.path, toJson(ex));
  }

  if (!opts.check) {
    const header = [
      `# regen-diff.log: differences between the seed's .out files and output generated in ${opts.image}`,
      `# exercises: ${res.exercises}, reference failures: ${res.failed.length}, tests that differ from the seed: ${res.seedDiffs}`,
      '',
    ];
    if (diffLog.length === 0) header.push('no differences');
    writeFileSync(join(opts.root, 'regen-diff.log'), [...header, ...diffLog].join('\n') + '\n');
  }
  log(`regen: ${res.exercises} exercises, ${res.changed.length} test values ${opts.check ? 'would change' : 'updated'}, `
    + `${res.failed.length} reference failures, ${res.seedDiffs} differences from the seed (${opts.image})`);
  return res;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2), ['check']);
  const only = flagStr(args, 'only')?.split(',').filter(Boolean);
  const res = regen({
    root: contentRoot(args),
    image: flagStr(args, 'image') ?? process.env.GRADER_IMAGE ?? DEFAULT_IMAGE,
    only,
    check: args.flags.get('check') === true,
  });
  if (res.failed.length > 0 || (args.flags.get('check') === true && res.changed.length > 0)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(`regen: ${(e as Error).message}`); process.exit(1); }
}
