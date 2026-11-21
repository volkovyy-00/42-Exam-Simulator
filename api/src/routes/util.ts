import type { FastifyReply } from 'fastify';
import type { ApiError, ErrorCode } from '@ceg/contract';

/** Marks a response as coming from a stub route (DESIGN.md §3.1). */
export function stub(reply: FastifyReply): FastifyReply {
  return reply.header('x-stub', '1');
}

export function sendError(reply: FastifyReply, status: number, error: ErrorCode, message: string,
  extra: Partial<ApiError> = {}): FastifyReply {
  const body: ApiError = { error, message, ...extra };
  return reply.code(status).send(body);
}

export const submitBodySchema = {
  type: 'object',
  required: ['filename', 'source'],
  additionalProperties: false,
  properties: {
    filename: { type: 'string', minLength: 3, maxLength: 64 },
    source: { type: 'string', maxLength: 65536 },
  },
} as const;
