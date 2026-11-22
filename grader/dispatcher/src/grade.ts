// The grading pipeline (DESIGN.md §6): file + static, job dir, sandbox, compare, response.
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Exercise, FailureReason, FirstFailure, GradeJobRequest, GradeJobResponse, RunnerJob, RunnerOutput,
  RunnerTestResult, Stage, TestDetail, TestStatus,
} from '@ceg/contract';
import type { DispatcherConfig } from './config.ts';
import { catE, firstDiffByte, koReason, reasonText, type Observed } from './compare.ts';
import { contentPath, type Content } from './content.ts';
import { removeContainer, type SandboxRunner } from './docker.ts';
import { checkFile, checkStatic } from './static.ts';

export const MAX_TEST_TIMEOUT_MS = 10_000;

/** Effective per-test wall timeout: TEST_TIMEOUT_S, raised by limits.timeout_ms, never above 10 s. */
export function testTimeoutMs(cfg: DispatcherConfig, ex: Exercise): number {
  return Math.min(MAX_TEST_TIMEOUT_MS, Math.max(cfg.testTimeoutS * 1000, ex.limits.timeout_ms));
}

/** §6.5: min(60 s, max(SUBMISSION_TIMEOUT_S, COMPILE_TIMEOUT_S + n_tests × test_timeout + 10 s)). */
export function outerDeadlineMs(cfg: DispatcherConfig, ex: Exercise): number {
  const need = cfg.compileTimeoutS * 1000 + ex.tests.length * testTimeoutMs(cfg, ex) + 10_000;
  return Math.min(60_000, Math.max(cfg.submissionTimeoutS * 1000, need));
}

/**
 * job.json. `allow_asm` is not in the contract's RunnerJob yet (grader-only, additive): the
 * runner's object-code asm check is skipped when it is true.
 */
export type GraderRunnerJob = RunnerJob & { allow_asm: boolean };

/**
 * RunnerOutput plus the grader-only "static" stage: the runner found a syscall/sysenter/int/svc
 * instruction in student.o (an asm construct the source lexer missed, e.g. via token pasting).
 */
export type GraderRunnerOutput = Omit<RunnerOutput, 'stage'> & {
  stage: RunnerOutput['stage'] | 'static';
  static_message?: string;
};

export function runnerJob(cfg: DispatcherConfig, ex: Exercise, studentFile: string): GraderRunnerJob {
  return {
    kind: ex.kind,
    allow_asm: ex.allow_asm === true,
    student_file: studentFile,
    has_main: ex.harness.main !== null,
    cflags_extra: ex.harness.cflags_extra,
    compile_timeout_s: cfg.compileTimeoutS,
    test_timeout_ms: testTimeoutMs(cfg, ex),
    test_cpu_s: cfg.testCpuS,
    max_output_bytes: ex.limits.max_output_bytes,
    tests: ex.tests.map((t) => ({
      id: t.id,
      argv: t.argv,
      stdin_b64: t.stdin === null ? null : Buffer.from(t.stdin, 'utf8').toString('base64'),
    })),
  };
}

/**
 * Write JOBS_DIR/<job_id>/in: the student file, harness main.c and headers, allow.txt, job.json.
 * Never expected output, never a reference. Readable by uid 65534 inside the sandbox.
 */
export async function writeJobDir(cfg: DispatcherConfig, content: Content, ex: Exercise, req: GradeJobRequest): Promise<string> {
  const jobDir = path.join(cfg.jobsDir, req.job_id);
  const inDir = path.join(jobDir, 'in');
  await fs.mkdir(inDir, { mode: 0o755 }); // runJob created jobDir
  const put = (name: string, data: string | Buffer) => fs.writeFile(path.join(inDir, name), data, { mode: 0o644, flag: 'wx' });
  await put(req.filename, req.source);
  if (ex.harness.main !== null) await put('main.c', await fs.readFile(contentPath(content.dir, ex.harness.main)));
  for (const inc of ex.harness.includes) {
    await put(path.basename(inc), await fs.readFile(contentPath(content.dir, inc)));
  }
  const allow = [...new Set([...ex.allowed_functions, ...content.ignoreSymbols])];
  await put('allow.txt', allow.join('\n') + (allow.length ? '\n' : ''));
  await put('job.json', JSON.stringify(runnerJob(cfg, ex, req.filename)));
  // Undo a restrictive umask: the sandbox user (65534) must be able to read everything.
  for (const p of [jobDir, inDir]) await fs.chmod(p, 0o755);
  return inDir;
}

/** The last non-empty stdout line, validated as a RunnerOutput. */
export function parseRunnerOutput(stdout: string): GraderRunnerOutput | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  let o: unknown;
  try { o = JSON.parse(last); } catch { return null; }
  const r = o as GraderRunnerOutput;
  if (typeof r !== 'object' || r === null) return null;
  if (!['static', 'compile', 'nm', 'link', 'tests'].includes(r.stage)) return null;
  if (typeof r.compile_ok !== 'boolean' || typeof r.link_ok !== 'boolean') return null;
  if (typeof r.compile_stderr !== 'string' || typeof r.link_stderr !== 'string') return null;
  if (!Array.isArray(r.nm_symbols) || !Array.isArray(r.forbidden) || !Array.isArray(r.tests)) return null;
  for (const t of r.tests) {
    if (typeof t !== 'object' || t === null || typeof t.id !== 'string' || typeof t.stdout_b64 !== 'string') return null;
  }
  return r;
}

const cap16k = (s: string) => (s.length > 16384 ? s.slice(0, 16384) + '\n[... truncated at 16 KiB]\n' : s);

function base(req: GradeJobRequest, started: number): Omit<GradeJobResponse, 'verdict' | 'stage' | 'message'> {
  return {
    job_id: req.job_id, tests: [], first_failure: null, compile_stderr: null, forbidden: [],
    duration_ms: Date.now() - started, test_details: [], runner_version: '1',
  };
}

export function failBeforeSandbox(req: GradeJobRequest, started: number, stage: Stage, message: string): GradeJobResponse {
  return { ...base(req, started), verdict: 'FAIL', stage, message };
}

/** Turn runner output (or a killed container) into the response. Expected output lives only here. */
export function judge(req: GradeJobRequest, ex: Exercise, started: number, out: GraderRunnerOutput | null, killedReason: 'timeout' | 'signal' | null): GradeJobResponse {
  const b = base(req, started);
  if (out) b.runner_version = out.runner_version;
  if (out && out.stage === 'static') {
    return { ...b, verdict: 'FAIL', stage: 'static', message: 'forbidden construct: asm' };
  }
  if (out && out.stage === 'compile' && !out.compile_ok) {
    return { ...b, verdict: 'FAIL', stage: 'compile', message: 'compilation failed', compile_stderr: cap16k(out.compile_stderr) };
  }
  if (out && out.stage === 'nm' && out.forbidden.length > 0) {
    return { ...b, verdict: 'FAIL', stage: 'nm', message: `forbidden function: ${out.forbidden.join(', ')}`, forbidden: out.forbidden };
  }
  if (out && out.stage === 'link' && !out.link_ok) {
    // GradeOutcome has one stderr field: the linker's message goes there.
    return { ...b, verdict: 'FAIL', stage: 'link', message: 'link failed', compile_stderr: cap16k(out.link_stderr) };
  }

  // Tests stage. A test the runner did not report (container killed) counts as timed out or killed.
  const byId = new Map<string, RunnerTestResult>((out?.tests ?? []).map((t) => [t.id, t]));
  const tests: TestStatus[] = [];
  const details: TestDetail[] = [];
  let first: FirstFailure | null = null;
  let firstReason: FailureReason | null = null;
  let firstId = '';
  for (const t of ex.tests) {
    const r = byId.get(t.id);
    const got: Observed = r
      ? { stdout: Buffer.from(r.stdout_b64, 'base64'), exit: r.exit, signal: r.signal, timed_out: r.timed_out === true, truncated: r.truncated === true }
      : { stdout: Buffer.alloc(0), exit: null, signal: killedReason === 'signal' ? 'SIGKILL' : null, timed_out: killedReason !== 'signal', truncated: false };
    const expected = Buffer.from(t.expected_stdout_b64, 'base64');
    const reason = koReason(got, expected, t.expected_exit);
    tests.push({ id: t.id, visible: t.visible, status: reason ? 'KO' : 'OK' });
    details.push({
      id: t.id, status: reason ? 'KO' : 'OK', reason, stdout_b64: Buffer.from(got.stdout).toString('base64'),
      exit: got.exit, signal: got.signal, timed_out: got.timed_out, truncated: got.truncated, duration_ms: r?.duration_ms ?? 0,
    });
    if (reason && !first) {
      firstReason = reason;
      firstId = t.id;
      first = {
        test_id: t.id, hidden: !t.visible, argv: t.argv, stdin: t.stdin, reason,
        expected_b64: t.expected_stdout_b64, got_b64: Buffer.from(got.stdout).toString('base64'),
        expected_cat_e: catE(expected), got_cat_e: catE(got.stdout),
        expected_exit: t.expected_exit, exit: got.exit, signal: got.signal,
        timed_out: got.timed_out, truncated: got.truncated, first_diff_byte: firstDiffByte(got.stdout, expected),
      };
    }
  }
  b.tests = tests;
  b.test_details = details;
  if (first && firstReason) {
    const msg = `Test ${firstId} failed: ${reasonText(firstReason, { stdout: Buffer.alloc(0), exit: first.exit, signal: first.signal, timed_out: first.timed_out, truncated: first.truncated })}`;
    return { ...b, verdict: 'FAIL', stage: 'tests', message: msg, first_failure: first };
  }
  return { ...b, verdict: 'PASS', stage: 'done', message: 'All tests passed' };
}

export class InternalError extends Error {}
export class DuplicateJobError extends Error {}

/** Job dir → sandbox → judge. Always removes the container and the job dir. */
export async function runJob(cfg: DispatcherConfig, content: Content, ex: Exercise, req: GradeJobRequest, sandbox: SandboxRunner, started: number, onStart?: () => void): Promise<GradeJobResponse> {
  const jobDir = path.join(cfg.jobsDir, req.job_id);
  await fs.mkdir(cfg.jobsDir, { recursive: true, mode: 0o755 });
  try {
    await fs.mkdir(jobDir, { mode: 0o755 });
  } catch (e) {
    // Never touch a directory we did not create: it may belong to a running job.
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new DuplicateJobError(`job ${req.job_id} already exists`);
    throw e;
  }
  try {
    const inDir = await writeJobDir(cfg, content, ex, req);
    onStart?.();
    const res = await sandbox(req.job_id, inDir, outerDeadlineMs(cfg, ex));
    const out = parseRunnerOutput(res.stdout);
    if (out) return judge(req, ex, started, out, null);
    if (res.killed) return judge(req, ex, started, null, 'timeout');
    // 137: the container was OOM-killed or the runner was killed: the submission's doing.
    if (res.code === 137) return judge(req, ex, started, null, 'signal');
    throw new InternalError(`sandbox failed (exit ${res.code}): ${res.stderr.slice(0, 2000)}`);
  } finally {
    await removeContainer(req.job_id).catch(() => {});
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

export { checkFile, checkStatic };
