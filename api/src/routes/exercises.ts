import type { FastifyInstance } from 'fastify';
import type { ExerciseListResponse } from '@ceg/contract';
import { stubExerciseDetails, stubExercises } from '../stubs.ts';
import { sendError, stub } from './util.ts';

// TODO(WP3): load CONTENT_DIR/exercises/*/*.json at startup (reload on SIGHUP),
// join per-user attempts/solved from submissions, never expose tests' expected output.

export async function exerciseRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { level?: number } }>('/api/exercises', {
    schema: { querystring: { type: 'object', properties: { level: { type: 'integer', minimum: 0, maximum: 5 } } } },
  }, async (req, reply) => {
    const { level } = req.query;
    const body: ExerciseListResponse = {
      exercises: stubExercises.filter((e) => level === undefined || e.level === level),
    };
    return stub(reply).send(body);
  });

  app.get<{ Params: { id: string } }>('/api/exercises/:id', async (req, reply) => {
    const ex = stubExerciseDetails[req.params.id];
    if (!ex) return sendError(reply, 404, 'not_found', `unknown exercise ${req.params.id}`);
    return stub(reply).send(ex);
  });
}
