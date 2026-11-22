import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ApiError, ExamProfile } from '@ceg/contract';
import { SESSION_COOKIE, readCookie, sessionUser } from './auth.ts';
import type { Config } from './config.ts';
import { ContentStore } from './content.ts';
import type { Ctx } from './context.ts';
import type { DB } from './db.ts';
import { type GraderClient, graderClient } from './grader.ts';
import { authRoutes } from './routes/auth.ts';
import { examRoutes } from './routes/exams.ts';
import { exerciseRoutes } from './routes/exercises.ts';
import { healthRoutes } from './routes/health.ts';
import { hintRoutes } from './routes/hints.ts';
import { practiceRoutes } from './routes/practice.ts';

export interface AppDeps {
  config: Config;
  db: DB;
  logger?: boolean;
  /** Clock in ms. Defaults to Date.now. */
  now?: () => number;
  /** fetch for OpenRouter. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Dispatcher client. Defaults to HTTP against config.dispatcherUrl. */
  grader?: GraderClient;
  content?: ContentStore;
}

export interface RouteInfo { method: string; url: string; public: boolean }

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, logger = false } = deps;
  const app = Fastify({ logger, bodyLimit: 256 * 1024 });

  const ctx: Ctx = {
    config,
    db,
    content: deps.content ?? new ContentStore(config.contentDir),
    grader: deps.grader ?? graderClient(config.dispatcherUrl),
    profiles: JSON.parse(fs.readFileSync(config.examProfilesPath, 'utf8')) as ExamProfile[],
    now: deps.now ?? Date.now,
    fetch: deps.fetch ?? fetch,
    log: app.log,
    inFlight: new Set(),
  };
  app.decorate('db', db);
  app.decorate('ctx', ctx);

  // Route table, for the "every protected route is 401" test.
  const routes: RouteInfo[] = [];
  app.decorate('routeTable', routes);
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    const isPublic = (r.config as { public?: boolean } | undefined)?.public === true;
    for (const m of methods) if (m !== 'HEAD') routes.push({ method: m, url: r.url, public: isPublic });
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  // CSRF posture (DESIGN.md §3.1): mutating routes take JSON only, else 415. Then auth: every
  // /api route not marked public needs a valid session, else 401. Both run in onRequest, before
  // the body is parsed, so a request without a session never reaches validation or a handler.
  app.removeContentTypeParser('text/plain');
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions;
    if (!route.url || !req.url.startsWith('/api/')) return; // unknown route → 404 handler
    if (MUTATING.has(req.method)) {
      const ct = (req.headers['content-type'] ?? '').toLowerCase();
      const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
      if ((ct && !/^application\/json\s*(;|$)/.test(ct)) || (hasBody && !ct)) {
        const body: ApiError = { error: 'unsupported_media_type', message: 'Send application/json.' };
        return reply.code(415).send(body);
      }
    }
    if ((route.config as { public?: boolean }).public === true) return;
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const s = token ? sessionUser(db, token, ctx.now()) : null;
    if (!s) {
      const body: ApiError = { error: 'unauthorized', message: 'Log in first.' };
      return reply.code(401).send(body);
    }
    req.user = s.user;
    req.sessionId = s.sessionId;
  });

  app.setErrorHandler((err: { statusCode?: number; validation?: unknown; message: string }, _req, reply) => {
    const status = err.statusCode ?? 500;
    let body: ApiError;
    if (err.validation) body = { error: 'bad_request', message: err.message };
    else if (status === 401) body = { error: 'unauthorized', message: 'Log in first.' };
    else if (status === 415) body = { error: 'unsupported_media_type', message: 'Send application/json.' };
    else if (status === 413) body = { error: 'bad_source', message: 'Request body too large.' };
    else if (status < 500) body = { error: 'bad_request', message: err.message };
    else {
      app.log.error(err);
      body = { error: 'internal', message: 'Internal error.' };
    }
    return reply.code(status).send(body);
  });

  await app.register(healthRoutes, { ctx });
  await app.register(authRoutes, { ctx });
  await app.register(exerciseRoutes, { ctx });
  await app.register(practiceRoutes, { ctx });
  await app.register(hintRoutes, { ctx });
  await app.register(examRoutes, { ctx });

  const hasSpa = fs.existsSync(path.join(config.webDist, 'index.html'));
  if (hasSpa) await app.register(fastifyStatic, { root: config.webDist, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !hasSpa || req.method !== 'GET') {
      const body: ApiError = { error: 'not_found', message: `No route for ${req.method} ${req.url}` };
      return reply.code(404).send(body);
    }
    return reply.sendFile('index.html');
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
    ctx: Ctx;
    routeTable: RouteInfo[];
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}
