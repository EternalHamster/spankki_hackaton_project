import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatHandler } from './chat.mjs';
const defaultRoot = fileURLToPath(new URL('./public/', import.meta.url));
const requiredFiles = ['index.html', 'app.js', 'chat.js', 'model.js', 'styles.css', 'demo-data.json',
  'wrapped.js', 'wrapped.css', 'wrapped-data.json',
  'adapters/project-finance.js', 'finance-analytics/index.js', 'finance-analytics/model.js', 'finance-analytics/styles.css'];
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.ts': 'text/plain; charset=utf-8' };
const headers = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
};
const log = (severity, message) => console.log(JSON.stringify({ severity, message }));

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

export function createAppServer({ publicRoot = defaultRoot, chatOptions } = {}) {
  const root = path.resolve(publicRoot);
  const chat = createChatHandler(chatOptions);
  async function ready() {
    await Promise.all(requiredFiles.map(async file => {
      const stat = await fs.stat(path.join(root, file));
      if (!stat.isFile()) throw new Error('Missing runtime file');
    }));
  }
  return http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
      res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    let route;
    try { route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { send(400, 'Bad request'); return; }
    if (route === '/api/chat') {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      await chat(req, res);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      req.resume();
      send(405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' });
      return;
    }
    if (route.includes('\\') || route.includes('\0') || route.split('/').some(part => part.startsWith('.'))) {
      send(403, 'Forbidden'); return;
    }
    if (route === '/healthz' || route === '/readyz') {
      try {
        if (route === '/readyz') await ready();
        send(200, JSON.stringify({ status: route === '/readyz' ? 'ready' : 'ok' }), 'application/json');
      } catch { send(503, JSON.stringify({ status: 'unavailable' }), 'application/json'); }
      return;
    }
    const file = path.resolve(root, '.' + (route === '/' ? '/index.html' : route));
    if (!within(root, file)) { send(403, 'Forbidden'); return; }
    try {
      // Resolve symlinks as well as URL traversal before reading any public file.
      const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
      if (!within(realRoot, realFile)) { send(403, 'Forbidden'); return; }
      const type = mime[path.extname(realFile)];
      if (!type || !(await fs.stat(realFile)).isFile()) { send(404, 'Not found'); return; }
      send(200, await fs.readFile(realFile), type);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) send(404, 'Not found');
      else if (error.code === 'EACCES') send(403, 'Forbidden');
      else { log('ERROR', 'Static request failed'); send(500, 'Internal server error'); }
    }
  });
}

export async function startServer() {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const server = createAppServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  log('INFO', `Oma talous listening on ${host}:${port}`);
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    log('INFO', 'Shutting down');
    // Cloud Run allows ten seconds after SIGTERM; leave time for the process to exit.
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 8000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); process.exit(0); });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch(error => { log('ERROR', error.message); process.exitCode = 1; });
}
