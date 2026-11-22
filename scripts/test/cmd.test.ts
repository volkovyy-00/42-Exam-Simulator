import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CmdParseError, parseCmd } from '../lib/cmd.ts';

const argv = (s: string) => parseCmd(s).argv;

test('TASKS.md WP2 cases', () => {
  assert.deepEqual(parseCmd('./a.out "hello world" | cat -e\n'), {
    program: './a.out', argv: ['hello world'], cat_e: true, stdin_file: null,
  });
  assert.deepEqual(argv("./a.out 'a b' c"), ['a b', 'c']);
  assert.deepEqual(argv('./a.out'), []);
  assert.deepEqual(argv('./a.out\n'), []);
  assert.deepEqual(argv('./a.out "" "x"'), ['', 'x']);
});

test('escaped quotes and backslashes', () => {
  assert.deepEqual(argv('./a.out "say \\"hi\\"" | cat -e'), ['say "hi"']);
  assert.deepEqual(argv("./a.out 'it'\\''s'"), ["it's"]);
  assert.deepEqual(argv('./a.out it\\\'s'), ["it's"]);
  assert.deepEqual(argv('./a.out "a\\\\b"'), ['a\\b']);
  // In double quotes a backslash before anything else stays literal (POSIX sh).
  assert.deepEqual(argv('./a.out "x\\ny"'), ['x\\ny']);
  assert.deepEqual(argv("./a.out '\\t'"), ['\\t']);
});

test('quoting details', () => {
  assert.deepEqual(argv('./a.out vincent mit "l\'ane" dans'), ['vincent', 'mit', "l'ane", 'dans']);
  assert.deepEqual(argv("./a.out '' '{[(0 + 0)]}'"), ['', '{[(0 + 0)]}']);
  assert.deepEqual(argv('./a.out "123" "*" 456'), ['123', '*', '456']);
  assert.deepEqual(argv('./a.out a"b c"d'), ['ab cd']);
  assert.deepEqual(argv('./a.out   a\t\tb  '), ['a', 'b']);
  assert.deepEqual(argv('./a.out -%'), ['-%']);
  // A newline inside quotes is part of the argument; the final line end is not.
  assert.deepEqual(argv('./a.out "++[>\n<-]" | cat -e\n'), ['++[>\n<-]']);
  // `<` inside quotes is not a redirection.
  assert.deepEqual(parseCmd('./a.out "<<<-]" | cat -e').stdin_file, null);
});

test('pipe variants', () => {
  assert.equal(parseCmd('./a.out x |cat -e').cat_e, true);
  assert.equal(parseCmd('./a.out x|cat -e').cat_e, true);
  assert.equal(parseCmd('./a.out x').cat_e, false);
  assert.throws(() => parseCmd('./a.out x | wc -l'), CmdParseError);
  assert.throws(() => parseCmd('./a.out x | cat -e | cat'), CmdParseError);
});

test('stdin redirection', () => {
  assert.deepEqual(parseCmd('./a.out a < in.txt | cat -e'), {
    program: './a.out', argv: ['a'], cat_e: true, stdin_file: 'in.txt',
  });
  assert.deepEqual(parseCmd('./a.out <in.txt').stdin_file, 'in.txt');
  assert.throws(() => parseCmd('./a.out <'), CmdParseError);
  assert.throws(() => parseCmd('./a.out << EOF'), CmdParseError);
});

test('rejects what a shell would expand or that has no argv equivalent', () => {
  for (const bad of ['./a.out $HOME', './a.out "$HOME"', './a.out *', './a.out a?', './a.out ~',
    './a.out a; ls', './a.out > f', './a.out `id`', './a.out "unterminated', "./a.out 'x", '']) {
    assert.throws(() => parseCmd(bad), CmdParseError, bad);
  }
  // A lone $ before a closing quote is literal in sh.
  assert.deepEqual(argv('./a.out "a$"'), ['a$']);
});
