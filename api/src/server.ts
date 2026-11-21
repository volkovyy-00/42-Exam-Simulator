import path from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';

const config = loadConfig();
if (config.cookieSecure && !config.sessionSecret) {
  console.warn('SESSION_SECRET is empty. Set it before going to production.');
}
const db = openDb(path.join(config.dataDir, 'gym.sqlite'));
const app = await buildApp({ config, db, logger: true });

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
