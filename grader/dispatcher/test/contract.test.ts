import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { FIXTURES } from './fixtures-path.ts';
import { loadConfig } from '../src/config.ts';
import type { SandboxRunner } from '../src/docker.ts';

// Contract shape only, with a fake sandbox (no Docker). Real grading: test/grading/.
const fakeSandbox: SandboxRunner = async () => ({
  code: 0, killed: false, stderr: '',
  stdout: JSON.stringify({ runner_version: '1', stage: 'compile', compile_ok: false, compile_stderr: 'fake',
    nm_symbols: [], forbidden: [], link_ok: false, link_stderr: '', tests: [] }) + '\n',
});

let app: FastifyInstance;
let jobsDir: string;
before(async () => {
  jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceg-jobs-'));
  app = await buildApp(loadConfig({ CONTENT_DIR: FIXTURES, JOBS_DIR: jobsDir }), false,
    { sandbox: fakeSandbox, dockerHealth: async () => true });
});
after(async () => { await app.close(); fs.rmSync(jobsDir, { recursive: true, force: true }); });

it('GET /health', async () => {
  const r = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(r.statusCode, 200);
  for (const k of ['ok', 'docker', 'image', 'queue', 'running']) assert.ok(k in r.json());
});

it('POST /grade answers with a GradeJobResponse and no stub header', async () => {
  const r = await app.inject({
    method: 'POST', url: '/grade',
    payload: { job_id: randomUUID(), user_id: 1, exercise_id: 'gym_echo_first',
      filename: 'gym_echo_first.c', source: 'int main(void){return 0;}\n', mode: 'practice', purpose: 'submission' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['x-stub'], undefined);
  for (const k of ['job_id', 'verdict', 'stage', 'message', 'tests', 'first_failure', 'compile_stderr',
    'forbidden', 'duration_ms', 'test_details', 'runner_version']) assert.ok(k in r.json(), `missing ${k}`);
});

it('POST /grade validates the body', async () => {
  const r = await app.inject({ method: 'POST', url: '/grade', payload: { job_id: 'x' } });
  assert.equal(r.statusCode, 400);
});

it('POST /grade rejects an unknown exercise with 400', async () => {
  const r = await app.inject({
    method: 'POST', url: '/grade',
    payload: { job_id: randomUUID(), user_id: 1, exercise_id: 'nope', filename: 'nope.c', source: '',
      mode: 'practice', purpose: 'submission' },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'bad_request');
});
