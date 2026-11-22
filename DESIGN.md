# C Exam Gym: design

A private, self-hosted web app for practising the 42 Piscine C exam from a phone or laptop.
It runs on a Raspberry Pi 4 (arm64, 1.8 GiB RAM), is reachable only over Tailscale, and serves 20 to 40
invite-only users. Everything in this document is the contract that the four work packages in
[TASKS.md](TASKS.md) build against. If code and this document disagree, fix one of them in the
same commit.

Source material: `42-exam-trainer-brief.md` and `intent.md` (2026-11-21). Section numbers like
"brief §5" point into the brief.

## 0. Decisions taken (defaults from the brief)

The open questions in `intent.md` were resolved with the brief's recommended defaults, confirmed by the project owner on 2026-11-21. Pi RAM (row 8) has since been measured on the real Pi 4.

| # | Question | Decision |
|---|---|---|
| 1 | Exam profile | **Piscine** (`piscine_exam`, levels 0–5, 240 min) plus `piscine_final` (480 min). `rank02` exists in config but `enabled: false`. |
| 2 | Piscine scoring | **Seed model**: 16 questions (L0×2, L1–L4×3, L5×2), 6 points each, the last worth 10 (max 100), pass at 30. Pass mark, points and fail policy are config. Labelled "approximation" in the UI. |
| 3 | Scope before Friday 27 Nov | **Grading + editor first, hints behind `HINTS_ENABLED`** (default `false`). If LLM hints are not stable by day 3, ship the deterministic diff-only hint. Practise on the seed's `./exam` CLI meanwhile. |
| 4 | Access | **Tailscale only.** `web` binds `127.0.0.1:8042`; `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8042` (its own port: 443 is taken by another service on the Pi). No LAN/Caddy, no root certificates on phones. `Tailscale-User-*` headers are ignored. |
| 5 | Host changes | Required before launch, documented in DEPLOY.md: `cgroup_enable=memory`, full upgrade + reboot for GhostLock (CVE-2026-43499), Tailscale ACL. Nothing in this repo changes the host. |
| 6 | Timeouts / cooldown | **2 s wall + 1 s CPU per test**, 10 s compile, 30 s whole submission. Cooldown after a FAIL in exam mode: `[0.5, 2.5, 3, 5.5, 8.5, 14, 22.5]` minutes, repeating the last, grows with each FAIL in the same slot (a failed grademe draws a new exercise but keeps the count) and resets when the slot is passed, labelled "approximation". **No cooldown in practice mode** (the per-user rate limit still applies). |
| 7 | Hint model | **`deepseek/deepseek-v4-flash-0731`**, `reasoning: {"enabled": false}`, fallbacks `deepseek/deepseek-v4.1-flash-1017`, `anthropic/claude-haiku-5.5`; provider ignore list `["Inceptron"]`. Limits: 25 uncached calls/user/day, 3/exercise/user/day, $2/day app-wide stop, $10 OpenRouter key cap. |
| 8 | Pi RAM | **Pi 4, 1.8 GiB**; measured peak 843 MiB during tests. Worst case for the app is **832 MiB**: `GRADER_CONCURRENCY=1` × 256 MiB sandbox + web 320 MiB + dispatcher 256 MiB. Check `free -h` before launch. |
| – | Content licensing | `content/` is git-ignored. 42-derived subject texts are © 42 / École 42. Only original fixtures (`fixtures/`) are committed. Footer disclaimer on every page. |
| – | Sandbox | Hardened `docker run --rm` (runc) per submission. gVisor is out: on the Pi 4 (4K-page kernel) the 16K-page blocker is gone, but the stock kernel's 39-bit VA (VA_BITS_39) still rules it out. |
| – | Repo layout | `api/` is the brief's `web` service (Fastify; also serves the built SPA). `web/` is the SPA. `grader/` holds the dispatcher and the sandbox image. |
| – | TypeScript | Node 22 (≥ 22.18) runs `.ts` directly via type stripping, so the backend has no build step. Only erasable TS syntax (no `enum`, no `namespace`, no parameter properties). `tsc --noEmit` is the type check. |

## 1. Repo layout

```
c-exam-gym/
├── DESIGN.md                this file
├── TASKS.md                 the four work packages
├── README.md                quick start, host prerequisites
├── docker-compose.yml       web, grader-dispatcher, grader-image (profile "build")
├── .env.example             every env var with its default
├── package.json             npm workspaces: contract, api, web, grader/dispatcher
├── tsconfig.base.json
├── contract/                @ceg/contract: TypeScript types only (no runtime code)
│   ├── src/api.ts           public HTTP API (§3)
│   ├── src/grader.ts        dispatcher API + runner I/O (§6)
│   ├── src/exercise.ts      exercise file type (§5)
│   └── schemas/exercise.schema.json
├── api/                     Fastify service "web" (port 8042)
│   ├── src/server.ts        entry point
│   ├── src/app.ts           buildApp(): registers routes, used by tests
│   ├── src/config.ts        env parsing
│   ├── src/db.ts            opens SQLite (WAL), applies schema.sql
│   ├── src/schema.sql       DB schema (§4)
│   ├── src/context.ts       shared services (Ctx), clock, ISO time helpers
│   ├── src/auth.ts          argon2id, invites, sessions, cookie, login limiter
│   ├── src/content.ts       content loader (SIGHUP reload), client view of exercises
│   ├── src/normalize.ts     source normalization (§7)
│   ├── src/grader.ts        dispatcher HTTP client
│   ├── src/submissions.ts   grading pipeline shared by practice and grademe
│   ├── src/exams.ts         exam state machine (§3.7)
│   ├── src/hints/           report + diff hint, post-filter, OpenRouter client, service (§8)
│   ├── src/routes/*.ts      one file per area: auth, exercises, practice, hints, exams, health
│   ├── prompts/             hint-v1.txt (system), hint-user-v1.txt (user template)
│   ├── scripts/admin.ts     admin CLI: create | invite
│   ├── config/exam-profiles.json
│   ├── test/                contract + acceptance tests (fake dispatcher, :memory: DB)
│   └── Dockerfile           builds web/ and runs api/
├── web/                     Vite + React + TS SPA
│   └── src/api.ts           typed client for every endpoint in §3
├── grader/
│   ├── dispatcher/          Node service, the only holder of docker.sock
│   │   ├── src/server.ts    POST /grade, GET /health (internal network only)
│   │   └── Dockerfile
│   └── image/               grader:pinned sandbox image (debian:trixie-slim + gcc)
│       ├── Dockerfile
│       └── runner.sh        runs inside the sandbox (§6.3)
├── fixtures/                ORIGINAL exercises (MIT), same layout as content/, used by tests
├── scripts/                 (WP2) import_trainer.ts, regen_expected.ts, validate.ts
├── content/                 GIT-IGNORED. Imported 42-derived pool. Layout in §5.2
└── data/                    GIT-IGNORED. SQLite database (gym.sqlite)
```

## 2. Runtime architecture

```
phone ──HTTPS (tailscale serve, ts.net cert)──▶ 127.0.0.1:8042  web (api/ + built SPA)
                                                   │  SQLite ./data, reads ./content (ro)
                                                   │  OpenRouter (hints, egress network)
                                                   ▼  HTTP on the "internal" network only
                                          grader-dispatcher :9000 (no published port)
                                                   │  /var/run/docker.sock, ./content (ro)
                                                   │  /srv/grader/jobs (same path as host)
                                                   ▼
                              docker run --rm grader:pinned /runner.sh   (one per submission)
```

- `web` never sees `docker.sock`. The dispatcher never talks to the internet.
- Expected outputs and references never enter the sandbox, the SPA bundle, an API response
  (except the first failing test's expected bytes, and the solution reveal in practice mode),
  or an LLM prompt.

## 3. Public HTTP API (served by `api/`)

TypeScript types for every body below are in `contract/src/api.ts`; the names in brackets are
those types. All bodies are JSON (`content-type: application/json`). Times are ISO 8601 UTC
strings. `source` is the student's C file as a UTF-8 string.

### 3.1 Conventions

- **Auth:** session cookie `ceg_session` (httpOnly, Secure, SameSite=Strict, Path=/, 14 days).
  Every route except `GET /api/health`, `POST /api/auth/register` and `POST /api/auth/login`
  returns `401` without a valid session.
- **CSRF:** SameSite=Strict plus "JSON only": mutating routes reject any content type other than
  `application/json` with `415`.
- **Errors** [`ApiError`]: `{"error": "<code>", "message": "human readable"}`, optionally with
  `retry_after_s` and `next_grade_at`.

| HTTP | `error` | When |
|---|---|---|
| 400 | `bad_request` | Validation failed |
| 401 | `unauthorized` | No or expired session, wrong login |
| 403 | `forbidden` | Hints or reveal in exam mode, reveal before an attempt, non-admin |
| 404 | `not_found` | Unknown exercise, exam, submission |
| 409 | `conflict` | Username taken, invite used, exam already active |
| 409 | `hint_not_eligible` | Not enough failed attempts, or code unchanged since last hint |
| 410 | `exam_over` | Grademe after the exam's end time |
| 415 | `unsupported_media_type` | Non-JSON body on a mutating route |
| 422 | `bad_source` | CRLF fixed silently; non-ASCII outside literals, or file too large (> 64 KiB) |
| 429 | `rate_limited` | > 6 submissions/min/user, or hint quota used |
| 429 | `cooldown` | Exam grademe before `next_grade_at` |
| 503 | `grader_busy` | Queue depth 20 reached, or 1 submission already in flight for this user |
| 503 | `hints_disabled` | `HINTS_ENABLED=false`, or the $2/day stop tripped |
| 501 | `not_implemented` | Stub routes may return this while a work package is in progress |

- **Stub marker:** while a route is still a stub it sets the response header `x-stub: 1`.
  The contract test (`api/test/contract.test.ts`) checks shapes, not the header.

### 3.2 Health

`GET /api/health` → `200` [`HealthResponse`]
```json
{ "ok": true, "version": "0.1.0", "grader": "up", "hints_enabled": false, "exercises": 73 }
```

### 3.3 Auth

`POST /api/auth/register` [`RegisterRequest`] → `201` [`MeResponse`] + `Set-Cookie`
```json
{ "invite_code": "k3q9-x2m7", "username": "zhenia", "password": "at least 10 chars" }
```
```json
{ "user": { "id": 1, "username": "zhenia", "is_admin": false } }
```
Username: `^[a-z0-9_-]{3,20}$`. Password: 10–200 chars. Invite codes are single use.
Errors: `400`, `409 conflict` (username taken), `401 unauthorized` (bad or used invite).

`POST /api/auth/login` [`LoginRequest`] → `200` [`MeResponse`] + `Set-Cookie`
```json
{ "username": "zhenia", "password": "…" }
```
Errors: `401`. Login is limited to 10 attempts per username per 15 min (`429 rate_limited`).

`POST /api/auth/logout` → `204`, clears the cookie and deletes the session row.

`GET /api/me` → `200` [`MeResponse`].

Admin tasks (create the first admin, create invites) are CLI only: `npm run admin:create`,
`npm run admin:invite` in `api/`. There is no admin HTTP API.

### 3.4 Exercises

`GET /api/exercises?level=<0-5>` → `200` [`ExerciseListResponse`]
```json
{ "exercises": [
  { "id": "gym_echo_first", "level": 0, "kind": "program",
    "attempts": 3, "solved": true, "solved_without_hints": true }
] }
```
Sorted by level, then id. `level` is optional.

`GET /api/exercises/:id` → `200` [`ExerciseDetail`]
```json
{ "id": "gym_strlen", "level": 1, "kind": "function",
  "expected_files": ["gym_strlen.c"], "allowed_functions": [],
  "prototype": "int\tgym_strlen(char *str);",
  "subject_md": "…", "subject_source": "original",
  "visible_tests": [ { "id": "01", "argv": ["hello"], "stdin": null } ],
  "autocomplete_words": ["gym_strlen"] }
```
`visible_tests` never include expected output. Exercises are available in practice mode only;
in an active exam the client reads the current question from `/api/exams/:id/question`.

### 3.5 Practice mode

`POST /api/practice/:exerciseId/submissions` [`SubmitRequest`] → `200` [`GradeResult`]
```json
{ "filename": "gym_echo_first.c", "source": "#include <unistd.h>\n…" }
```
```json
{ "submission_id": 42, "exercise_id": "gym_echo_first", "mode": "practice",
  "attempt_no": 3, "created_at": "2026-11-22T10:00:00Z",
  "verdict": "FAIL", "stage": "tests",
  "message": "Test 02 failed: output differs",
  "tests": [ { "id": "01", "visible": true, "status": "OK" },
             { "id": "02", "visible": false, "status": "KO" },
             { "id": "03", "visible": false, "status": "KO" } ],
  "first_failure": {
    "test_id": "02", "hidden": true, "argv": [], "stdin": null,
    "reason": "output",
    "expected_b64": "Cg==", "got_b64": "",
    "expected_cat_e": "$", "got_cat_e": "",
    "expected_exit": 0, "exit": 0, "signal": null,
    "timed_out": false, "truncated": false, "first_diff_byte": 0 },
  "compile_stderr": null, "forbidden": [], "duration_ms": 812 }
```
The call is synchronous: it waits in the grader queue (max 30 s of grading). `first_failure` is
`null` on PASS and on failures before the test stage. On `stage: "compile"` or `"link"`,
`compile_stderr` holds the compiler output (capped at 16 KiB). On `stage: "nm"`, `forbidden`
lists the symbols, for example `["printf"]`, and `message` is `forbidden function: printf`.

`GET /api/practice/:exerciseId/submissions` → `200` [`SubmissionListResponse`]
```json
{ "submissions": [ { "id": 42, "attempt_no": 3, "verdict": "FAIL", "stage": "tests",
                     "created_at": "2026-11-22T10:00:00Z" } ] }
```
Newest first, at most 50.

`GET /api/submissions/:id` → `200` [`SubmissionDetail`]: a `GradeResult` plus `filename` and
`source`. Only the owner can read it (`404` otherwise).

`GET /api/practice/:exerciseId/solution` → `200` [`SolutionResponse`]
```json
{ "exercise_id": "gym_echo_first", "filename": "gym_echo_first.c", "source": "…" }
```
`403 forbidden` until the user has at least one graded practice submission for this exercise.
The first reveal is recorded (`reveals` table) and the exercise stops counting as
"solved without hints" unless it was already solved before the reveal.

### 3.6 Hints (practice mode, `HINTS_ENABLED=true`)

`GET /api/practice/:exerciseId/hints` → `200` [`HintStateResponse`]
```json
{ "enabled": true, "eligible_level": 1, "reason": null,
  "failed_runs": 1, "minutes_on_exercise": 3,
  "quota": { "user_day_left": 24, "exercise_day_left": 3 },
  "hints": [] }
```
`eligible_level` is `null` when no hint can be requested now; `reason` then says why
(`"need_failed_run"`, `"code_unchanged"`, `"quota"`, `"disabled"`).

`POST /api/practice/:exerciseId/hints` [`HintRequest`] → `200` [`Hint`]
```json
{ "submission_id": 42 }
```
```json
{ "hint_id": 7, "level": 1, "text": "Test 02 runs with no arguments …",
  "source": "llm", "cached": false, "created_at": "2026-11-22T10:01:00Z" }
```
The server picks the level (brief §6): L1 after ≥ 1 failed graded run; L2 after ≥ 2 failed runs
and L1 seen; L3 after ≥ 4 failed runs and ≥ 8 min on the exercise. `submission_id` must be the
user's latest FAIL for this exercise and its code hash must differ from the last hinted one.
`source` is `"llm"`, `"canned"` (post-filter rejected twice) or `"diff"` (deterministic hint,
also used when hints are disabled for LLM but the diff hint is on). The response is not streamed
in v1; streaming L1/L2 is a later improvement.

`POST /api/hints/:hintId/rating` [`HintRatingRequest`] → `204`
```json
{ "rating": "wrong" }
```

All hint routes return `403 forbidden` while the user has an active exam.

### 3.7 Exam mode

`GET /api/exam/profiles` → `200` [`ExamProfilesResponse`]
```json
{ "profiles": [ {
  "id": "piscine_exam", "label": "Piscine exam (4 h)", "enabled": true,
  "duration_min": 240, "slots": [0,0,1,1,1,2,2,2,3,3,3,4,4,4,5,5],
  "points": [6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,10], "pass_mark": 30,
  "fail_policy": "new_exercise", "decay": [],
  "cooldown_min": [0.5,2.5,3,5.5,8.5,14,22.5],
  "approximation_note": "Scoring, cooldown and timeouts approximate the real exam." } ] }
```
Source of truth: `api/config/exam-profiles.json`.

`POST /api/exams` [`StartExamRequest`] → `201` [`ExamStatus`]
```json
{ "profile_id": "piscine_exam" }
```
`409 conflict` if the user already has an active exam. Draws a random exercise for slot 0 from
the slot's level, avoiding exercises already drawn in this exam.

`GET /api/exams/current` → `200` [`ExamStatus`] or `404 not_found` if none is active.

`GET /api/exams/:examId` → `200` [`ExamStatus`] (this is the `status` command)
```json
{ "exam_id": 5, "profile_id": "piscine_exam", "status": "active",
  "started_at": "2026-11-22T09:00:00Z", "ends_at": "2026-11-22T13:00:00Z",
  "now": "2026-11-22T09:42:10Z", "time_left_s": 11870,
  "score": 12, "pass_mark": 30, "passed": false,
  "slot": 2, "total_slots": 16, "level": 1,
  "current": { "exercise_id": "gym_strlen", "expected_files": ["gym_strlen.c"],
               "assigned_at": "2026-11-22T09:30:00Z", "failures": 1 },
  "next_grade_at": "2026-11-22T09:42:40Z",
  "history": [
    { "slot": 0, "level": 0, "exercise_id": "gym_echo_first", "result": "passed",
      "points": 6, "at": "2026-11-22T09:10:00Z" } ] }
```
`current` is `null` once all slots are done or the exam has ended. An expired exam is reported
with `status: "expired"` the first time it is read after `ends_at`.

`GET /api/exams/:examId/question` → `200` [`ExerciseDetail`] for the current slot's exercise.

`POST /api/exams/:examId/grademe` [`SubmitRequest`] → `200` [`GrademeResponse`]
```json
{ "result": { "…": "GradeResult, mode: \"exam\"" }, "status": { "…": "ExamStatus after grading" } }
```
The client asks for confirmation before calling it. On PASS the slot's points are added and the
next slot is drawn. On FAIL, `fail_policy: "new_exercise"` draws a different exercise at the
same level (the Piscine default), `"same_exercise"` keeps it, and `next_grade_at` is set from
the cooldown schedule (index = failures in this slot − 1, repeating the last value). The failure
count stays with the slot when a FAIL draws a new exercise and resets only when the slot is passed.
Errors:
`429 cooldown` with `next_grade_at`, `410 exam_over` after `ends_at` (the late submission is
not graded), `409 conflict` if the exam is finished.

`POST /api/exams/:examId/finish` → `200` [`ExamStatus`] with `status: "finished"`.

In exam mode there are no hints, no solution reveal and no redraw. Hint and solution routes, and
practice grading (`POST /api/practice/:exerciseId/submissions`), return `403 forbidden` while an
exam is active.

## 4. Database schema (SQLite, WAL)

The schema lives in `api/src/schema.sql` and is applied on startup with `CREATE … IF NOT
EXISTS`. Later changes go in numbered migration files, tracked with `PRAGMA user_version`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                -- argon2id encoded string
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE invites (
  code        TEXT PRIMARY KEY,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  used_by     INTEGER REFERENCES users(id),
  used_at     TEXT
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,              -- sha256(cookie token), hex
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE exams (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  profile_id  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active','finished','expired')),
  started_at  TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  finished_at TEXT,
  score       INTEGER NOT NULL DEFAULT 0,
  passed      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_active_exam ON exams(user_id) WHERE status = 'active';

-- One row per exercise drawn in an exam. A failed exercise under fail_policy=new_exercise
-- is closed with status 'replaced' and a new row is added for the same slot.
CREATE TABLE exam_questions (
  id            INTEGER PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  slot          INTEGER NOT NULL,
  level         INTEGER NOT NULL,
  exercise_id   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('current','passed','replaced','abandoned')),
  failures      INTEGER NOT NULL DEFAULT 0,  -- failures in this slot so far (drives cooldown)
  points        INTEGER NOT NULL DEFAULT 0,  -- awarded on pass
  next_grade_at TEXT,
  assigned_at   TEXT NOT NULL,
  resolved_at   TEXT
);
CREATE UNIQUE INDEX one_current_question ON exam_questions(exam_id) WHERE status = 'current';

CREATE TABLE submissions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  exercise_id  TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('practice','exam')),
  exam_question_id INTEGER REFERENCES exam_questions(id),
  attempt_no   INTEGER NOT NULL,             -- per (user, exercise, mode)
  filename     TEXT NOT NULL,
  source       TEXT NOT NULL,
  code_hash    TEXT NOT NULL,                -- sha256 of normalized source (§7)
  verdict      TEXT NOT NULL CHECK (verdict IN ('PASS','FAIL','ERROR')),
  stage        TEXT NOT NULL,
  result_json  TEXT NOT NULL,                -- full GradeJobResponse from the dispatcher
  duration_ms  INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX submissions_user_ex ON submissions(user_id, exercise_id, created_at);
CREATE INDEX submissions_user_time ON submissions(user_id, created_at);

CREATE TABLE reveals (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  exercise_id TEXT NOT NULL,
  revealed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, exercise_id)
);

CREATE TABLE hint_cache (
  key        TEXT PRIMARY KEY,   -- sha256(exercise|level|code_hash|test_fingerprint|prompt_version|model)
  level      INTEGER NOT NULL,
  text       TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE hint_log (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  exercise_id       TEXT NOT NULL,
  submission_id     INTEGER NOT NULL REFERENCES submissions(id),
  level             INTEGER NOT NULL CHECK (level IN (1,2,3)),
  source            TEXT NOT NULL CHECK (source IN ('llm','canned','diff')),
  model             TEXT,
  provider          TEXT,
  prompt_version    TEXT NOT NULL,
  code_hash         TEXT NOT NULL,
  test_fingerprint  TEXT NOT NULL,
  cache_hit         INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  reasoning_tokens  INTEGER,
  cost_usd          REAL,
  ttft_ms           INTEGER,
  latency_ms        INTEGER,
  filter_verdict    TEXT,          -- 'ok' | 'reject:<rule>'
  containment       REAL,
  swapped           INTEGER NOT NULL DEFAULT 0,
  raw_output        TEXT,
  shown_output      TEXT NOT NULL,
  rating            TEXT CHECK (rating IN ('helpful','wrong')),
  created_at        TEXT NOT NULL
);
CREATE INDEX hint_log_user_day ON hint_log(user_id, created_at);
```

Derived values (no extra tables): "solved" = any PASS submission; "solved without hints" = a PASS
in practice or exam mode with no `hint_log` row and no `reveals` row for that exercise dated
before it; rate limits = `COUNT(*)` over `submissions` / `hint_log` in the window; the $2/day stop
= `SUM(cost_usd)` over today's `hint_log`.

## 5. Exercises

### 5.1 Exercise file (`content/exercises/<level>/<id>.json`)

Type: `Exercise` in `contract/src/exercise.ts`. JSON Schema: `contract/schemas/exercise.schema.json`.

```json
{
  "id": "gym_echo_first",
  "level": 0,
  "kind": "program",
  "expected_files": ["gym_echo_first.c"],
  "allowed_functions": ["write"],
  "prototype": null,
  "subject_md": "Write a program that prints its first argument …",
  "subject_source": "original",
  "harness": { "main": null, "includes": [], "cflags_extra": ["-std=gnu17"] },
  "tests": [
    { "id": "01", "visible": true, "argv": ["abc"], "stdin": null,
      "expected_stdout_b64": "YWJjCg==", "expected_exit": 0 }
  ],
  "limits": { "timeout_ms": 2000, "max_output_bytes": 65536 },
  "reference_path": "refs/gym_echo_first.c",
  "provenance": { "repo": "c-exam-gym", "commit": null,
                  "license_code": "MIT", "license_subject": "MIT" },
  "hint_tags": ["argv", "write"]
}
```

| Field | Rule |
|---|---|
| `id` | `^[a-z0-9_]+$`, unique across levels, equals the file name without `.json` |
| `level` | 0–5 |
| `kind` | `"program"` (has its own `main`) or `"function"` (linked with `harness.main`) |
| `expected_files` | Exactly the file names the student must submit. v1 supports one file. |
| `allowed_functions` | Allowlist for the `nm -u` check. Empty means no libc calls at all. |
| `prototype` | Required for `function`, `null` for `program` |
| `subject_source` | `"42-derived-private"` (imported, never committed) or `"original"` |
| `harness.main` | Path under the content root, e.g. `harness/ft_list_size/main.c`, or `null` |
| `harness.includes` | Paths under the content root, e.g. `harness/include/ft_list.h`; copied next to the student file |
| `harness.cflags_extra` | Appended to both compiles. Default `["-std=gnu17"]` |
| `tests[].argv` | argv[1..], an explicit array. Never run through a shell. |
| `tests[].stdin` | String fed on stdin, or `null` for `/dev/null` |
| `tests[].expected_stdout_b64` | Raw stdout bytes, base64. Generated in the grader image, never typed. No `cat -e` `$`. |
| `tests[].expected_exit` | Usually 0 |
| `limits.timeout_ms` | Per-test wall time. Default 2000 |
| `limits.max_output_bytes` | Default 65536. More output is KO (`truncated`) |
| `reference_path` | Path under the content root. Never sent to the client before a reveal, never to the sandbox, never to the LLM |
| `allow_asm` | Optional, default `false`. Allows `asm`, `__asm__`, `syscall(` |

### 5.2 Content root layout (`CONTENT_DIR`, default `./content`)

```
content/                        git-ignored (fixtures/ has the same layout and is committed)
├── manifest.json               { "repo", "commit", "generated_at", "count", "ignore_symbols": [] }
├── exercises/<level>/<id>.json
├── refs/<id>.c                 reference solutions
├── harness/<id>/main.c         grader mains for function exercises
├── harness/include/*.h         shared headers (list.h, ft_list.h)
├── fingerprints/<id>.json      winnowing fingerprint of the reference (hints post-filter)
├── hints/<id>.json             optional canned hints { "1": "…", "2": "…", "3": "…" }
├── toolchain-ignore.txt        symbols tolerated by nm (built only from references)
├── regen-diff.log
└── LICENSE-seed                the seed's MIT notice
```

Both `api` and the dispatcher read the content root at startup and reload it on `SIGHUP`.
`fixtures/` holds two original exercises (`gym_echo_first`, `gym_strlen`) so every package can
be tested without the private pool: `CONTENT_DIR=./fixtures`.

## 6. Grader

### 6.1 Dispatcher API (internal network only, port 9000)

Types: `contract/src/grader.ts`.

`GET /health` → `200` `{ "ok": true, "docker": true, "image": "grader:pinned", "queue": 0, "running": 0 }`

`POST /grade` [`GradeJobRequest`] → `200` [`GradeJobResponse`]
```json
{ "job_id": "1d1f5a1e-…", "user_id": 1, "exercise_id": "gym_echo_first",
  "filename": "gym_echo_first.c", "source": "…", "mode": "practice", "purpose": "submission" }
```
`purpose: "hint_skeleton_check"` is used by the hint post-filter to run an L3 skeleton; it has
the same response and does not count towards the user's queue slot.

```json
{ "job_id": "1d1f5a1e-…", "verdict": "FAIL", "stage": "tests",
  "message": "Test 02 failed: output differs",
  "tests": [ { "id": "01", "visible": true, "status": "OK" },
             { "id": "02", "visible": false, "status": "KO" } ],
  "first_failure": { "…": "FirstFailure, as in §3.5" },
  "compile_stderr": null, "forbidden": [], "duration_ms": 812,
  "test_details": [
    { "id": "01", "status": "OK", "reason": null, "stdout_b64": "YWJjCg==", "exit": 0,
      "signal": null, "timed_out": false, "truncated": false, "duration_ms": 3 } ],
  "runner_version": "1" }
```
`test_details` stays on the server (stored in `submissions.result_json`, used for hints); `api`
strips it before answering the client. Dispatcher errors: `400` (bad request, unknown exercise),
`422 bad_source` (static check, returned as a normal FAIL with `stage: "static"` instead when the
problem is the student's code), `503 grader_busy` (queue full or the user already has a job in
flight), `500 internal` (Docker failure; `verdict` would be `ERROR`).

Stages, in order. The first stage that fails sets `stage` and `verdict: "FAIL"`:

| Stage | Where | Fails when | Message |
|---|---|---|---|
| `file` | dispatcher | `filename` not in `expected_files` | `expected file gym_strlen.c, got strlen.c` |
| `static` | dispatcher | non-ASCII outside literals; `asm`/`__asm__`/`syscall(` without `allow_asm`; > 64 KiB | `forbidden construct: asm` |
| `compile` | sandbox | any diagnostic from compile A | `compilation failed` |
| `nm` | sandbox | a symbol from `nm -u` (compile B) not in allowlist ∪ ignore list | `forbidden function: printf` |
| `link` | sandbox | link error, including a duplicate `main` | `link failed` |
| `tests` | dispatcher | any test KO | `Test 02 failed: output differs` |
| `done` | – | PASS | `All tests passed` |

### 6.2 Job directory (written by the dispatcher, mounted read-only at `/in`)

`/srv/grader/jobs/<job_id>/in/` (the same path on host and in the dispatcher container):

```
<student file>          e.g. gym_strlen.c (CRLF→LF already applied)
main.c                  function exercises only (from harness.main)
*.h                     harness.includes
allow.txt               allowed_functions ∪ toolchain ignore list, one per line
job.json                RunnerJob (below). No expected output, no reference.
```

`job.json` [`RunnerJob`]:
```json
{ "kind": "function", "student_file": "gym_strlen.c", "has_main": true,
  "cflags_extra": ["-std=gnu17"], "compile_timeout_s": 10,
  "test_timeout_ms": 2000, "test_cpu_s": 1, "max_output_bytes": 65536,
  "tests": [ { "id": "01", "argv": ["hello"], "stdin_b64": null } ] }
```

### 6.3 Sandbox run and runner output

```
docker run --rm --name grade-<job_id> --network none --cap-drop ALL \
  --security-opt no-new-privileges --user 65534:65534 --read-only \
  --tmpfs /work:rw,exec,nosuid,nodev,size=16m,uid=65534,gid=65534 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
  -v /srv/grader/jobs/<job_id>/in:/in:ro --pids-limit 64 --memory 256m --memory-swap 256m \
  --cpus 1 --ulimit nofile=64:64 --ulimit fsize=8388608:8388608 --ulimit core=0:0 \
  --ulimit cpu=20:20 --log-opt max-size=1m grader:pinned /runner.sh
```
Default seccomp, never `--privileged`. Docker copies the mode of the image's /work (root 755 from WORKDIR) onto the tmpfs, so without uid=/gid= uid 65534 cannot write it (verified on Docker 26.1 and 29.10). The uid=65534,gid=65534 option is required. Outer
kill after the per-job deadline in §6.5 (30 s by default): `docker kill`, then `docker rm -f`
and job dir removal in a `finally`.

`runner.sh` copies `/in` to `/work` and runs:
1. Compile A: `cc -Wall -Wextra -Werror <cflags_extra> -c <student> -o student.o` (10 s).
2. Compile B: the same plus `-fno-builtin` into `student_nm.o`; `nm -u student_nm.o`, strip a
   leading `_`, compare with `allow.txt`.
3. Link: `student.o` alone (program) or `student.o` + `main.c` compiled with the same flags.
4. Each test: `setsid timeout -s KILL <t> ./a.out <argv…> < stdin`, `ulimit -t 1 -s 8192`,
   stdout piped through `head -c <max+1>`, kill the process group on timeout.

It prints exactly one JSON object on stdout, the last line [`RunnerOutput`]:
```json
{ "runner_version": "1", "stage": "tests",
  "compile_ok": true, "compile_stderr": "",
  "nm_symbols": ["write"], "forbidden": [],
  "link_ok": true, "link_stderr": "",
  "tests": [ { "id": "01", "stdout_b64": "YWJjCg==", "exit": 0, "signal": null,
               "timed_out": false, "truncated": false, "duration_ms": 3 } ] }
```
`stage` is the last stage reached (`compile`, `nm`, `link` or `tests`). Tests are only run when
compile, nm and link succeed. Stderr fields are capped at 16 KiB. The runner never compares
output; it never sees expected output. (Accepted risk: a student binary runs as the same UID and
could forge this JSON. That only cheats the student.)

### 6.4 Comparison and display (dispatcher)

- A test is OK iff `stdout` bytes equal `expected_stdout_b64` exactly (no normalization, the
  trailing `\n` counts), `exit == expected_exit`, no signal, not timed out, not truncated.
- `reason` for KO, first match wins: `timeout`, `signal`, `truncated`, `exit_code`, `output`.
- PASS iff every test is OK. No partial credit.
- `first_failure` is the first KO test in file order. `first_diff_byte` is the index of the first
  differing byte (or the shorter length), `null` when the outputs are equal.
- `*_cat_e` rendering follows `cat -e`: `$` before each `\n`; bytes 0x00–0x1F except `\t` and `\n`
  as `^@`…`^_`; 0x7F as `^?`; bytes ≥ 0x80 as `M-` plus the rendering of `byte - 0x80`. Tabs stay
  literal. The SPA's "visible whitespace" toggle re-renders from the `_b64` fields (`·` for
  space, `\t`, `\xNN`); the server does not send a second rendering.

### 6.5 Limits (env, dispatcher)

| Env | Default |
|---|---|
| `COMPILE_TIMEOUT_S` | 10 |
| `TEST_TIMEOUT_S` | 2 (overridden by `limits.timeout_ms` when larger, never above 10) |
| `TEST_CPU_S` | 1 |
| `SUBMISSION_TIMEOUT_S` | 30 |
| `GRADER_CONCURRENCY` | 2 (`docker-compose.yml` sets 1 for the Pi 4, §0 row 8) |
| `GRADER_QUEUE_MAX` | 20 |
| `GRADER_IMAGE` | `grader:pinned` |
| `JOBS_DIR` | `/srv/grader/jobs` |

**Outer kill.** For each job the dispatcher sets the outer `docker kill` deadline to
`min(60 s, max(SUBMISSION_TIMEOUT_S, COMPILE_TIMEOUT_S + n_tests × test_timeout + 10 s))`,
where `test_timeout` is the effective per-test wall timeout (after `limits.timeout_ms`) and
`n_tests` the exercise's test count. So the default 30 s never cuts short an exercise whose
tests legitimately need longer (e.g. 10 s per test), up to the 60 s cap, and no job ever holds
a grader slot for more than 60 s.

Per-user limits (1 job in flight, 6 submissions/min) are enforced in `api`; the dispatcher also
enforces 1 in flight per `user_id` as a backstop.

## 7. Source normalization (api, before the dispatcher)

1. Reject `source` over 64 KiB (`422 bad_source`).
2. Convert CRLF and lone CR to LF.
3. Reject bytes ≥ 0x80 outside string and char literals and comments, with line and column in the
   message.
4. `code_hash` = sha256 of the normalized source with trailing whitespace stripped per line.

## 8. Hints (summary; full rules in brief §6 and §9)

- Server decides the level; the model never does. Hints off in exam mode.
- Prompt files: `api/prompts/hint-v1.txt` (system, verbatim from brief §9) and
  `api/prompts/hint-user-v1.txt`. The user id sent to OpenRouter is `sha256(user_id + secret)`.
- OpenRouter request: `model: "deepseek/deepseek-v4-flash-0731"`, `models: [fallbacks]`,
  `reasoning: {"enabled": false}`, `provider: {"ignore": ["Inceptron"]}`; L1 `max_tokens 220,
  temperature 0.3`; L2 `320, 0.3`; L3 `550, 0.4`. Timeout 20 s (L3 30 s), one retry.
- Assert `usage.completion_tokens_details.reasoning_tokens == 0`; `finish_reason = "length"` with
  empty content is a failure.
- Post-filter every output (brief §6): code-in-L1, L2 line limits, L3 statement ratio, winnowing
  containment ≥ 0.35 against `content/fingerprints/<id>.json`, L3 skeleton run through the
  dispatcher, non-allowlisted functions, injection keywords. One regenerate at temperature 0.2,
  then the canned hint, then the deterministic diff hint.

## 9. Configuration (`.env`)

| Var | Service | Default |
|---|---|---|
| `PORT` | api | 8042 |
| `HOST` | api | `0.0.0.0` in the container (published on `127.0.0.1` only) |
| `DATA_DIR` | api | `./data` |
| `CONTENT_DIR` | api, dispatcher | `./content` (`/content` in containers) |
| `WEB_DIST` | api | `../web/dist` (`/app/web/dist` in the container) |
| `DISPATCHER_URL` | api | `http://grader-dispatcher:9000` |
| `COOKIE_SECURE` | api | `true` (set `false` only for plain-HTTP local dev) |
| `SESSION_SECRET` | api | required in production (hashes user ids for OpenRouter) |
| `HINTS_ENABLED` | api | `false` |
| `OPENROUTER_API_KEY` | api | empty |
| `HINT_MODEL` | api | `deepseek/deepseek-v4-flash-0731` |
| `HINT_FALLBACK_MODELS` | api | `deepseek/deepseek-v4.1-flash-1017,anthropic/claude-haiku-5.5` |
| `HINT_PROVIDER_IGNORE` | api | `Inceptron` (OpenRouter `provider.ignore`, comma-separated) |
| `HINT_DAILY_USD_STOP` | api | 2 |
| `SUBMISSIONS_PER_MIN` | api | 6 |
| `COMPILE_TIMEOUT_S`, `TEST_TIMEOUT_S`, `TEST_CPU_S`, `SUBMISSION_TIMEOUT_S`, `GRADER_CONCURRENCY`, `GRADER_QUEUE_MAX`, `GRADER_IMAGE`, `JOBS_DIR` | dispatcher | §6.5 |

Only `web` loads `.env` (`env_file`, optional). `grader-dispatcher` holds `docker.sock`, so it has
no `env_file`: compose passes it only its own vars through `environment:`, the tunables with
`${VAR:-default}` interpolation (which reads `.env` at `docker compose` time) and the
in-container paths `CONTENT_DIR=/content` and `JOBS_DIR=/srv/grader/jobs` hard-coded so they
always match its mounts. `OPENROUTER_API_KEY` and `SESSION_SECRET` never reach it. A new
dispatcher var must be added to that list in `docker-compose.yml`.

## 10. Deployment notes

- `docker compose --profile build build && docker compose up -d`.
- `web` publishes `127.0.0.1:8042` only; the dispatcher publishes nothing.
- Secrets stay out of the `docker.sock` holder: `web` gets `.env` via
  `env_file: [ { path: .env, required: false } ]`; `grader-dispatcher` gets only its own vars by
  interpolation (§9). Check with `docker compose config`: no `OPENROUTER_API_KEY` or
  `SESSION_SECRET` under `grader-dispatcher`.
- SQLite lives in `./data`, bind-mounted at `/data`; the container runs as `node` (uid 1000), so
  the host directory must be owned by 1000:1000 (`mkdir -p data && sudo chown 1000:1000 data`).
  If it is not, `web` exits with a message naming the directory and the `chown` command.
- Host prerequisites (DEPLOY.md): `cgroup_enable=memory` in `/boot/firmware/cmdline.txt` + reboot;
  `apt full-upgrade` + reboot for GhostLock; Tailscale ACL so the Pi cannot initiate connections
  to other tailnet devices; `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8042`; `/srv/grader/jobs`
  created on the host; stay on the default Pi 4 kernel (`kernel8.img`).
- The dispatcher refuses to start if `docker info` reports no memory-limit support.
- Footer on every page: "Independent practice tool. Not affiliated with, endorsed by, or
  reflective of the official exams of 42 / École 42."
