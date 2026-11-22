// npm run content:fingerprint -- [--content <dir>]
//
// Writes content/fingerprints/<id>.json: the winnowing fingerprint (k=5, w=4, normalized C
// tokens, see lib/winnow.ts) of each exercise's reference, for the hint post-filter.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentRoot, loadExercises, parseArgs, toJson, writeFileEnsured } from './lib/content.ts';
import { fingerprint } from './lib/winnow.ts';

export const K = 5;
export const W = 4;

export function fingerprintAll(root: string, log: (s: string) => void = console.log): number {
  const dir = join(root, 'fingerprints');
  rmSync(dir, { recursive: true, force: true });
  let n = 0;
  for (const { exercise: ex } of loadExercises(root)) {
    const src = readFileSync(join(root, ex.reference_path), 'utf8');
    const fp = fingerprint(ex.id, src, K, W);
    if (fp.hashes.length === 0) log(`warning ${ex.id}: empty fingerprint`);
    writeFileEnsured(join(dir, `${ex.id}.json`), toJson(fp));
    n++;
  }
  log(`fingerprints: ${n} written to ${dir} (k=${K}, w=${W})`);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fingerprintAll(contentRoot(parseArgs(process.argv.slice(2))));
}
