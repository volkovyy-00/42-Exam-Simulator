// Fake grader dispatcher for the e2e suite (DESIGN.md §6.1 shapes, contract/src/grader.ts).
// The real API calls it at DISPATCHER_URL; no Docker involved. The verdict is chosen from the
// source text:
//   contains `#error`                  -> FAIL, stage "compile"
//   contains `printf`                  -> FAIL, stage "nm", forbidden ["printf"]
//   contains `write(1, "\n", 1)`       -> PASS
//   anything else (an empty editor)    -> FAIL, stage "tests": 01 OK, hidden 02 KO, expected "\n"
import http from 'node:http';

const port = Number(process.env.PORT ?? 19000);

const okDetail = (id) => ({
  id, status: 'OK', reason: null, stdout_b64: 'Cg==', exit: 0, signal: null,
  timed_out: false, truncated: false, duration_ms: 1,
});

function base(job, rest) {
  return {
    job_id: job.job_id, compile_stderr: null, forbidden: [], duration_ms: 5,
    first_failure: null, test_details: [], runner_version: 'fake-1', ...rest,
  };
}

function grade(job) {
  const src = String(job.source ?? '');
  if (src.includes('#error')) {
    return base(job, {
      verdict: 'FAIL', stage: 'compile', message: 'compilation failed', tests: [],
      compile_stderr: `${job.filename}:1:2: error: #error fake compile error`,
    });
  }
  if (src.includes('printf')) {
    return base(job, {
      verdict: 'FAIL', stage: 'nm', message: 'forbidden function: printf', tests: [], forbidden: ['printf'],
    });
  }
  if (src.includes('write(1, "\\n", 1)')) {
    return base(job, {
      verdict: 'PASS', stage: 'done', message: 'All tests passed',
      tests: [{ id: '01', visible: true, status: 'OK' }, { id: '02', visible: false, status: 'OK' }],
      test_details: [okDetail('01'), okDetail('02')],
    });
  }
  return base(job, {
    verdict: 'FAIL', stage: 'tests', message: 'Test 02 failed: output differs',
    tests: [{ id: '01', visible: true, status: 'OK' }, { id: '02', visible: false, status: 'KO' }],
    first_failure: {
      test_id: '02', hidden: true, argv: [], stdin: null, reason: 'output',
      expected_b64: 'Cg==', got_b64: '', expected_cat_e: '$', got_cat_e: '',
      expected_exit: 0, exit: 0, signal: null, timed_out: false, truncated: false, first_diff_byte: 0,
    },
    test_details: [okDetail('01'), { ...okDetail('02'), status: 'KO', reason: 'output', stdout_b64: '' }],
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, docker: true, image: 'grader:fake', queue: 0, running: 0 });
  }
  if (req.method === 'POST' && req.url === '/grade') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        send(res, 200, grade(JSON.parse(body)));
      } catch {
        send(res, 400, { error: 'bad_request', message: 'invalid JSON' });
      }
    });
    return;
  }
  send(res, 404, { error: 'not_found', message: `${req.method} ${req.url}` });
}).listen(port, '127.0.0.1', () => console.log(`fake dispatcher on 127.0.0.1:${port}`));
