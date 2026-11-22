// Test helpers: a fake dispatcher on a random port (shape from contract/src/grader.ts), an app on
// a :memory: DB, a fake clock, and login.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Exercise, GradeJobRequest, GradeJobResponse } from '@ceg/contract';
import { buildApp } from '../src/app.ts';
import { createInvite } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES = path.join(root, 'fixtures');

// ---- fake dispatcher ---------------------------------------------------------------------

export type Responder = (req: GradeJobRequest) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

export interface FakeDispatcher {
  url: string;
  requests: GradeJobRequest[];
  respond: Responder;
  healthy: boolean;
  close(): Promise<void>;
}

export async function startFakeDispatcher(): Promise<FakeDispatcher> {
  const fake: FakeDispatcher = {
    url: '',
    requests: [],
    healthy: true,
    respond: (req) => ({ body: gradeResponse(req, 'FAIL') }),
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(fake.healthy ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: fake.healthy, docker: true, image: 'grader:pinned', queue: 0, running: 0 }));
        return;
      }
      if (req.method === 'POST' && req.url === '/grade') {
        const body = JSON.parse(data) as GradeJobRequest;
        fake.requests.push(body);
        const out = await fake.respond(body);
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return fake;
}

/** A dispatcher response. FAIL fails test 02 on output (missing newline), like DESIGN §3.5. */
export function gradeResponse(req: { job_id: string }, verdict: 'PASS' | 'FAIL' | 'ERROR',
  over: Partial<GradeJobResponse> = {}): GradeJobResponse {
  const pass = verdict === 'PASS';
  return {
    job_id: req.job_id,
    verdict,
    stage: pass ? 'done' : 'tests',
    message: pass ? 'All tests passed' : 'Test 02 failed: output differs',
    tests: [
      { id: '01', visible: true, status: 'OK' },
      { id: '02', visible: false, status: pass ? 'OK' : 'KO' },
    ],
    first_failure: pass ? null : {
      test_id: '02', hidden: true, argv: [], stdin: null, reason: 'output',
      expected_b64: 'Cg==', got_b64: '', expected_cat_e: '$', got_cat_e: '',
      expected_exit: 0, exit: 0, signal: null, timed_out: false, truncated: false, first_diff_byte: 0,
    },
    compile_stderr: null,
    forbidden: [],
    duration_ms: 12,
    test_details: [
      { id: '01', status: 'OK', reason: null, stdout_b64: 'YWJjCg==', exit: 0, signal: null, timed_out: false, truncated: false, duration_ms: 3 },
      { id: '02', status: pass ? 'OK' : 'KO', reason: pass ? null : 'output', stdout_b64: pass ? 'Cg==' : '', exit: 0, signal: null, timed_out: false, truncated: false, duration_ms: 3 },
    ],
    runner_version: '1',
    ...over,
  };
}

// ---- content with several exercises per level (exam tests) -------------------------------

/** Copies fixtures/ to a temp dir and adds `perLevel` clones of gym_echo_first at levels 0–5. */
export function makeContentDir(perLevel = 3): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceg-content-'));
  fs.cpSync(FIXTURES, dir, { recursive: true });
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'exercises/0/gym_echo_first.json'), 'utf8')) as Exercise;
  for (let level = 0; level <= 5; level++) {
    fs.mkdirSync(path.join(dir, 'exercises', String(level)), { recursive: true });
    for (let i = 0; i < perLevel; i++) {
      const id = `gym_l${level}_${String.fromCharCode(97 + i)}`;
      const ex: Exercise = { ...base, id, level, expected_files: [`${id}.c`], reference_path: 'refs/gym_echo_first.c' };
      fs.writeFileSync(path.join(dir, 'exercises', String(level), `${id}.json`), JSON.stringify(ex));
    }
  }
  return dir;
}

// ---- app ---------------------------------------------------------------------------------

export interface TestApp {
  app: FastifyInstance;
  clock: { t: number; advance(ms: number): void };
  close(): Promise<void>;
}

export async function startApp(opts: {
  dispatcherUrl: string;
  contentDir?: string;
  env?: Record<string, string>;
  fetch?: typeof fetch;
}): Promise<TestApp> {
  const clock = { t: Date.parse('2026-11-22T09:00:00Z'), advance(ms: number) { this.t += ms; } };
  const config = loadConfig({
    CONTENT_DIR: opts.contentDir ?? FIXTURES,
    WEB_DIST: path.join(root, 'nonexistent-dist'),
    DISPATCHER_URL: opts.dispatcherUrl,
    COOKIE_SECURE: 'true',
    SESSION_SECRET: 'test-secret',
    OPENROUTER_API_KEY: '',
    ...opts.env,
  });
  const failFetch = (async () => { throw new Error('real OpenRouter calls are not allowed in tests'); }) as typeof fetch;
  const app = await buildApp({ config, db: openDb(':memory:'), now: () => clock.t, fetch: opts.fetch ?? failFetch });
  return { app, clock, close: () => app.close() };
}

export const json = (payload: unknown) => ({
  payload: JSON.stringify(payload),
  headers: { 'content-type': 'application/json' },
});

/** Registers a fresh user with a new invite and returns its cookie header value. */
export async function login(app: FastifyInstance, username = 'zhenia', password = 'long-enough-pw'): Promise<string> {
  const code = createInvite(app.db);
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', ...json({ invite_code: code, username, password }) });
  if (r.statusCode !== 201) throw new Error(`register failed: ${r.statusCode} ${r.body}`);
  return cookieOf(r.headers['set-cookie']);
}

export function cookieOf(h: string | string[] | number | undefined): string {
  const s = Array.isArray(h) ? h[0] : String(h);
  return (s ?? '').split(';')[0] ?? '';
}

/** inject() with the session cookie and optional JSON body. */
export function as(app: FastifyInstance, cookie: string) {
  return (method: 'GET' | 'POST', url: string, body?: unknown) => app.inject({
    method,
    url,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
