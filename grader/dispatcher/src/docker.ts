// Docker CLI wrappers: the hardened sandbox run (DESIGN.md §6.3), startup guard, cleanup.
// Every call is spawn() with an argv array: no shell.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ExecResult { code: number | null; stdout: string; stderr: string }

export function exec(args: string[], timeoutMs = 30_000, maxBytes = 1 << 20): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < maxBytes) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < maxBytes) stderr += d.toString('utf8'); });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolve({ code: null, stdout, stderr: stderr + String(e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  });
}

export const containerName = (jobId: string) => `grade-${jobId}`;

/** The exact §6.3 flag set. `cmd` defaults to the runner; tests override it to probe the sandbox. */
export function dockerRunArgs(jobId: string, inDir: string, image: string, cmd: string[] = ['/runner.sh']): string[] {
  return [
    'run', '--rm', '--name', containerName(jobId), '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--read-only',
    '--tmpfs', '/work:rw,exec,nosuid,nodev,size=16m,uid=65534,gid=65534',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m',
    '-v', `${inDir}:/in:ro`, '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m',
    '--cpus', '1', '--ulimit', 'nofile=64:64', '--ulimit', 'fsize=8388608:8388608', '--ulimit', 'core=0:0',
    '--ulimit', 'cpu=20:20', '--log-opt', 'max-size=1m', image, ...cmd,
  ];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** The outer deadline fired and the container was killed. */
  killed: boolean;
}

export type SandboxRunner = (jobId: string, inDir: string, deadlineMs: number) => Promise<SandboxResult>;

const STDOUT_CAP = 64 << 20;

/**
 * Runs one job container. At the deadline: `docker kill`, then wait for the CLI to exit.
 * The caller removes the container (`docker rm -f`) and the job dir in its `finally`.
 */
export function makeDockerSandbox(image: string): SandboxRunner {
  return (jobId, inDir, deadlineMs) => new Promise((resolve) => {
    const child = spawn('docker', dockerRunArgs(jobId, inDir, image), { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outLen = 0;
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (d: Buffer) => { if (outLen < STDOUT_CAP) { out.push(d); outLen += d.length; } });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 65536) stderr += d.toString('utf8'); });
    let grace: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      killed = true;
      void exec(['kill', containerName(jobId)], 10_000);
      // If the CLI still hangs after the kill, stop waiting for it.
      grace = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, deadlineMs);
    const done = (code: number | null, extra = '') => {
      clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: stderr + extra, code, killed });
    };
    child.on('error', (e) => done(null, String(e)));
    child.on('close', (code) => done(code));
  });
}

export async function removeContainer(jobId: string): Promise<void> {
  await exec(['rm', '-f', containerName(jobId)], 30_000);
}

/** The memory-limit problem `docker info` reports, or null when limits work. */
export function memoryLimitProblem(info: string): string | null {
  const m = info.match(/^.*WARNING: No memory limit support.*$/im);
  return m ? m[0].trim() : null;
}

export const CGROUP_FIX = [
  'Docker reports no memory limit support, so --memory 256m would be silently ignored.',
  'Fix: enable the memory cgroup on the kernel command line and reboot:',
  '  Raspberry Pi OS: append "cgroup_enable=memory cgroup_memory=1 swapaccount=1" to the single line in',
  '                   /boot/firmware/cmdline.txt (older images: /boot/cmdline.txt)',
  '  GRUB:            add the same to GRUB_CMDLINE_LINUX in /etc/default/grub, run update-grub',
  'Then check that `docker info` no longer prints "WARNING: No memory limit support".',
].join('\n');

/** Startup guard. Throws (with the fix) when Docker is unreachable or lacks memory limits. */
export async function dockerStartupGuard(): Promise<string[]> {
  const r = await exec(['info'], 30_000);
  if (r.code !== 0) throw new Error(`docker info failed (is /var/run/docker.sock mounted?):\n${r.stderr}`);
  const all = `${r.stdout}\n${r.stderr}`;
  const problem = memoryLimitProblem(all);
  if (problem) throw new Error(`${problem}\n${CGROUP_FIX}`);
  return all.split('\n').filter((l) => /WARNING/.test(l)).map((l) => l.trim());
}

export async function dockerUp(): Promise<boolean> {
  const r = await exec(['version', '--format', '{{.Server.Version}}'], 5_000);
  return r.code === 0 && r.stdout.trim() !== '';
}

/**
 * Remove exited/created/dead grade-* containers, and job dirs older than `maxAgeMs` that no
 * running job owns. Returns what was removed.
 */
export async function cleanup(jobsDir: string, active: Set<string>, maxAgeMs = 3600_000): Promise<{ containers: string[]; dirs: string[] }> {
  const containers: string[] = [];
  for (const status of ['exited', 'created', 'dead']) {
    const r = await exec(['ps', '-a', '--filter', 'name=grade-', '--filter', `status=${status}`, '--format', '{{.Names}}'], 15_000);
    for (const name of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (active.has(name.replace(/^grade-/, ''))) continue;
      await exec(['rm', '-f', name], 15_000);
      containers.push(name);
    }
  }
  const dirs: string[] = [];
  let entries: string[] = [];
  try { entries = await fs.readdir(jobsDir); } catch { /* no jobs dir yet */ }
  const now = Date.now();
  for (const e of entries) {
    if (active.has(e)) continue;
    const p = path.join(jobsDir, e);
    try {
      const st = await fs.stat(p);
      if (now - st.mtimeMs > maxAgeMs) { await fs.rm(p, { recursive: true, force: true }); dirs.push(e); }
    } catch { /* raced with a finally */ }
  }
  return { containers, dirs };
}
