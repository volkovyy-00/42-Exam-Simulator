// Docker-backed checks: `npm run test:docker -w scripts` (GRADER_IMAGE=<tag> to use an image
// other than grader:pinned). Skipped unless CEG_DOCKER_TESTS=1.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Exercise } from '@ceg/contract';
import { importTrainer } from '../import_trainer.ts';
import { REPO_ROOT, loadExercises } from '../lib/content.ts';
import { DEFAULT_IMAGE } from '../lib/sandbox.ts';
import { regen } from '../regen_expected.ts';
import { validate } from '../validate.ts';
import { makeSyntheticSeed } from './synthetic-seed.ts';

const image = process.env.GRADER_IMAGE ?? DEFAULT_IMAGE;
const skip = process.env.CEG_DOCKER_TESTS !== '1';
const quiet = () => {};

function fixturesCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ceg-fixtures-'));
  cpSync(join(REPO_ROOT, 'fixtures'), dir, { recursive: true });
  return dir;
}

test('regen on fixtures/ reproduces the committed expected_stdout_b64 exactly', { skip }, () => {
  const dir = fixturesCopy();
  const res = regen({ root: dir, image, check: true, log: quiet });
  assert.equal(res.exercises, 2);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(res.changed, []);
  // And a corrupted value is caught and rewritten.
  const p = join(dir, 'exercises/1/gym_strlen.json');
  const ex = JSON.parse(readFileSync(p, 'utf8')) as Exercise;
  const want = ex.tests[0]!.expected_stdout_b64;
  ex.tests[0]!.expected_stdout_b64 = Buffer.from('4\n').toString('base64');
  writeFileSync(p, JSON.stringify(ex));
  const res2 = regen({ root: dir, image, log: quiet });
  assert.deepEqual(res2.changed, [{ id: 'gym_strlen', test: '01' }]);
  const after = loadExercises(dir).find((f) => f.exercise.id === 'gym_strlen')!.exercise;
  assert.equal(after.tests[0]!.expected_stdout_b64, want);
});

test('content:check passes fixtures/ with an empty ignore list', { skip }, () => {
  const res = validate({ root: fixturesCopy(), image, write: false, log: quiet });
  assert.deepEqual(res.failures, []);
  assert.deepEqual(res.passing.sort(), ['gym_echo_first', 'gym_strlen']);
});

test('content:check names the exercise and stage of each failure', { skip }, () => {
  const dir = fixturesCopy();
  writeFileSync(join(dir, 'refs/gym_echo_first.c'),
    '#include <stdio.h>\n\nint\tmain(int argc, char **argv)\n{\n\tif (argc == 2)\n\t\tprintf("%s", argv[1]);\n\tprintf("\\n");\n\treturn (0);\n}\n');
  writeFileSync(join(dir, 'refs/gym_strlen.c'), 'int\tgym_strlen(char *str)\n{\n\tint\tunused;\n\n\treturn (str[0]);\n}\n');
  const res = validate({ root: dir, image, write: false, log: quiet });
  assert.deepEqual(res.passing, []);
  const by = Object.fromEntries(res.failures.map((f) => [f.id, f]));
  assert.equal(by.gym_echo_first?.stage, 'nm');
  assert.match(by.gym_echo_first?.detail ?? '', /printf/);
  assert.equal(by.gym_strlen?.stage, 'compile');
  assert.match(by.gym_strlen?.detail ?? '', /Werror|unused/);
});

test('synthetic seed: import → regen → check end to end', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ceg-content-'));
  importTrainer(makeSyntheticSeed(), root, quiet);
  const r = regen({ root, image, log: quiet });
  assert.deepEqual(r.failed, []);
  assert.equal(r.seedDiffs, 0);
  assert.match(readFileSync(join(root, 'regen-diff.log'), 'utf8'), /no differences/);
  const v = validate({ root, image, log: quiet });
  assert.deepEqual(v.failures, []);
  assert.equal(v.passing.length, 2);
  assert.match(readFileSync(join(root, 'toolchain-ignore.txt'), 'utf8'), /^$/);
});
