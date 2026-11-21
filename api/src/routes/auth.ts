import type { FastifyInstance } from 'fastify';
import type { LoginRequest, MeResponse, RegisterRequest } from '@ceg/contract';
import { stubUser } from '../stubs.ts';
import { stub } from './util.ts';

// TODO(WP3): argon2id hashing, invites, sessions table, ceg_session cookie
// (httpOnly, Secure, SameSite=Strict), login rate limit, 401 on every protected route.

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: RegisterRequest }>('/api/auth/register', {
    schema: {
      body: {
        type: 'object',
        required: ['invite_code', 'username', 'password'],
        additionalProperties: false,
        properties: {
          invite_code: { type: 'string', minLength: 1, maxLength: 64 },
          username: { type: 'string', pattern: '^[a-z0-9_-]{3,20}$' },
          password: { type: 'string', minLength: 10, maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const body: MeResponse = { user: { ...stubUser, username: req.body.username } };
    return stub(reply).code(201).send(body);
  });

  app.post<{ Body: LoginRequest }>('/api/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        additionalProperties: false,
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 20 },
          password: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const body: MeResponse = { user: { ...stubUser, username: req.body.username } };
    return stub(reply).send(body);
  });

  app.post('/api/auth/logout', async (_req, reply) => stub(reply).code(204).send());

  app.get('/api/me', async (_req, reply) => {
    const body: MeResponse = { user: stubUser };
    return stub(reply).send(body);
  });
}
