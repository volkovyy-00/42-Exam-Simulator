import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { root, startApp, startFakeDispatcher } from './helpers.ts';

describe('health', () => {
  it('reports grader "up" and the exercise count with a live dispatcher', async () => {
    const fake = await startFakeDispatcher();
    const t = await startApp({ dispatcherUrl: fake.url });
    try {
      const r = await t.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json(), { ok: true, version: '0.1.0', grader: 'up', hints_enabled: false, exercises: 2 });
      assert.equal(r.headers['x-stub'], undefined);
      fake.healthy = false;
      assert.equal((await t.app.inject({ method: 'GET', url: '/api/health' })).json().grader, 'down');
    } finally {
      await t.close();
      await fake.close();
    }
  });

  it('reports grader "down" when the dispatcher is unreachable', async () => {
    const fake = await startFakeDispatcher();
    const url = fake.url;
    await fake.close(); // nothing listens on that port any more
    const t = await startApp({ dispatcherUrl: url });
    try {
      const r = await t.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().grader, 'down');
      assert.equal(r.json().ok, true);
    } finally {
      await t.close();
    }
  });

  it('a practice submit with the dispatcher unreachable is a JSON 502, not a crash', async () => {
    const fake = await startFakeDispatcher();
    const url = fake.url;
    await fake.close();
    const t = await startApp({ dispatcherUrl: url });
    try {
      const { login, as } = await import('./helpers.ts');
      const req = as(t.app, await login(t.app, 'health_user'));
      const r = await req('POST', '/api/practice/gym_echo_first/submissions', { filename: 'gym_echo_first.c', source: 'int x;\n' });
      assert.equal(r.statusCode, 502);
      assert.equal(r.json().error, 'internal');
    } finally {
      await t.close();
    }
  });
});

describe('admin CLI', () => {
  it('create makes an argon2id admin; invite prints single-use codes', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceg-admin-'));
    const env = { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: 'admin-password-1' };
    const script = path.join(root, 'api/scripts/admin.ts');
    try {
      const out = execFileSync(process.execPath, [script, 'create', 'root_admin'], { env, encoding: 'utf8' });
      assert.match(out, /Created admin root_admin/);
      const codes = execFileSync(process.execPath, [script, 'invite', '--count', '2', '--days', '3'], { env, encoding: 'utf8' })
        .trim().split('\n');
      assert.equal(codes.length, 2);
      for (const c of codes) assert.match(c, /^[a-z0-9]{4}-[a-z0-9]{4}$/);
      const db = openDb(path.join(dataDir, 'gym.sqlite'));
      const u = db.prepare("SELECT is_admin, password_hash FROM users WHERE username = 'root_admin'").get() as { is_admin: number; password_hash: string };
      assert.equal(u.is_admin, 1);
      assert.match(u.password_hash, /^\$argon2id\$/);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_by IS NULL AND expires_at IS NOT NULL').get() as { n: number }).n, 2);
      db.close();
      assert.throws(() => execFileSync(process.execPath, [script, 'create', 'root_admin'], { env, stdio: 'pipe' }));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('content loader', () => {
  it('reload() (SIGHUP) picks up added and removed exercises; broken files are skipped', async () => {
    const { ContentStore } = await import('../src/content.ts');
    const { makeContentDir } = await import('./helpers.ts');
    const dir = makeContentDir(1);
    try {
      const store = new ContentStore(dir);
      assert.equal(store.count, 2 + 6);
      fs.rmSync(path.join(dir, 'exercises/5/gym_l5_a.json'));
      fs.writeFileSync(path.join(dir, 'exercises/4/broken.json'), '{ not json');
      const warnings: string[] = [];
      assert.equal(store.reload((m) => warnings.push(m)), 2 + 5);
      assert.equal(store.get('gym_l5_a'), undefined);
      assert.ok(warnings.some((w) => w.includes('broken.json')));
      assert.deepEqual(store.list().map((e) => e.level), [...store.list().map((e) => e.level)].sort((a, b) => a - b));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
