#!/usr/bin/env node
// Generates docs/requirements/REQUIREMENTS-INDEX.md from the SRS files and
// checks requirement IDs for duplicates and dangling references.
//
// Usage:  node docs/tools/requirements-index.mjs          (write index)
//         node docs/tools/requirements-index.mjs --check  (exit 1 on problems, no write)

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const reqDir = join(root, 'docs', 'requirements');
const scanDirs = [reqDir, join(root, 'docs', 'architecture'), join(root, 'docs', 'database')];
const OUT = join(reqDir, 'REQUIREMENTS-INDEX.md');

// ID families that are *defined* in the SRS and must be unique.
const FAMILIES = [
  { prefix: 'FR', label: 'Functional requirements' },
  { prefix: 'NFR', label: 'Non-functional requirements' },
  { prefix: 'BR', label: 'Business rules' },
  { prefix: 'AC', label: 'Acceptance criteria' },
  { prefix: 'API', label: 'API endpoints' },
  { prefix: 'EVT', label: 'Real-time events' },
];
const ID_RE = /\b(FR|NFR|BR|AC|API|EVT)-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}\b/g;

function listMd(dir) {
  try {
    return readdirSync(dir, { recursive: true })
      .filter((f) => String(f).endsWith('.md'))
      .map((f) => join(dir, String(f)));
  } catch {
    return [];
  }
}

const definitions = new Map(); // id -> [{file, title, priority, release}]
const references = new Map(); // id -> Set(file)

function addDef(id, def) {
  if (!definitions.has(id)) definitions.set(id, []);
  definitions.get(id).push(def);
}

for (const file of scanDirs.flatMap(listMd)) {
  if (file === OUT) continue;
  const rel = relative(reqDir, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    // Definition form 1: table row whose first cell is the ID.
    const row = line.match(/^\|\s*((?:FR|NFR|BR|AC|API|EVT)-[A-Z0-9-]+-\d{3})\s*\|(.*)$/);
    // Definition form 2: heading "#### FR-XXX-NNN — Title  [P0 · MVP]".
    const head = line.match(/^#{2,5}\s+((?:FR|NFR|BR|AC|API|EVT)-[A-Z0-9-]+-\d{3})\s+[—-]\s+(.*)$/);
    if (row) {
      const cells = row[2].split('|').map((c) => c.trim()).filter((c, i, a) => i < a.length - 1 || c);
      const pri = cells.find((c) => /^P[0-3]$/.test(c));
      const rel_ = cells.find((c) => /^(MVP|CORE|ADV|FUT)\b/.test(c));
      addDef(row[1], { kind: 'row', file: rel, title: cells[0] ?? '', priority: pri ?? '', release: rel_ ?? '' });
    } else if (head) {
      const m = head[2].match(/\[(P[0-3])\s*·\s*(MVP|CORE|ADV|FUT)\]/);
      addDef(head[1], {
        kind: 'heading',
        file: rel,
        title: head[2].replace(/\s*\[.*\]\s*$/, ''),
        priority: m?.[1] ?? '',
        release: m?.[2] ?? '',
      });
    }
    for (const id of line.match(ID_RE) ?? []) {
      if (!references.has(id)) references.set(id, new Set());
      references.get(id).add(rel);
    }
  }
}

// A heading that elaborates an ID already defined by a table row in the same
// file (e.g. detailed API specs) is a detail section, not a second definition.
for (const [id, defs] of definitions) {
  const rows = defs.filter((d) => d.kind === 'row');
  const kept = defs.filter((d) => d.kind === 'row' || !rows.some((r) => r.file === d.file));
  definitions.set(id, kept);
}
const duplicates = [...definitions].filter(([, defs]) => defs.length > 1);
const dangling = [...references.keys()].filter((id) => !definitions.has(id)).sort();

if (process.argv.includes('--check')) {
  for (const [id, defs] of duplicates) console.error(`DUPLICATE ${id}: ${defs.map((d) => d.file).join(', ')}`);
  for (const id of dangling) console.error(`DANGLING ${id}: referenced in ${[...references.get(id)].join(', ')}`);
  console.log(`${definitions.size} IDs defined, ${duplicates.length} duplicates, ${dangling.length} dangling references`);
  process.exit(duplicates.length || dangling.length ? 1 : 0);
}

const esc = (s) => s.replace(/\|/g, '\\|').slice(0, 110);
let md = `# Requirements Index\n\n> **Generated file — do not edit by hand.** Run \`node docs/tools/requirements-index.mjs\` after changing any SRS file.\n> Lists every requirement-family ID defined in the SRS with its source file, priority and release.\n\n`;
md += `| Family | Defined IDs |\n|---|---|\n`;
for (const f of FAMILIES) {
  md += `| ${f.label} (\`${f.prefix}-*\`) | ${[...definitions.keys()].filter((id) => id.startsWith(f.prefix + '-')).length} |\n`;
}
md += `\nIntegrity: **${duplicates.length}** duplicate definitions, **${dangling.length}** references to undefined IDs.\n`;
if (dangling.length) md += `\nUndefined references (to resolve): ${dangling.map((d) => `\`${d}\``).join(', ')}\n`;

for (const f of FAMILIES) {
  const ids = [...definitions.keys()].filter((id) => id.startsWith(f.prefix + '-')).sort();
  md += `\n## ${f.label}\n\n| ID | Title / summary | Priority | Release | Defined in |\n|---|---|---|---|---|\n`;
  for (const id of ids) {
    const d = definitions.get(id)[0];
    md += `| ${id} | ${esc(d.title)} | ${d.priority} | ${d.release} | [${d.file}](${d.file}) |\n`;
  }
}
writeFileSync(OUT, md);
console.log(`Wrote ${relative(root, OUT)}: ${definitions.size} IDs, ${duplicates.length} duplicates, ${dangling.length} dangling`);
