import type { FastifyInstance } from 'fastify';
import type { HintRatingRequest, HintRequest } from '@ceg/contract';
import type { Ctx } from '../context.ts';
import { activeExam } from '../exams.ts';
import { hintState, requestHint } from '../hints/service.ts';
import { HttpError } from '../submissions.ts';
import { idParam, sendError, userOf } from './util.ts';

const EXAM_MSG = 'No hints during an exam.';

export async function hintRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get<{ Params: { exerciseId: string } }>('/api/practice/:exerciseId/hints', async (req, reply) => {
    const user = userOf(req);
    if (!ctx.content.get(req.params.exerciseId)) return sendError(reply, 404, 'not_found', 'unknown exercise');
    if (activeExam(ctx, user.id)) return sendError(reply, 403, 'forbidden', EXAM_MSG);
    return reply.send(hintState(ctx, user.id, req.params.exerciseId));
  });

  app.post<{ Params: { exerciseId: string }; Body: HintRequest }>('/api/practice/:exerciseId/hints', {
    schema: {
      body: {
        type: 'object',
        required: ['submission_id'],
        additionalProperties: false,
        properties: { submission_id: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (req, reply) => {
    const user = userOf(req);
    const ex = ctx.content.get(req.params.exerciseId);
    if (!ex) return sendError(reply, 404, 'not_found', 'unknown exercise');
    if (activeExam(ctx, user.id)) return sendError(reply, 403, 'forbidden', EXAM_MSG);
    try {
      return reply.send(await requestHint(ctx, user.id, ex, req.body.submission_id));
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.status).send(err.body);
      throw err;
    }
  });

  app.post<{ Params: { hintId: string }; Body: HintRatingRequest }>('/api/hints/:hintId/rating', {
    schema: {
      body: {
        type: 'object',
        required: ['rating'],
        additionalProperties: false,
        properties: { rating: { enum: ['helpful', 'wrong'] } },
      },
    },
  }, async (req, reply) => {
    const user = userOf(req);
    if (activeExam(ctx, user.id)) return sendError(reply, 403, 'forbidden', EXAM_MSG);
    const id = idParam(req.params.hintId);
    const info = id === null ? { changes: 0 } :
      ctx.db.prepare('UPDATE hint_log SET rating = ? WHERE id = ? AND user_id = ?').run(req.body.rating, id, user.id);
    if (info.changes === 0) return sendError(reply, 404, 'not_found', 'unknown hint');
    return reply.code(204).send();
  });
}
