# scripts (WP2 content pipeline)

Turns a local clone of `tomascoutotech/42-piscine-exam-trainer` into the private, git-ignored
`content/` tree described in DESIGN.md §5. Nothing here contains 42 text; the unit tests use
synthetic subjects.

```sh
git clone https://github.com/tomascoutotech/42-piscine-exam-trainer /tmp/seed
npm run content:import -- /tmp/seed     # exercises, refs, harness, manifest (provisional outputs)
npm run content:regen                   # expected outputs generated in grader:pinned
npm run content:check                   # schema + reference compile/nm/link/tests + mutant, N/73
npm run content:fingerprint             # winnowing fingerprints for the hint post-filter
```

Run them in this order. Re-running import resets `exercises/`, `refs/`, `harness/`,
`seed-cases/` and `manifest.json` (so run regen and check again afterwards); it leaves `hints/`
and `fingerprints/` alone.

Every command takes `--content <dir>` (default `$CONTENT_DIR`, else `<repo>/content`). Regen and
check take `--image <tag>` (default `$GRADER_IMAGE`, else `grader:pinned`) and `--only id,id`.
`regen --check` writes nothing and exits 1 if any expected value would change.
`content:check --no-write` skips writing `toolchain-ignore.txt` and `manifest.ignore_symbols`.

## What each step does

- **import_trainer.ts** lists `pool/level*/<name>/` on disk, records `git rev-parse HEAD`, parses
  the subject header (`lib/subject.ts`), sets `kind: "function"` iff `tests/mains/<name>.c`
  exists, converts each `tests/cases/<name>/NN.cmd` once to an argv array (`lib/cmd.ts`: quotes,
  empty args, escaped quotes, newlines inside quotes, `< file` stdin, trailing `| cat -e`
  stripped; anything a shell would expand is rejected), and marks the first 2 tests visible.
  Headers the harness main includes become `harness.includes` (`harness/include/*.h` for the
  shared ones, `harness/<id>/*.h` otherwise); a header only the reference uses is inlined into
  `refs/<id>.c` so the reference is one file, like a submission. Subjects whose expected files
  are `*.c, *.h` or list a header are mapped to `<id>.c` (v1 grades one file) and noted.
  The seed's raw `.cmd`/`.out` files are kept in `content/seed-cases/<id>/` for regen's diff log.
  `generated_at` is the seed commit's date, so the import is byte-for-byte idempotent.
- **regen_expected.ts** runs each reference in the grader image with the DESIGN.md §6.3
  `docker run` flags (`--network none`, `/work` tmpfs `uid=65534,gid=65534`, read-only `/in`, …)
  and the graded flags (`-Wall -Wextra -Werror` + `cflags_extra`), using its own small
  in-container script (`lib/sandbox.ts`) because `runner.sh` belongs to WP1. If `grader:pinned`
  is missing it is built from `grader/image` (read-only use). It overwrites
  `expected_stdout_b64`/`expected_exit` and writes `content/regen-diff.log` with every
  difference from the seed's `.out` files (rendered with `cat -e` when the seed piped through it).
- **validate.ts** (`content:check`) checks every file against
  `contract/schemas/exercise.schema.json` plus id/level/file consistency, then per reference:
  compile, `nm -u` with `-fno-builtin` (one leading `_` stripped) ⊆ allowed ∪ ignore list, link,
  tests equal the expected values, and the auto-mutant (drop each output's final newline; if no
  output ends in one, append one) differs. The ignore list is built only from symbols the
  references trigger outside their allowlist and only if they look like toolchain symbols
  (`__*`, `_GLOBAL_OFFSET_TABLE_`); anything else fails the exercise at `nm`. It prints the list
  and `N/<total> references passing`, and writes `toolchain-ignore.txt` and
  `manifest.ignore_symbols`.
- **fingerprint.ts** writes `content/fingerprints/<id>.json`:
  `{ id, k: 5, w: 4, normalization: "c-tokens-v1", token_count, hashes: number[] }`.
  Normalization and hashing are in `lib/winnow.ts` (comments and `#include` lines dropped,
  identifiers → `I`, numbers → `N`, strings → `S`, chars → `C`, keywords and punctuators kept;
  FNV-1a 32-bit per 5-gram; rightmost minimum per window of 4). Containment of a candidate in a
  reference is `|A ∩ B| / |A|` over `hashes` (`containment()`).

## Tests

- `npm test -w scripts`: unit tests, no Docker.
- `npm run test:docker -w scripts`: regen reproduces `fixtures/` exactly, `content:check` passes
  `fixtures/` and names the stage of broken references, and a synthetic seed goes through
  import → regen → check. Needs Docker and the grader image (`GRADER_IMAGE=<tag>` to use
  another one).
