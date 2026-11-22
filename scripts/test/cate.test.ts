import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catE, firstDiff, uncatE } from '../lib/cate.ts';

const b = (s: string) => Buffer.from(s, 'latin1');

test('catE follows cat -e', () => {
  assert.equal(catE(b('a\tb\n')).toString('latin1'), 'a\tb$\n');
  assert.equal(catE(b('\x01')).toString('latin1'), '^A');
  assert.equal(catE(b('\x7f')).toString('latin1'), '^?');
  assert.equal(catE(b('\xc3\xa9')).toString('latin1'), 'M-CM-)');
  assert.equal(catE(b('\x8a\xff')).toString('latin1'), 'M-^JM-^?');
  assert.equal(catE(b('')).length, 0);
});

test('uncatE inverts catE on unambiguous input', () => {
  for (const s of ['abc\n', '', 'a', '$\n', 'x$$y\n\n', '\x00\x1f\x7f\t', '\x80\xc3\xa9\x8a\xff\n']) {
    assert.deepEqual(uncatE(catE(b(s))), b(s), JSON.stringify(s));
  }
});

test('firstDiff', () => {
  assert.equal(firstDiff(b('abc\n'), b('abc')), 3);
  assert.equal(firstDiff(b('abc'), b('abd')), 2);
  assert.equal(firstDiff(b('abc'), b('abc')), null);
});
