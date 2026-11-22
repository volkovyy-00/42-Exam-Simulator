import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Exercise } from '@ceg/contract';
import { codeHash, findNonAsciiOutsideLiterals, normalizeSource } from '../src/normalize.ts';
import { FIXTURES, type FakeDispatcher, type TestApp, as, gradeResponse, login, startApp, startFakeDispatcher } from './helpers.ts';

describe('normalizeSource (DESIGN §7)', () => {
  it('CRLF and lone CR → LF', () => {
    const r = normalizeSource('a\r\nb\rc\n');
    assert.ok(r.ok);
    assert.equal(r.ok && r.source, 'a\nb\nc\n');
  });
  it('rejects > 64 KiB (bytes, not characters)', () => {
    assert.equal(normalizeSource('x'.repeat(65536)).ok, true);
    assert.equal(normalizeSource('x'.repeat(65537)).ok, false);
    const r = normalizeSource(`/*${'é'.repeat(33000)}*/`);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.message : '', /too large/);
  });
  it('allows non-ASCII in strings, chars and comments; rejects it elsewhere with line:col', () => {
    assert.equal(findNonAsciiOutsideLiterals('char *s = "héllo"; // ça va\n/* ñ\n */ char c = \'é\';'), null);
    assert.equal(findNonAsciiOutsideLiterals('char *s = "a\\"é";'), null);
    const bad = normalizeSource('int main(void)\n{\n\tint café = 0;\n}\n');
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.message : '', /line 3, column 9/);
    // A "string" inside a comment does not open a literal.
    const p = findNonAsciiOutsideLiterals('// "\nint é;');
    assert.deepEqual(p && { line: p.line, col: p.col }, { line: 2, col: 5 });
  });
  it('code_hash ignores trailing whitespace per line', () => {
    assert.equal(codeHash('int a;  \nint b;\t\n'), codeHash('int a;\nint b;\n'));
    assert.notEqual(codeHash('int a;\n'), codeHash('int b;\n'));
  });
});

describe('practice', () => {
  let fake: FakeDispatcher;
  let t: TestApp;
  before(async () => {
    fake = await startFakeDispatcher();
    t = await startApp({ dispatcherUrl: fake.url });
  });
  after(async () => {
    await t.close();
    await fake.close();
  });
  beforeEach(() => {
    fake.requests.length = 0;
    fake.respond = (r) => ({ body: gradeResponse(r, 'FAIL') });
  });

  it('forwards the normalized source with a uuid job_id, stores the row, strips test_details', async () => {
    const req = as(t.app, await login(t.app, 'user_p1'));
    const r = await req('POST', '/api/practice/gym_echo_first/submissions',
      { filename: 'gym_echo_first.c', source: 'int\tmain(void)\r\n{\r\n\treturn (0);\r\n}\r\n' });
    assert.equal(r.statusCode, 200);
    assert.equal(fake.requests.length, 1);
    const sent = fake.requests[0]!;
    assert.equal(sent.source, 'int\tmain(void)\n{\n\treturn (0);\n}\n');
    assert.match(sent.job_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(sent.mode, 'practice');
    assert.equal(sent.purpose, 'submission');
    assert.equal(sent.exercise_id, 'gym_echo_first');
    const body = r.json();
    assert.ok(!('test_details' in body));
    assert.ok(!r.body.includes('test_details') && !r.body.includes('runner_version'));
    assert.equal(body.attempt_no, 1);
    assert.equal(body.mode, 'practice');
    assert.equal(body.verdict, 'FAIL');
    const row = t.app.db.prepare('SELECT * FROM submissions WHERE id = ?').get(body.submission_id) as Record<string, unknown>;
    assert.equal(row.source, sent.source);
    assert.ok(JSON.parse(row.result_json as string).test_details.length === 2, 'full result_json stored');
    assert.equal(row.code_hash, codeHash(sent.source));
    const second = await req('POST', '/api/practice/gym_echo_first/submissions', { filename: 'gym_echo_first.c', source: 'int x;\n' });
    assert.equal(second.json().attempt_no, 2);
  });

  it('non-ASCII outside literals → 422 bad_source with line and column; nothing is graded', async () => {
    const req = as(t.app, await login(t.app, 'user_p2'));
    const r = await req('POST', '/api/practice/gym_echo_first/submissions',
      { filename: 'gym_echo_first.c', source: 'int main(void)\n{\n  return (0); « \n}\n' });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error, 'bad_source');
    assert.match(r.json().message, /line 3, column 15/);
    assert.equal(fake.requests.length, 0);
  });

  it('the 7th submit within a minute → 429 rate_limited', async () => {
    const req = as(t.app, await login(t.app, 'user_p3'));
    const src = { filename: 'gym_echo_first.c', source: 'int x;\n' };
    for (let i = 0; i < 6; i++) assert.equal((await req('POST', '/api/practice/gym_echo_first/submissions', src)).statusCode, 200);
    const r = await req('POST', '/api/practice/gym_echo_first/submissions', src);
    assert.equal(r.statusCode, 429);
    assert.equal(r.json().error, 'rate_limited');
    assert.equal(fake.requests.length, 6);
    t.clock.advance(61_000);
    assert.equal((await req('POST', '/api/practice/gym_echo_first/submissions', src)).statusCode, 200);
  });

  it('1 submission in flight per user → 503 grader_busy', async () => {
    const req = as(t.app, await login(t.app, 'user_p4'));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fake.respond = async (r) => { await gate; return { body: gradeResponse(r, 'PASS') }; };
    const src = { filename: 'gym_echo_first.c', source: 'int x;\n' };
    const first = req('POST', '/api/practice/gym_echo_first/submissions', src);
    while (fake.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await req('POST', '/api/practice/gym_echo_first/submissions', src);
    assert.equal(second.statusCode, 503);
    assert.equal(second.json().error, 'grader_busy');
    release();
    assert.equal((await first).statusCode, 200);
  });

  it('dispatcher 503 → 503 grader_busy, nothing stored', async () => {
    const req = as(t.app, await login(t.app, 'user_p5'));
    fake.respond = () => ({ status: 503, body: { error: 'grader_busy', message: 'queue full' } });
    const r = await req('POST', '/api/practice/gym_echo_first/submissions', { filename: 'gym_echo_first.c', source: 'int x;\n' });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error, 'grader_busy');
    assert.equal((await req('GET', '/api/practice/gym_echo_first/submissions')).json().submissions.length, 0);
  });

  it('history is newest first; submission detail is owner-only', async () => {
    const req = as(t.app, await login(t.app, 'user_p6'));
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await req('POST', '/api/practice/gym_echo_first/submissions', { filename: 'gym_echo_first.c', source: `int x${i};\n` })).json().submission_id);
    }
    const h = (await req('GET', '/api/practice/gym_echo_first/submissions')).json().submissions;
    assert.deepEqual(h.map((s: { id: number }) => s.id), [...ids].reverse());
    assert.deepEqual(h.map((s: { attempt_no: number }) => s.attempt_no), [3, 2, 1]);
    const d = await req('GET', `/api/submissions/${ids[0]}`);
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().source, 'int x0;\n');
    assert.ok(!d.body.includes('test_details'));
    const other = as(t.app, await login(t.app, 'user_p6b'));
    const denied = await other('GET', `/api/submissions/${ids[0]}`);
    assert.equal(denied.statusCode, 404);
    assert.equal((await req('GET', '/api/practice/nope/submissions')).statusCode, 404);
  });

  it('GET /api/exercises/:id never contains expected output or the reference path (every fixture)', async () => {
    const req = as(t.app, await login(t.app, 'user_p7'));
    const files = fs.readdirSync(path.join(FIXTURES, 'exercises'))
      .flatMap((l) => fs.readdirSync(path.join(FIXTURES, 'exercises', l)).map((f) => path.join(FIXTURES, 'exercises', l, f)));
    assert.ok(files.length >= 2);
    const list = (await req('GET', '/api/exercises')).json().exercises;
    assert.equal(list.length, files.length);
    for (const f of files) {
      const ex = JSON.parse(fs.readFileSync(f, 'utf8')) as Exercise;
      const r = await req('GET', `/api/exercises/${ex.id}`);
      assert.equal(r.statusCode, 200);
      assert.ok(!r.body.includes('expected_stdout_b64'), ex.id);
      assert.ok(!r.body.includes('reference_path'), ex.id);
      assert.ok(!r.body.includes(ex.reference_path), ex.id);
      for (const tc of ex.tests) assert.ok(!r.body.includes(tc.expected_stdout_b64), `${ex.id} test ${tc.id}`);
      assert.deepEqual(r.json().visible_tests.map((v: { id: string }) => v.id), ex.tests.filter((x) => x.visible).map((x) => x.id));
    }
  });

  it('solution: 403 before any attempt, 200 after one (reveal recorded), 403 during an active exam', async () => {
    const req = as(t.app, await login(t.app, 'user_p8'));
    const before = await req('GET', '/api/practice/gym_strlen/solution');
    assert.equal(before.statusCode, 403);
    assert.equal(before.json().error, 'forbidden');
    await req('POST', '/api/practice/gym_strlen/submissions', { filename: 'gym_strlen.c', source: 'int x;\n' });
    const ok = await req('GET', '/api/practice/gym_strlen/solution');
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().filename, 'gym_strlen.c');
    assert.equal(ok.json().source, fs.readFileSync(path.join(FIXTURES, 'refs/gym_strlen.c'), 'utf8'));
    const reveals = t.app.db.prepare("SELECT COUNT(*) AS n FROM reveals WHERE exercise_id = 'gym_strlen'").get() as { n: number };
    assert.equal(reveals.n, 1);
    assert.equal((await req('POST', '/api/exams', { profile_id: 'piscine_exam' })).statusCode, 201);
    const during = await req('GET', '/api/practice/gym_strlen/solution');
    assert.equal(during.statusCode, 403);
  });

  it('practice grading is 403 during an active exam (no row, nothing graded), 200 after finish', async () => {
    const req = as(t.app, await login(t.app, 'user_p10'));
    const exam = (await req('POST', '/api/exams', { profile_id: 'piscine_exam' })).json();
    const exId = exam.current.exercise_id as string;
    const count = () => (t.app.db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE exercise_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)')
      .get(exId, 'user_p10') as { n: number }).n;
    const src = { filename: `${exId}.c`, source: 'int x;\n' };
    const r = await req('POST', `/api/practice/${exId}/submissions`, src);
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error, 'forbidden');
    assert.equal(r.json().message, 'No practice grading during an exam.');
    assert.equal(count(), 0);
    assert.equal(fake.requests.length, 0);
    assert.equal((await req('GET', `/api/practice/${exId}/submissions`)).statusCode, 200, 'history stays readable');
    assert.equal((await req('POST', `/api/exams/${exam.exam_id}/finish`)).statusCode, 200);
    const ok = await req('POST', `/api/practice/${exId}/submissions`, src);
    assert.equal(ok.statusCode, 200);
    assert.equal(count(), 1);
  });

  it('solved / solved_without_hints: a reveal before the PASS spoils it, a PASS before the reveal keeps it', async () => {
    const req = as(t.app, await login(t.app, 'user_p9'));
    const src = (f: string) => ({ filename: f, source: 'int x;\n' });
    // gym_strlen: FAIL, reveal, PASS → solved, not without hints.
    await req('POST', '/api/practice/gym_strlen/submissions', src('gym_strlen.c'));
    t.clock.advance(2000);
    await req('GET', '/api/practice/gym_strlen/solution');
    t.clock.advance(2000);
    fake.respond = (r) => ({ body: gradeResponse(r, 'PASS') });
    await req('POST', '/api/practice/gym_strlen/submissions', src('gym_strlen.c'));
    // gym_echo_first: PASS, then reveal → still without hints.
    await req('POST', '/api/practice/gym_echo_first/submissions', src('gym_echo_first.c'));
    t.clock.advance(2000);
    await req('GET', '/api/practice/gym_echo_first/solution');
    const list = (await req('GET', '/api/exercises')).json().exercises as { id: string; attempts: number; solved: boolean; solved_without_hints: boolean }[];
    const by = Object.fromEntries(list.map((e) => [e.id, e]));
    assert.deepEqual([by.gym_strlen?.solved, by.gym_strlen?.solved_without_hints, by.gym_strlen?.attempts], [true, false, 2]);
    assert.deepEqual([by.gym_echo_first?.solved, by.gym_echo_first?.solved_without_hints], [true, true]);
  });
});
