import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containment, fingerprint, normalizeTokens, winnow } from '../lib/winnow.ts';

const A = `#include <unistd.h>
/* count */
int\tmy_len(char *s)
{
\tint\ti;

\ti = 0; // start
\twhile (s[i] != '\\0')
\t\ti++;
\treturn (i);
}
`;
// Same code, renamed identifiers, different layout and comments.
const B = `int count_chars(char *str) { int n; n = 0; while (str[n] != '\\0') n++; return (n); }`;

test('normalization drops comments and includes, abstracts names and literals', () => {
  assert.deepEqual(normalizeTokens('#include "x.h"\nint f(void) { return write(1, "a\\"b", 3) + \'c\'; }'),
    ['int', 'I', '(', 'void', ')', '{', 'return', 'I', '(', 'N', ',', 'S', ',', 'N', ')', '+', 'C', ';', '}']);
  assert.deepEqual(normalizeTokens('a->b <<= c++ // x\n'), ['I', '->', 'I', '<<=', 'I', '++']);
});

test('fingerprint is deterministic and invariant to renaming and layout', () => {
  const fa = fingerprint('a', A);
  assert.deepEqual(fa, fingerprint('a', A));
  assert.equal(fa.k, 5);
  assert.equal(fa.w, 4);
  assert.ok(fa.hashes.length > 0);
  assert.deepEqual(fingerprint('b', B).hashes, fa.hashes);
  assert.equal(containment(fingerprint('b', B).hashes, fa.hashes), 1);
});

test('unrelated code has low containment', () => {
  const other = 'void f(int *t, int n) { int j; for (j = n - 1; j > 0; j--) if (t[j] < t[j - 1]) { int x = t[j]; t[j] = t[j - 1]; t[j - 1] = x; } }';
  assert.ok(containment(fingerprint('o', other).hashes, fingerprint('a', A).hashes) < 0.35);
  assert.equal(containment([], [1, 2]), 0);
});

test('winnow picks the rightmost minimum of every window, once', () => {
  assert.deepEqual(winnow([5, 3, 4, 3, 9, 8, 7, 1], 4).map((p) => p.pos), [3, 7]);
  assert.deepEqual(winnow([2, 1], 4), [{ hash: 1, pos: 1 }]);
  assert.deepEqual(winnow([], 4), []);
});
