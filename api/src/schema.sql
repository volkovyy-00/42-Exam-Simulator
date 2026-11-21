-- C Exam Gym DB schema v1. Mirror of DESIGN.md §4; keep both in sync.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                -- argon2id encoded string
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  used_by     INTEGER REFERENCES users(id),
  used_at     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,              -- sha256(cookie token), hex
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exams (
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
CREATE UNIQUE INDEX IF NOT EXISTS one_active_exam ON exams(user_id) WHERE status = 'active';

-- One row per exercise drawn in an exam. A failed exercise under fail_policy=new_exercise
-- is closed with status 'replaced' and a new row is added for the same slot.
CREATE TABLE IF NOT EXISTS exam_questions (
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
CREATE UNIQUE INDEX IF NOT EXISTS one_current_question ON exam_questions(exam_id) WHERE status = 'current';

CREATE TABLE IF NOT EXISTS submissions (
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
CREATE INDEX IF NOT EXISTS submissions_user_ex ON submissions(user_id, exercise_id, created_at);
CREATE INDEX IF NOT EXISTS submissions_user_time ON submissions(user_id, created_at);

CREATE TABLE IF NOT EXISTS reveals (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  exercise_id TEXT NOT NULL,
  revealed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, exercise_id)
);

CREATE TABLE IF NOT EXISTS hint_cache (
  key        TEXT PRIMARY KEY,   -- sha256(exercise|level|code_hash|test_fingerprint|prompt_version|model)
  level      INTEGER NOT NULL,
  text       TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hint_log (
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
CREATE INDEX IF NOT EXISTS hint_log_user_day ON hint_log(user_id, created_at);
