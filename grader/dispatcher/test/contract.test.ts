import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

let app: FastifyInstance;
before(async () => { app = await buildApp(loadConfig({ CONTENT_DIR: 'fixtures' })); });
after(async () => app.close());

it('GET /health', async () => {
  const r = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(r.statusCode, 200);
  for (const k of ['ok', 'docker', 'image', 'queue', 'running']) assert.ok(k in r.json());
});

it('POST /grade answers with a GradeJobResponse', async () => {
  const r = await app.inject({
    method: 'POST', url: '/grade',
    payload: { job_id: randomUUID(), user_id: 1, exercise_id: 'gym_echo_first',
      filename: 'gym_echo_first.c', source: 'int main(void){return 0;}\n', mode: 'practice', purpose: 'submission' },
  });
  assert.equal(r.statusCode, 200);
  for (const k of ['job_id', 'verdict', 'stage', 'message', 'tests', 'first_failure', 'compile_stderr',
    'forbidden', 'duration_ms', 'test_details', 'runner_version']) assert.ok(k in r.json(), `missing ${k}`);
});

it('POST /grade validates the body', async () => {
  const r = await app.inject({ method: 'POST', url: '/grade', payload: { job_id: 'x' } });
  assert.equal(r.statusCode, 400);
});
