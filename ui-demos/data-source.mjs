import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDemoCustomer, DEMO_CUSTOMERS } from './customers.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
function interpreter() {
  if (process.env.COACH_PYTHON) return process.env.COACH_PYTHON;
  const local = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3';
}

export function createDataSource({ python = interpreter(), worker = path.join(root, 'runtime/worker.py'),
  env = process.env, timeoutMs = 20000 } = {}) {
  let child, lines, sequence = 0, closed = false;
  const pending = new Map();
  function failAll() {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Customer data service unavailable')); }
    pending.clear();
  }
  function start() {
    if (closed) throw new Error('Customer data service closed');
    if (child) return child;
    const processHandle = spawn(python, ['-u', worker], { cwd: root, env: { ...env, PYTHONUTF8: '1' }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    child = processHandle;
    lines = createInterface({ input: processHandle.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { processHandle.kill(); return; }
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.error) {
        const invalid = message.error.code === 'invalid_request';
        const error = new Error(invalid ? message.error.message : 'Customer data unavailable');
        if (invalid) error.code = 'invalid_request';
        task.reject(error);
      }
      else task.resolve(message.result);
    });
    // Never forward raw worker output: an exception might contain a row or filesystem path.
    processHandle.stderr.on('data', () => {});
    processHandle.stdin.on('error', () => { if (child === processHandle) { processHandle.kill(); failAll(); } });
    processHandle.on('error', () => { if (child === processHandle) { child = null; failAll(); } });
    processHandle.on('exit', () => {
      if (child === processHandle) { child = null; lines?.close(); failAll(); }
    });
    return processHandle;
  }
  function call(operation, customerId, args = {}) {
    if (customerId !== undefined && !isDemoCustomer(customerId)) return Promise.reject(new Error('Unknown demo customer'));
    if (pending.size >= 48) return Promise.reject(new Error('Customer data service busy'));
    return new Promise((resolve, reject) => {
      const processHandle = start(), id = ++sequence;
      const timer = setTimeout(() => { processHandle.kill(); failAll(); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      processHandle.stdin.write(JSON.stringify({ id, operation, ...(customerId ? { customer_id: customerId } : {}), args }) + '\n', error => {
        if (error) { processHandle.kill(); failAll(); }
      });
    });
  }
  return {
    ready: () => call('ready'),
    bootstrap: customer => call('bootstrap', customer),
    context: customer => call('context', customer),
    toolDefinitions: () => call('tools'),
    execute: (customer, name, args) => call('tool', customer, { name, arguments: args }),
    purchasePlan: (customer, args) => call('purchase_plan', customer, args),
    async warm() { await call('ready'); for (const { id } of DEMO_CUSTOMERS) { await call('context', id); await call('bootstrap', id); } },
    close() { closed = true; child?.kill(); failAll(); },
  };
}
