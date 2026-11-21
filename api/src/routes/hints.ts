import type { FastifyInstance } from 'fastify';
import type { HintRatingRequest, HintRequest } from '@ceg/contract';
import type { Config } from '../config.ts';
import { stubHint, stubHintState } from '../stubs.ts';
import { sendError, stub } from './util.ts';

// TODO(WP3): level gating, anti-farming (code hash), quotas, OpenRouter client, post-filter,
// hint_cache + hint_log, 403 while an exam is active (DESIGN.md §3.6, §8).

export async function hintRoutes(app: FastifyInstance, opts: { config: Config }) {
  app.get<{ Params: { exerciseId: string } }>('/api/practice/:exerciseId/hints', async (_req, reply) => {
    return stub(reply).send({ ...stubHintState, enabled: opts.config.hintsEnabled });
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
  }, async (_req, reply) => {
    if (!opts.config.hintsEnabled) {
      return sendError(stub(reply), 503, 'hints_disabled', 'Hints are turned off on this server.');
    }
    return stub(reply).send(stubHint);
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
  }, async (_req, reply) => stub(reply).code(204).send());
}
