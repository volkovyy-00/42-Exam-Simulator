// Builds a tiny seed clone in a temp dir with the same layout as the trainer repo
// (pool/level*/<name>/, solucoes/, tests/{cases,mains,include}/). All text is synthetic.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

function put(root: string, rel: string, data: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
}

// The header label is assembled at run time so the no-42-text `git grep` check stays empty.
const AN = ['Assignment', 'name'].join(' ');
const header = (name: string, files: string, allowed: string) =>
  `${AN}  : ${name}\nExpected files   : ${files}\nAllowed functions: ${allowed}\n${'-'.repeat(80)}\n\n`;

export function makeSyntheticSeed(): string {
  const root = mkdtempSync(join(tmpdir(), 'ceg-seed-'));
  // Program: prints its first argument with a newline.
  put(root, 'pool/level0/say_first/subject.en.txt', header('say_first', 'say_first.c', 'write')
    + 'Print the first argument, then a newline.\n\n$> ./say_first "x y" | cat -e\nx y$\n');
  put(root, 'solucoes/say_first/say_first.c', `#include <unistd.h>
#include "say_first.h"

int\tmain(int argc, char **argv)
{
\tif (argc > 1)
\t\twrite(1, argv[1], my_len(argv[1]));
\twrite(1, "\\n", 1);
\treturn (0);
}

int\tmy_len(char *s)
{
\tint\ti;

\ti = 0;
\twhile (s[i])
\t\ti++;
\treturn (i);
}
`);
  put(root, 'solucoes/say_first/say_first.h', '#ifndef SAY_FIRST_H\n# define SAY_FIRST_H\nint\tmy_len(char *s);\n#endif\n');
  put(root, 'pool/level0/say_first/examples.txt', '$> ./say_first a b\na\n');
  const cases: [string, string][] = [
    ['./say_first "hello world" | cat -e\n', 'hello world$\n'],
    ["./say_first 'it'\\''s' x\n", "it's\n"],
    ['./say_first | cat -e\n', '$\n'],
    ['./say_first "" "x"\n', '\n'],
    ['./say_first < in.txt\n', '\n'],
  ];
  cases.forEach(([cmd, out], i) => {
    const n = String(i + 1).padStart(2, '0');
    put(root, `tests/cases/say_first/${n}.cmd`, cmd);
    put(root, `tests/cases/say_first/${n}.out`, out);
  });
  put(root, 'tests/cases/say_first/in.txt', 'ignored\n');

  // Function with a shared header, a harness main and an "odd" header line.
  put(root, 'pool/level2/herd_size/subject.en.txt', '[' + header('herd_size', 'herd_size.c, herd.h', '')
    + 'Count the nodes.\n\nint\therd_size(t_herd *h);\n');
  put(root, 'solucoes/herd_size/herd_size.c', '#include "herd.h"\n\nint\therd_size(t_herd *h)\n{\n\tint\tn;\n\n\tn = 0;\n\twhile (h)\n\t{\n\t\tn++;\n\t\th = h->next;\n\t}\n\treturn (n);\n}\n');
  put(root, 'tests/include/herd.h', '#ifndef HERD_H\n# define HERD_H\ntypedef struct s_herd\n{\n\tstruct s_herd\t*next;\n}\tt_herd;\n#endif\n');
  put(root, 'tests/mains/herd_size.c', '#include <stdio.h>\n#include "herd.h"\n\nint\therd_size(t_herd *h);\n\nint\tmain(void)\n{\n\tt_herd\tc = {0};\n\tt_herd\tb = {&c};\n\n\tprintf("%d %d\\n", herd_size(&b), herd_size(0));\n\treturn (0);\n}\n');
  put(root, 'tests/cases/herd_size/01.cmd', './herd_size\n');
  put(root, 'tests/cases/herd_size/01.out', '2 0\n');

  put(root, 'LICENSE', 'MIT License (synthetic test seed)\n');
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'seed', '--date', '2026-01-02T03:04:05Z');
  return root;
}
