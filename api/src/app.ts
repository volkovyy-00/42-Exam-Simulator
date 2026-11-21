import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ApiError, ExamProfile } from '@ceg/contract';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
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
}

export async function buildApp({ config, db, logger = false }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger, bodyLimit: 128 * 1024 });
  app.decorate('db', db);

  // CSRF posture: JSON bodies only (DESIGN.md §3.1). Fastify answers 415 for other types.
  app.removeContentTypeParser('text/plain');

  app.setErrorHandler((err: { statusCode?: number; validation?: unknown; message: string }, _req, reply) => {
    const status = err.statusCode ?? 500;
    let body: ApiError;
    if (err.validation) body = { error: 'bad_request', message: err.message };
    else if (status === 415) body = { error: 'unsupported_media_type', message: 'Send application/json.' };
    else if (status === 413) body = { error: 'bad_source', message: 'Request body too large.' };
    else if (status < 500) body = { error: 'bad_request', message: err.message };
    else {
      app.log.error(err);
      body = { error: 'internal', message: 'Internal error.' };
    }
    return reply.code(status).send(body);
  });

  const profiles = JSON.parse(fs.readFileSync(config.examProfilesPath, 'utf8')) as ExamProfile[];

  await app.register(healthRoutes, { config });
  await app.register(authRoutes);
  await app.register(exerciseRoutes);
  await app.register(practiceRoutes);
  await app.register(hintRoutes, { config });
  await app.register(examRoutes, { profiles: { profiles } });

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
  }
}
