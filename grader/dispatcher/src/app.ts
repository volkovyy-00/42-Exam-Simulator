import Fastify, { type FastifyInstance } from 'fastify';
import type { DispatcherHealth, GradeJobRequest, GradeJobResponse } from '@ceg/contract';
import type { DispatcherConfig } from './config.ts';

// Stub dispatcher. WP1 replaces the /grade handler with the real pipeline (DESIGN.md §6):
// file + static checks, job dir, hardened `docker run`, runner output parsing, byte compare,
// cat -e rendering, semaphore + queue, startup `docker info` guard, cleanup.

export const gradeBodySchema = {
  type: 'object',
  required: ['job_id', 'user_id', 'exercise_id', 'filename', 'source', 'mode', 'purpose'],
  additionalProperties: false,
  properties: {
    job_id: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
    user_id: { type: 'integer', minimum: 1 },
    exercise_id: { type: 'string', pattern: '^[a-z0-9_]+$' },
    filename: { type: 'string', maxLength: 64 },
    source: { type: 'string', maxLength: 65536 },
    mode: { enum: ['practice', 'exam'] },
    purpose: { enum: ['submission', 'hint_skeleton_check'] },
  },
} as const;

export async function buildApp(config: DispatcherConfig, logger = false): Promise<FastifyInstance> {
  const app = Fastify({ logger, bodyLimit: 128 * 1024 });

  app.get('/health', async () => {
    const body: DispatcherHealth = { ok: true, docker: false, image: config.image, queue: 0, running: 0 };
    return body;
  });

  app.post<{ Body: GradeJobRequest }>('/grade', { schema: { body: gradeBodySchema } }, async (req, reply) => {
    const body: GradeJobResponse = {
      job_id: req.body.job_id,
      verdict: 'ERROR',
      stage: 'file',
      message: 'grader not implemented yet (WP1)',
      tests: [],
      first_failure: null,
      compile_stderr: null,
      forbidden: [],
      duration_ms: 0,
      test_details: [],
      runner_version: 'stub',
    };
    return reply.header('x-stub', '1').send(body);
  });

  return app;
}
