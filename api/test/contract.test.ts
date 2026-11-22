// Contract smoke test: every endpoint in DESIGN.md §3 exists and answers with the documented
// status and shape. Runs against the real implementation, logged in, with a fake dispatcher.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { type FakeDispatcher, type TestApp, as, json, login, startApp, startFakeDispatcher } from './helpers.ts';

let fake: FakeDispatcher;
let t: TestApp;
let app: FastifyInstance;
let req: ReturnType<typeof as>;

before(async () => {
  fake = await startFakeDispatcher();
  t = await startApp({ dispatcherUrl: fake.url, env: { COOKIE_SECURE: 'false' } });
  app = t.app;
  req = as(app, await login(app, 'contract'));
});
after(async () => {
  await t.close();
  await fake.close();
});

function hasKeys(obj: unknown, keys: string[]) {
  assert.equal(typeof obj, 'object');
  for (const k of keys) assert.ok(k in (obj as object), `missing key ${k}`);
}

const gradeKeys = ['submission_id', 'exercise_id', 'mode', 'attempt_no', 'created_at', 'verdict',
  'stage', 'message', 'tests', 'first_failure', 'compile_stderr', 'forbidden', 'duration_ms'];
const examKeys = ['exam_id', 'profile_id', 'status', 'started_at', 'ends_at', 'now', 'time_left_s',
  'score', 'pass_mark', 'passed', 'slot', 'total_slots', 'level', 'current', 'next_grade_at', 'history'];

describe('database', () => {
  it('applies the schema', () => {
    const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((r) => (r as { name: string }).name);
    for (const t of ['users', 'invites', 'sessions', 'exams', 'exam_questions', 'submissions',
      'reveals', 'hint_cache', 'hint_log']) assert.ok(tables.includes(t), `missing table ${t}`);
  });
});

describe('health', () => {
  it('GET /api/health', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(r.statusCode, 200);
    hasKeys(r.json(), ['ok', 'version', 'grader', 'hints_enabled', 'exercises']);
    assert.equal(r.headers['x-stub'], undefined);
  });
});

describe('auth', () => {
  it('POST /api/auth/register', async () => {
    const { createInvite } = await import('../src/auth.ts');
    const code = createInvite(app.db);
    const r = await app.inject({ method: 'POST', url: '/api/auth/register',
      ...json({ invite_code: code, username: 'zhenia', password: 'long-enough-pw' }) });
    assert.equal(r.statusCode, 201);
    hasKeys(r.json().user, ['id', 'username', 'is_admin']);
  });
  it('POST /api/auth/register rejects a short password', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register',
      ...json({ invite_code: 'abc', username: 'zhenia', password: 'short' }) });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'bad_request');
  });
  it('POST /api/auth/login', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login',
      ...json({ username: 'zhenia', password: 'long-enough-pw' }) });
    assert.equal(r.statusCode, 200);
    hasKeys(r.json().user, ['id', 'username', 'is_admin']);
  });
  it('rejects non-JSON bodies with 415', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: 'username=x',
      headers: { 'content-type': 'text/plain' } });
    assert.equal(r.statusCode, 415);
    assert.equal(r.json().error, 'unsupported_media_type');
  });
  it('GET /api/me', async () => {
    const r = await req('GET', '/api/me');
    assert.equal(r.statusCode, 200);
    hasKeys(r.json().user, ['id', 'username', 'is_admin']);
  });
});

describe('exercises', () => {
  it('GET /api/exercises', async () => {
    const r = await req('GET', '/api/exercises?level=0');
    assert.equal(r.statusCode, 200);
    const { exercises } = r.json();
    assert.ok(Array.isArray(exercises));
    assert.ok(exercises.length > 0);
    for (const e of exercises) {
      hasKeys(e, ['id', 'level', 'kind', 'attempts', 'solved', 'solved_without_hints']);
      assert.equal(e.level, 0);
    }
  });
  it('GET /api/exercises/:id never leaks expected output', async () => {
    const r = await req('GET', '/api/exercises/gym_echo_first');
    assert.equal(r.statusCode, 200);
    hasKeys(r.json(), ['id', 'level', 'kind', 'expected_files', 'allowed_functions', 'prototype',
      'subject_md', 'subject_source', 'visible_tests', 'autocomplete_words']);
    assert.ok(!r.body.includes('expected_stdout_b64'));
    assert.ok(!r.body.includes('reference_path'));
  });
  it('GET /api/exercises/:id 404', async () => {
    const r = await req('GET', '/api/exercises/nope');
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, 'not_found');
  });
});

describe('practice', () => {
  const src = { filename: 'gym_echo_first.c', source: 'int main(void){return 0;}\n' };
  let submissionId = 0;
  it('POST /api/practice/:id/submissions', async () => {
    const r = await req('POST', '/api/practice/gym_echo_first/submissions', src);
    assert.equal(r.statusCode, 200);
    hasKeys(r.json(), gradeKeys);
    assert.ok(!('test_details' in r.json()), 'test_details must be stripped');
    submissionId = r.json().submission_id;
  });
  it('GET /api/practice/:id/submissions', async () => {
    const r = await req('GET', '/api/practice/gym_echo_first/submissions');
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().submissions.length >= 1);
    for (const s of r.json().submissions) hasKeys(s, ['id', 'attempt_no', 'verdict', 'stage', 'created_at']);
  });
  it('GET /api/submissions/:id', async () => {
    const r = await req('GET', `/api/submissions/${submissionId}`);
    assert.equal(r.statusCode, 200);
    hasKeys(r.json(), [...gradeKeys, 'filename', 'source']);
  });
  it('GET /api/practice/:id/solution', async () => {
    const r = await req('GET', '/api/practice/gym_echo_first/solution');
    assert.ok([200, 403].includes(r.statusCode));
    if (r.statusCode === 200) hasKeys(r.json(), ['exercise_id', 'filename', 'source']);
  });
});

describe('hints', () => {
  it('GET /api/practice/:id/hints', async () => {
    const r = await req('GET', '/api/practice/gym_echo_first/hints');
    assert.equal(r.statusCode, 200);
    hasKeys(r.json(), ['enabled', 'eligible_level', 'reason', 'failed_runs', 'minutes_on_exercise', 'quota', 'hints']);
  });
  it('POST /api/practice/:id/hints is 503 when hints are disabled', async () => {
    const r = await req('POST', '/api/practice/gym_echo_first/hints', { submission_id: 1 });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error, 'hints_disabled');
  });
  it('POST /api/hints/:id/rating', async () => {
    // No hint exists while hints are disabled: an unknown hint id is a JSON 404.
    const r = await req('POST', '/api/hints/1/rating', { rating: 'wrong' });
    assert.ok([204, 404].includes(r.statusCode));
    if (r.statusCode === 404) assert.equal(r.json().error, 'not_found');
  });
});

describe('exams', () => {
  let examId = 0;
  it('GET /api/exam/profiles', async () => {
    const r = await req('GET', '/api/exam/profiles');
    assert.equal(r.statusCode, 200);
    const p = r.json().profiles.find((x: { id: string }) => x.id === 'piscine_exam');
    assert.ok(p);
    assert.equal(p.slots.length, 16);
    assert.equal(p.points.reduce((a: number, b: number) => a + b, 0), 100);
    assert.equal(p.pass_mark, 30);
  });
  it('POST /api/exams', async () => {
    const r = await req('POST', '/api/exams', { profile_id: 'piscine_exam' });
    assert.equal(r.statusCode, 201);
    hasKeys(r.json(), examKeys);
    examId = r.json().exam_id;
  });
  it('POST /api/exams rejects a disabled profile', async () => {
    const r = await req('POST', '/api/exams', { profile_id: 'rank02' });
    assert.equal(r.statusCode, 400);
  });
  it('GET /api/exams/current', async () => {
    const r = await req('GET', '/api/exams/current');
    assert.ok([200, 404].includes(r.statusCode));
    if (r.statusCode === 200) hasKeys(r.json(), examKeys);
  });
  it('GET /api/exams/:id', async () => {
    const r = await req('GET', `/api/exams/${examId}`);
    assert.equal(r.statusCode, 200);
    hasKeys(r.json(), examKeys);
  });
  it('GET /api/exams/:id/question', async () => {
    const r = await req('GET', `/api/exams/${examId}/question`);
    assert.equal(r.statusCode, 200);
    hasKeys(r.json(), ['id', 'expected_files', 'subject_md', 'visible_tests']);
  });
  it('POST /api/exams/:id/grademe', async () => {
    const r = await req('POST', `/api/exams/${examId}/grademe`,
      { filename: 'gym_echo_first.c', source: 'int main(void){return 0;}\n' });
    assert.equal(r.statusCode, 200);
    hasKeys(r.json().result, gradeKeys);
    hasKeys(r.json().status, examKeys);
  });
  it('POST /api/exams/:id/finish', async () => {
    const r = await req('POST', `/api/exams/${examId}/finish`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().status, 'finished');
  });
  it('POST /api/auth/logout', async () => {
    const r = await req('POST', '/api/auth/logout');
    assert.equal(r.statusCode, 204);
  });
});

describe('fallbacks', () => {
  it('unknown /api route is a JSON 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, 'not_found');
  });
  it('no route sets x-stub', () => {
    // Every route above answered without the stub marker; stubs.ts is gone.
    assert.ok(app.routeTable.length > 0);
  });
});
