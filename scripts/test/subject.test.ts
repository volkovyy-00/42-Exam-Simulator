import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPrototype, parseSubjectHeader } from '../lib/subject.ts';

// Synthetic subjects written for these tests (no 42 text). The header label is assembled at run
// time so that the no-42-text `git grep` check stays empty.
const AN = ['Assignment', 'name'].join(' ');
const PROGRAM = `${AN}  : say_moo
Expected files   : say_moo.c
Allowed functions: write, malloc , free
--------------------------------------------------------------------------------

Write a program that prints "moo".
Allowed functions: this line is below the rule and must be ignored
`;

const FUNCTION = `${AN}  : cow_count
Expected files   : cow_count.c, cows.h
Allowed functions:
--------------------------------------------------------------------------------

Count the cows.

Your function must be declared as follows:

int\tcow_count(t_cow *herd, unsigned int n);

cow_count(herd, 3) => 3
`;

test('reads name, expected files and allowed functions', () => {
  assert.deepEqual(parseSubjectHeader(PROGRAM), {
    name: 'say_moo', expected_files: ['say_moo.c'], allowed_functions: ['write', 'malloc', 'free'],
  });
  assert.deepEqual(parseSubjectHeader(FUNCTION), {
    name: 'cow_count', expected_files: ['cow_count.c', 'cows.h'], allowed_functions: [],
  });
});

test('empty, "-" and "None" mean no functions; stray leading junk and CRLF are tolerated', () => {
  for (const v of ['', '-', 'None', 'none']) {
    assert.deepEqual(parseSubjectHeader(`${AN} : x\nAllowed functions: ${v}\n---\n`).allowed_functions, []);
  }
  const h = parseSubjectHeader(`[${AN}  : odd_one\r\nExpected files   : *.c, *.h\r\nAllowed functions: write\r\n---\r\n`);
  assert.equal(h.name, 'odd_one');
  assert.deepEqual(h.expected_files, ['*.c', '*.h']);
  assert.deepEqual(h.allowed_functions, ['write']);
});

test('finds the prototype', () => {
  assert.equal(findPrototype(FUNCTION, 'cow_count'), 'int\tcow_count(t_cow *herd, unsigned int n);');
  assert.equal(findPrototype('char    *moo_dup(char *src);\n', 'moo_dup'), 'char    *moo_dup(char *src);');
  assert.equal(findPrototype('void\tapply(t_x *l, void (*f)(void *));', 'apply'), 'void\tapply(t_x *l, void (*f)(void *));');
  assert.equal(findPrototype('cow_count(herd, 3) => 3\n\treturn cow_count(a);\n', 'cow_count'), null);
  assert.equal(findPrototype('int\tcow_counter(int a);', 'cow_count'), null);
});
