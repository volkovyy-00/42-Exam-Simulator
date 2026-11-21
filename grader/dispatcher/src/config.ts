import path from 'node:path';

const num = (v: string | undefined, def: number) => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
};

export interface DispatcherConfig {
  port: number;
  host: string;
  contentDir: string;
  jobsDir: string;
  image: string;
  compileTimeoutS: number;
  testTimeoutS: number;
  testCpuS: number;
  submissionTimeoutS: number;
  concurrency: number;
  queueMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DispatcherConfig {
  return {
    port: num(env.DISPATCHER_PORT, 9000),
    host: env.DISPATCHER_HOST ?? '127.0.0.1',
    contentDir: path.resolve(env.CONTENT_DIR ?? 'content'),
    jobsDir: env.JOBS_DIR ?? '/srv/grader/jobs',
    image: env.GRADER_IMAGE ?? 'grader:pinned',
    compileTimeoutS: num(env.COMPILE_TIMEOUT_S, 10),
    testTimeoutS: num(env.TEST_TIMEOUT_S, 2),
    testCpuS: num(env.TEST_CPU_S, 1),
    submissionTimeoutS: num(env.SUBMISSION_TIMEOUT_S, 30),
    concurrency: num(env.GRADER_CONCURRENCY, 2),
    queueMax: num(env.GRADER_QUEUE_MAX, 20),
  };
}
