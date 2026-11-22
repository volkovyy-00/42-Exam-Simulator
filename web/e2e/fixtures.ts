// Accounts for the e2e suite, against the real API (DESIGN.md §3.3).
//
// - "worker" (default): one user per worker, registered once with an admin.ts invite; the
//   session is saved as a storageState file and every test in that worker starts logged in.
//   Separate users keep workers from sharing server state (rate limit, in-flight grade, exams).
// - "seed": the `e2e` user (id 1) that playwright.config.ts creates with admin.ts before the
//   API starts; logged in once per worker.
// - "fresh": a new user for this test only, for tests that need a known history.
//
// `exam` starts an exam for the test's user and finishes it afterwards, so the next test in the
// worker can grade in practice mode again.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, request, test as base } from '@playwright/test';
import type { ExamStatus } from '@ceg/contract';
import { E2E } from './env.ts';

export { expect };

const here = path.dirname(fileURLToPath(import.meta.url));
const adminScript = path.resolve(here, '../../api/scripts/admin.ts');

/** A new single-use invite code, written straight into the e2e database by admin.ts. */
export function newInvite(): string {
  const dataDir = process.env.E2E_DATA_DIR;
  if (!dataDir) throw new Error('E2E_DATA_DIR is not set (it comes from playwright.config.ts)');
  const out = execFileSync(process.execPath, [adminScript, 'invite'], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.trim();
}

export interface Account {
  username: string;
  password: string;
  storageState: string;
}

async function saveSession(file: string, call: (api: Awaited<ReturnType<typeof request.newContext>>) => Promise<number>, want: number) {
  const api = await request.newContext({ baseURL: E2E.apiUrl });
  try {
    expect(await call(api)).toBe(want);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await api.storageState({ path: file });
  } finally {
    await api.dispose();
  }
}

async function register(username: string, file: string): Promise<Account> {
  const invite_code = newInvite();
  await saveSession(file, async (api) =>
    (await api.post('/api/auth/register', { data: { invite_code, username, password: E2E.password } })).status(), 201);
  return { username, password: E2E.password, storageState: file };
}

async function login(username: string, file: string): Promise<Account> {
  await saveSession(file, async (api) =>
    (await api.post('/api/auth/login', { data: { username, password: E2E.password } })).status(), 200);
  return { username, password: E2E.password, storageState: file };
}

// Worker-level accounts, created on first use (each worker is its own process).
let workerAccount: Promise<Account> | null = null;
let seedAccount: Promise<Account> | null = null;

type AccountKind = 'worker' | 'seed' | 'fresh';

export const test = base.extend<{ account: AccountKind; user: Account; exam: ExamStatus }>({
  account: ['worker', { option: true }],

  user: async ({ account }, use, testInfo) => {
    const dir = path.join(testInfo.project.outputDir, '.auth');
    let acc: Account;
    if (account === 'worker') {
      workerAccount ??= register(`e2e-w${testInfo.workerIndex}`, path.join(dir, `w${testInfo.workerIndex}.json`));
      acc = await workerAccount;
    } else if (account === 'seed') {
      seedAccount ??= login(E2E.seedUser, path.join(dir, `seed-${testInfo.workerIndex}.json`));
      acc = await seedAccount;
    } else {
      const name = `e2e-t${crypto.randomBytes(4).toString('hex')}`;
      acc = await register(name, path.join(dir, `${name}.json`));
    }
    await use(acc);
  },

  storageState: async ({ user }, use) => {
    await use(user.storageState);
  },

  exam: async ({ page }, use) => {
    const res = await page.request.post('/api/exams', { data: { profile_id: 'piscine_exam' } });
    expect(res.status(), await res.text()).toBe(201);
    const status = (await res.json()) as ExamStatus;
    await use(status);
    // Finish it unless the test already did, so practice grading works again for this user.
    await page.request.post(`/api/exams/${status.exam_id}/finish`, { data: {} });
  },
});
