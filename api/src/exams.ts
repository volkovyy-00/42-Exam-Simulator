// Exam state machine on exams / exam_questions (DESIGN.md §3.7, §4).
import type { ExamHistoryEntry, ExamProfile, ExamStatus } from '@ceg/contract';
import { iso, type Ctx } from './context.ts';

export interface ExamRow {
  id: number;
  user_id: number;
  profile_id: string;
  status: 'active' | 'finished' | 'expired';
  started_at: string;
  ends_at: string;
  finished_at: string | null;
  score: number;
  passed: number;
}

export interface QuestionRow {
  id: number;
  exam_id: number;
  slot: number;
  level: number;
  exercise_id: string;
  status: 'current' | 'passed' | 'replaced' | 'abandoned';
  failures: number;
  points: number;
  next_grade_at: string | null;
  assigned_at: string;
  resolved_at: string | null;
}

export function getExam(ctx: Ctx, id: number): ExamRow | undefined {
  return ctx.db.prepare('SELECT * FROM exams WHERE id = ?').get(id) as ExamRow | undefined;
}

export function currentQuestion(ctx: Ctx, examId: number): QuestionRow | undefined {
  return ctx.db.prepare("SELECT * FROM exam_questions WHERE exam_id = ? AND status = 'current'")
    .get(examId) as QuestionRow | undefined;
}

/** Expiry on read: an active exam past ends_at becomes 'expired' and its question 'abandoned'. */
export function applyExpiry(ctx: Ctx, exam: ExamRow): ExamRow {
  if (exam.status !== 'active' || Date.parse(exam.ends_at) > ctx.now()) return exam;
  const tx = ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE exams SET status = 'expired', finished_at = ends_at WHERE id = ? AND status = 'active'").run(exam.id);
    ctx.db.prepare("UPDATE exam_questions SET status = 'abandoned', resolved_at = ? WHERE exam_id = ? AND status = 'current'")
      .run(exam.ends_at, exam.id);
  });
  tx();
  return getExam(ctx, exam.id) as ExamRow;
}

/** The user's active exam, after expiry. */
export function activeExam(ctx: Ctx, userId: number): ExamRow | null {
  const row = ctx.db.prepare("SELECT * FROM exams WHERE user_id = ? AND status = 'active'").get(userId) as ExamRow | undefined;
  if (!row) return null;
  const after = applyExpiry(ctx, row);
  return after.status === 'active' ? after : null;
}

/**
 * Random exercise at `level`, avoiding everything already drawn in this exam. If the level is
 * exhausted, falls back to any exercise at the level except `avoid`; null if the level is empty.
 */
export function drawExercise(ctx: Ctx, examId: number, level: number, avoid: string | null,
  random: () => number = Math.random): string | null {
  const pool = ctx.content.list(level).map((e) => e.id);
  if (pool.length === 0) return null;
  const drawn = new Set((ctx.db.prepare('SELECT exercise_id FROM exam_questions WHERE exam_id = ?').all(examId) as
    { exercise_id: string }[]).map((r) => r.exercise_id));
  let candidates = pool.filter((id) => !drawn.has(id));
  if (candidates.length === 0) candidates = pool.filter((id) => id !== avoid);
  if (candidates.length === 0) candidates = pool;
  return candidates[Math.floor(random() * candidates.length)] ?? null;
}

/** Inserts the question for `slot`; returns false if the slot's level has no exercises. */
export function assignSlot(ctx: Ctx, examId: number, profile: ExamProfile, slot: number,
  carry: { failures: number; next_grade_at: string | null; avoid: string | null } = { failures: 0, next_grade_at: null, avoid: null }): boolean {
  const level = profile.slots[slot];
  if (level === undefined) return false;
  const ex = drawExercise(ctx, examId, level, carry.avoid);
  if (!ex) return false;
  ctx.db.prepare(`INSERT INTO exam_questions (exam_id, slot, level, exercise_id, status, failures, next_grade_at, assigned_at)
      VALUES (?, ?, ?, ?, 'current', ?, ?, ?)`)
    .run(examId, slot, level, ex, carry.failures, carry.next_grade_at, iso(ctx.now()));
  return true;
}

export function cooldownMs(profile: ExamProfile, failures: number): number {
  const list = profile.cooldown_min;
  if (failures < 1 || list.length === 0) return 0;
  const m = list[Math.min(failures - 1, list.length - 1)] as number;
  return Math.round(m * 60_000);
}

export function slotPoints(profile: ExamProfile, slot: number, failures: number): number {
  const base = profile.points[slot] ?? 0;
  if (profile.decay.length === 0) return base;
  const f = profile.decay[Math.min(failures, profile.decay.length - 1)] ?? 1;
  return Math.round(base * f);
}

export function examStatus(ctx: Ctx, exam: ExamRow, profile: ExamProfile): ExamStatus {
  const nowMs = ctx.now();
  const qs = ctx.db.prepare('SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY id').all(exam.id) as QuestionRow[];
  const cur = exam.status === 'active' ? qs.find((q) => q.status === 'current') : undefined;
  const passedSlots = qs.filter((q) => q.status === 'passed').length;
  const history: ExamHistoryEntry[] = qs
    .filter((q) => q.status === 'passed' || q.status === 'replaced')
    .map((q) => ({
      slot: q.slot,
      level: q.level,
      exercise_id: q.exercise_id,
      result: q.status === 'passed' ? 'passed' : 'replaced',
      points: q.points,
      at: q.resolved_at ?? q.assigned_at,
    }));
  const ex = cur ? ctx.content.get(cur.exercise_id) : undefined;
  const nextGrade = cur?.next_grade_at && Date.parse(cur.next_grade_at) > nowMs ? cur.next_grade_at : null;
  return {
    exam_id: exam.id,
    profile_id: exam.profile_id,
    status: exam.status,
    started_at: exam.started_at,
    ends_at: exam.ends_at,
    now: iso(nowMs),
    time_left_s: exam.status === 'active' ? Math.max(0, Math.ceil((Date.parse(exam.ends_at) - nowMs) / 1000)) : 0,
    score: exam.score,
    pass_mark: profile.pass_mark,
    passed: exam.passed === 1,
    slot: cur ? cur.slot : passedSlots,
    total_slots: profile.slots.length,
    level: cur ? cur.level : null,
    current: cur ? {
      exercise_id: cur.exercise_id,
      expected_files: ex ? [...ex.expected_files] : [`${cur.exercise_id}.c`],
      assigned_at: cur.assigned_at,
      failures: cur.failures,
    } : null,
    next_grade_at: nextGrade,
    history,
  };
}
