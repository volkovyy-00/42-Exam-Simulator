import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { ARGON2_MAX_CONCURRENT, createInvite, verifyPassword } from '../src/auth.ts';
import { type FakeDispatcher, type TestApp, as, cookieOf, json, login, startApp, startFakeDispatcher } from './helpers.ts';

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

describe('auth', () => {
  it('register → cookie flags; invite reuse → 401; login → 200; logout → 204 then 401', async () => {
    const { app } = t;
    const code = createInvite(app.db);
    const r = await app.inject({ method: 'POST', url: '/api/auth/register',
      ...json({ invite_code: code, username: 'alice', password: 'correct-horse' }) });
    assert.equal(r.statusCode, 201);
    assert.deepEqual(r.json().user, { id: r.json().user.id, username: 'alice', is_admin: false });
    const set = String(r.headers['set-cookie']);
    assert.match(set, /^ceg_session=[A-Za-z0-9_-]{40,};/);
    assert.match(set, /; HttpOnly/);
    assert.match(set, /; Secure/);
    assert.match(set, /; SameSite=Strict/);
    assert.match(set, /; Path=\//);
    assert.match(set, /; Max-Age=1209600/); // 14 days

    const again = await app.inject({ method: 'POST', url: '/api/auth/register',
      ...json({ invite_code: code, username: 'bob_2', password: 'correct-horse' }) });
    assert.equal(again.statusCode, 401);
    assert.equal(again.json().error, 'unauthorized');

    const li = await app.inject({ method: 'POST', url: '/api/auth/login',
      ...json({ username: 'alice', password: 'correct-horse' }) });
    assert.equal(li.statusCode, 200);
    const cookie = cookieOf(li.headers['set-cookie']);

    const req = as(app, cookie);
    assert.equal((await req('GET', '/api/me')).statusCode, 200);
    const lo = await req('POST', '/api/auth/logout');
    assert.equal(lo.statusCode, 204);
    assert.match(String(lo.headers['set-cookie']), /Max-Age=0/);
    const me = await req('GET', '/api/me');
    assert.equal(me.statusCode, 401);
    assert.equal(me.json().error, 'unauthorized');
  });

  it('unknown invite → 401, taken username → 409, wrong password → 401', async () => {
    const { app } = t;
    const bad = await app.inject({ method: 'POST', url: '/api/auth/register',
      ...json({ invite_code: 'zzzz-zzzz', username: 'carol', password: 'correct-horse' }) });
    assert.equal(bad.statusCode, 401);
    await login(app, 'dave');
    const taken = await app.inject({ method: 'POST', url: '/api/auth/register',
      ...json({ invite_code: createInvite(app.db), username: 'dave', password: 'correct-horse' }) });
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json().error, 'conflict');
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login',
      ...json({ username: 'dave', password: 'not-the-password' }) });
    assert.equal(wrong.statusCode, 401);
  });

  it('an expired invite → 401', async () => {
    const { app, clock } = t;
    const code = createInvite(app.db, { days: 1, nowMs: clock.t });
    clock.advance(2 * 86_400_000);
    const r = await app.inject({ method: 'POST', url: '/api/auth/register',
      ...json({ invite_code: code, username: 'erin', password: 'correct-horse' }) });
    assert.equal(r.statusCode, 401);
  });

  it('the DB stores an $argon2id$ hash and sha256(token), never the token', async () => {
    const { app } = t;
    const cookie = await login(app, 'frank', 'frank-password');
    const token = cookie.split('=')[1] as string;
    const u = app.db.prepare("SELECT id, password_hash FROM users WHERE username = 'frank'").get() as { id: number; password_hash: string };
    assert.match(u.password_hash, /^\$argon2id\$/);
    const sessions = app.db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(u.id) as { id: string }[];
    assert.deepEqual(sessions.map((s) => s.id), [crypto.createHash('sha256').update(token).digest('hex')]);
    const dump = JSON.stringify(app.db.prepare('SELECT * FROM sessions').all());
    assert.ok(!dump.includes(token), 'raw token must not be stored');
  });

  it('a session expires after 14 days', async () => {
    const { app, clock } = t;
    const req = as(app, await login(app, 'gina'));
    assert.equal((await req('GET', '/api/me')).statusCode, 200);
    clock.advance(14 * 86_400_000 + 1000);
    assert.equal((await req('GET', '/api/me')).statusCode, 401);
  });

  it('login is limited to 10 attempts per username per 15 min', async () => {
    const { app, clock } = t;
    await login(app, 'henry', 'henry-password');
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ username: 'henry', password: 'wrong-password' }) });
      assert.equal(r.statusCode, 401);
    }
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ username: 'henry', password: 'henry-password' }) });
    assert.equal(r.statusCode, 429);
    assert.equal(r.json().error, 'rate_limited');
    assert.ok(r.json().retry_after_s > 0);
    // Another username is unaffected.
    await login(app, 'ivy', 'ivy-password-1');
    const other = await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ username: 'ivy', password: 'ivy-password-1' }) });
    assert.equal(other.statusCode, 200);
    clock.advance(15 * 60_000 + 1000);
    const later = await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ username: 'henry', password: 'henry-password' }) });
    assert.equal(later.statusCode, 200);
  });

  it('every protected route returns 401 without a cookie (route table)', async () => {
    const { app } = t;
    const api = app.routeTable.filter((r) => r.url.startsWith('/api/'));
    const publicOnes = api.filter((r) => r.public).map((r) => `${r.method} ${r.url}`).sort();
    assert.deepEqual(publicOnes, ['GET /api/health', 'POST /api/auth/login', 'POST /api/auth/register']);
    const protectedRoutes = api.filter((r) => !r.public);
    assert.ok(protectedRoutes.length >= 18, `only ${protectedRoutes.length} protected routes`);
    for (const r of protectedRoutes) {
      const url = r.url.replace(/:(\w+)/g, (_m, p: string) => (p.toLowerCase().includes('exercise') ? 'gym_echo_first' : '1'));
      for (const cookie of [undefined, 'ceg_session=forged-token']) {
        const res = await app.inject({
          method: r.method as 'GET' | 'POST',
          url,
          headers: { ...(cookie ? { cookie } : {}), ...(r.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
          ...(r.method === 'POST' ? { payload: '{}' } : {}),
        });
        assert.equal(res.statusCode, 401, `${r.method} ${url} with ${cookie ?? 'no cookie'} → ${res.statusCode}`);
        assert.equal(res.json().error, 'unauthorized');
      }
    }
  });

  it('mutating routes reject non-JSON bodies with 415', async () => {
    const { app } = t;
    const cookie = await login(app, 'jack');
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await app.inject({ method: 'POST', url: '/api/practice/gym_echo_first/submissions',
        headers: { cookie, 'content-type': ct }, payload: 'filename=a.c&source=x' });
      assert.equal(r.statusCode, 415, ct);
      assert.equal(r.json().error, 'unsupported_media_type');
    }
    const noType = await app.inject({ method: 'POST', url: '/api/exams', headers: { cookie }, payload: 'profile_id=x' });
    assert.equal(noType.statusCode, 415);
    const charset = await app.inject({ method: 'POST', url: '/api/exams',
      headers: { cookie, 'content-type': 'application/json; charset=utf-8' }, payload: JSON.stringify({ profile_id: 'rank02' }) });
    assert.equal(charset.statusCode, 400); // parsed as JSON; rank02 is disabled
  });
  it('new hashes use OWASP argon2id params; hashes with the old defaults still verify', async () => {
    const { app } = t;
    await login(app, 'kate', 'kate-password');
    const u = app.db.prepare("SELECT password_hash FROM users WHERE username = 'kate'").get() as { password_hash: string };
    assert.match(u.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const old = await argon2.hash('legacy-password', { type: argon2.argon2id }); // library defaults
    assert.match(old, /\$m=65536,t=3,p=4\$/);
    assert.equal(await verifyPassword(old, 'legacy-password'), true);
    assert.equal(await verifyPassword(old, 'wrong-password'), false);
  });

  it('8 concurrent logins all answer correctly, with at most 2 argon2 calls at once', async () => {
    const { app } = t;
    const users = ['lara', 'mike', 'nina', 'oleg', 'pete', 'quinn'];
    for (const u of users) await login(app, u, `${u}-password`);
    const realHash = argon2.hash;
    const realVerify = argon2.verify;
    let active = 0;
    let peak = 0;
    let calls = 0;
    const track = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
      active++;
      calls++;
      peak = Math.max(peak, active);
      try {
        return await fn(...a);
      } finally {
        active--;
      }
    };
    argon2.hash = track(realHash) as typeof argon2.hash;
    argon2.verify = track(realVerify) as typeof argon2.verify;
    try {
      const attempts = [
        ...users.map((u) => ({ username: u, password: `${u}-password`, want: 200 })),
        { username: 'lara', password: 'wrong-password', want: 401 },
        { username: 'nobody_here', password: 'whatever-pw', want: 401 }, // dummy hash path
      ];
      const res = await Promise.all(attempts.map((a) =>
        app.inject({ method: 'POST', url: '/api/auth/login', ...json({ username: a.username, password: a.password }) })));
      assert.deepEqual(res.map((r) => r.statusCode), attempts.map((a) => a.want));
      for (const r of res.filter((x) => x.statusCode === 200)) assert.match(String(r.headers['set-cookie']), /^ceg_session=/);
    } finally {
      argon2.hash = realHash;
      argon2.verify = realVerify;
    }
    assert.ok(calls >= 8, `only ${calls} argon2 calls`);
    assert.ok(peak <= ARGON2_MAX_CONCURRENT, `peak ${peak} concurrent argon2 calls`);
    assert.equal(peak, ARGON2_MAX_CONCURRENT, 'the semaphore should still allow 2 at once');
  });
});
