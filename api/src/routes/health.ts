import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@ceg/contract';
import type { Ctx } from '../context.ts';
import { publicRoute } from './util.ts';

export const VERSION = '0.1.0';

export async function healthRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get('/api/health', publicRoute, async (_req, reply) => {
    const d = await ctx.grader.health();
    const body: HealthResponse = {
      ok: true,
      version: VERSION,
      grader: d?.ok ? 'up' : 'down',
      hints_enabled: ctx.config.hintsEnabled,
      exercises: ctx.content.count,
    };
    return reply.send(body);
  });
}
