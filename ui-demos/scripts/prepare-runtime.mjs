import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = fileURLToPath(new URL('../', import.meta.url)), repo = path.resolve(ui, '..');
const target = path.join(ui, '.runtime');
const inputs = ['coach_context/__init__.py', 'coach_context/profile_card.py', 'coach_context/insight_context.py',
  'BDA/engine/config.py', 'BDA/output/coach.duckdb'];
const database = path.join(repo, 'BDA/output/coach.duckdb');
if ((await fs.stat(database)).size < 1000000) throw new Error('Fetch the DuckDB snapshot with git lfs pull before deployment.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(database)) hash.update(chunk);
for (const file of inputs) {
  const to = path.join(target, file);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(path.join(repo, file), to);
}
const manifest = { snapshot_sha256: hash.digest('hex'), files: inputs };
await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ message: 'Prepared private DuckDB runtime', ...manifest }));
