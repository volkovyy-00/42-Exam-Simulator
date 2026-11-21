// Canned responses for the stub routes. Every value is typed against @ceg/contract, so a
// contract change that is not reflected here fails `npm run typecheck`.
// WP3 replaces each use of these with real logic and deletes this file.
import type {
  ExamStatus,
  ExerciseDetail,
  ExerciseSummary,
  GradeResult,
  Hint,
  HintStateResponse,
  Mode,
  SolutionResponse,
  SubmissionDetail,
  SubmissionSummary,
  User,
} from '@ceg/contract';

const now = () => new Date().toISOString();

export const stubUser: User = { id: 1, username: 'demo', is_admin: false };

export const stubExercises: ExerciseSummary[] = [
  { id: 'gym_echo_first', level: 0, kind: 'program', attempts: 0, solved: false, solved_without_hints: false },
  { id: 'gym_strlen', level: 1, kind: 'function', attempts: 0, solved: false, solved_without_hints: false },
];

export const stubExerciseDetails: Record<string, ExerciseDetail> = {
  gym_echo_first: {
    id: 'gym_echo_first',
    level: 0,
    kind: 'program',
    expected_files: ['gym_echo_first.c'],
    allowed_functions: ['write'],
    prototype: null,
    subject_md:
      'Write a program that takes exactly one argument and prints it, followed by a newline.\n\n' +
      'With any other number of arguments, the program prints only a newline.',
    subject_source: 'original',
    visible_tests: [{ id: '01', argv: ['abc'], stdin: null }],
    autocomplete_words: ['write', 'main', 'argc', 'argv'],
  },
  gym_strlen: {
    id: 'gym_strlen',
    level: 1,
    kind: 'function',
    expected_files: ['gym_strlen.c'],
    allowed_functions: [],
    prototype: 'int\tgym_strlen(char *str);',
    subject_md: 'Write a function that returns the number of characters in a string.',
    subject_source: 'original',
    visible_tests: [{ id: '01', argv: ['hello'], stdin: null }],
    autocomplete_words: ['gym_strlen'],
  },
};

export function stubGradeResult(exerciseId: string, mode: Mode): GradeResult {
  return {
    submission_id: 1,
    exercise_id: exerciseId,
    mode,
    attempt_no: 1,
    created_at: now(),
    verdict: 'FAIL',
    stage: 'tests',
    message: 'Test 02 failed: output differs',
    tests: [
      { id: '01', visible: true, status: 'OK' },
      { id: '02', visible: false, status: 'KO' },
    ],
    first_failure: {
      test_id: '02',
      hidden: true,
      argv: [],
      stdin: null,
      reason: 'output',
      expected_b64: 'Cg==',
      got_b64: '',
      expected_cat_e: '$',
      got_cat_e: '',
      expected_exit: 0,
      exit: 0,
      signal: null,
      timed_out: false,
      truncated: false,
      first_diff_byte: 0,
    },
    compile_stderr: null,
    forbidden: [],
    duration_ms: 0,
  };
}

export const stubSubmissions: SubmissionSummary[] = [
  { id: 1, attempt_no: 1, verdict: 'FAIL', stage: 'tests', created_at: '2026-11-22T10:00:00Z' },
];

export function stubSubmissionDetail(id: number): SubmissionDetail {
  return {
    ...stubGradeResult('gym_echo_first', 'practice'),
    submission_id: id,
    filename: 'gym_echo_first.c',
    source: '#include <unistd.h>\n\nint\tmain(void)\n{\n\treturn (0);\n}\n',
  };
}

export function stubSolution(exerciseId: string): SolutionResponse {
  return { exercise_id: exerciseId, filename: `${exerciseId}.c`, source: '/* reference goes here */\n' };
}

export const stubHint: Hint = {
  hint_id: 1,
  level: 1,
  text: 'Test 02 runs with no arguments. What does your program print when argc is 1?',
  source: 'diff',
  cached: false,
  created_at: '2026-11-22T10:01:00Z',
};

export const stubHintState: HintStateResponse = {
  enabled: false,
  eligible_level: null,
  reason: 'disabled',
  failed_runs: 0,
  minutes_on_exercise: 0,
  quota: { user_day_left: 25, exercise_day_left: 3 },
  hints: [],
};

export function stubExamStatus(profileId = 'piscine_exam'): ExamStatus {
  const started = new Date();
  const ends = new Date(started.getTime() + 240 * 60_000);
  return {
    exam_id: 1,
    profile_id: profileId,
    status: 'active',
    started_at: started.toISOString(),
    ends_at: ends.toISOString(),
    now: started.toISOString(),
    time_left_s: 240 * 60,
    score: 0,
    pass_mark: 30,
    passed: false,
    slot: 0,
    total_slots: 16,
    level: 0,
    current: {
      exercise_id: 'gym_echo_first',
      expected_files: ['gym_echo_first.c'],
      assigned_at: started.toISOString(),
      failures: 0,
    },
    next_grade_at: null,
    history: [],
  };
}
