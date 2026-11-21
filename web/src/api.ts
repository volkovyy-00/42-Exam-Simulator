// Typed client for every endpoint in DESIGN.md §3. Same-origin, cookie auth.
import type {
  ApiError,
  ExamProfilesResponse,
  ExamStatus,
  ExerciseDetail,
  ExerciseListResponse,
  GradeResult,
  GrademeResponse,
  HealthResponse,
  Hint,
  HintRatingRequest,
  HintStateResponse,
  LoginRequest,
  MeResponse,
  RegisterRequest,
  SolutionResponse,
  SubmissionDetail,
  SubmissionListResponse,
  SubmitRequest,
} from '@ceg/contract';

export class ApiFailure extends Error {
  readonly status: number;
  readonly body: ApiError;
  constructor(status: number, body: ApiError) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({ error: 'internal', message: res.statusText }));
  if (!res.ok) throw new ApiFailure(res.status, data as ApiError);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  health: () => call<HealthResponse>('GET', '/api/health'),

  register: (b: RegisterRequest) => call<MeResponse>('POST', '/api/auth/register', b),
  login: (b: LoginRequest) => call<MeResponse>('POST', '/api/auth/login', b),
  logout: () => call<void>('POST', '/api/auth/logout'),
  me: () => call<MeResponse>('GET', '/api/me'),

  exercises: (level?: number) =>
    call<ExerciseListResponse>('GET', level === undefined ? '/api/exercises' : `/api/exercises?level=${level}`),
  exercise: (id: string) => call<ExerciseDetail>('GET', `/api/exercises/${enc(id)}`),

  submitPractice: (id: string, b: SubmitRequest) =>
    call<GradeResult>('POST', `/api/practice/${enc(id)}/submissions`, b),
  practiceSubmissions: (id: string) => call<SubmissionListResponse>('GET', `/api/practice/${enc(id)}/submissions`),
  submission: (id: number) => call<SubmissionDetail>('GET', `/api/submissions/${id}`),
  solution: (id: string) => call<SolutionResponse>('GET', `/api/practice/${enc(id)}/solution`),

  hintState: (id: string) => call<HintStateResponse>('GET', `/api/practice/${enc(id)}/hints`),
  requestHint: (id: string, submissionId: number) =>
    call<Hint>('POST', `/api/practice/${enc(id)}/hints`, { submission_id: submissionId }),
  rateHint: (hintId: number, b: HintRatingRequest) => call<void>('POST', `/api/hints/${hintId}/rating`, b),

  examProfiles: () => call<ExamProfilesResponse>('GET', '/api/exam/profiles'),
  startExam: (profileId: string) => call<ExamStatus>('POST', '/api/exams', { profile_id: profileId }),
  currentExam: () => call<ExamStatus>('GET', '/api/exams/current'),
  exam: (examId: number) => call<ExamStatus>('GET', `/api/exams/${examId}`),
  examQuestion: (examId: number) => call<ExerciseDetail>('GET', `/api/exams/${examId}/question`),
  grademe: (examId: number, b: SubmitRequest) => call<GrademeResponse>('POST', `/api/exams/${examId}/grademe`, b),
  finishExam: (examId: number) => call<ExamStatus>('POST', `/api/exams/${examId}/finish`),
};
