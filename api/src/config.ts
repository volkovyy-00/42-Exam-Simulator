import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return v === 'true' || v === '1';
}

function num(v: string | undefined, def: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  contentDir: string;
  webDist: string;
  dispatcherUrl: string;
  cookieSecure: boolean;
  sessionSecret: string;
  submissionsPerMin: number;
  hintsEnabled: boolean;
  openrouterApiKey: string;
  hintModel: string;
  hintFallbackModels: string[];
  hintDailyUsdStop: number;
  examProfilesPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8042),
    host: env.HOST ?? '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR ?? path.join(repoRoot, 'data')),
    contentDir: path.resolve(env.CONTENT_DIR ?? path.join(repoRoot, 'content')),
    webDist: path.resolve(env.WEB_DIST ?? path.join(repoRoot, 'web/dist')),
    dispatcherUrl: env.DISPATCHER_URL ?? 'http://127.0.0.1:9000',
    cookieSecure: bool(env.COOKIE_SECURE, true),
    sessionSecret: env.SESSION_SECRET ?? '',
    submissionsPerMin: num(env.SUBMISSIONS_PER_MIN, 6),
    hintsEnabled: bool(env.HINTS_ENABLED, false),
    openrouterApiKey: env.OPENROUTER_API_KEY ?? '',
    hintModel: env.HINT_MODEL ?? 'deepseek/deepseek-v4-flash-0731',
    hintFallbackModels: (env.HINT_FALLBACK_MODELS ??
      'deepseek/deepseek-v4.1-flash-1017,anthropic/claude-haiku-5.5')
      .split(',').map((s) => s.trim()).filter(Boolean),
    hintDailyUsdStop: num(env.HINT_DAILY_USD_STOP, 2),
    examProfilesPath: path.resolve(here, '../config/exam-profiles.json'),
  };
}
