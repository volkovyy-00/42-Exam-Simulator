// E2E for WP4 (TASKS.md): the built SPA served by `vite preview`, proxied to the real API
// (api/src/server.ts) on a fresh temp DATA_DIR with CONTENT_DIR=fixtures/, which grades through
// a fake dispatcher (e2e/fake-dispatcher.mjs). Users are seeded with api/scripts/admin.ts; see
// e2e/fixtures.ts for the per-worker login.
// Device profiles: iPhone 15 and Pixel 8. The iPhone profile runs on Chromium by default
// (viewport, DPR, touch, coarse pointer and UA of an iPhone 15); set PW_IPHONE_WEBKIT=1 to run
// it on WebKit where that browser is installed. Real-device checks stay manual (see TASKS.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { E2E, LOGIN_DEMO } from './e2e/env.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

// One temp DATA_DIR per run. The config is loaded again in every worker; workers inherit the
// runner's environment, so they all see the directory created here once.
process.env.E2E_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ceg-e2e-'));
const dataDir = process.env.E2E_DATA_DIR;

const admin = `node ${JSON.stringify(path.join(repo, 'api/scripts/admin.ts'))}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: E2E.webUrl,
    trace: 'off',
  },
  projects: [
    {
      name: 'iphone-15',
      use: {
        ...devices['iPhone 15'],
        browserName: process.env.PW_IPHONE_WEBKIT ? 'webkit' : 'chromium',
      },
    },
    { name: 'pixel-8', use: { ...devices['Pixel 8'] } },
  ],
  webServer: [
    {
      command: `node e2e/fake-dispatcher.mjs`,
      url: `${E2E.dispatcherUrl}/health`,
      env: { PORT: String(E2E.dispatcherPort) },
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      // Seed before the server starts: `e2e` (id 1, the draft-key test) and the login-form user.
      command: [
        `${admin} create ${E2E.seedUser}`,
        `ADMIN_PASSWORD=${JSON.stringify(LOGIN_DEMO.password)} ${admin} create ${LOGIN_DEMO.username}`,
        `node ${JSON.stringify(path.join(repo, 'api/src/server.ts'))}`,
      ].join(' && '),
      url: `${E2E.apiUrl}/api/health`,
      env: {
        PORT: String(E2E.apiPort),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        CONTENT_DIR: path.join(repo, 'fixtures'),
        COOKIE_SECURE: 'false',
        DISPATCHER_URL: E2E.dispatcherUrl,
        HINTS_ENABLED: 'false',
        ADMIN_PASSWORD: E2E.password,
      },
      // A fresh DATA_DIR every run: never attach to an API left over from another run.
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npm run build && npx vite preview --host 127.0.0.1 --port ${E2E.webPort} --strictPort`,
      url: E2E.webUrl,
      env: { API_URL: E2E.apiUrl },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
