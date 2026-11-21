import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export type DB = Database.Database;

/** Opens (or creates) the SQLite database and applies schema.sql. Use ':memory:' in tests. */
export function openDb(file: string): DB {
  let db: DB;
  try {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL');
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (file !== ':memory:' && (code === 'EACCES' || code === 'EPERM' || code === 'SQLITE_CANTOPEN')) {
      throw dataDirError(path.dirname(file), err);
    }
    throw err;
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  if (db.pragma('user_version', { simple: true }) === 0) db.pragma('user_version = 1');
  return db;
}

/** A short, actionable error for an unwritable data directory (no stack trace when uncaught). */
function dataDirError(dir: string, cause: unknown): Error {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  const err = new Error(
    `Cannot open the SQLite database (${errCode(cause)}): the data directory ${dir} is not writable by uid ${uid}.\n` +
      `On the host, run: mkdir -p data && sudo chown ${uid}:${gid} data\n` +
      `(in the container ${dir} is the ./data bind mount next to docker-compose.yml).`,
  );
  err.stack = err.message;
  return err;
}

const errCode = (err: unknown) => String((err as { code?: unknown }).code ?? 'unknown');
