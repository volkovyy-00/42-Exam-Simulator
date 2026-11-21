// Dispatcher API and sandbox runner I/O (DESIGN.md §6). Types only.
import type { FailureReason, GradeOutcome, Mode } from './api.ts';

export interface GradeJobRequest {
  job_id: string;
  user_id: number;
  exercise_id: string;
  filename: string;
  /** Already normalized by api (DESIGN.md §7). */
  source: string;
  mode: Mode;
  purpose: 'submission' | 'hint_skeleton_check';
}

export interface TestDetail {
  id: string;
  status: 'OK' | 'KO';
  reason: FailureReason | null;
  stdout_b64: string;
  exit: number | null;
  signal: string | null;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
}

export interface GradeJobResponse extends GradeOutcome {
  job_id: string;
  /** Server-only. api strips this before answering the client. */
  test_details: TestDetail[];
  runner_version: string;
}

export interface DispatcherHealth {
  ok: boolean;
  docker: boolean;
  image: string;
  queue: number;
  running: number;
}

/** /in/job.json inside the sandbox. Never contains expected output. */
export interface RunnerJob {
  kind: 'program' | 'function';
  student_file: string;
  has_main: boolean;
  cflags_extra: string[];
  compile_timeout_s: number;
  test_timeout_ms: number;
  test_cpu_s: number;
  max_output_bytes: number;
  tests: { id: string; argv: string[]; stdin_b64: string | null }[];
}

export interface RunnerTestResult {
  id: string;
  stdout_b64: string;
  exit: number | null;
  signal: string | null;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
}

/** The single JSON object runner.sh prints as its last stdout line. */
export interface RunnerOutput {
  runner_version: string;
  stage: 'compile' | 'nm' | 'link' | 'tests';
  compile_ok: boolean;
  compile_stderr: string;
  nm_symbols: string[];
  forbidden: string[];
  link_ok: boolean;
  link_stderr: string;
  tests: RunnerTestResult[];
}
