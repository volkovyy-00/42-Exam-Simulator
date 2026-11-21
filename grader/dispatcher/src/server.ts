import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
// TODO(WP1): run `docker info`; refuse to start if it warns about missing memory limit support
// (print the cgroup_enable=memory fix), and start the cleanup interval for grade-* containers.
const app = await buildApp(config, true);
process.on('SIGTERM', () => void app.close().then(() => process.exit(0)));
await app.listen({ port: config.port, host: config.host });
