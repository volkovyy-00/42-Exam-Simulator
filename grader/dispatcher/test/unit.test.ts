import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Exercise } from '@ceg/contract';
import { catE, firstDiffByte, koReason, type Observed } from '../src/compare.ts';
import { loadConfig } from '../src/config.ts';
import { dockerRunArgs, memoryLimitProblem } from '../src/docker.ts';
import { outerDeadlineMs, parseRunnerOutput, runnerJob, testTimeoutMs } from '../src/grade.ts';
import { BusyError, Scheduler } from '../src/queue.ts';
import { checkFile, checkStatic } from '../src/static.ts';
import { FIXTURES } from './fixtures-path.ts';

const b = (s: string) => Buffer.from(s, 'latin1');
const echo = JSON.parse(fs.readFileSync(`${FIXTURES}/exercises/0/gym_echo_first.json`, 'utf8')) as Exercise;

describe('catE (DESIGN §6.4)', () => {
  it('renders the acceptance cases', () => {
    assert.equal(catE(b('a\tb\n')), 'a\tb$');
    assert.equal(catE(b('\x01')), '^A');
    assert.equal(catE(b('\x7f')), '^?');
    assert.equal(catE(b('\xc3\xa9')), 'M-CM-)');
    assert.equal(catE(b('')), '');
  });
  it('renders newlines inside the output and high control bytes', () => {
    assert.equal(catE(b('a\nb\n')), 'a$\nb$');
    assert.equal(catE(b('a\n\n')), 'a$\n$');
    assert.equal(catE(b('\x00\x1f\x89\xff')), '^@^_M-^IM-^?');
    assert.equal(catE(b('abc')), 'abc');
  });
});

describe('compare', () => {
  const ok: Observed = { stdout: b('abc\n'), exit: 0, signal: null, timed_out: false, truncated: false };
  it('first_diff_byte', () => {
    assert.equal(firstDiffByte(b('abc\n'), b('abc')), 3);
    assert.equal(firstDiffByte(b('abc'), b('abc\n')), 3);
    assert.equal(firstDiffByte(b('abd'), b('abc')), 2);
    assert.equal(firstDiffByte(b('abc'), b('abc')), null);
  });
  it('byte-exact: the trailing newline counts', () => {
    assert.equal(koReason(ok, b('abc\n'), 0), null);
    assert.equal(koReason({ ...ok, stdout: b('abc') }, b('abc\n'), 0), 'output');
  });
  it('reason precedence timeout > signal > truncated > exit_code > output', () => {
    const all: Observed = { stdout: b('x'), exit: 3, signal: 'SIGSEGV', timed_out: true, truncated: true };
    assert.equal(koReason(all, b('abc\n'), 0), 'timeout');
    assert.equal(koReason({ ...all, timed_out: false }, b('abc\n'), 0), 'signal');
    assert.equal(koReason({ ...all, timed_out: false, signal: null }, b('abc\n'), 0), 'truncated');
    assert.equal(koReason({ ...all, timed_out: false, signal: null, truncated: false }, b('abc\n'), 0), 'exit_code');
    assert.equal(koReason({ ...all, timed_out: false, signal: null, truncated: false, exit: 0 }, b('abc\n'), 0), 'output');
  });
});

describe('file and static stages', () => {
  it('file', () => {
    assert.equal(checkFile(echo, 'gym_echo_first.c'), null);
    assert.equal(checkFile(echo, 'echo.c'), 'expected file gym_echo_first.c, got echo.c');
  });
  it('static', () => {
    assert.equal(checkStatic(echo, 'int main(void){return 0;}\n'), null);
    assert.equal(checkStatic(echo, 'int main(void){__asm__("nop");return 0;}'), 'forbidden construct: asm');
    assert.equal(checkStatic(echo, 'int main(void){asm ("nop");return 0;}'), 'forbidden construct: asm');
    assert.equal(checkStatic(echo, 'int main(void){return syscall (1);}'), 'forbidden construct: syscall');
    assert.equal(checkStatic({ ...echo, allow_asm: true }, 'void f(void){__asm__("nop");}'), null);
    assert.equal(checkStatic(echo, '// asm é\nchar *s = "__asm__ é"; char c = \'"\'; /* syscall( */\n'), null);
    assert.match(checkStatic(echo, 'int x;\nint é;\n') ?? '', /non-ASCII .* line 2, column 5/);
    assert.equal(checkStatic(echo, 'x'.repeat(65537)), 'source is larger than 64 KiB');
  });
});

describe('limits and job.json', () => {
  const cfg = loadConfig({});
  it('outer deadline per §6.5', () => {
    assert.equal(outerDeadlineMs(cfg, echo), 30_000); // 10 + 5×2 + 10 = 30
    const slow = { ...echo, limits: { ...echo.limits, timeout_ms: 10_000 } };
    assert.equal(testTimeoutMs(cfg, slow), 10_000);
    assert.equal(outerDeadlineMs(cfg, slow), 60_000); // 10 + 50 + 10 = 70 → capped at 60
    assert.equal(testTimeoutMs(cfg, { ...echo, limits: { ...echo.limits, timeout_ms: 99_000 } }), 10_000);
  });
  it('job.json carries no expected output', () => {
    const job = JSON.stringify(runnerJob(cfg, echo, 'gym_echo_first.c'));
    assert.ok(!job.includes('expected'));
    for (const t of echo.tests) assert.ok(!job.includes(t.expected_stdout_b64));
    assert.ok(!job.includes('refs/'));
  });
  it('docker run flags are exactly DESIGN §6.3', () => {
    const want = 'run --rm --name grade-J --network none --cap-drop ALL --security-opt no-new-privileges '
      + '--user 65534:65534 --read-only --tmpfs /work:rw,exec,nosuid,nodev,size=16m,uid=65534,gid=65534 '
      + '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m -v /srv/grader/jobs/J/in:/in:ro --pids-limit 64 '
      + '--memory 256m --memory-swap 256m --cpus 1 --ulimit nofile=64:64 --ulimit fsize=8388608:8388608 '
      + '--ulimit core=0:0 --ulimit cpu=20:20 --log-opt max-size=1m grader:pinned /runner.sh';
    const args = dockerRunArgs('J', '/srv/grader/jobs/J/in', 'grader:pinned');
    assert.equal(args.join(' '), want);
    assert.ok(!args.includes('--privileged'));
    assert.ok(!args.some((a) => a.startsWith('seccomp')));
  });
  it('runner output parsing takes the last line and rejects junk', () => {
    const line = JSON.stringify({ runner_version: '1', stage: 'tests', compile_ok: true, compile_stderr: '',
      nm_symbols: [], forbidden: [], link_ok: true, link_stderr: '', tests: [] });
    assert.ok(parseRunnerOutput(`noise\n${line}\n`));
    assert.equal(parseRunnerOutput(`${line}\nnoise\n`), null);
    assert.equal(parseRunnerOutput(''), null);
  });
});

describe('startup guard', () => {
  it('detects missing memory-limit support', () => {
    assert.equal(memoryLimitProblem('Server Version: 29\nWARNING: No swap limit support\n'), null);
    assert.match(memoryLimitProblem('Server Version: 29\nWARNING: No memory limit support\n') ?? '', /No memory limit/);
  });
});

describe('scheduler', () => {
  it('limits concurrency, queues FIFO, rejects when the queue is full or the user is busy', async () => {
    const s = new Scheduler(2, 1);
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const job = (n: number) => async () => { order.push(n); await gate; return n; };
    const p1 = s.run(1, job(1));
    const p2 = s.run(2, job(2));
    const p3 = s.run(3, job(3));
    await assert.rejects(s.run(4, job(4)), BusyError); // queue (max 1) full
    await assert.rejects(s.run(1, job(5)), BusyError); // user 1 in flight
    assert.equal(s.running, 2);
    assert.equal(s.queued, 1);
    release();
    assert.deepEqual(await Promise.all([p1, p2, p3]), [1, 2, 3]);
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(s.running, 0);
    assert.equal(s.queued, 0);
    assert.equal(await s.run(1, async () => 'again'), 'again');
  });
  it('a null user (hint skeleton check) does not take the user slot', async () => {
    const s = new Scheduler(2, 5);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = s.run(1, () => gate);
    const q = s.run(null, async () => 'skeleton');
    assert.equal(await q, 'skeleton');
    release();
    await p;
  });
});

describe('runner_lib asm_check (object code)', () => {
  const lib = fileURLToPath(new URL('../../image/runner_lib.py', import.meta.url));
  const check = (objdump: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceg-asm-'));
    try {
      fs.writeFileSync(path.join(dir, 'od'), objdump);
      execFileSync('python3', ['-I', lib, 'asm_check', path.join(dir, 'od'), dir]);
      return fs.existsSync(path.join(dir, 'static_insns')) ? fs.readFileSync(path.join(dir, 'static_insns'), 'utf8') : '';
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const head = 'student.o:     file format elf64-x86-64\n\nDisassembly of section .text:\n\n0000000000000000 <main>:\n';
  it('flags syscall, sysenter, int and svc, ignores the rest', () => {
    assert.equal(check(head + '   0:\tpush   %rbp\n   1:\tsyscall\n'), 'syscall');
    assert.equal(check(head + '   0:\tint    $0x80\n   2:\tsysenter\n'), 'int\nsysenter');
    assert.equal(check('0000000000000000 <f>:\n   0:\td2800808 \tmov\tx8, #0x40\n   4:\tsvc\t#0x0\n'), 'svc');
    assert.equal(check(head + '   0:\tlock syscall\n'), 'syscall');
    assert.equal(check(head + '   0:\tint3\n   1:\tcall   6 <main+0x6>\n   6:\tret\n'), '');
  });
});
