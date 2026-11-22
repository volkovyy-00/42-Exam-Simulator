import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { cleanup, dockerStartupGuard } from './docker.ts';

const config = loadConfig();

// Refuse to start without memory-limit support: --memory would be silently ignored.
try {
  const warnings = await dockerStartupGuard();
  for (const w of warnings) console.warn(`docker info: ${w}`);
} catch (e) {
  console.error(`grader-dispatcher: refusing to start.\n${(e as Error).message}`);
  process.exit(1);
}

const app = await buildApp(config, true);
const { dispatcher } = app;

const sweep = async () => {
  try {
    const r = await cleanup(config.jobsDir, dispatcher.active);
    if (r.containers.length || r.dirs.length) app.log.info({ removed: r }, 'cleanup');
  } catch (e) {
    app.log.error(e, 'cleanup failed');
  }
};
await sweep();
const timer = setInterval(() => void sweep(), 5 * 60_000);
timer.unref();

process.on('SIGHUP', () => {
  try {
    dispatcher.reload();
    app.log.info({ exercises: dispatcher.content().exercises.size }, 'content reloaded');
  } catch (e) {
    app.log.error(e, 'content reload failed; keeping the previous content');
  }
});
process.on('SIGTERM', () => void app.close().then(() => process.exit(0)));
await app.listen({ port: config.port, host: config.host });
