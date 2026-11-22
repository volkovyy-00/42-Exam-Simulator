import type { FastifyInstance } from 'fastify';
import type { LoginRequest, MeResponse, RegisterRequest } from '@ceg/contract';
import {
  LoginLimiter,
  clearedCookie,
  createSession,
  deleteSession,
  dummyPasswordHash,
  findUserByName,
  registerWithInvite,
  sessionCookie,
  toUser,
  verifyPassword,
} from '../auth.ts';
import type { Ctx } from '../context.ts';
import { publicRoute, sendError, userOf } from './util.ts';

export async function authRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const { db, config } = ctx;
  const limiter = new LoginLimiter();

  app.post<{ Body: RegisterRequest }>('/api/auth/register', {
    ...publicRoute,
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
    const { invite_code, username, password } = req.body;
    const out = await registerWithInvite(db, invite_code.trim().toLowerCase(), username, password, ctx.now());
    if (!out.ok) return sendError(reply, out.status, out.status === 409 ? 'conflict' : 'unauthorized', out.message);
    const { token, expiresMs } = createSession(db, out.user.id, ctx.now());
    reply.header('set-cookie', sessionCookie(token, expiresMs, config.cookieSecure));
    const body: MeResponse = { user: out.user };
    return reply.code(201).send(body);
  });

  app.post<{ Body: LoginRequest }>('/api/auth/login', {
    ...publicRoute,
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
    const { username, password } = req.body;
    const wait = limiter.hit(username, ctx.now());
    if (wait > 0) {
      return sendError(reply, 429, 'rate_limited', 'Too many login attempts. Try again later.', { retry_after_s: wait });
    }
    const row = findUserByName(db, username);
    const ok = await verifyPassword(row?.password_hash ?? await dummyPasswordHash(), password);
    if (!row || !ok) return sendError(reply, 401, 'unauthorized', 'Wrong username or password.');
    const { token, expiresMs } = createSession(db, row.id, ctx.now());
    reply.header('set-cookie', sessionCookie(token, expiresMs, config.cookieSecure));
    const body: MeResponse = { user: toUser(row) };
    return reply.send(body);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    userOf(req);
    if (req.sessionId) deleteSession(db, req.sessionId);
    reply.header('set-cookie', clearedCookie(config.cookieSecure));
    return reply.code(204).send();
  });

  app.get('/api/me', async (req, reply) => {
    const body: MeResponse = { user: userOf(req) };
    return reply.send(body);
  });
}
