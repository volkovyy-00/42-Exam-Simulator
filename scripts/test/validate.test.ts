import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../lib/content.ts';
import { classifySymbols, isToolchainSymbol, mutantDiffers, schemaValidator } from '../validate.ts';

test('fixtures pass the exercise schema; broken files do not', () => {
  const v = schemaValidator();
  for (const f of ['exercises/0/gym_echo_first.json', 'exercises/1/gym_strlen.json']) {
    const ex = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', f), 'utf8')) as Record<string, unknown>;
    assert.ok(v(ex), JSON.stringify(v.errors));
    assert.equal(v({ ...ex, level: 6 }), false);
    assert.equal(v({ ...ex, extra: 1 }), false);
    assert.equal(v({ ...ex, expected_files: ['a.c', 'b.c'] }), false);
  }
  const fn = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/exercises/1/gym_strlen.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(v({ ...fn, prototype: null }), false);
});

test('ignore list candidates are toolchain symbols only', () => {
  assert.ok(isToolchainSymbol('_stack_chk_fail'));
  assert.ok(isToolchainSymbol('GLOBAL_OFFSET_TABLE_'));
  assert.ok(!isToolchainSymbol('printf'));
  assert.deepEqual(classifySymbols(['write', '_stack_chk_fail', 'strlen'], ['write']),
    { toolchain: ['_stack_chk_fail'], forbidden: ['strlen'] });
});

test('auto-mutant', () => {
  const b = (s: string) => Buffer.from(s).toString('base64');
  assert.deepEqual(mutantDiffers([b('abc\n'), b('')]), { differs: true, kind: 'drop-final-newline' });
  assert.deepEqual(mutantDiffers([b('a')]), { differs: true, kind: 'add-final-newline' });
  assert.deepEqual(mutantDiffers([]), { differs: false, kind: 'add-final-newline' });
});
