import { useState } from 'react';
import type { FailureReason, FirstFailure, GradeResult } from '@ceg/contract';
import { b64ToBytes, labelled, visibleWhitespace } from '../lib/bytes.ts';

const REASON: Record<FailureReason, string> = {
  output: 'output differs',
  exit_code: 'wrong exit code',
  timeout: 'timed out',
  signal: 'crashed',
  truncated: 'output too long (truncated)',
};

const STAGE: Record<string, string> = {
  file: 'file check',
  static: 'source check',
  compile: 'compilation',
  nm: 'forbidden function check',
  link: 'link',
  tests: 'tests',
  done: 'done',
};

function quoteArg(a: string): string {
  return /^[\w./=-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
}

function Failure({ f, filename }: { f: FirstFailure; filename: string }) {
  const [visible, setVisible] = useState(false);
  const exp = visible ? visibleWhitespace(b64ToBytes(f.expected_b64)) : f.expected_cat_e;
  const got = visible ? visibleWhitespace(b64ToBytes(f.got_b64)) : f.got_cat_e;
  const prog = filename.replace(/\.c$/, '');
  return (
    <div className="failure">
      <p className="failure-head">
        <strong>Test {f.test_id}</strong>
        {f.hidden ? <span className="tag">hidden test</span> : <span className="tag">visible test</span>}
        <span>{REASON[f.reason]}</span>
      </p>
      <p className="mono small">
        $ ./{prog}{f.argv.length ? ' ' + f.argv.map(quoteArg).join(' ') : ''}
        {f.stdin !== null ? ' < stdin' : ''} | cat -e
      </p>
      {f.stdin !== null && <pre className="mono small">stdin: {f.stdin}</pre>}
      {f.reason === 'exit_code' && (
        <p className="mono small">exit: expected {f.expected_exit}, got {f.exit ?? '—'}</p>
      )}
      {f.signal && <p className="mono small">signal: {f.signal}</p>}
      {f.timed_out && <p className="mono small">killed after the time limit</p>}
      {f.truncated && <p className="mono small">output was cut off at the size limit</p>}
      <div className="diff-head">
        <span className="muted small">{visible ? 'visible whitespace' : 'cat -e'}</span>
        <button
          type="button"
          className="small-btn"
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? 'Show cat -e' : 'Show whitespace'}
        </button>
      </div>
      <pre className="diff" data-testid="diff">
        {labelled('expected: ', exp, 10)}
        {'\n'}
        {labelled('got: ', got, 10)}
      </pre>
      {f.first_diff_byte !== null && (
        <p className="muted small">First difference at byte {f.first_diff_byte}.</p>
      )}
    </div>
  );
}

export function ResultView({ result, filename }: { result: GradeResult; filename: string }) {
  const pass = result.verdict === 'PASS';
  return (
    <section className={`result ${pass ? 'ok' : 'ko'}`} aria-live="polite" data-testid="result">
      <h3 className="verdict">
        {pass ? 'PASS' : result.verdict === 'ERROR' ? 'ERROR' : 'FAIL'}
        <span className="muted small"> · attempt {result.attempt_no} · {STAGE[result.stage] ?? result.stage}</span>
      </h3>
      <p>{result.message}</p>
      {result.tests.length > 0 && (
        <p className="tests mono" data-testid="tests">
          {result.tests.map((t) => `[${t.status}]`).join(' ')}
        </p>
      )}
      {result.compile_stderr && (
        <>
          <p className="small"><strong>Compiler output</strong></p>
          <pre className="compile mono">{result.compile_stderr}</pre>
        </>
      )}
      {result.forbidden.length > 0 && (
        <p className="forbidden">
          Forbidden functions used: <span className="mono">{result.forbidden.join(', ')}</span>
        </p>
      )}
      {result.first_failure && <Failure f={result.first_failure} filename={filename} />}
    </section>
  );
}
