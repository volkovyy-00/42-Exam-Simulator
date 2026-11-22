// Ports, URLs and seeded accounts shared by playwright.config.ts and the fixtures.
const apiPort = Number(process.env.E2E_API_PORT ?? 18042);
const webPort = Number(process.env.E2E_WEB_PORT ?? 4173);
const dispatcherPort = Number(process.env.E2E_DISPATCHER_PORT ?? 19000);

export const E2E = {
  apiPort,
  webPort,
  dispatcherPort,
  apiUrl: `http://127.0.0.1:${apiPort}`,
  webUrl: `http://127.0.0.1:${webPort}`,
  dispatcherUrl: `http://127.0.0.1:${dispatcherPort}`,
  /** Created first by admin.ts, so it is user id 1 (the draft-key test relies on that). */
  seedUser: 'e2e',
  /** Password of every account the suite creates. */
  password: 'e2e-password-123',
} as const;

/** The account the login-form test types in. Seeded by admin.ts before the API starts. */
export const LOGIN_DEMO = { username: 'zhenia', password: 'long enough pass' } as const;
