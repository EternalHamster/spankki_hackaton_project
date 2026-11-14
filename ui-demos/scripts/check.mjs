import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function files(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const sources = ['server.mjs', 'chat.mjs', 'scripts/check.mjs', ...files('public'), ...files('tests')].filter(file => /\.(m?js)$/.test(file));
for (const file of sources) run(['--check', file]);
run(['--test', ...files('tests').filter(file => file.endsWith('.test.mjs')).sort()]);
console.log('Syntax, financial calculations and HTTP integration checks passed.');
