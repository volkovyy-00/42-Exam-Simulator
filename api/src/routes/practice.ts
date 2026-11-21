import type { FastifyInstance } from 'fastify';
import type { SubmissionListResponse, SubmitRequest } from '@ceg/contract';
import {
  stubExerciseDetails,
  stubGradeResult,
  stubSolution,
  stubSubmissionDetail,
  stubSubmissions,
} from '../stubs.ts';
import { sendError, stub, submitBodySchema } from './util.ts';

// TODO(WP3): normalize source (DESIGN.md §7), rate limit, call the dispatcher
// (POST DISPATCHER_URL/grade), store the submission, strip test_details.

export async function practiceRoutes(app: FastifyInstance) {
  app.post<{ Params: { exerciseId: string }; Body: SubmitRequest }>(
    '/api/practice/:exerciseId/submissions',
    { schema: { body: submitBodySchema } },
    async (req, reply) => {
      if (!stubExerciseDetails[req.params.exerciseId]) {
        return sendError(reply, 404, 'not_found', `unknown exercise ${req.params.exerciseId}`);
      }
      return stub(reply).send(stubGradeResult(req.params.exerciseId, 'practice'));
    },
  );

  app.get<{ Params: { exerciseId: string } }>('/api/practice/:exerciseId/submissions', async (_req, reply) => {
    const body: SubmissionListResponse = { submissions: stubSubmissions };
    return stub(reply).send(body);
  });

  app.get<{ Params: { id: string } }>('/api/submissions/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return sendError(reply, 404, 'not_found', 'unknown submission');
    return stub(reply).send(stubSubmissionDetail(id));
  });

  app.get<{ Params: { exerciseId: string } }>('/api/practice/:exerciseId/solution', async (req, reply) => {
    if (!stubExerciseDetails[req.params.exerciseId]) {
      return sendError(reply, 404, 'not_found', `unknown exercise ${req.params.exerciseId}`);
    }
    return stub(reply).send(stubSolution(req.params.exerciseId));
  });
}
