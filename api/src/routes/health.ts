import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@ceg/contract';
import type { Config } from '../config.ts';
import { stub } from './util.ts';

export async function healthRoutes(app: FastifyInstance, opts: { config: Config }) {
  app.get('/api/health', async (_req, reply) => {
    // TODO(WP3): ping DISPATCHER_URL/health and count loaded exercises.
    const body: HealthResponse = {
      ok: true,
      version: '0.1.0',
      grader: 'down',
      hints_enabled: opts.config.hintsEnabled,
      exercises: 0,
    };
    return stub(reply).send(body);
  });
}
