import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import type { ContentManifest, Exercise } from '@ceg/contract';
import { importTrainer, inlineHeaders } from '../import_trainer.ts';
import { schemaValidator } from '../validate.ts';
import { makeSyntheticSeed } from './synthetic-seed.ts';

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, 'base64'));
    }
  };
  walk(dir);
  return out;
}

const quiet = () => {};

test('import builds content/ from disk, validates, and is idempotent', () => {
  const seed = makeSyntheticSeed();
  const root = mkdtempSync(join(tmpdir(), 'ceg-content-'));
  const res = importTrainer(seed, root, quiet);
  assert.equal(res.count, 2);
  assert.deepEqual(res.levels, { 0: 1, 2: 1 });
  assert.deepEqual(res.skipped, []);

  const commit = execFileSync('git', ['-C', seed, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as ContentManifest;
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.count, 2);
  assert.deepEqual(manifest.ignore_symbols, []);
  assert.equal(readFileSync(join(root, 'LICENSE-seed'), 'utf8'), 'MIT License (synthetic test seed)\n');

  const validateSchema = schemaValidator();
  const prog = JSON.parse(readFileSync(join(root, 'exercises/0/say_first.json'), 'utf8')) as Exercise;
  assert.ok(validateSchema(prog), JSON.stringify(validateSchema.errors));
  assert.equal(prog.kind, 'program');
  assert.equal(prog.subject_source, '42-derived-private');
  assert.equal(prog.provenance.commit, commit);
  assert.deepEqual(prog.allowed_functions, ['write']);
  assert.deepEqual(prog.expected_files, ['say_first.c']);
  assert.equal(prog.harness.main, null);
  assert.deepEqual(prog.harness.includes, []);
  assert.match(prog.subject_md, /Print the first argument/);
  assert.match(prog.subject_md, /More examples/);
  assert.deepEqual(prog.tests.map((t) => [t.id, t.visible, t.argv, t.stdin]), [
    ['01', true, ['hello world'], null],
    ['02', true, ["it's", 'x'], null],
    ['03', false, [], null],
    ['04', false, ['', 'x'], null],
    ['05', false, [], 'ignored\n'],
  ]);
  // Provisional expected output: `| cat -e` is undone, raw .out kept as is.
  assert.deepEqual(prog.tests.map((t) => Buffer.from(t.expected_stdout_b64, 'base64').toString()),
    ['hello world\n', "it's\n", '\n', '\n', '\n']);
  // Header only the reference uses is inlined.
  const ref = readFileSync(join(root, 'refs/say_first.c'), 'utf8');
  assert.doesNotMatch(ref, /#include "say_first.h"/);
  assert.match(ref, /int\tmy_len\(char \*s\);/);

  const fn = JSON.parse(readFileSync(join(root, 'exercises/2/herd_size.json'), 'utf8')) as Exercise;
  assert.ok(validateSchema(fn), JSON.stringify(validateSchema.errors));
  assert.equal(fn.kind, 'function');
  assert.equal(fn.prototype, 'int\therd_size(t_herd *h);');
  assert.deepEqual(fn.expected_files, ['herd_size.c']);
  assert.deepEqual(fn.allowed_functions, []);
  assert.equal(fn.harness.main, 'harness/herd_size/main.c');
  assert.deepEqual(fn.harness.includes, ['harness/include/herd.h']);
  assert.ok(existsSync(join(root, 'harness/herd_size/main.c')));
  assert.ok(existsSync(join(root, 'harness/include/herd.h')));
  assert.deepEqual(fn.tests.map((t) => [t.id, t.visible, t.argv]), [['01', true, []]]);
  assert.ok(existsSync(join(root, 'seed-cases/say_first/01.out')));

  const before = snapshot(root);
  importTrainer(seed, root, quiet);
  assert.deepEqual(snapshot(root), before);
});

test('inlineHeaders replaces only the named header', () => {
  const src = '#include <unistd.h>\n#include "a.h"\n# include "b.h"\nint x;\n';
  const out = inlineHeaders(src, new Map([['a.h', 'int a;\n']]));
  assert.match(out, /int a;/);
  assert.match(out, /# include "b.h"/);
  assert.doesNotMatch(out, /#include "a.h"/);
});
