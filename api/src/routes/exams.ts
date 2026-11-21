import type { FastifyInstance } from 'fastify';
import type { ExamProfilesResponse, GrademeResponse, StartExamRequest, SubmitRequest } from '@ceg/contract';
import { stubExamStatus, stubExerciseDetails, stubGradeResult } from '../stubs.ts';
import { sendError, stub, submitBodySchema } from './util.ts';

// TODO(WP3): exam state machine on exams/exam_questions (DESIGN.md §3.7): random draw per
// slot, fail policy, cooldown, 410 after ends_at, scoring from the profile.

export async function examRoutes(app: FastifyInstance, opts: { profiles: ExamProfilesResponse }) {
  app.get('/api/exam/profiles', async (_req, reply) => reply.send(opts.profiles));

  app.post<{ Body: StartExamRequest }>('/api/exams', {
    schema: {
      body: {
        type: 'object',
        required: ['profile_id'],
        additionalProperties: false,
        properties: { profile_id: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const profile = opts.profiles.profiles.find((p) => p.id === req.body.profile_id);
    if (!profile || !profile.enabled) return sendError(reply, 400, 'bad_request', 'unknown or disabled profile');
    return stub(reply).code(201).send(stubExamStatus(profile.id));
  });

  app.get('/api/exams/current', async (_req, reply) => stub(reply).send(stubExamStatus()));

  app.get<{ Params: { examId: string } }>('/api/exams/:examId', async (_req, reply) =>
    stub(reply).send(stubExamStatus()));

  app.get<{ Params: { examId: string } }>('/api/exams/:examId/question', async (_req, reply) =>
    stub(reply).send(stubExerciseDetails.gym_echo_first));

  app.post<{ Params: { examId: string }; Body: SubmitRequest }>(
    '/api/exams/:examId/grademe',
    { schema: { body: submitBodySchema } },
    async (_req, reply) => {
      const body: GrademeResponse = {
        result: stubGradeResult('gym_echo_first', 'exam'),
        status: { ...stubExamStatus(), next_grade_at: new Date(Date.now() + 30_000).toISOString() },
      };
      return stub(reply).send(body);
    },
  );

  app.post<{ Params: { examId: string } }>('/api/exams/:examId/finish', async (_req, reply) =>
    stub(reply).send({ ...stubExamStatus(), status: 'finished', current: null }));
}
