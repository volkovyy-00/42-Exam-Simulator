import type { FastifyInstance } from 'fastify';
import type { SolutionResponse, SubmissionDetail, SubmissionListResponse, SubmitRequest } from '@ceg/contract';
import { iso, type Ctx } from '../context.ts';
import { activeExam } from '../exams.ts';
import { HttpError, getSubmission, gradeAndStore, toGradeResult } from '../submissions.ts';
import { idParam, sendError, submitBodySchema, userOf } from './util.ts';

export async function practiceRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.post<{ Params: { exerciseId: string }; Body: SubmitRequest }>(
    '/api/practice/:exerciseId/submissions',
    { schema: { body: submitBodySchema } },
    async (req, reply) => {
      const user = userOf(req);
      const ex = ctx.content.get(req.params.exerciseId);
      if (!ex) return sendError(reply, 404, 'not_found', `unknown exercise ${req.params.exerciseId}`);
      try {
        const row = await gradeAndStore(ctx, {
          userId: user.id, exercise: ex, mode: 'practice', filename: req.body.filename, source: req.body.source,
        });
        return reply.send(toGradeResult(row));
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.status).send(err.body);
        throw err;
      }
    },
  );

  app.get<{ Params: { exerciseId: string } }>('/api/practice/:exerciseId/submissions', async (req, reply) => {
    const user = userOf(req);
    if (!ctx.content.get(req.params.exerciseId)) {
      return sendError(reply, 404, 'not_found', `unknown exercise ${req.params.exerciseId}`);
    }
    const rows = ctx.db.prepare(`SELECT id, attempt_no, verdict, stage, created_at FROM submissions
        WHERE user_id = ? AND exercise_id = ? AND mode = 'practice' ORDER BY id DESC LIMIT 50`)
      .all(user.id, req.params.exerciseId) as SubmissionListResponse['submissions'];
    const body: SubmissionListResponse = { submissions: rows };
    return reply.send(body);
  });

  app.get<{ Params: { id: string } }>('/api/submissions/:id', async (req, reply) => {
    const user = userOf(req);
    const id = idParam(req.params.id);
    const row = id === null ? undefined : getSubmission(ctx, id);
    if (!row || row.user_id !== user.id) return sendError(reply, 404, 'not_found', 'unknown submission');
    const body: SubmissionDetail = { ...toGradeResult(row), filename: row.filename, source: row.source };
    return reply.send(body);
  });

  app.get<{ Params: { exerciseId: string } }>('/api/practice/:exerciseId/solution', async (req, reply) => {
    const user = userOf(req);
    const ex = ctx.content.get(req.params.exerciseId);
    if (!ex) return sendError(reply, 404, 'not_found', `unknown exercise ${req.params.exerciseId}`);
    if (activeExam(ctx, user.id)) return sendError(reply, 403, 'forbidden', 'No solution reveal during an exam.');
    const graded = ctx.db.prepare(`SELECT 1 FROM submissions WHERE user_id = ? AND exercise_id = ?
        AND mode = 'practice' AND verdict IN ('PASS','FAIL') LIMIT 1`).get(user.id, ex.id);
    if (!graded) return sendError(reply, 403, 'forbidden', 'Submit at least one graded attempt first.');
    const source = ctx.content.reference(ex.id);
    if (source === null) return sendError(reply, 404, 'not_found', 'No reference solution for this exercise.');
    ctx.db.prepare('INSERT OR IGNORE INTO reveals (user_id, exercise_id, revealed_at) VALUES (?, ?, ?)')
      .run(user.id, ex.id, iso(ctx.now()));
    const body: SolutionResponse = { exercise_id: ex.id, filename: ex.expected_files[0] ?? `${ex.id}.c`, source };
    return reply.send(body);
  });
}
