// Public HTTP API contract (DESIGN.md §3). Types only: no runtime code in this package.

export type Mode = 'practice' | 'exam';
export type Verdict = 'PASS' | 'FAIL' | 'ERROR';
export type Stage = 'file' | 'static' | 'compile' | 'nm' | 'link' | 'tests' | 'done';
export type ExerciseKind = 'program' | 'function';
export type SubjectSource = '42-derived-private' | 'original';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'hint_not_eligible'
  | 'exam_over'
  | 'unsupported_media_type'
  | 'bad_source'
  | 'rate_limited'
  | 'cooldown'
  | 'grader_busy'
  | 'hints_disabled'
  | 'not_implemented'
  | 'internal';

export interface ApiError {
  error: ErrorCode;
  message: string;
  retry_after_s?: number;
  next_grade_at?: string;
}

// ---- health -------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  version: string;
  grader: 'up' | 'down';
  hints_enabled: boolean;
  exercises: number;
}

// ---- auth ---------------------------------------------------------------

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
}

export interface RegisterRequest {
  invite_code: string;
  username: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface MeResponse {
  user: User;
}

// ---- exercises ----------------------------------------------------------

export interface ExerciseSummary {
  id: string;
  level: number;
  kind: ExerciseKind;
  attempts: number;
  solved: boolean;
  solved_without_hints: boolean;
}

export interface ExerciseListResponse {
  exercises: ExerciseSummary[];
}

export interface VisibleTest {
  id: string;
  argv: string[];
  stdin: string | null;
}

export interface ExerciseDetail {
  id: string;
  level: number;
  kind: ExerciseKind;
  expected_files: string[];
  allowed_functions: string[];
  prototype: string | null;
  subject_md: string;
  subject_source: SubjectSource;
  visible_tests: VisibleTest[];
  /** Words for the editor's completion list (prototype names, allowed functions). */
  autocomplete_words: string[];
}

// ---- grading ------------------------------------------------------------

export interface SubmitRequest {
  filename: string;
  source: string;
}

export interface TestStatus {
  id: string;
  visible: boolean;
  status: 'OK' | 'KO';
}

export type FailureReason = 'timeout' | 'signal' | 'truncated' | 'exit_code' | 'output';

export interface FirstFailure {
  test_id: string;
  hidden: boolean;
  argv: string[];
  stdin: string | null;
  reason: FailureReason;
  expected_b64: string;
  got_b64: string;
  /** `cat -e` rendering (DESIGN.md §6.4). */
  expected_cat_e: string;
  got_cat_e: string;
  expected_exit: number;
  exit: number | null;
  signal: string | null;
  timed_out: boolean;
  truncated: boolean;
  first_diff_byte: number | null;
}

/** What the dispatcher decides about one submission, minus server-only details. */
export interface GradeOutcome {
  verdict: Verdict;
  stage: Stage;
  message: string;
  tests: TestStatus[];
  first_failure: FirstFailure | null;
  compile_stderr: string | null;
  forbidden: string[];
  duration_ms: number;
}

export interface GradeResult extends GradeOutcome {
  submission_id: number;
  exercise_id: string;
  mode: Mode;
  attempt_no: number;
  created_at: string;
}

export interface SubmissionSummary {
  id: number;
  attempt_no: number;
  verdict: Verdict;
  stage: Stage;
  created_at: string;
}

export interface SubmissionListResponse {
  submissions: SubmissionSummary[];
}

export interface SubmissionDetail extends GradeResult {
  filename: string;
  source: string;
}

export interface SolutionResponse {
  exercise_id: string;
  filename: string;
  source: string;
}

// ---- hints --------------------------------------------------------------

export type HintLevel = 1 | 2 | 3;
export type HintSource = 'llm' | 'canned' | 'diff';
export type HintBlockReason = 'need_failed_run' | 'code_unchanged' | 'quota' | 'disabled' | 'exam_active';

export interface Hint {
  hint_id: number;
  level: HintLevel;
  text: string;
  source: HintSource;
  cached: boolean;
  created_at: string;
}

export interface HintStateResponse {
  enabled: boolean;
  eligible_level: HintLevel | null;
  reason: HintBlockReason | null;
  failed_runs: number;
  minutes_on_exercise: number;
  quota: { user_day_left: number; exercise_day_left: number };
  hints: Hint[];
}

export interface HintRequest {
  submission_id: number;
}

export interface HintRatingRequest {
  rating: 'helpful' | 'wrong';
}

// ---- exams --------------------------------------------------------------

export interface ExamProfile {
  id: string;
  label: string;
  enabled: boolean;
  duration_min: number;
  /** Level of each question slot, in order. */
  slots: number[];
  /** Points awarded for passing each slot (same length as slots). */
  points: number[];
  pass_mark: number;
  fail_policy: 'new_exercise' | 'same_exercise';
  /** Optional points decay per failure in a slot, e.g. [1, 0.8, 0.6]. Empty = none. */
  decay: number[];
  /** Cooldown after the n-th failure in a slot, minutes; the last value repeats. */
  cooldown_min: number[];
  approximation_note: string;
}

export interface ExamProfilesResponse {
  profiles: ExamProfile[];
}

export interface StartExamRequest {
  profile_id: string;
}

export interface ExamHistoryEntry {
  slot: number;
  level: number;
  exercise_id: string;
  result: 'passed' | 'replaced';
  points: number;
  at: string;
}

export interface ExamStatus {
  exam_id: number;
  profile_id: string;
  status: 'active' | 'finished' | 'expired';
  started_at: string;
  ends_at: string;
  now: string;
  time_left_s: number;
  score: number;
  pass_mark: number;
  passed: boolean;
  slot: number;
  total_slots: number;
  level: number | null;
  current: {
    exercise_id: string;
    expected_files: string[];
    assigned_at: string;
    failures: number;
  } | null;
  next_grade_at: string | null;
  history: ExamHistoryEntry[];
}

export interface GrademeResponse {
  result: GradeResult;
  status: ExamStatus;
}
