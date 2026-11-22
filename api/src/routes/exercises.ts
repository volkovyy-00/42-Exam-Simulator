import type { FastifyInstance } from 'fastify';
import type { ExerciseListResponse, ExerciseSummary } from '@ceg/contract';
import { toDetail } from '../content.ts';
import type { Ctx } from '../context.ts';
import { sendError, userOf } from './util.ts';

interface ProgressRow { exercise_id: string; attempts: number; solved: number; solved_clean: number }

/**
 * Per-exercise progress for one user. "Solved without hints" = a PASS with no hint_log row and
 * no reveal for that exercise dated at or before it (DESIGN.md §4).
 */
export function progressByExercise(ctx: Ctx, userId: number): Map<string, ProgressRow> {
  const rows = ctx.db.prepare(`
    SELECT s.exercise_id,
           COUNT(*) AS attempts,
           MAX(s.verdict = 'PASS') AS solved,
           MAX(s.verdict = 'PASS'
               AND NOT EXISTS (SELECT 1 FROM hint_log h WHERE h.user_id = s.user_id
                                 AND h.exercise_id = s.exercise_id AND h.created_at <= s.created_at)
               AND NOT EXISTS (SELECT 1 FROM reveals r WHERE r.user_id = s.user_id
                                 AND r.exercise_id = s.exercise_id AND r.revealed_at <= s.created_at)
           ) AS solved_clean
    FROM submissions s WHERE s.user_id = ? GROUP BY s.exercise_id`).all(userId) as ProgressRow[];
  return new Map(rows.map((r) => [r.exercise_id, r]));
}

export async function exerciseRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get<{ Querystring: { level?: number } }>('/api/exercises', {
    schema: { querystring: { type: 'object', properties: { level: { type: 'integer', minimum: 0, maximum: 5 } } } },
  }, async (req, reply) => {
    const user = userOf(req);
    const progress = progressByExercise(ctx, user.id);
    const exercises: ExerciseSummary[] = ctx.content.list(req.query.level).map((e) => {
      const p = progress.get(e.id);
      return {
        id: e.id,
        level: e.level,
        kind: e.kind,
        attempts: p?.attempts ?? 0,
        solved: (p?.solved ?? 0) === 1,
        solved_without_hints: (p?.solved_clean ?? 0) === 1,
      };
    });
    const body: ExerciseListResponse = { exercises };
    return reply.send(body);
  });

  app.get<{ Params: { id: string } }>('/api/exercises/:id', async (req, reply) => {
    userOf(req);
    const ex = ctx.content.get(req.params.id);
    if (!ex) return sendError(reply, 404, 'not_found', `unknown exercise ${req.params.id}`);
    return reply.send(toDetail(ex));
  });
}
