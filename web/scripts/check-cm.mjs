// Asserts exactly one installed copy of @codemirror/state and @codemirror/view. Two copies
// break CodeMirror at runtime ("Unrecognized extension value", instanceof checks failing).
// Walks every node_modules tree reachable from the repo root and web/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [path.join(webDir, 'node_modules'), path.join(webDir, '..', 'node_modules')];
const wanted = ['@codemirror/state', '@codemirror/view'];
const found = Object.fromEntries(wanted.map((n) => [n, []]));
const seen = new Set();

function walk(nm) {
  let real;
  try {
    real = fs.realpathSync(nm);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  for (const entry of fs.readdirSync(nm, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const dirs = entry.name.startsWith('@')
      ? fs.readdirSync(path.join(nm, entry.name)).map((n) => `${entry.name}/${n}`)
      : [entry.name];
    for (const name of dirs) {
      const dir = path.join(nm, name);
      const pkgFile = path.join(dir, 'package.json');
      if (found[name] && fs.existsSync(pkgFile)) {
        const { version } = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        found[name].push(`${version}  ${path.relative(path.join(webDir, '..'), dir)}`);
      }
      const nested = path.join(dir, 'node_modules');
      if (fs.existsSync(nested)) walk(nested);
    }
  }
}

for (const r of roots) if (fs.existsSync(r)) walk(r);

let ok = true;
for (const name of wanted) {
  const copies = found[name];
  console.log(`${name}: ${copies.length} cop${copies.length === 1 ? 'y' : 'ies'}`);
  for (const c of copies) console.log(`  ${c}`);
  if (copies.length !== 1) ok = false;
}
if (!ok) {
  console.error('check:cm FAILED: expected exactly one copy of each. Run `npm dedupe`.');
  process.exit(1);
}
console.log('check:cm OK');
