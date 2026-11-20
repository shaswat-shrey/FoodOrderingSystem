// Rebuilds src/modules/auth/data/common-passwords.json from a downloaded copy of
// SecLists Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt.
//
//   node apps/api/scripts/build-common-passwords.mjs /path/to/100k-most-used-passwords-NCSC.txt
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) {
  process.stderr.write('usage: build-common-passwords.mjs <downloaded list>\n');
  process.exit(1);
}
const entries = new Set();
for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
  const value = line.toLowerCase();
  const length = [...value].length;
  // Shorter passwords already fail BR-AUTH-001's length rule, so they are not stored.
  if (length >= 8 && length <= 128) entries.add(value);
}
const out = fileURLToPath(
  new URL('../src/modules/auth/data/common-passwords.json', import.meta.url),
);
writeFileSync(out, `${JSON.stringify([...entries].sort())}\n`);
process.stdout.write(`wrote ${entries.size} entries to ${out}\n`);
