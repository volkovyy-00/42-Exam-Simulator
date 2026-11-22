import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError, ErrorCode, User } from '@ceg/contract';

export function sendError(reply: FastifyReply, status: number, error: ErrorCode, message: string,
  extra: Partial<ApiError> = {}): FastifyReply {
  const body: ApiError = { error, message, ...extra };
  return reply.code(status).send(body);
}

/** The logged-in user. The auth hook in app.ts guarantees it on every protected route. */
export function userOf(req: FastifyRequest): User {
  if (!req.user) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  return req.user;
}

/** Fastify route option marking a route as reachable without a session. */
export const publicRoute = { config: { public: true } } as const;

export const submitBodySchema = {
  type: 'object',
  required: ['filename', 'source'],
  additionalProperties: false,
  properties: {
    filename: { type: 'string', minLength: 3, maxLength: 64 },
    // The 64 KiB limit is checked in bytes by normalizeSource (422 bad_source), not here.
    source: { type: 'string' },
  },
} as const;

export const idParam = (s: string): number | null => (/^[1-9]\d{0,15}$/.test(s) ? Number(s) : null);
