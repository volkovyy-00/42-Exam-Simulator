import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ExamProfile, ExamProfilesResponse, GrademeResponse, StartExamRequest, SubmitRequest } from '@ceg/contract';
import { toDetail } from '../content.ts';
import { iso, type Ctx } from '../context.ts';
import {
  type ExamRow,
  activeExam,
  applyExpiry,
  assignSlot,
  cooldownMs,
  currentQuestion,
  examStatus,
  getExam,
  slotPoints,
} from '../exams.ts';
import { HttpError, gradeAndStore, toGradeResult } from '../submissions.ts';
import { idParam, sendError, submitBodySchema, userOf } from './util.ts';

export async function examRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const profileOf = (id: string): ExamProfile | undefined => ctx.profiles.find((p) => p.id === id);

  /** The caller's exam by URL id (404 for anyone else's), with expiry applied. */
  const ownExam = (reply: FastifyReply, userId: number, raw: string): { exam: ExamRow; profile: ExamProfile } | null => {
    const id = idParam(raw);
    const row = id === null ? undefined : getExam(ctx, id);
    const profile = row ? profileOf(row.profile_id) : undefined;
    if (!row || row.user_id !== userId || !profile) {
      sendError(reply, 404, 'not_found', 'unknown exam');
      return null;
    }
    return { exam: applyExpiry(ctx, row), profile };
  };

  app.get('/api/exam/profiles', async (req, reply) => {
    userOf(req);
    const body: ExamProfilesResponse = { profiles: ctx.profiles };
    return reply.send(body);
  });

  app.post<{ Body: StartExamRequest }>('/api/exams', {
    schema: {
      body: {
        type: 'object',
        required: ['profile_id'],
        additionalProperties: false,
        properties: { profile_id: { type: 'string', maxLength: 64 } },
      },
    },
  }, async (req, reply) => {
    const user = userOf(req);
    const profile = profileOf(req.body.profile_id);
    if (!profile || !profile.enabled) return sendError(reply, 400, 'bad_request', 'unknown or disabled profile');
    if (activeExam(ctx, user.id)) return sendError(reply, 409, 'conflict', 'You already have an active exam.');
    const firstLevel = profile.slots[0];
    if (firstLevel === undefined || ctx.content.list(firstLevel).length === 0) {
      return sendError(reply, 400, 'bad_request', `no exercises at level ${firstLevel ?? '?'} for this profile`);
    }
    const nowMs = ctx.now();
    const tx = ctx.db.transaction((): number => {
      const info = ctx.db.prepare(`INSERT INTO exams (user_id, profile_id, status, started_at, ends_at)
          VALUES (?, ?, 'active', ?, ?)`)
        .run(user.id, profile.id, iso(nowMs), iso(nowMs + profile.duration_min * 60_000));
      const examId = Number(info.lastInsertRowid);
      assignSlot(ctx, examId, profile, 0);
      return examId;
    });
    let examId: number;
    try {
      examId = tx();
    } catch (err) {
      // The one_active_exam unique index catches a concurrent second start.
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return sendError(reply, 409, 'conflict', 'You already have an active exam.');
      }
      throw err;
    }
    return reply.code(201).send(examStatus(ctx, getExam(ctx, examId) as ExamRow, profile));
  });

  app.get('/api/exams/current', async (req, reply) => {
    const user = userOf(req);
    const exam = activeExam(ctx, user.id);
    const profile = exam ? profileOf(exam.profile_id) : undefined;
    if (!exam || !profile) return sendError(reply, 404, 'not_found', 'no active exam');
    return reply.send(examStatus(ctx, exam, profile));
  });

  app.get<{ Params: { examId: string } }>('/api/exams/:examId', async (req, reply) => {
    const own = ownExam(reply, userOf(req).id, req.params.examId);
    if (!own) return reply;
    return reply.send(examStatus(ctx, own.exam, own.profile));
  });

  app.get<{ Params: { examId: string } }>('/api/exams/:examId/question', async (req, reply) => {
    const own = ownExam(reply, userOf(req).id, req.params.examId);
    if (!own) return reply;
    const q = own.exam.status === 'active' ? currentQuestion(ctx, own.exam.id) : undefined;
    const ex = q ? ctx.content.get(q.exercise_id) : undefined;
    if (!ex) return sendError(reply, 404, 'not_found', 'no current question');
    return reply.send(toDetail(ex));
  });

  app.post<{ Params: { examId: string }; Body: SubmitRequest }>(
    '/api/exams/:examId/grademe',
    { schema: { body: submitBodySchema } },
    async (req, reply) => {
      const user = userOf(req);
      const own = ownExam(reply, user.id, req.params.examId);
      if (!own) return reply;
      const { exam, profile } = own;
      if (exam.status === 'expired') {
        return sendError(reply, 410, 'exam_over', 'The exam is over. This submission was not graded.');
      }
      if (exam.status !== 'active') return sendError(reply, 409, 'conflict', 'This exam is finished.');
      const q = currentQuestion(ctx, exam.id);
      const ex = q ? ctx.content.get(q.exercise_id) : undefined;
      if (!q || !ex) return sendError(reply, 409, 'conflict', 'No question left to grade.');
      if (q.next_grade_at && Date.parse(q.next_grade_at) > ctx.now()) {
        return sendError(reply, 429, 'cooldown', 'Wait before the next grademe.', {
          next_grade_at: q.next_grade_at,
          retry_after_s: Math.ceil((Date.parse(q.next_grade_at) - ctx.now()) / 1000),
        });
      }

      let row;
      try {
        row = await gradeAndStore(ctx, {
          userId: user.id,
          exercise: ex,
          mode: 'exam',
          filename: req.body.filename,
          source: req.body.source,
          examQuestionId: q.id,
          onStored: (sub) => {
            // Re-read inside the transaction: the question may have changed while grading.
            const live = currentQuestion(ctx, exam.id);
            if (!live || live.id !== q.id) return;
            const nowIso = iso(ctx.now());
            if (sub.verdict === 'PASS') {
              const pts = slotPoints(profile, q.slot, q.failures);
              ctx.db.prepare("UPDATE exam_questions SET status = 'passed', points = ?, resolved_at = ?, next_grade_at = NULL WHERE id = ?")
                .run(pts, nowIso, q.id);
              const score = (getExam(ctx, exam.id) as ExamRow).score + pts;
              ctx.db.prepare('UPDATE exams SET score = ?, passed = ? WHERE id = ?')
                .run(score, score >= profile.pass_mark ? 1 : 0, exam.id);
              if (q.slot + 1 < profile.slots.length) assignSlot(ctx, exam.id, profile, q.slot + 1);
            } else if (sub.verdict === 'FAIL') {
              const failures = q.failures + 1;
              const next = iso(ctx.now() + cooldownMs(profile, failures));
              if (profile.fail_policy === 'new_exercise') {
                ctx.db.prepare("UPDATE exam_questions SET status = 'replaced', failures = ?, resolved_at = ?, next_grade_at = ? WHERE id = ?")
                  .run(failures, nowIso, next, q.id);
                assignSlot(ctx, exam.id, profile, q.slot, { failures, next_grade_at: next, avoid: q.exercise_id });
              } else {
                ctx.db.prepare('UPDATE exam_questions SET failures = ?, next_grade_at = ? WHERE id = ?').run(failures, next, q.id);
              }
            }
            // ERROR (grader failure) is not the student's fault: no failure, no cooldown.
          },
        });
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.status).send(err.body);
        throw err;
      }
      const body: GrademeResponse = {
        result: toGradeResult(row),
        status: examStatus(ctx, getExam(ctx, exam.id) as ExamRow, profile),
      };
      return reply.send(body);
    },
  );

  app.post<{ Params: { examId: string } }>('/api/exams/:examId/finish', async (req, reply) => {
    const own = ownExam(reply, userOf(req).id, req.params.examId);
    if (!own) return reply;
    if (own.exam.status === 'active') {
      const nowIso = iso(ctx.now());
      ctx.db.transaction(() => {
        ctx.db.prepare("UPDATE exams SET status = 'finished', finished_at = ? WHERE id = ?").run(nowIso, own.exam.id);
        ctx.db.prepare("UPDATE exam_questions SET status = 'abandoned', resolved_at = ? WHERE exam_id = ? AND status = 'current'")
          .run(nowIso, own.exam.id);
      })();
    }
    return reply.send(examStatus(ctx, getExam(ctx, own.exam.id) as ExamRow, own.profile));
  });
}
