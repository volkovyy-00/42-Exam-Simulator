// Admin CLI (DESIGN.md §3.3). There is no admin HTTP API.
//   node scripts/admin.ts create <username>          create an admin (prompts for a password,
//                                                     or reads ADMIN_PASSWORD when stdin is not a TTY)
//   node scripts/admin.ts invite [--days N] [--count N]   print new single-use invite codes
// Uses DATA_DIR like the server (gym.sqlite inside it).
import path from 'node:path';
import readline from 'node:readline';
import { USERNAME_RE, createInvite, createUser, findUserByName } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';

function usage(): never {
  console.error('usage: admin.ts create <username> | invite [--days N] [--count N]');
  process.exit(2);
}

function flag(args: string[], name: string): number | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 1) usage();
  return n;
}

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0] ?? '';
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string) => new Promise<string>((res) => {
    // Hide typed characters.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(q)) process.stdout.write(s);
    };
    rl.question(q, (a) => { process.stdout.write('\n'); res(a); });
  });
  const a = await ask('Password: ');
  const b = await ask('Repeat password: ');
  rl.close();
  if (a !== b) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  return a;
}

const [cmd, ...rest] = process.argv.slice(2);
const config = loadConfig();
const dbFile = path.join(config.dataDir, 'gym.sqlite');

if (cmd === 'create') {
  const username = rest[0];
  if (!username || !USERNAME_RE.test(username)) {
    console.error('Username must match ^[a-z0-9_-]{3,20}$.');
    process.exit(2);
  }
  const db = openDb(dbFile);
  if (findUserByName(db, username)) {
    console.error(`User ${username} already exists.`);
    process.exit(1);
  }
  const pw = await readPassword();
  if (pw.length < 10 || pw.length > 200) {
    console.error('Password must be 10 to 200 characters.');
    process.exit(1);
  }
  const user = await createUser(db, username, pw, true);
  db.close();
  console.log(`Created admin ${user.username} (id ${user.id}) in ${dbFile}.`);
} else if (cmd === 'invite') {
  const days = flag(rest, '--days') ?? 7;
  const count = flag(rest, '--count') ?? 1;
  const db = openDb(dbFile);
  for (let i = 0; i < count; i++) console.log(createInvite(db, { days }));
  db.close();
  console.error(`(single use, valid ${days} day${days === 1 ? '' : 's'})`);
} else {
  usage();
}
