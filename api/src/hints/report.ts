// Deterministic pieces of a hint: the escaped test report, the diff hint, the test fingerprint
// and the user prompt (prompts/hint-user-v1.txt).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Exercise, GradeJobResponse } from '@ceg/contract';

export const PROMPT_VERSION = 'hint-v1';
const promptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts');
export const SYSTEM_PROMPT = fs.readFileSync(path.join(promptDir, 'hint-v1.txt'), 'utf8');
const USER_TEMPLATE = fs.readFileSync(path.join(promptDir, 'hint-user-v1.txt'), 'utf8');

/** Visible escaping for the report: \n, \t, · for space, \xNN for other non-printables. */
export function escapeBytes(buf: Buffer, max = 400): string {
  let out = '';
  for (const b of buf.subarray(0, max)) {
    if (b === 0x0a) out += '\\n';
    else if (b === 0x09) out += '\\t';
    else if (b === 0x20) out += '·';
    else if (b === 0x5c) out += '\\\\';
    else if (b < 0x20 || b >= 0x7f) out += `\\x${b.toString(16).padStart(2, '0')}`;
    else out += String.fromCharCode(b);
  }
  if (buf.length > max) out += `… (${buf.length} bytes)`;
  return out;
}

const escStr = (s: string) => escapeBytes(Buffer.from(s, 'utf8'), 200);
const b64 = (s: string) => Buffer.from(s ?? '', 'base64');

function byteDesc(buf: Buffer, i: number): string {
  const b = buf[i];
  return b === undefined ? 'end of output' : `'${escapeBytes(Buffer.from([b]))}' (0x${b.toString(16).padStart(2, '0')})`;
}

export function testReport(r: GradeJobResponse): string {
  const lines: string[] = [];
  const total = r.tests.length;
  const ff = r.first_failure;
  if (ff) {
    const n = r.tests.findIndex((t) => t.id === ff.test_id) + 1;
    lines.push(`first_failing_test: ${ff.test_id} (${n}/${total})${ff.hidden ? ', hidden test' : ''}`);
    lines.push(`reason: ${ff.reason}`);
    lines.push(`args: [${ff.argv.map((a) => `"${escStr(a)}"`).join(', ')}]`);
    lines.push(`stdin: ${ff.stdin === null ? '(none)' : `"${escStr(ff.stdin)}"`}`);
    const exp = b64(ff.expected_b64);
    const got = b64(ff.got_b64);
    lines.push(`expected: "${escapeBytes(exp)}"`);
    lines.push(`got:      "${escapeBytes(got)}"`);
    if (ff.first_diff_byte !== null) {
      lines.push(`first_difference_at_byte: ${ff.first_diff_byte} (expected ${byteDesc(exp, ff.first_diff_byte)}, got ${byteDesc(got, ff.first_diff_byte)})`);
    }
    if (ff.exit !== ff.expected_exit) lines.push(`exit: expected ${ff.expected_exit}, got ${ff.exit ?? 'none'}`);
    if (ff.signal) lines.push(`signal: ${ff.signal}`);
    if (ff.timed_out) lines.push('timed_out: true');
    if (ff.truncated) lines.push('truncated: true (too much output)');
  } else {
    lines.push(`stage: ${r.stage}`, `message: ${r.message}`);
  }
  lines.push(`forbidden_functions_used: ${r.forbidden.length ? r.forbidden.join(', ') : '(none)'}`);
  return lines.join('\n');
}

/** What the hint is about. Two submissions failing the same way share a fingerprint. */
export function testFingerprint(r: GradeJobResponse): string {
  const ff = r.first_failure;
  const key = JSON.stringify([r.stage, ff?.test_id ?? null, ff?.reason ?? null, ff?.got_b64 ?? null,
    ff?.exit ?? null, r.forbidden, r.compile_stderr ?? null]);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** The deterministic hint: what failed and where the bytes differ. No LLM involved. */
export function diffHint(r: GradeJobResponse): string {
  const ff = r.first_failure;
  if (r.stage === 'compile' || r.stage === 'link') {
    const first = (r.compile_stderr ?? '').split('\n').find((l) => /error|warning/i.test(l)) ?? r.message;
    return `Your code does not ${r.stage === 'link' ? 'link' : 'compile'} with -Wall -Wextra -Werror. ` +
      `Start with the first message: ${first.trim().slice(0, 300)}. Try it, then resubmit.`;
  }
  if (r.stage === 'nm') {
    return `Your code calls a function that is not allowed here: ${r.forbidden.join(', ')}. ` +
      'Only the functions listed in the subject may be used. Try it, then resubmit.';
  }
  if (!ff) return `${r.message}. Try it, then resubmit.`;
  const exp = b64(ff.expected_b64);
  const got = b64(ff.got_b64);
  const label = `Test ${ff.test_id}${ff.hidden ? ' (hidden test)' : ''} with args [${ff.argv.map((a) => `"${escStr(a)}"`).join(', ')}]`;
  switch (ff.reason) {
    case 'timeout':
      return `${label} did not finish in time. Look for a loop whose condition never becomes false on this input. Try it, then resubmit.`;
    case 'signal':
      return `${label} crashed (${ff.signal ?? 'signal'}). Check every array or pointer access on this input, especially at the end of the string. Try it, then resubmit.`;
    case 'truncated':
      return `${label} printed far too much output. Check that your loop stops. Try it, then resubmit.`;
    case 'exit_code':
      return `${label} returned exit code ${ff.exit ?? 'none'}, expected ${ff.expected_exit}. Check what main returns. Try it, then resubmit.`;
    default: {
      const at = ff.first_diff_byte;
      const where = at === null ? '' : ` The first difference is at byte ${at}: expected ${byteDesc(exp, at)}, got ${byteDesc(got, at)}.`;
      return `${label}: expected "${escapeBytes(exp)}" but got "${escapeBytes(got)}".${where} ` +
        'Compare expected vs got byte by byte (newline, spaces, sign). Try it, then resubmit.';
    }
  }
}

export function numberLines(src: string): string {
  const lines = src.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const w = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(w, ' ')}| ${l}`).join('\n');
}

export function buildUserPrompt(args: {
  level: number;
  attemptNo: number;
  exercise: Exercise;
  result: GradeJobResponse;
  source: string;
  previousHints: string[];
}): string {
  const { exercise: ex, result: r } = args;
  const compiler = r.stage === 'compile' || r.stage === 'link'
    ? (r.compile_stderr ?? '').slice(0, 1500) || r.message
    : '(compiled OK)';
  const vars: Record<string, string> = {
    level: String(args.level),
    attempt_no: String(args.attemptNo),
    exercise_name: ex.id,
    prototype: ex.prototype ?? '(program with main)',
    allowed_functions: ex.allowed_functions.length ? ex.allowed_functions.join(', ') : '(none)',
    subject: ex.subject_md.slice(0, 1200),
    compiler_output: compiler,
    test_report: testReport(r),
    student_code: numberLines(args.source),
    previous_hints: args.previousHints.length ? args.previousHints.slice(-2).join('\n---\n') : 'none',
  };
  // Single pass, so a placeholder inside student code is never expanded.
  return USER_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}
