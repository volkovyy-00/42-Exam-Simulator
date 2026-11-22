import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { type FakeDispatcher, type TestApp, as, gradeResponse, login, makeContentDir, startApp, startFakeDispatcher } from './helpers.ts';

let fake: FakeDispatcher;
let t: TestApp;
let contentDir: string;
let n = 0;

before(async () => {
  fake = await startFakeDispatcher();
  contentDir = makeContentDir(3);
  t = await startApp({ dispatcherUrl: fake.url, contentDir });
});
after(async () => {
  await t.close();
  await fake.close();
  fs.rmSync(contentDir, { recursive: true, force: true });
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.respond = (r) => ({ body: gradeResponse(r, 'FAIL') });
});

async function user() {
  return as(t.app, await login(t.app, `exam_user${++n}`));
}
const submit = (exerciseId: string) => ({ filename: `${exerciseId}.c`, source: 'int x;\n' });

describe('exams', () => {
  it('start → slot 0 at level 0; a second start → 409; current/status/question agree', async () => {
    const req = await user();
    const r = await req('POST', '/api/exams', { profile_id: 'piscine_exam' });
    assert.equal(r.statusCode, 201);
    const s = r.json();
    assert.equal(s.status, 'active');
    assert.equal(s.slot, 0);
    assert.equal(s.level, 0);
    assert.equal(s.total_slots, 16);
    assert.equal(s.score, 0);
    assert.equal(s.time_left_s, 240 * 60);
    assert.equal(Date.parse(s.ends_at) - Date.parse(s.started_at), 240 * 60_000);
    assert.equal(s.next_grade_at, null);
    assert.ok(s.current.exercise_id);
    assert.deepEqual(s.current.expected_files, [`${s.current.exercise_id}.c`]);

    const again = await req('POST', '/api/exams', { profile_id: 'piscine_final' });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, 'conflict');

    const cur = await req('GET', '/api/exams/current');
    assert.equal(cur.json().exam_id, s.exam_id);
    const q = await req('GET', `/api/exams/${s.exam_id}/question`);
    assert.equal(q.statusCode, 200);
    assert.equal(q.json().id, s.current.exercise_id);
    assert.equal(q.json().level, 0);
    assert.ok(!q.body.includes('expected_stdout_b64') && !q.body.includes('reference_path'));

    const other = await user();
    assert.equal((await other('GET', `/api/exams/${s.exam_id}`)).statusCode, 404);
    assert.equal((await other('POST', `/api/exams/${s.exam_id}/grademe`, submit(s.current.exercise_id))).statusCode, 404);
  });

  it('FAIL → 429 cooldown until next_grade_at, then a different exercise at the same level; PASS → +6 and slot 1', async () => {
    const req = await user();
    const s0 = (await req('POST', '/api/exams', { profile_id: 'piscine_exam' })).json();
    const ex0 = s0.current.exercise_id;

    const fail = await req('POST', `/api/exams/${s0.exam_id}/grademe`, submit(ex0));
    assert.equal(fail.statusCode, 200);
    const { result, status } = fail.json();
    assert.equal(result.mode, 'exam');
    assert.equal(result.verdict, 'FAIL');
    assert.ok(!fail.body.includes('test_details'));
    assert.equal(fake.requests[0]?.mode, 'exam');
    // new_exercise: a different exercise at the same level, same slot, cooldown 0.5 min.
    assert.equal(status.slot, 0);
    assert.equal(status.level, 0);
    assert.notEqual(status.current.exercise_id, ex0);
    assert.equal(status.current.failures, 1);
    assert.equal(Date.parse(status.next_grade_at) - t.clock.t, 30_000);
    assert.deepEqual(status.history.map((h: { result: string; exercise_id: string }) => [h.result, h.exercise_id]), [['replaced', ex0]]);
    const ex1 = status.current.exercise_id;

    const early = await req('POST', `/api/exams/${s0.exam_id}/grademe`, submit(ex1));
    assert.equal(early.statusCode, 429);
    assert.equal(early.json().error, 'cooldown');
    assert.equal(early.json().next_grade_at, status.next_grade_at);
    assert.equal(fake.requests.length, 1, 'nothing graded during cooldown');

    t.clock.advance(29_000);
    assert.equal((await req('POST', `/api/exams/${s0.exam_id}/grademe`, submit(ex1))).statusCode, 429);
    t.clock.advance(1_000);

    // Second FAIL in the slot: cooldown index 1 → 2.5 min.
    const fail2 = (await req('POST', `/api/exams/${s0.exam_id}/grademe`, submit(ex1))).json();
    assert.equal(fail2.status.current.failures, 2);
    assert.equal(Date.parse(fail2.status.next_grade_at) - t.clock.t, 150_000);
    t.clock.advance(150_000);

    fake.respond = (r) => ({ body: gradeResponse(r, 'PASS') });
    const pass = (await req('POST', `/api/exams/${s0.exam_id}/grademe`, submit(fail2.status.current.exercise_id))).json();
    assert.equal(pass.result.verdict, 'PASS');
    assert.equal(pass.status.score, 6);
    assert.equal(pass.status.slot, 1);
    assert.equal(pass.status.level, 0);
    assert.equal(pass.status.current.failures, 0);
    assert.equal(pass.status.next_grade_at, null);
    // Slot 1 avoids every exercise already drawn in this exam (4 at level 0 → the one left).
    const drawn = new Set([ex0, ex1, fail2.status.current.exercise_id]);
    assert.equal(drawn.size, 3);
    assert.ok(!drawn.has(pass.status.current.exercise_id));
    assert.equal(pass.status.history.length, 3);
    // Level 0 is now exhausted; the next draw at level 0 falls back to a repeat, never the same one twice in a row.
    t.clock.advance(60_000);
    fake.respond = (r) => ({ body: gradeResponse(r, 'FAIL') });
    const last = pass.status.current.exercise_id;
    const f3 = (await req('POST', `/api/exams/${s0.exam_id}/grademe`, submit(last))).json();
    assert.equal(f3.status.level, 0);
    assert.notEqual(f3.status.current.exercise_id, last);
  });

  it('a scripted run of 16 passes totals 100 and passes', async () => {
    const req = await user();
    fake.respond = (r) => ({ body: gradeResponse(r, 'PASS') });
    let s = (await req('POST', '/api/exams', { profile_id: 'piscine_exam' })).json();
    const levels: number[] = [];
    for (let i = 0; i < 16; i++) {
      levels.push(s.level);
      t.clock.advance(11_000); // stay under 6 submissions/min
      const r = await req('POST', `/api/exams/${s.exam_id}/grademe`, submit(s.current.exercise_id));
      assert.equal(r.statusCode, 200, r.body);
      s = r.json().status;
    }
    assert.deepEqual(levels, [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5]);
    assert.equal(s.score, 100);
    assert.equal(s.passed, true);
    assert.equal(s.current, null);
    assert.equal(s.slot, 16);
    assert.equal(s.history.length, 16);
    assert.equal(s.history.at(-1).points, 10);
    const done = await req('POST', `/api/exams/${s.exam_id}/grademe`, submit('gym_l5_a'));
    assert.equal(done.statusCode, 409);
    assert.equal((await req('POST', `/api/exams/${s.exam_id}/finish`)).json().status, 'finished');
  });

  it('after ends_at → 410 exam_over and no submission row; the exam reads as expired', async () => {
    const req = await user();
    const s = (await req('POST', '/api/exams', { profile_id: 'piscine_exam' })).json();
    t.clock.advance(240 * 60_000);
    const before = (t.app.db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n;
    const late = await req('POST', `/api/exams/${s.exam_id}/grademe`, submit(s.current.exercise_id));
    assert.equal(late.statusCode, 410);
    assert.equal(late.json().error, 'exam_over');
    assert.equal(fake.requests.length, 0);
    assert.equal((t.app.db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n, before);
    const st = (await req('GET', `/api/exams/${s.exam_id}`)).json();
    assert.equal(st.status, 'expired');
    assert.equal(st.current, null);
    assert.equal(st.time_left_s, 0);
    assert.equal((await req('GET', '/api/exams/current')).statusCode, 404);
    // A new exam can start once the old one expired.
    assert.equal((await req('POST', '/api/exams', { profile_id: 'piscine_exam' })).statusCode, 201);
  });

  it('expiry on read: an exam past ends_at is expired the first time it is read', async () => {
    const req = await user();
    const s = (await req('POST', '/api/exams', { profile_id: 'piscine_exam' })).json();
    t.clock.advance(240 * 60_000 + 1);
    const row = () => (t.app.db.prepare('SELECT status FROM exams WHERE id = ?').get(s.exam_id) as { status: string }).status;
    assert.equal(row(), 'active');
    assert.equal((await req('GET', `/api/exams/${s.exam_id}`)).json().status, 'expired');
    assert.equal(row(), 'expired');
  });

  it('finish → status finished; grademe after → 409; hints and reveal are 403 only while active', async () => {
    const req = await user();
    // An attempt in practice first, so the reveal is otherwise allowed.
    await req('POST', '/api/practice/gym_echo_first/submissions', submit('gym_echo_first'));
    t.clock.advance(11_000);
    const s = (await req('POST', '/api/exams', { profile_id: 'piscine_exam' })).json();
    for (const [m, u, b] of [
      ['GET', '/api/practice/gym_echo_first/solution', undefined],
      ['GET', '/api/practice/gym_echo_first/hints', undefined],
      ['POST', '/api/practice/gym_echo_first/hints', { submission_id: 1 }],
      ['POST', '/api/hints/1/rating', { rating: 'wrong' }],
    ] as const) {
      const r = await req(m, u, b);
      assert.equal(r.statusCode, 403, `${m} ${u}`);
      assert.equal(r.json().error, 'forbidden');
    }
    const fin = await req('POST', `/api/exams/${s.exam_id}/finish`);
    assert.equal(fin.statusCode, 200);
    assert.equal(fin.json().status, 'finished');
    assert.equal(fin.json().current, null);
    const after = await req('POST', `/api/exams/${s.exam_id}/grademe`, submit(s.current.exercise_id));
    assert.equal(after.statusCode, 409);
    assert.equal((await req('GET', '/api/practice/gym_echo_first/solution')).statusCode, 200);
    assert.equal((await req('GET', '/api/practice/gym_echo_first/hints')).statusCode, 200);
  });

  it('profiles come from config/exam-profiles.json; a disabled profile cannot start', async () => {
    const req = await user();
    const p = (await req('GET', '/api/exam/profiles')).json().profiles;
    assert.deepEqual(p.map((x: { id: string }) => x.id), ['piscine_exam', 'piscine_final', 'rank02']);
    assert.equal((await req('POST', '/api/exams', { profile_id: 'rank02' })).statusCode, 400);
    assert.equal((await req('POST', '/api/exams', { profile_id: 'nope' })).statusCode, 400);
    const fin = (await req('POST', '/api/exams', { profile_id: 'piscine_final' })).json();
    assert.equal(fin.time_left_s, 480 * 60);
  });
});
