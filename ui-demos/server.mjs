import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatHandler } from './chat.mjs';
import { createInsightStore, DEMO_CUSTOMERS } from './insights.mjs';
const defaultRoot = fileURLToPath(new URL('./public/', import.meta.url));
const requiredFiles = ['index.html', 'app.js', 'chat.js', 'model.js', 'styles.css',
  'wrapped.js', 'wrapped.css',
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

export function createAppServer({ publicRoot = defaultRoot, chatOptions, insightStore = createInsightStore(),
  customerId = process.env.PUBLIC_DEMO_CUSTOMER_ID || 'CUST00207' } = {}) {
  if (!DEMO_CUSTOMERS.includes(customerId)) throw new Error('Only an allowlisted synthetic demo customer may be public');
  const root = path.resolve(publicRoot);
  const chat = createChatHandler({ ...chatOptions, insightContext: id => insightStore.context(customerId, id) });
  let customerData;
  async function scopedData() {
    if (!customerData) customerData = fs.readFile(new URL('./server-data/demo-data.json', import.meta.url), 'utf8').then(JSON.parse).then(data => {
      const selected = data.profiles.find(profile => profile.customer_id === customerId);
      if (!selected) throw new Error('Configured demo customer not found');
      // Do not include the other profiles, mortgage or negotiation records from the source bundle.
      return { summary: data.summary, profiles: [selected] };
    }).catch(error => { customerData = undefined; throw error; });
    return customerData;
  }
  let wrappedData;
  async function scopedWrapped() {
    if (!wrappedData) wrappedData = fs.readFile(new URL('./server-data/wrapped-data.json', import.meta.url), 'utf8').then(JSON.parse).then(data => {
      const selected = data.recaps[customerId];
      if (!selected?.length) throw new Error('Configured demo recap not found');
      return { period: data.period, recaps: { [customerId]: selected } };
    }).catch(error => { wrappedData = undefined; throw error; });
    return wrappedData;
  }
  async function ready() {
    if (!await insightStore.cards(customerId)) throw new Error('Configured demo insights missing');
    await scopedData();
    await scopedWrapped();
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
    if (route === '/api/insights' || route === '/demo-data.json' || route === '/wrapped-data.json') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      try {
        if (query.size !== 0) {
          send(400, JSON.stringify({ error: 'Asiakasta ei voi vaihtaa pyynnössä.' }), 'application/json'); return;
        }
        const cards = route === '/demo-data.json' ? await scopedData() :
          route === '/wrapped-data.json' ? await scopedWrapped() : await insightStore.cards(customerId);
        send(cards ? 200 : 404, JSON.stringify(cards || { error: 'Demoasiakasta ei löydy.' }), 'application/json', { 'Cache-Control': 'no-store' });
      } catch { send(503, JSON.stringify({ error: 'Havainnot eivät latautuneet. Yritä uudelleen.' }), 'application/json'); }
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
