import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export type DB = Database.Database;

/** Opens (or creates) the SQLite database and applies schema.sql. Use ':memory:' in tests. */
export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  if (db.pragma('user_version', { simple: true }) === 0) db.pragma('user_version = 1');
  return db;
}
