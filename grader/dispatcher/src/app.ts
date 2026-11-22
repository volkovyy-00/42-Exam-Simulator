import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiError, DispatcherHealth, GradeJobRequest } from '@ceg/contract';
import type { DispatcherConfig } from './config.ts';
import { loadContent, type Content } from './content.ts';
import { dockerUp, makeDockerSandbox, type SandboxRunner } from './docker.ts';
import { DuplicateJobError, failBeforeSandbox, runJob } from './grade.ts';
import { BusyError, Scheduler } from './queue.ts';
import { checkFile, checkStatic } from './static.ts';

// Dispatcher (DESIGN.md §6): file + static checks, job dir, hardened `docker run`, runner output
// parsing, byte compare, cat -e rendering, semaphore + queue. Startup guard and cleanup: server.ts.

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

export interface Dispatcher {
  config: DispatcherConfig;
  scheduler: Scheduler;
  /** job ids with a job dir / container right now (cleanup skips them). */
  active: Set<string>;
  content(): Content;
  reload(): void;
}

declare module 'fastify' {
  interface FastifyInstance { dispatcher: Dispatcher }
}

export interface AppDeps {
  sandbox?: SandboxRunner;
  dockerHealth?: () => Promise<boolean>;
}

const SAFE_FILENAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.c$/;

export async function buildApp(config: DispatcherConfig, logger = false, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger, bodyLimit: 128 * 1024 });
  const sandbox = deps.sandbox ?? makeDockerSandbox(config.image);
  const dockerHealth = deps.dockerHealth ?? dockerUp;
  let content = loadContent(config.contentDir);
  const dispatcher: Dispatcher = {
    config,
    scheduler: new Scheduler(config.concurrency, config.queueMax),
    active: new Set(),
    content: () => content,
    reload: () => { content = loadContent(config.contentDir); },
  };

  const err = (error: ApiError['error'], message: string): ApiError => ({ error, message });

  app.get('/health', async () => {
    const docker = await dockerHealth().catch(() => false);
    const body: DispatcherHealth = {
      ok: docker, docker, image: config.image,
      queue: dispatcher.scheduler.queued, running: dispatcher.scheduler.running,
    };
    return body;
  });

  app.post<{ Body: GradeJobRequest }>('/grade', { schema: { body: gradeBodySchema } }, async (req, reply) => {
    const started = Date.now();
    const body = req.body;
    const ex = content.exercises.get(body.exercise_id);
    if (!ex) return reply.code(400).send(err('bad_request', `unknown exercise ${body.exercise_id}`));

    // file and static stages: no container, no job dir.
    const fileProblem = checkFile(ex, body.filename) ?? (SAFE_FILENAME.test(body.filename) ? null : `bad file name ${body.filename}`);
    if (fileProblem) return failBeforeSandbox(body, started, 'file', fileProblem);
    const staticProblem = checkStatic(ex, body.source);
    if (staticProblem) return failBeforeSandbox(body, started, 'static', staticProblem);

    if (dispatcher.active.has(body.job_id)) return reply.code(400).send(err('bad_request', 'duplicate job_id'));
    const userKey = body.purpose === 'hint_skeleton_check' ? null : body.user_id;
    try {
      return await dispatcher.scheduler.run(userKey, async () => {
        dispatcher.active.add(body.job_id);
        try {
          return await runJob(config, content, ex, body, sandbox, started);
        } finally {
          dispatcher.active.delete(body.job_id);
        }
      });
    } catch (e) {
      if (e instanceof BusyError) return reply.code(503).send(err('grader_busy', e.message));
      if (e instanceof DuplicateJobError) return reply.code(400).send(err('bad_request', e.message));
      req.log.error(e);
      return reply.code(500).send(err('internal', 'grader failure'));
    }
  });

  app.decorate('dispatcher', dispatcher);
  return app;
}
