// Grading pipeline shared by practice submissions and exam grademe: normalize (§7), per-user
// limits, dispatcher call, store the row, strip server-only fields.
import crypto from 'node:crypto';
import type { Exercise, GradeJobResponse, GradeOutcome, GradeResult, Mode, Stage, Verdict } from '@ceg/contract';
import type { ApiError, ErrorCode } from '@ceg/contract';
import { iso, type Ctx } from './context.ts';
import { DispatcherError } from './grader.ts';
import { normalizeSource } from './normalize.ts';

export interface SubmissionRow {
  id: number;
  user_id: number;
  exercise_id: string;
  mode: Mode;
  exam_question_id: number | null;
  attempt_no: number;
  filename: string;
  source: string;
  code_hash: string;
  verdict: Verdict;
  stage: Stage;
  result_json: string;
  duration_ms: number;
  created_at: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: ApiError;
  constructor(status: number, error: ErrorCode, message: string, extra: Partial<ApiError> = {}) {
    super(message);
    this.status = status;
    this.body = { error, message, ...extra };
  }
}

/** GradeResult for the client: the dispatcher's outcome minus test_details/job_id/runner_version. */
export function toGradeResult(row: SubmissionRow): GradeResult {
  const r = JSON.parse(row.result_json) as GradeJobResponse;
  const outcome: GradeOutcome = {
    verdict: r.verdict,
    stage: r.stage,
    message: r.message,
    tests: r.tests,
    first_failure: r.first_failure ?? null,
    compile_stderr: r.compile_stderr ?? null,
    forbidden: r.forbidden ?? [],
    duration_ms: r.duration_ms,
  };
  return {
    submission_id: row.id,
    exercise_id: row.exercise_id,
    mode: row.mode,
    attempt_no: row.attempt_no,
    created_at: row.created_at,
    ...outcome,
  };
}

export function getSubmission(ctx: Ctx, id: number): SubmissionRow | undefined {
  return ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as SubmissionRow | undefined;
}

/** Throws HttpError 422/429/503 before anything is graded. Returns the normalized source. */
export function precheck(ctx: Ctx, userId: number, source: string): { source: string; code_hash: string } {
  const norm = normalizeSource(source);
  if (!norm.ok) throw new HttpError(422, 'bad_source', norm.message);
  const since = iso(ctx.now() - 60_000);
  const { n } = ctx.db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND created_at > ?')
    .get(userId, since) as { n: number };
  if (n >= ctx.config.submissionsPerMin) {
    throw new HttpError(429, 'rate_limited', `At most ${ctx.config.submissionsPerMin} submissions per minute.`,
      { retry_after_s: 60 });
  }
  if (ctx.inFlight.has(userId)) {
    throw new HttpError(503, 'grader_busy', 'You already have a submission being graded.', { retry_after_s: 5 });
  }
  return { source: norm.source, code_hash: norm.code_hash };
}

/**
 * Grades and stores one submission. `onStored` runs inside the insert transaction (exam state
 * changes go there so both commit together).
 */
export async function gradeAndStore(ctx: Ctx, args: {
  userId: number;
  exercise: Exercise;
  mode: Mode;
  filename: string;
  source: string;
  examQuestionId?: number | null;
  onStored?: (row: SubmissionRow) => void;
}): Promise<SubmissionRow> {
  const pre = precheck(ctx, args.userId, args.source);
  ctx.inFlight.add(args.userId);
  let res: GradeJobResponse;
  try {
    res = await ctx.grader.grade({
      job_id: crypto.randomUUID(),
      user_id: args.userId,
      exercise_id: args.exercise.id,
      filename: args.filename,
      source: pre.source,
      mode: args.mode,
      purpose: 'submission',
    });
  } catch (err) {
    if (err instanceof DispatcherError) {
      if (err.status === 503) throw new HttpError(503, 'grader_busy', 'The grader is busy. Try again in a moment.', { retry_after_s: 10 });
      if (err.status === 400) throw new HttpError(400, 'bad_request', err.message);
      if (err.status === 422) throw new HttpError(422, 'bad_source', err.message);
      ctx.log.error({ err: err.message, status: err.status }, 'dispatcher error');
      throw new HttpError(502, 'internal', 'The grader is unavailable. Try again later.');
    }
    throw err;
  } finally {
    ctx.inFlight.delete(args.userId);
  }

  const created = iso(ctx.now());
  const tx = ctx.db.transaction((): SubmissionRow => {
    const { n } = ctx.db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND exercise_id = ? AND mode = ?')
      .get(args.userId, args.exercise.id, args.mode) as { n: number };
    const info = ctx.db.prepare(`INSERT INTO submissions (user_id, exercise_id, mode, exam_question_id, attempt_no,
        filename, source, code_hash, verdict, stage, result_json, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(args.userId, args.exercise.id, args.mode, args.examQuestionId ?? null, n + 1, args.filename,
        pre.source, pre.code_hash, res.verdict, res.stage, JSON.stringify(res), Math.round(res.duration_ms ?? 0), created);
    const row = getSubmission(ctx, Number(info.lastInsertRowid)) as SubmissionRow;
    args.onStored?.(row);
    return row;
  });
  return tx();
}
