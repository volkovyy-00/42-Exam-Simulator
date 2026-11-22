// E2E for WP4 (TASKS.md): the built SPA served by `vite preview`, proxied to the API stubs.
// Device profiles: iPhone 15 and Pixel 8. The iPhone profile runs on Chromium by default
// (viewport, DPR, touch, coarse pointer and UA of an iPhone 15); set PW_IPHONE_WEBKIT=1 to run
// it on WebKit where that browser is installed. Real-device checks stay manual (see TASKS.md).
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const API_PORT = Number(process.env.E2E_API_PORT ?? 18042);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const apiUrl = `http://127.0.0.1:${API_PORT}`;
const dataDir = path.join(os.tmpdir(), `ceg-e2e-${API_PORT}`);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
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
      command: 'node ../api/src/server.ts',
      url: `${apiUrl}/api/health`,
      env: { PORT: String(API_PORT), HOST: '127.0.0.1', COOKIE_SECURE: 'false', DATA_DIR: dataDir },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `npm run build && npx vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { API_URL: apiUrl },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
