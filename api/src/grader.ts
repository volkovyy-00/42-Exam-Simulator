// HTTP client for the grader dispatcher (DESIGN.md §6.1).
import type { DispatcherHealth, GradeJobRequest, GradeJobResponse } from '@ceg/contract';

export class DispatcherError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface GraderClient {
  grade(req: GradeJobRequest): Promise<GradeJobResponse>;
  health(): Promise<DispatcherHealth | null>;
}

export function graderClient(baseUrl: string, fetchFn: typeof fetch = fetch,
  gradeTimeoutMs = 90_000): GraderClient {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async grade(req) {
      let res: Response;
      try {
        res = await fetchFn(`${base}/grade`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(gradeTimeoutMs),
        });
      } catch (err) {
        throw new DispatcherError(0, 'unreachable', `grader unreachable: ${(err as Error).message}`);
      }
      const text = await res.text();
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      if (res.ok && isGradeResponse(body)) return body;
      // A Docker failure may come back as 500 with a full ERROR result: keep it.
      if (res.status === 500 && isGradeResponse(body)) return body;
      const b = (body ?? {}) as { error?: string; message?: string };
      throw new DispatcherError(res.status, b.error, b.message ?? `dispatcher answered ${res.status}`);
    },
    async health() {
      try {
        const res = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return null;
        return (await res.json()) as DispatcherHealth;
      } catch {
        return null;
      }
    },
  };
}

function isGradeResponse(b: unknown): b is GradeJobResponse {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return typeof o.verdict === 'string' && typeof o.stage === 'string' && Array.isArray(o.tests);
}
