// WP1 acceptance tests against real Docker (TASKS.md WP1). Run with
//   npm run test:grading -w grader/dispatcher
// GRADER_IMAGE selects the sandbox image (default grader:pinned). JOBS_DIR defaults to a fresh
// temp dir. Content: ./fixtures, plus one test-only exercise (gym_probe, allows fork) in a copy.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { GradeJobResponse } from '@ceg/contract';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { cleanup, dockerRunArgs, makeDockerSandbox, type SandboxRunner } from '../../src/docker.ts';
import { checkStatic } from '../../src/static.ts';
import { FIXTURES } from '../fixtures-path.ts';

const IMAGE = process.env.GRADER_IMAGE || 'grader:pinned';
const REF_ECHO = fs.readFileSync(path.join(FIXTURES, 'refs/gym_echo_first.c'), 'utf8');
const REF_STRLEN = fs.readFileSync(path.join(FIXTURES, 'refs/gym_strlen.c'), 'utf8');

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });
const gradeContainers = () => docker('ps', '-a', '--filter', 'name=grade-', '--format', '{{.Names}}').split('\n').filter(Boolean);

let app: FastifyInstance;
let jobsDir: string;
let contentDir: string;
let sandboxCalls = 0;

before(async () => {
  docker('image', 'inspect', IMAGE); // fail fast without the image
  jobsDir = process.env.JOBS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ceg-jobs-'));
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.chmodSync(jobsDir, 0o755);
  contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceg-content-'));
  fs.cpSync(FIXTURES, contentDir, { recursive: true });
  fs.mkdirSync(path.join(contentDir, 'exercises/9'));
  fs.writeFileSync(path.join(contentDir, 'exercises/9/gym_probe.json'), JSON.stringify({
    id: 'gym_probe', level: 9, kind: 'program', expected_files: ['gym_probe.c'], allowed_functions: ['write', 'fork'],
    prototype: null, subject_md: 'test-only', subject_source: 'original',
    harness: { main: null, includes: [], cflags_extra: ['-std=gnu17'] },
    tests: [{ id: '01', visible: true, argv: [], stdin: null, expected_stdout_b64: 'eAo=', expected_exit: 0 }],
    limits: { timeout_ms: 2000, max_output_bytes: 65536 }, reference_path: 'refs/gym_probe.c',
    provenance: { repo: 'c-exam-gym', commit: null, license_code: 'MIT', license_subject: 'MIT' }, hint_tags: [],
  }));
  // Test-only twin of gym_echo_first with allow_asm: proves the token-pasted asm version really
  // works (so the static FAIL below is the object-code check, not a broken program).
  const echoEx = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'exercises/0/gym_echo_first.json'), 'utf8'));
  fs.writeFileSync(path.join(contentDir, 'exercises/9/gym_echo_asm.json'), JSON.stringify({
    ...echoEx, id: 'gym_echo_asm', level: 9, expected_files: ['gym_echo_asm.c'], allowed_functions: [], allow_asm: true,
    reference_path: 'refs/gym_echo_asm.c',
  }));
  const real = makeDockerSandbox(IMAGE);
  const counting: SandboxRunner = (...a) => { sandboxCalls++; return real(...a); };
  app = await buildApp(loadConfig({ CONTENT_DIR: contentDir, JOBS_DIR: jobsDir, GRADER_IMAGE: IMAGE, GRADER_CONCURRENCY: '2' }),
    false, { sandbox: counting });
});

after(async () => {
  await app?.close();
  if (contentDir) fs.rmSync(contentDir, { recursive: true, force: true });
});

function assertClean() {
  assert.deepEqual(fs.readdirSync(jobsDir), [], 'job dirs left behind');
}

async function submit(exercise_id: string, filename: string, source: string, user_id = 1) {
  const r = await app.inject({
    method: 'POST', url: '/grade',
    payload: { job_id: randomUUID(), user_id, exercise_id, filename, source, mode: 'practice', purpose: 'submission' },
  });
  return { status: r.statusCode, body: r.json() as GradeJobResponse & { error?: string } };
}

// gym_echo_first with raw write syscalls through a token-pasted __asm__: the source lexer never
// sees "asm" or "syscall(" and nm -u is empty.
const SYS_WRITE = process.arch === 'arm64'
  ? `static long\tsys_write(long fd, const char *buf, long len)
{
\tregister long\tx0 CAT(__as, m__)("x0") = fd;
\tregister long\tx1 CAT(__as, m__)("x1") = (long)buf;
\tregister long\tx2 CAT(__as, m__)("x2") = len;
\tregister long\tx8 CAT(__as, m__)("x8") = 64;

\tCAT(__as, m__) volatile ("svc #0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x8) : "memory");
\treturn (x0);
}
`
  : `static long\tsys_write(long fd, const char *buf, long len)
{
\tlong\tret;

\tCAT(__as, m__) volatile ("syscall" : "=a"(ret) : "a"(1L), "D"(fd), "S"(buf), "d"(len) : "rcx", "r11", "memory");
\treturn (ret);
}
`;
const ECHO_PASTED_ASM = `#define CAT(a, b) a##b

${SYS_WRITE}
int\tmain(int argc, char **argv)
{
\tlong\ti;

\ti = 0;
\tif (argc == 2)
\t{
\t\twhile (argv[1][i])
\t\t\ti++;
\t\tsys_write(1, argv[1], i);
\t}
\tsys_write(1, "\\n", 1);
\treturn (0);
}
`;

const echoNoNewline = REF_ECHO.replace('\twrite(1, "\\n", 1);\n', '');

describe('grading against real Docker', { concurrency: false }, () => {
  it('GET /health reports docker: true', async () => {
    const r = (await app.inject({ method: 'GET', url: '/health' })).json();
    assert.deepEqual(r, { ok: true, docker: true, image: IMAGE, queue: 0, running: 0 });
  });

  it('gym_echo_first reference → PASS, stage done, 5 × OK', async () => {
    const { status, body } = await submit('gym_echo_first', 'gym_echo_first.c', REF_ECHO);
    assert.equal(status, 200);
    assert.equal(body.verdict, 'PASS', JSON.stringify(body));
    assert.equal(body.stage, 'done');
    assert.equal(body.message, 'All tests passed');
    assert.deepEqual(body.tests.map((t) => t.status), ['OK', 'OK', 'OK', 'OK', 'OK']);
    assert.equal(body.first_failure, null);
    assert.equal(body.runner_version, '1');
    assertClean();
  });

  it('gym_strlen reference (function, harness main) → PASS', async () => {
    const { body } = await submit('gym_strlen', 'gym_strlen.c', REF_STRLEN);
    assert.equal(body.verdict, 'PASS', JSON.stringify(body));
    assert.equal(body.stage, 'done');
    assert.deepEqual(body.tests.map((t) => t.status), ['OK', 'OK', 'OK']);
    assertClean();
  });

  it('missing final newline → FAIL tests, first_failure 01, abc$ vs abc', async () => {
    assert.notEqual(echoNoNewline, REF_ECHO);
    const { body } = await submit('gym_echo_first', 'gym_echo_first.c', echoNoNewline);
    assert.equal(body.verdict, 'FAIL');
    assert.equal(body.stage, 'tests');
    assert.equal(body.message, 'Test 01 failed: output differs');
    const f = body.first_failure!;
    assert.equal(f.test_id, '01');
    assert.equal(f.hidden, false);
    assert.equal(f.reason, 'output');
    assert.equal(f.expected_cat_e, 'abc$');
    assert.equal(f.got_cat_e, 'abc');
    assert.equal(f.first_diff_byte, 3);
    assertClean();
  });

  it('printf → FAIL nm, forbidden [printf]', async () => {
    const src = '#include <stdio.h>\n\nint\tmain(int argc, char **argv)\n{\n\tif (argc == 2)\n\t\tprintf("%s", argv[1]);\n\tprintf("\\n");\n\treturn (0);\n}\n';
    const { body } = await submit('gym_echo_first', 'gym_echo_first.c', src);
    assert.equal(body.verdict, 'FAIL');
    assert.equal(body.stage, 'nm');
    assert.deepEqual(body.forbidden, ['printf']);
    assert.equal(body.message, 'forbidden function: printf');
    assertClean();
  });

  it('unused variable → FAIL compile, stderr mentions -Werror', async () => {
    const { body } = await submit('gym_echo_first', 'gym_echo_first.c', 'int\tmain(void)\n{\n\tint\tx;\n\n\treturn (0);\n}\n');
    assert.equal(body.verdict, 'FAIL');
    assert.equal(body.stage, 'compile');
    assert.equal(body.message, 'compilation failed');
    assert.match(body.compile_stderr ?? '', /-Werror/);
    assertClean();
  });

  it('gym_strlen.c that also defines main → FAIL link', async () => {
    const { body } = await submit('gym_strlen', 'gym_strlen.c', REF_STRLEN + '\nint\tmain(void)\n{\n\treturn (0);\n}\n');
    assert.equal(body.verdict, 'FAIL');
    assert.equal(body.stage, 'link');
    assert.match(body.compile_stderr ?? '', /main/);
    assertClean();
  });

  it('wrong filename → FAIL file, no container started', async () => {
    const before = sandboxCalls;
    const { body } = await submit('gym_strlen', 'strlen.c', REF_STRLEN);
    assert.equal(body.verdict, 'FAIL');
    assert.equal(body.stage, 'file');
    assert.equal(body.message, 'expected file gym_strlen.c, got strlen.c');
    assert.equal(sandboxCalls, before);
    assertClean();
  });

  it('__asm__ → FAIL static', async () => {
    const before = sandboxCalls;
    const { body } = await submit('gym_echo_first', 'gym_echo_first.c', 'int\tmain(void)\n{\n\t__asm__("nop");\n\treturn (0);\n}\n');
    assert.equal(body.verdict, 'FAIL');
    assert.equal(body.stage, 'static');
    assert.equal(body.message, 'forbidden construct: asm');
    assert.equal(sandboxCalls, before);
  });

  it('token-pasted __asm__ syscall → FAIL static (object-code check); it really runs with allow_asm; reference still PASS', async () => {
    const ex = app.dispatcher.content().exercises.get('gym_echo_first')!;
    assert.equal(checkStatic(ex, ECHO_PASTED_ASM), null, 'the lexer fast path must not catch this one');
    const before = sandboxCalls;
    const { body } = await submit('gym_echo_first', 'gym_echo_first.c', ECHO_PASTED_ASM);
    assert.equal(body.verdict, 'FAIL', JSON.stringify(body));
    assert.equal(body.stage, 'static');
    assert.equal(body.message, 'forbidden construct: asm');
    assert.equal(sandboxCalls, before + 1, 'caught in the sandbox, not by the lexer');
    const allowed = await submit('gym_echo_asm', 'gym_echo_asm.c', ECHO_PASTED_ASM);
    assert.equal(allowed.body.verdict, 'PASS', JSON.stringify(allowed.body));
    const ref = await submit('gym_echo_first', 'gym_echo_first.c', REF_ECHO);
    assert.equal(ref.body.verdict, 'PASS', JSON.stringify(ref.body));
    assertClean();
  });

  it('while(1); → KO timed_out within 2 s + overhead, job < 30 s', async () => {
    const t0 = Date.now();
    const { body } = await submit('gym_echo_first', 'gym_echo_first.c', 'int\tmain(void)\n{\n\twhile (1)\n\t\t;\n\treturn (0);\n}\n');
    const took = Date.now() - t0;
    assert.equal(body.verdict, 'FAIL');
    assert.equal(body.stage, 'tests');
    assert.equal(body.first_failure?.reason, 'timeout');
    assert.equal(body.first_failure?.timed_out, true);
    for (const d of body.test_details) {
      assert.equal(d.timed_out, true);
      assert.ok(d.duration_ms < 2500, `test ${d.id} took ${d.duration_ms} ms`);
    }
    assert.ok(took < 30_000, `job took ${took} ms`);
    console.log(`# while(1): job ${took} ms, per test ${body.test_details.map((d) => d.duration_ms).join('/')} ms`);
    assertClean();
  });

  it('while(1) fork(); → FAIL or timeout, nothing left behind, host still answers', async () => {
    const src = '#include <unistd.h>\n\nint\tmain(void)\n{\n\twhile (1)\n\t\tfork();\n\treturn (0);\n}\n';
    const { status, body } = await submit('gym_probe', 'gym_probe.c', src);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.verdict, 'FAIL');
    assert.ok(['timeout', 'signal'].includes(body.first_failure?.reason ?? ''), JSON.stringify(body.first_failure));
    console.log(`# fork bomb: ${body.message}; ${JSON.stringify(body.test_details.map((d) => [d.reason, d.signal, d.duration_ms]))}`);
    assert.deepEqual(gradeContainers(), []);
    assert.equal(execFileSync('sh', ['-c', 'echo alive'], { encoding: 'utf8' }), 'alive\n');
    const h = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(h.statusCode, 200);
    assertClean();
  });

  it('printing 1 MiB → KO truncated', async () => {
    const src = '#include <unistd.h>\n\nint\tmain(void)\n{\n\tint\ti;\n\n\ti = 0;\n\twhile (i < 16384)\n\t{\n'
      + '\t\twrite(1, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\\n", 64);\n\t\ti++;\n\t}\n\treturn (0);\n}\n';
    const { body } = await submit('gym_echo_first', 'gym_echo_first.c', src);
    assert.equal(body.verdict, 'FAIL');
    assert.equal(body.first_failure?.reason, 'truncated');
    assert.equal(body.first_failure?.truncated, true);
    assertClean();
  });

  it('#include of a job dir or a reference → compile error, nothing leaks', async () => {
    for (const inc of ['/srv/grader/jobs/00000000-0000-0000-0000-000000000000/in/job.json',
      `${jobsDir}/x/in/job.json`, '/content/refs/gym_echo_first.c', `${contentDir}/refs/gym_echo_first.c`,
      `${contentDir}/exercises/0/gym_echo_first.json`]) {
      const { body } = await submit('gym_echo_first', 'gym_echo_first.c', `#include "${inc}"\n\nint\tmain(void)\n{\n\treturn (0);\n}\n`);
      assert.equal(body.stage, 'compile', inc);
      const err = body.compile_stderr ?? '';
      assert.match(err, /No such file or directory/, inc);
      for (const secret of ['YWJjCg', 'ICB0d28', 'expected_stdout', 'argv[1][i]', 'write(1, argv[1], i)']) {
        assert.ok(!err.includes(secret), `${secret} leaked via ${inc}`);
      }
    }
    assertClean();
  });

  it('3 users, concurrency 2 → at most 2 grade-* containers; same user twice → 503 grader_busy', async () => {
    const slow = 'int\tmain(void)\n{\n\twhile (1)\n\t\t;\n\treturn (0);\n}\n';
    let max = 0;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const n = docker('ps', '--filter', 'name=grade-', '-q').split('\n').filter(Boolean).length;
        max = Math.max(max, n);
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const jobs = [submit('gym_echo_first', 'gym_echo_first.c', slow, 101),
      submit('gym_echo_first', 'gym_echo_first.c', slow, 102),
      submit('gym_echo_first', 'gym_echo_first.c', slow, 103)];
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(app.dispatcher.scheduler.running, 2);
    assert.equal(app.dispatcher.scheduler.queued, 1);
    const dup = await submit('gym_echo_first', 'gym_echo_first.c', REF_ECHO, 101);
    assert.equal(dup.status, 503);
    assert.equal(dup.body.error, 'grader_busy');
    const res = await Promise.all(jobs);
    polling = false;
    await poll;
    for (const r of res) { assert.equal(r.status, 200); assert.equal(r.body.first_failure?.reason, 'timeout'); }
    assert.ok(max <= 2, `saw ${max} grade-* containers`);
    assert.equal(max, 2, 'expected the two slots to be used in parallel');
    assertClean();
  });

  it('outer deadline: docker kill, then the job is judged as a timeout and cleaned up', async () => {
    // Same code path as runJob, with a 1.5 s outer deadline instead of the §6.5 one.
    const { runJob } = await import('../../src/grade.ts');
    const ex = app.dispatcher.content().exercises.get('gym_echo_first')!;
    const shortDeadline: SandboxRunner = (id, inDir) => makeDockerSandbox(IMAGE)(id, inDir, 1500);
    const req = { job_id: randomUUID(), user_id: 7, exercise_id: ex.id, filename: 'gym_echo_first.c',
      source: 'int\tmain(void)\n{\n\twhile (1)\n\t\t;\n\treturn (0);\n}\n', mode: 'practice' as const, purpose: 'submission' as const };
    const t0 = Date.now();
    const body = await runJob(app.dispatcher.config, app.dispatcher.content(), ex, req, shortDeadline, t0);
    assert.ok(Date.now() - t0 < 12_000, `took ${Date.now() - t0} ms`);
    assert.equal(body.verdict, 'FAIL');
    assert.equal(body.stage, 'tests');
    assert.equal(body.first_failure?.reason, 'timeout');
    assert.deepEqual(gradeContainers(), []);
    assertClean();
  });

  it('every job dir is removed, no grade-* container is left', async () => {
    assertClean();
    assert.deepEqual(gradeContainers(), []);
  });
});

describe('sandbox (full §6.3 flag set, probed directly)', { concurrency: false }, () => {
  async function probe(cmd: string, files: Record<string, string> = {}) {
    const id = randomUUID();
    const inDir = path.join(jobsDir, id, 'in');
    fs.mkdirSync(inDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(jobsDir, id), 0o755);
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(inDir, n), c, { mode: 0o644 });
    try {
      return execFileSync('docker', dockerRunArgs(id, inDir, IMAGE, ['sh', '-c', cmd]), { encoding: 'utf8' });
    } finally {
      fs.rmSync(path.join(jobsDir, id), { recursive: true, force: true });
    }
  }

  it('as uid 65534: cp /in/<file> /work/, compile, link and run succeed (the /work tmpfs fix)', async () => {
    const out = await probe(
      'set -e; id -u; cp /in/gym_echo_first.c /work/; cd /work; '
      + 'cc -Wall -Wextra -Werror -std=gnu17 -c gym_echo_first.c -o student.o; cc student.o -o a.out; ./a.out hello',
      { 'gym_echo_first.c': REF_ECHO });
    assert.equal(out, '65534\nhello\n');
  });

  it('id -u is 65534, /in is read-only, no network, NoNewPrivs: 1', async () => {
    const out = await probe([
      'id -u',
      'touch /in/x 2>/dev/null && echo in-writable || echo in-readonly',
      'python3 -I -c "import socket; s = socket.socket(); s.settimeout(2); s.connect((\'1.1.1.1\', 53))" 2>/dev/null && echo net-ok || echo connect-failed',
      'grep NoNewPrivs /proc/self/status',
    ].join('; '));
    assert.equal(out, '65534\nin-readonly\nconnect-failed\nNoNewPrivs:\t1\n');
  });

  it('cleanup() removes exited grade-* containers and stale job dirs', async () => {
    const id = randomUUID();
    docker('create', '--name', `grade-${id}`, IMAGE, 'true');
    const stale = path.join(jobsDir, randomUUID());
    fs.mkdirSync(stale);
    const old = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(stale, old, old);
    const fresh = path.join(jobsDir, randomUUID());
    fs.mkdirSync(fresh);
    const r = await cleanup(jobsDir, new Set());
    assert.ok(r.containers.includes(`grade-${id}`));
    assert.deepEqual(r.dirs, [path.basename(stale)]);
    assert.ok(fs.existsSync(fresh));
    fs.rmSync(fresh, { recursive: true });
    assert.deepEqual(gradeContainers(), []);
  });
});
