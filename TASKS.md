# TASKS: four work packages

The scaffold is in place: every endpoint in [DESIGN.md](DESIGN.md) §3 and §6.1 exists as a stub
that matches `@ceg/contract`, the DB schema is applied on startup, and `npm run check`
(type check + contract tests + SPA build) passes. The work below finishes the app.

## Rules for every package

- **Independent by construction.** Each package owns its directories and codes against the
  contract (`contract/src/*.ts`, DESIGN.md), not against another package's internals. Use
  `fixtures/` (`CONTENT_DIR=./fixtures`) instead of the private pool, and the stubs or a fake
  instead of another package's service.
- **Contract changes** go in one PR that updates `contract/`, DESIGN.md, the stubs and the
  contract tests together. Keep them rare and additive before Friday.
- **Done** means: the package's acceptance tests pass, `npm run check` passes at the root, and
  no route the package owns still sets `x-stub: 1`.
- **Never commit `content/`.** The pre-merge check is `git ls-files content/` printing only
  `content/README.md`.
- **Friday first.** The exam is Friday 27 Nov 2026. Priority order if time runs short:
  WP1 → WP3 (auth, practice, exam; hints last) → WP4 (editor, practice screen) → WP2 regen.
  If grading is not correct by Tuesday 24 Nov, drill on the seed CLI and keep building after
  the exam.

| WP | Owns | Needs from others (until they land) |
|---|---|---|
| WP1 Grader | `grader/` | `fixtures/` |
| WP2 Content pipeline | `scripts/`, `content/` layout, root `content:*` scripts | `grader/image/Dockerfile` (already there) |
| WP3 API backend | `api/` | dispatcher: a fake HTTP server in tests (shape from `contract/src/grader.ts`) |
| WP4 Web app | `web/` | API stubs (already answer with contract-shaped data) |

---

## WP1: Grader (dispatcher + sandbox image)

**Goal:** `POST /grade` grades a submission exactly as DESIGN.md §6 says, inside a hardened,
throwaway container, and never leaks expected output or references into the sandbox.

**Scope**
1. `grader/image/runner.sh` (+ helper if needed): copy `/in` → `/work`; compile A
   (`cc -Wall -Wextra -Werror -std=gnu17 -c`, 10 s, stderr capped 16 KiB); compile B with
   `-fno-builtin` + `nm -u` on the student object only, leading `_` stripped, checked against
   `allow.txt`; link (program alone, or + harness `main.c`); per test `setsid timeout -s KILL`,
   `ulimit -t 1 -s 8192`, argv from `job.json` (no shell), stdin or `/dev/null`,
   `head -c max+1`, process-group kill; print one `RunnerOutput` JSON line.
2. Dispatcher pipeline in `grader/dispatcher/src/`: content loader (`CONTENT_DIR`, SIGHUP
   reload); `file` and `static` stages; job dir under `JOBS_DIR/<job_id>/in` with no expected
   output; the exact `docker run` flags in §6.3; 30 s outer `docker kill` and `docker rm -f` +
   job dir removal in `finally`; byte-exact compare; KO reasons; `first_failure`; `cat -e`
   rendering per §6.4; `GradeJobResponse`.
3. Concurrency: semaphore `GRADER_CONCURRENCY`, FIFO queue `GRADER_QUEUE_MAX` then 503
   `grader_busy`, 1 in-flight job per `user_id`.
4. Startup guard: refuse to start if `docker info` warns about missing memory-limit support
   (print the `cgroup_enable=memory` fix). Interval cleanup of exited `grade-*` containers and
   job dirs older than 1 h. Real `GET /health` (`docker: true`, queue, running).
5. Print `cc --version` from the image in the README.

**Acceptance tests** (`npm run test:grading -w grader/dispatcher`, real Docker, `CONTENT_DIR=fixtures`)
- [ ] Unit: `catE()` renders `"a\tb\n"` → `"a\tb$"`, `"\x01"` → `"^A"`, `"\x7f"` → `"^?"`,
      `"\xc3\xa9"` → `"M-CM-)"`, and an empty buffer → `""`.
- [ ] Unit: compare gives `first_diff_byte` 3 for `"abc\n"` vs `"abc"`, and reason precedence
      timeout > signal > truncated > exit_code > output.
- [ ] `gym_echo_first` reference → `PASS`, `stage: "done"`, 5 × OK.
- [ ] `gym_strlen` reference (function, harness main) → `PASS`.
- [ ] `gym_echo_first` without the final `write(1, "\n", 1)` → `FAIL`, `stage: "tests"`,
      `first_failure.test_id: "01"`, `expected_cat_e: "abc$"`, `got_cat_e: "abc"`.
- [ ] A version using `printf` → `FAIL`, `stage: "nm"`, `forbidden: ["printf"]`,
      `message: "forbidden function: printf"`.
- [ ] An unused variable → `FAIL`, `stage: "compile"`, `compile_stderr` mentions `-Werror`.
- [ ] `gym_strlen.c` that also defines `main` → `FAIL`, `stage: "link"`.
- [ ] Wrong filename (`strlen.c`) → `FAIL`, `stage: "file"`, no container started.
- [ ] `__asm__` in the source → `FAIL`, `stage: "static"`.
- [ ] `while(1);` → KO with `timed_out: true` within 2 s + overhead; the whole job < 30 s.
- [ ] `while(1) fork();` → FAIL or timeout; afterwards `docker ps -a --filter name=grade-` is
      empty and the host still answers.
- [ ] Printing 1 MiB → KO `truncated`.
- [ ] `#include "/srv/grader/jobs/…"` or `#include "/content/refs/gym_echo_first.c"` →
      compile error; no expected output or reference text appears in `compile_stderr`.
- [ ] Inside the sandbox `id -u` is 65534, `/in` is read-only, there is no network
      (`connect()` fails), and `cat /proc/self/status` shows `NoNewPrivs: 1`.
- [ ] 3 concurrent jobs from 3 users with `GRADER_CONCURRENCY=2` → at most 2 `grade-*`
      containers at any moment; 2 jobs for the same user → second gets 503 `grader_busy`.
- [ ] Every job dir is removed after the job, including after a timeout.

---

## WP2: Content pipeline (import, regenerate, validate)

**Goal:** turn a local clone of `tomascoutotech/42-piscine-exam-trainer` into a private
`content/` tree (DESIGN.md §5) with expected outputs generated on the grader toolchain.

**Scope**
1. `scripts/import_trainer.ts <seed-clone>`: record `git rev-parse HEAD`; build the manifest
   from disk (`pool/level*/<name>/`), never a hard-coded list; parse the subject header
   (Assignment name / Expected files / Allowed functions); `kind = "function"` iff
   `tests/mains/<name>.c` exists; convert every `tests/cases/<name>/NN.cmd` once to an argv
   array (quotes handled, `| cat -e` stripped); copy `solucoes/` → `content/refs/`, mains →
   `content/harness/<id>/main.c`, `tests/include/` → `content/harness/include/`; write
   `content/exercises/<level>/<id>.json` with `subject_source: "42-derived-private"` and
   provenance; copy the seed LICENSE to `content/LICENSE-seed`; write `manifest.json`.
   Mark the first 2 tests of each exercise `visible: true`, the rest hidden.
2. `scripts/regen_expected.ts`: compile each reference **in `grader:pinned`** (`docker run`
   with the §6.3 flags, `--network none`) with the graded flags, run every test, overwrite
   `expected_stdout_b64` / `expected_exit`, and log every difference from the seed's `.out`
   files to `content/regen-diff.log`.
3. `scripts/validate.ts` (`npm run content:check`): every file passes
   `contract/schemas/exercise.schema.json`; every reference compiles and its `nm -u` (with
   `-fno-builtin`) ⊆ `allowed_functions` ∪ ignore list; an auto-mutant (drop the final
   newline of each test's output) differs; build the toolchain ignore list **only** from symbols
   the references trigger, print it for review and write `content/toolchain-ignore.txt` and
   `manifest.ignore_symbols`.
4. `scripts/fingerprint.ts`: winnowing fingerprints (k=5, w=4, normalized tokens) of each
   reference into `content/fingerprints/<id>.json` for the hint post-filter.
5. Make `scripts/` an npm workspace (`scripts/package.json`, add it to the root `workspaces`) and
   add root scripts `content:import`, `content:regen`, `content:check`, `content:fingerprint`.

**Acceptance tests** (`npm test -w scripts` for unit tests; the rest on a real seed clone)
- [ ] Unit: the `.cmd` → argv converter handles `./a.out "hello world" | cat -e` →
      `["hello world"]`, `./a.out 'a b' c` → `["a b","c"]`, `./a.out` → `[]`,
      `./a.out "" "x"` → `["","x"]`, escaped quotes, and stdin redirections if the seed has any.
- [ ] Unit: the subject header parser reads name, expected files and allowed functions from a
      synthetic subject (write your own; don't commit 42 text).
- [ ] Running the pipeline on `fixtures/` (as if it were imported content) reproduces the
      committed `expected_stdout_b64` values exactly.
- [ ] Import on the pinned seed commit produces 73 exercise files over levels 0–5
      (or a printed list explaining any difference) and every file validates against the schema.
- [ ] `content:check` reports N/73 references passing and prints the ignore list; any failure
      names the exercise and the stage.
- [ ] `regen-diff.log` exists; every diff in it is explained or fixed.
- [ ] No 42 text in git: `git ls-files content/` prints only `content/README.md`, and
      `git grep -l "Assignment name"` finds nothing.
- [ ] Running import twice is idempotent (no diff in `content/`).

---

## WP3: API backend

**Goal:** replace every stub in `api/` with the real behaviour of DESIGN.md §3, §4, §7, §8.

**Scope**
1. Content loader: read `CONTENT_DIR/exercises/*/*.json` at startup, reload on SIGHUP; map to
   `ExerciseSummary` / `ExerciseDetail` without expected outputs or `reference_path`.
2. Auth: `argon2` (argon2id), invites, `sessions` (store sha256 of the token), cookie
   `ceg_session` httpOnly + Secure + SameSite=Strict, 14 days; login rate limit; a preHandler
   that returns 401 on every protected route; `scripts/admin.ts create|invite`.
3. Practice: source normalization (§7), per-user limits (6/min, 1 in flight), call
   `DISPATCHER_URL/grade` with a new `job_id`, store `submissions` (full response in
   `result_json`), strip `test_details`, `attempt_no`; history; submission detail (owner only);
   solution reveal rules + `reveals`.
4. Exams: profiles from `config/exam-profiles.json`; start (409 if active); random draw per
   slot avoiding repeats; grademe with cooldown (429 + `next_grade_at`), fail policy, scoring,
   410 after `ends_at` (not graded), expiry on read; finish; question endpoint; hints and
   reveal → 403 while an exam is active.
5. Hints (`HINTS_ENABLED`): level gating and anti-farming; deterministic `diff` hint first;
   then the OpenRouter client (`deepseek/deepseek-v4-flash-0731`, reasoning off, fallbacks,
   provider ignore), post-filter, regenerate-once, canned fallback, `hint_cache`, `hint_log`,
   quotas and the $2/day stop. Prompts in `api/prompts/` verbatim from the brief §9.
6. Health: real `grader` status (ping the dispatcher) and exercise count. Delete `stubs.ts`.

**Acceptance tests** (`npm test -w api`; a fake dispatcher on a random port, `:memory:` DB,
`CONTENT_DIR=fixtures`)
- [ ] `test/contract.test.ts` still passes (update it to log in first).
- [ ] Register with a valid invite → 201 and a cookie with `HttpOnly`, `Secure`,
      `SameSite=Strict`; the same invite again → 401; login → 200; logout → 204 and the old
      cookie then gets 401 on `/api/me`.
- [ ] Every protected route returns 401 without a cookie (iterate the route table).
- [ ] The DB stores an `$argon2id$` hash and the sha256 of the session token, never the token.
- [ ] Practice submit forwards the normalized source (CRLF → LF) to the fake dispatcher, stores
      the row, and the response has no `test_details`; non-ASCII outside literals → 422
      `bad_source` with line and column; the 7th submit within a minute → 429 `rate_limited`.
- [ ] `GET /api/exercises/:id` never contains `expected_stdout_b64` or `reference_path`
      (check every fixture).
- [ ] Solution: 403 before any attempt, 200 after one, 403 during an active exam.
- [ ] Exam: start → slot 0 at level 0; a second start → 409; FAIL → 429 `cooldown` until
      `next_grade_at` (fake clock), then a different exercise at the same level
      (`new_exercise`); PASS → +6 points and slot 1; after `ends_at` → 410 and no submission row;
      finish → `status: "finished"`; scoring on a scripted run of 16 passes totals 100.
- [ ] Hints: 403 during an exam; `need_failed_run` before any FAIL; L1 after 1 FAIL; L2 needs
      ≥ 2 FAILs and an L1 seen; L3 needs ≥ 4 FAILs and ≥ 8 min; the same code hash twice →
      409 `hint_not_eligible`; quota exhaustion → 429.
- [ ] Post-filter unit tests: any code in an L1 output is rejected; an L2 output with 2 code
      lines is rejected; an L3 skeleton that copies the reference (containment ≥ 0.35) is
      rejected; a non-allowlisted function name is rejected; "ignore previous instructions" in
      the student code yields the fixed refusal + L1.
- [ ] OpenRouter client test with a mocked `fetch`: request body has the model id,
      `reasoning: {"enabled": false}`, the fallback `models` array and the hashed `user`; a
      response with `reasoning_tokens > 0` is logged as a guard failure; every call writes a
      `hint_log` row.
- [ ] `GET /api/health` reports `grader: "down"` when the dispatcher is unreachable.

---

## WP4: Web app (mobile editor and screens)

**Goal:** the SPA in `web/`, phone-first, against the API contract. Develop against the stubs
(`npm run dev:api` + `npm run dev:web`).

**Scope**
1. CodeMirror 6 editor with explicit extensions exactly as brief §9 "Mobile editor
   requirements" lists (pins: `@codemirror/view@^6.43.15`, `state@^6.7`, `commands@^6.11`,
   `language@^6.13`, `lang-cpp@^6.0.3`, `autocomplete@^6.20.4`; no `basicSetup`, no Monaco).
   Tabs, 16 px font on coarse pointers, autocomplete from `autocomplete_words` + C keywords +
   `completeAnyWord` outside strings/comments, a "practice without autocomplete" toggle, the
   `cm_edit_context=off` flag.
2. Key bar (`Tab { } ( ) ; * & " ' [ ] < > = ! \`) + Grade button in a fixed bottom bar
   re-anchored from `visualViewport` (resize, scroll, focusout), safe-area padding.
3. Screens: login/register; exercise list by level with solved / solved-without-hints marks;
   practice screen (subject, editor, Grade, result with [OK]/[KO] row, first failure in
   `cat -e` form, "visible whitespace" toggle from the `_b64` fields, compile errors,
   forbidden functions, history, solution reveal after an attempt); hints panel with "AI hint
   may be wrong" and a "this hint was wrong" button; exam screen (profile picker, clock,
   `status`, `grademe` with confirm dialog, cooldown countdown, `finish`), no hints or reveal
   there; progress headline "solved without hints".
4. Per-exercise draft autosave in `localStorage` (keyed by user + exercise).
5. Footer disclaimer on every screen; `npm run check:cm` asserting a single copy of
   `@codemirror/state` and `@codemirror/view`.

**Acceptance tests** (`npm run test:e2e -w web`: Playwright against `vite preview` + the API
stubs; iPhone 15 and Pixel 8 device profiles)
- [ ] The key bar renders on a coarse pointer and is hidden on a fine pointer.
- [ ] Tapping `(` inserts `()` with the caret between them, and `document.activeElement` is
      still inside `.cm-content`; `Tab` inserts `\t`.
- [ ] The Grade button stays visible with the editor focused; it is disabled while a grade
      request is in flight.
- [ ] A stubbed FAIL result shows `[OK] [KO]`, the hidden-test label, and
      `expected: $` / `got: ` in `cat -e` form; the whitespace toggle shows `\n` as visible.
- [ ] Exam screen: grademe asks for confirmation; a stubbed 429 `cooldown` shows a countdown
      to `next_grade_at`; there are no hint or solution controls.
- [ ] Every input and the editor compute `font-size >= 16px` at the iPhone profile, and the
      viewport meta has no `maximum-scale`.
- [ ] `npm run check:cm` prints one copy each of `@codemirror/state` and `@codemirror/view`.
- [ ] Manual, on real devices over the Tailscale URL (record results in the PR):
      iPhone Safari and Android GBoard; tap each key 20×; type `ft_putch` then `(`; accept
      autocomplete by tap and by Enter; focus every input without zoom; open/close the keyboard
      5× with the Grade bar placed correctly.

---

## After all four land (integration, not a package)

- [ ] `docker compose --profile build build && docker compose up -d` on the Pi (arm64).
- [ ] Import the seed, regen, `content:check`, then grade every reference through the real
      dispatcher: N/73 PASS.
- [ ] End to end on a phone: register with an invite, solve `gym_echo_first`, fail it once on
      purpose, see the `cat -e` diff, start a Piscine exam and pass slot 0.
