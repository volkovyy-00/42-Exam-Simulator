// Shared services handed to every route plugin.
import type { ExamProfile, User } from '@ceg/contract';
import type { Config } from './config.ts';
import type { ContentStore } from './content.ts';
import type { DB } from './db.ts';
import type { GraderClient } from './grader.ts';

export interface Logger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Ctx {
  config: Config;
  db: DB;
  content: ContentStore;
  grader: GraderClient;
  profiles: ExamProfile[];
  /** Milliseconds since the epoch. Tests replace it with a fake clock. */
  now: () => number;
  /** fetch used for OpenRouter. Tests replace it with a mock; nothing calls the real API in tests. */
  fetch: typeof fetch;
  log: Logger;
  /** Users with a grading job in flight (DESIGN.md §6.5: 1 per user, enforced here). */
  inFlight: Set<number>;
}

/** ISO 8601 UTC without milliseconds, e.g. 2026-11-22T10:00:00Z (the format stored in SQLite). */
export function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseIso(s: string): number {
  return Date.parse(s);
}

/** Start of the current UTC day, as stored ISO text. */
export function dayStart(ms: number): string {
  const d = new Date(ms);
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    sessionId: string | null;
  }
}
