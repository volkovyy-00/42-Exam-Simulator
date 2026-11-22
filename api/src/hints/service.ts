// Hint service (DESIGN.md §3.6, §8): level gating, anti-farming, quotas, cache, OpenRouter,
// post-filter, regenerate once, canned then diff fallback, hint_log.
import crypto from 'node:crypto';
import type { Exercise, GradeJobResponse, Hint, HintBlockReason, HintLevel, HintSource, HintStateResponse } from '@ceg/contract';
import { dayStart, iso, type Ctx } from '../context.ts';
import { HttpError, type SubmissionRow } from '../submissions.ts';
import { REFUSAL, definedFunctions, hasInjection, postFilter, type FilterVerdict } from './filter.ts';
import { type CompletionResult, OpenRouterError, REGENERATE_TEMPERATURE, complete } from './openrouter.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt, diffHint, testFingerprint } from './report.ts';

export const HINT_LIMITS = { userDay: 25, exerciseDay: 3 } as const;
export const LEVEL_GATES = { l2Fails: 2, l3Fails: 4, l3Minutes: 8 } as const;

interface HintLogRow {
  id: number;
  level: HintLevel;
  source: HintSource;
  code_hash: string;
  cache_hit: number;
  shown_output: string;
  created_at: string;
}

const toHint = (r: HintLogRow): Hint => ({
  hint_id: r.id,
  level: r.level,
  text: r.shown_output,
  source: r.source,
  cached: r.cache_hit === 1,
  created_at: r.created_at,
});

export function dailyCost(ctx: Ctx): number {
  const { c } = ctx.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM hint_log WHERE created_at >= ?')
    .get(dayStart(ctx.now())) as { c: number };
  return c;
}

export const stopTripped = (ctx: Ctx) => dailyCost(ctx) >= ctx.config.hintDailyUsdStop;

interface Eligibility {
  enabled: boolean;
  level: HintLevel | null;
  reason: HintBlockReason | null;
  failedRuns: number;
  minutes: number;
  userDayLeft: number;
  exerciseDayLeft: number;
  hints: HintLogRow[];
  latestFail: SubmissionRow | undefined;
}

export function eligibility(ctx: Ctx, userId: number, exerciseId: string): Eligibility {
  const db = ctx.db;
  const { n: failedRuns } = db.prepare(`SELECT COUNT(*) AS n FROM submissions
      WHERE user_id = ? AND exercise_id = ? AND mode = 'practice' AND verdict = 'FAIL'`).get(userId, exerciseId) as { n: number };
  const first = db.prepare(`SELECT MIN(created_at) AS t FROM submissions
      WHERE user_id = ? AND exercise_id = ? AND mode = 'practice'`).get(userId, exerciseId) as { t: string | null };
  const minutes = first.t ? Math.max(0, Math.floor((ctx.now() - Date.parse(first.t)) / 60_000)) : 0;
  const hints = db.prepare(`SELECT id, level, source, code_hash, cache_hit, shown_output, created_at FROM hint_log
      WHERE user_id = ? AND exercise_id = ? ORDER BY id`).all(userId, exerciseId) as HintLogRow[];
  const latestFail = db.prepare(`SELECT * FROM submissions WHERE user_id = ? AND exercise_id = ? AND mode = 'practice'
      AND verdict = 'FAIL' ORDER BY id DESC LIMIT 1`).get(userId, exerciseId) as SubmissionRow | undefined;
  const today = dayStart(ctx.now());
  // Quotas count uncached LLM calls only (model set, no cache hit).
  const { u } = db.prepare(`SELECT COUNT(*) AS u FROM hint_log WHERE user_id = ? AND created_at >= ?
      AND cache_hit = 0 AND model IS NOT NULL`).get(userId, today) as { u: number };
  const { e } = db.prepare(`SELECT COUNT(*) AS e FROM hint_log WHERE user_id = ? AND exercise_id = ? AND created_at >= ?
      AND cache_hit = 0 AND model IS NOT NULL`).get(userId, exerciseId, today) as { e: number };
  const userDayLeft = Math.max(0, HINT_LIMITS.userDay - u);
  const exerciseDayLeft = Math.max(0, HINT_LIMITS.exerciseDay - e);

  const enabled = ctx.config.hintsEnabled && !stopTripped(ctx);
  const l1Seen = hints.some((h) => h.level === 1);
  let level: HintLevel = 1;
  if (failedRuns >= LEVEL_GATES.l3Fails && minutes >= LEVEL_GATES.l3Minutes) level = 3;
  else if (failedRuns >= LEVEL_GATES.l2Fails && l1Seen) level = 2;

  let reason: HintBlockReason | null = null;
  if (!enabled) reason = 'disabled';
  else if (failedRuns < 1 || !latestFail) reason = 'need_failed_run';
  else if (hints.length > 0 && hints[hints.length - 1]?.code_hash === latestFail.code_hash) reason = 'code_unchanged';
  else if (userDayLeft <= 0 || exerciseDayLeft <= 0) reason = 'quota';

  return {
    enabled,
    level: reason ? null : level,
    reason,
    failedRuns,
    minutes,
    userDayLeft,
    exerciseDayLeft,
    hints,
    latestFail,
  };
}

export function hintState(ctx: Ctx, userId: number, exerciseId: string): HintStateResponse {
  const e = eligibility(ctx, userId, exerciseId);
  return {
    enabled: e.enabled,
    eligible_level: e.level,
    reason: e.reason,
    failed_runs: e.failedRuns,
    minutes_on_exercise: e.minutes,
    quota: { user_day_left: e.userDayLeft, exercise_day_left: e.exerciseDayLeft },
    hints: e.hints.map(toHint),
  };
}

interface LogFields {
  level: HintLevel;
  source: HintSource;
  model: string | null;
  provider: string | null;
  cache_hit: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  ttft_ms: number | null;
  latency_ms: number | null;
  filter_verdict: string | null;
  containment: number | null;
  swapped: boolean;
  raw_output: string | null;
  shown_output: string;
}

const userHash = (ctx: Ctx, userId: number) =>
  crypto.createHash('sha256').update(`${userId}${ctx.config.sessionSecret}`).digest('hex');

export async function requestHint(ctx: Ctx, userId: number, ex: Exercise, submissionId: number): Promise<Hint> {
  if (!ctx.config.hintsEnabled) throw new HttpError(503, 'hints_disabled', 'Hints are turned off on this server.');
  if (stopTripped(ctx)) throw new HttpError(503, 'hints_disabled', 'Hints are paused for today (daily budget reached).');

  const sub = ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId) as SubmissionRow | undefined;
  if (!sub || sub.user_id !== userId || sub.exercise_id !== ex.id || sub.mode !== 'practice') {
    throw new HttpError(404, 'not_found', 'unknown submission');
  }
  const el = eligibility(ctx, userId, ex.id);
  if (el.reason === 'need_failed_run') throw new HttpError(409, 'hint_not_eligible', 'A hint needs at least one failed graded run.');
  if (!el.latestFail || el.latestFail.id !== sub.id) {
    throw new HttpError(409, 'hint_not_eligible', 'Ask for a hint on your latest failed submission.');
  }
  if (el.reason === 'code_unchanged') throw new HttpError(409, 'hint_not_eligible', 'Change your code and resubmit before the next hint.');
  if (el.reason === 'quota') throw new HttpError(429, 'rate_limited', 'Hint quota used for today.');
  if (!el.level) throw new HttpError(503, 'hints_disabled', 'Hints are turned off on this server.');

  const level = el.level;
  const result = JSON.parse(sub.result_json) as GradeJobResponse;
  const fp = testFingerprint(result);
  const base = { model: null, provider: null, cache_hit: false, input_tokens: null, output_tokens: null,
    reasoning_tokens: null, cost_usd: null, ttft_ms: null, latency_ms: null, containment: null, raw_output: null };

  // Injection in the student's code: fixed refusal + a level 1 hint, no model call.
  if (hasInjection(sub.source)) {
    return writeLog(ctx, userId, ex.id, sub, fp, {
      ...base, level: 1, source: 'diff', filter_verdict: 'reject:injection_input', swapped: false,
      shown_output: `${REFUSAL} ${diffHint(result)}`,
    });
  }
  // No key configured: the deterministic diff hint (DESIGN.md §3.6 source "diff").
  if (!ctx.config.openrouterApiKey) {
    return writeLog(ctx, userId, ex.id, sub, fp, {
      ...base, level, source: 'diff', filter_verdict: null, swapped: false, shown_output: diffHint(result),
    });
  }

  const model = ctx.config.hintModel;
  const cacheKey = crypto.createHash('sha256')
    .update([ex.id, level, sub.code_hash, fp, PROMPT_VERSION, model].join('|')).digest('hex');
  const cached = ctx.db.prepare('SELECT text, model FROM hint_cache WHERE key = ?').get(cacheKey) as
    { text: string; model: string } | undefined;
  if (cached) {
    return writeLog(ctx, userId, ex.id, sub, fp, {
      ...base, level, source: 'llm', model: cached.model, cache_hit: true, filter_verdict: 'ok', swapped: false,
      shown_output: cached.text,
    });
  }

  const reference = ctx.content.reference(ex.id);
  const allowed = new Set<string>([...ex.allowed_functions, ...definedFunctions(sub.source), 'main']);
  const protoName = ex.prototype ? /([A-Za-z_]\w*)\s*\(/.exec(ex.prototype)?.[1] : undefined;
  if (protoName) allowed.add(protoName);
  const prompt = buildUserPrompt({
    level, attemptNo: sub.attempt_no, exercise: ex, result, source: sub.source,
    previousHints: el.hints.slice(-2).map((h) => h.shown_output),
  });
  const orOpts = {
    apiKey: ctx.config.openrouterApiKey,
    model,
    fallbacks: ctx.config.hintFallbackModels,
    providerIgnore: ctx.config.hintProviderIgnore,
    fetch: ctx.fetch,
    onGuardFailure: (what: string, detail: Record<string, unknown>) =>
      ctx.log.warn({ guard: what, ...detail, exercise: ex.id }, `hint guard failure: ${what}`),
  };

  const totals = { input: 0, output: 0, reasoning: 0, cost: 0, anyUsage: false };
  let last: CompletionResult | null = null;
  let verdict: FilterVerdict | null = null;
  let error: string | null = null;
  for (const temperature of [undefined, REGENERATE_TEMPERATURE]) {
    try {
      last = await complete(orOpts, { system: SYSTEM_PROMPT, user: prompt, level, temperature, userHash: userHash(ctx, userId) });
    } catch (err) {
      error = (err as Error).message;
      totals.cost += err instanceof OpenRouterError ? err.cost_usd : 0;
      ctx.log.warn({ err: error, exercise: ex.id }, 'openrouter call failed');
      last = null;
      break;
    }
    totals.anyUsage = true;
    totals.input += last.input_tokens ?? 0;
    totals.output += last.output_tokens ?? 0;
    totals.reasoning += last.reasoning_tokens ?? 0;
    totals.cost += last.cost_usd ?? 0;
    verdict = postFilter({ level, text: last.text, reference, allowed });
    if (verdict.ok && level === 3 && verdict.skeleton) {
      verdict = await skeletonCheck(ctx, userId, ex, result, verdict);
    }
    if (verdict.ok) break;
  }

  const usage = {
    model: last?.model ?? model,
    provider: last?.provider ?? null,
    input_tokens: totals.anyUsage ? totals.input : null,
    output_tokens: totals.anyUsage ? totals.output : null,
    reasoning_tokens: totals.anyUsage ? totals.reasoning : null,
    cost_usd: totals.cost,
    ttft_ms: last?.ttft_ms ?? null,
    latency_ms: last?.latency_ms ?? null,
    containment: verdict?.containment ?? null,
    raw_output: last?.text ?? null,
    cache_hit: false,
  };
  if (last && verdict?.ok) {
    ctx.db.prepare('INSERT OR REPLACE INTO hint_cache (key, level, text, model, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(cacheKey, level, last.text, usage.model, iso(ctx.now()));
    return writeLog(ctx, userId, ex.id, sub, fp, {
      ...usage, level, source: 'llm', filter_verdict: 'ok', swapped: false, shown_output: last.text,
    });
  }
  const canned = ctx.content.cannedHint(ex.id, level);
  return writeLog(ctx, userId, ex.id, sub, fp, {
    ...usage,
    level,
    source: canned ? 'canned' : 'diff',
    filter_verdict: error ? `error:${error.slice(0, 200)}` : (verdict?.verdict ?? null),
    swapped: last !== null,
    shown_output: canned ?? diffHint(result),
  });
}

/** Splices the L3 skeleton in as the student's file: reject if it passes a test the student fails. */
async function skeletonCheck(ctx: Ctx, userId: number, ex: Exercise, result: GradeJobResponse,
  v: FilterVerdict): Promise<FilterVerdict> {
  const failing = new Set(result.tests.filter((t) => t.status === 'KO').map((t) => t.id));
  if (failing.size === 0 || !v.skeleton) return v;
  try {
    const r = await ctx.grader.grade({
      job_id: crypto.randomUUID(),
      user_id: userId,
      exercise_id: ex.id,
      filename: ex.expected_files[0] ?? `${ex.id}.c`,
      source: v.skeleton,
      mode: 'practice',
      purpose: 'hint_skeleton_check',
    });
    if (r.tests.some((t) => t.status === 'OK' && failing.has(t.id))) {
      return { ...v, ok: false, verdict: 'reject:skeleton_passes' };
    }
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'skeleton check skipped: grader unavailable');
  }
  return v;
}

function writeLog(ctx: Ctx, userId: number, exerciseId: string, sub: SubmissionRow, fp: string, f: LogFields): Hint {
  const created = iso(ctx.now());
  const info = ctx.db.prepare(`INSERT INTO hint_log (user_id, exercise_id, submission_id, level, source, model, provider,
      prompt_version, code_hash, test_fingerprint, cache_hit, input_tokens, output_tokens, reasoning_tokens, cost_usd,
      ttft_ms, latency_ms, filter_verdict, containment, swapped, raw_output, shown_output, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, exerciseId, sub.id, f.level, f.source, f.model, f.provider, PROMPT_VERSION, sub.code_hash, fp,
      f.cache_hit ? 1 : 0, f.input_tokens, f.output_tokens, f.reasoning_tokens, f.cost_usd, f.ttft_ms, f.latency_ms,
      f.filter_verdict, f.containment, f.swapped ? 1 : 0, f.raw_output, f.shown_output, created);
  return {
    hint_id: Number(info.lastInsertRowid),
    level: f.level,
    text: f.shown_output,
    source: f.source,
    cached: f.cache_hit,
    created_at: created,
  };
}
