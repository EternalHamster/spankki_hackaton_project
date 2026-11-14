import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatHandler } from './chat.mjs';
import { createDataSource } from './data-source.mjs';
import { createCoach } from './coach.mjs';
import { createPreparedCoach } from './prepared.mjs';
import { createSessions, DEMO_CUSTOMERS, isDemoCustomer, sameOrigin } from './customers.mjs';
const defaultRoot = fileURLToPath(new URL('./public/', import.meta.url));
const requiredFiles = ['index.html', 'app.js', 'chat.js', 'coach-text.js', 'insights.js', 'exploration.js', 'model.js', 'styles.css',
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

export function createAppServer({ publicRoot = defaultRoot, chatOptions = {}, dataSource = createDataSource(), coach,
  sessions = createSessions(), customerId = process.env.PUBLIC_DEMO_CUSTOMER_ID || 'CUST00207' } = {}) {
  if (!isDemoCustomer(customerId)) throw new Error('Only an allowlisted synthetic demo customer may be public');
  const root = path.resolve(publicRoot);
  const model = coach || createPreparedCoach({ dataSource, coach: createCoach({ dataSource, ...chatOptions }) });
  const chat = createChatHandler({ ...chatOptions, answer: (session, messages, insight, level) =>
    model.chat(session.customer_id, { messages, insightId: insight?.insight_id, level }) });
  let wrappedData;
  async function scopedWrapped(id) {
    if (!wrappedData) wrappedData = fs.readFile(new URL('./server-data/wrapped-data.json', import.meta.url), 'utf8').then(JSON.parse)
      .catch(error => { wrappedData = undefined; throw error; });
    const data = await wrappedData, selected = data.recaps[id];
    if (!selected?.length) throw new Error('Configured demo recap not found');
    return { period: data.period, recaps: { [id]: selected } };
  }
  async function ready() {
    await dataSource.ready();
    await model.ready?.();
    await scopedWrapped(customerId);
    await Promise.all(requiredFiles.map(async file => {
      const stat = await fs.stat(path.join(root, file));
      if (!stat.isFile()) throw new Error('Missing runtime file');
    }));
  }
  const server = http.createServer({ requestTimeout: 120000, headersTimeout: 10000 }, async (req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
      res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    let route, url;
    try { url = new URL(req.url, 'http://localhost'); route = decodeURIComponent(url.pathname); }
    catch { send(400, 'Bad request'); return; }
    const json = (status, body, extra = {}) => send(status, JSON.stringify(body), 'application/json; charset=utf-8',
      { 'Cache-Control': 'no-store', Vary: 'Cookie, X-Demo-Selection', ...extra });
    const customerRoute = ['/api/session', '/api/insights', '/api/summaries', '/api/chat', '/demo-data.json', '/wrapped-data.json'].includes(route);
    if (customerRoute && !sameOrigin(req)) { req.resume(); json(403, { error: 'Avaa palvelu sovelluksesta.' }); return; }
    if (route === '/api/session') {
      if (!['GET', 'POST'].includes(req.method)) { req.resume(); json(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' }); return; }
      if (url.search) { json(400, { error: 'Virheellinen pyyntö.' }); return; }
      try {
        let selected = sessions.read(req);
        if (req.method === 'POST') {
          if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { req.resume(); json(415, { error: 'Use JSON' }); return; }
          let body = '', bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024) { json(413, { error: 'Request too large' }); return; } body += chunk.toString('utf8'); }
          let parsed; try { parsed = JSON.parse(body); } catch { json(400, { error: 'Virheellinen asiakasvalinta.' }); return; }
          if (!parsed || Object.keys(parsed).length !== 1 || !isDemoCustomer(parsed.customer_id)) { json(400, { error: 'Valitse demoasiakas listalta.' }); return; }
          selected = sessions.create(parsed.customer_id, res);
        } else if (!selected) selected = sessions.create(customerId, res);
        const { as_of } = await dataSource.ready();
        json(200, { customer_id: selected.customer_id, selection_id: selected.selection_id, customers: DEMO_CUSTOMERS, as_of });
      } catch { json(503, { error: 'Asiakkaan tiedot eivät juuri nyt lataudu.' }); }
      return;
    }
    if (customerRoute) {
      const selected = sessions.read(req);
      if (!selected) { req.resume(); json(401, { error: 'Avaa demoasiakas ensin.' }); return; }
      if (req.headers['x-demo-selection'] !== selected.selection_id) { req.resume(); json(409, { error: 'Asiakas vaihtui. Avaa näkymä uudelleen.' }); return; }
      req.demoSession = selected;
    }
    if (route === '/api/chat') {
      if (url.search) { req.resume(); json(400, { error: 'Virheellinen pyyntö.' }); return; }
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.setHeader('Vary', 'Cookie, X-Demo-Selection');
      await chat(req, res);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      req.resume();
      send(405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' });
      return;
    }
    if (route === '/api/summaries') {
      try {
        const keys = [...url.searchParams.keys()];
        if (keys.some(key => !['topic', 'month'].includes(key)) || new Set(keys).size !== keys.length) {
          json(400, { error: 'Virheellinen pyyntö.' }); return;
        }
        const selected = req.demoSession;
        const result = await model.summary(selected.customer_id, { topic: url.searchParams.get('topic'),
          month: url.searchParams.has('month') ? url.searchParams.get('month') : undefined });
        json(200, { ...result, customer_id: selected.customer_id, selection_id: selected.selection_id });
      } catch (error) { json(error.status || 503, { error: error.status ? error.message : 'Vastaus ei latautunut. Yritä uudelleen.' }); }
      return;
    }
    if (route === '/api/insights' || route === '/demo-data.json' || route === '/wrapped-data.json') {
      try {
        const allowedRetry = route === '/api/insights' && url.search === '?retry=1';
        if (url.search && !allowedRetry) {
          json(400, { error: 'Asiakasta ei voi vaihtaa pyynnössä.' }); return;
        }
        const selected = req.demoSession;
        const result = route === '/demo-data.json' ? await dataSource.bootstrap(selected.customer_id) :
          route === '/wrapped-data.json' ? await scopedWrapped(selected.customer_id) :
          // Prepared content is checked against the database and prompt version before serving.
          await model.insights(selected.customer_id, { retry: allowedRetry });
        json(result.status === 'generating' ? 202 : 200, { ...result, customer_id: selected.customer_id,
          selection_id: selected.selection_id, ...(result.status === 'generating' ? { retry_after_ms: 1000 } : {}) });
      } catch (error) { json(error.status || 503, { error: error.status ? error.message : 'Tiedot eivät latautuneet. Yritä uudelleen.' }); }
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
  server.once('close', () => dataSource.close?.());
  server.prepare = async () => {
    try { await dataSource.warm?.(); await ready(); }
    catch (error) { dataSource.close?.(); throw error; }
  };
  return server;
}

export async function startServer() {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const server = createAppServer();
  await server.prepare();
  await new Promise((resolve, reject) => {
    server.once('error', error => { server.close(); reject(error); });
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
