// Accounts, invites and sessions (DESIGN.md §3.3, §4). Used by routes/auth.ts and scripts/admin.ts.
import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { User } from '@ceg/contract';
import type { DB } from './db.ts';
import { iso } from './context.ts';

export const SESSION_COOKIE = 'ceg_session';
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

// A real hash to verify against when the username does not exist, so timing does not reveal it.
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

interface UserRow { id: number; username: string; password_hash: string; is_admin: number }

export const toUser = (r: { id: number; username: string; is_admin: number }): User =>
  ({ id: r.id, username: r.username, is_admin: r.is_admin === 1 });

export function findUserByName(db: DB, username: string): UserRow | undefined {
  return db.prepare('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?')
    .get(username) as UserRow | undefined;
}

export async function createUser(db: DB, username: string, password: string, isAdmin: boolean,
  nowMs = Date.now()): Promise<User> {
  const hash = await hashPassword(password);
  const info = db.prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hash, isAdmin ? 1 : 0, iso(nowMs));
  return { id: Number(info.lastInsertRowid), username, is_admin: isAdmin };
}

/** Invite codes look like k3q9-x2m7 (base36, 2×4 characters). */
export function createInvite(db: DB, opts: { createdBy?: number | null; days?: number | null; nowMs?: number } = {}): string {
  const nowMs = opts.nowMs ?? Date.now();
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const pick = (n: number) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % 36]).join('');
  const code = `${pick(4)}-${pick(4)}`;
  const expires = opts.days ? iso(nowMs + opts.days * 86_400_000) : null;
  db.prepare('INSERT INTO invites (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(code, opts.createdBy ?? null, iso(nowMs), expires);
  return code;
}

export type RegisterOutcome = { ok: true; user: User } | { ok: false; status: 401 | 409; message: string };

/** Single-use invite + new user, in one transaction. The password is hashed before it starts. */
export async function registerWithInvite(db: DB, code: string, username: string, password: string,
  nowMs: number): Promise<RegisterOutcome> {
  const inviteUsable = () => {
    const inv = db.prepare('SELECT used_by, expires_at FROM invites WHERE code = ?')
      .get(code) as { used_by: number | null; expires_at: string | null } | undefined;
    return !!inv && inv.used_by === null && (inv.expires_at === null || inv.expires_at > iso(nowMs));
  };
  if (!inviteUsable()) return { ok: false, status: 401, message: 'Invalid or used invite code.' };
  if (findUserByName(db, username)) return { ok: false, status: 409, message: 'Username taken.' };
  const hash = await hashPassword(password);
  const tx = db.transaction((): RegisterOutcome => {
    if (!inviteUsable()) return { ok: false, status: 401, message: 'Invalid or used invite code.' };
    if (findUserByName(db, username)) return { ok: false, status: 409, message: 'Username taken.' };
    const info = db.prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 0, ?)')
      .run(username, hash, iso(nowMs));
    const id = Number(info.lastInsertRowid);
    db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(id, iso(nowMs), code);
    return { ok: true, user: { id, username, is_admin: false } };
  });
  return tx();
}

/** Creates a session and returns the raw token for the cookie. Only sha256(token) is stored. */
export function createSession(db: DB, userId: number, nowMs: number): { token: string; expiresMs: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresMs = nowMs + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, iso(nowMs), iso(expiresMs), iso(nowMs));
  return { token, expiresMs };
}

export function sessionUser(db: DB, token: string, nowMs: number): { user: User; sessionId: string } | null {
  if (!token || token.length > 128) return null;
  const id = sha256(token);
  const row = db.prepare(`SELECT s.expires_at, s.last_seen_at, u.id, u.username, u.is_admin
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`)
    .get(id) as { expires_at: string; last_seen_at: string; id: number; username: string; is_admin: number } | undefined;
  if (!row) return null;
  if (row.expires_at <= iso(nowMs)) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  // last_seen_at at most once a minute, to keep writes down.
  if (Date.parse(row.last_seen_at) + 60_000 < nowMs) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(iso(nowMs), id);
  }
  return { user: toUser(row), sessionId: id };
}

export function deleteSession(db: DB, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function sessionCookie(token: string, expiresMs: number, secure: boolean): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Expires=${new Date(expiresMs).toUTCString()}; ` +
    `HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict`;
}

export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ` +
    `HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Sliding-window login limiter: LOGIN_LIMIT attempts per username per LOGIN_WINDOW_MS. In memory. */
export class LoginLimiter {
  private attempts = new Map<string, number[]>();

  /** Records an attempt. Returns seconds to wait if the limit is already reached, else 0. */
  hit(username: string, nowMs: number): number {
    const key = username.toLowerCase();
    const list = (this.attempts.get(key) ?? []).filter((t) => t > nowMs - LOGIN_WINDOW_MS);
    if (list.length >= LOGIN_LIMIT) {
      this.attempts.set(key, list);
      return Math.max(1, Math.ceil(((list[0] as number) + LOGIN_WINDOW_MS - nowMs) / 1000));
    }
    list.push(nowMs);
    this.attempts.set(key, list);
    if (this.attempts.size > 10_000) this.prune(nowMs);
    return 0;
  }

  private prune(nowMs: number) {
    for (const [k, v] of this.attempts) if (!v.some((t) => t > nowMs - LOGIN_WINDOW_MS)) this.attempts.delete(k);
  }
}
