import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server.mjs';
import { stubDataSource, stubCoach, openSession } from './helpers.mjs';

let server, base;
before(async () => {
  server = createAppServer({ dataSource: stubDataSource(), coach: stubCoach() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('HTTP serves the entry page and every app/analytics runtime asset', async () => {
  for (const [route, type] of [
    ['/', 'text/html'], ['/app.js', 'text/javascript'], ['/model.js', 'text/javascript'], ['/exploration.js', 'text/javascript'],
    ['/styles.css', 'text/css'], ['/adapters/project-finance.js', 'text/javascript'],
    ['/coach-text.js', 'text/javascript'], ['/insights.js', 'text/javascript'], ['/disclosure.js', 'text/javascript'],
    ['/customer-memory.js', 'text/javascript'], ['/answer-depth.js', 'text/javascript'], ['/summary-depth.js', 'text/javascript'], ['/weekly-plan.js', 'text/javascript'],
    ['/purchase-projects.js', 'text/javascript'], ['/project-ui.js', 'text/javascript'],
    ['/wrapped.js', 'text/javascript'], ['/wrapped.css', 'text/css'], ['/month-picker.js', 'text/javascript'], ['/saving-horizon.js', 'text/javascript'],
    ['/finance-analytics/index.js', 'text/javascript'], ['/finance-analytics/model.js', 'text/javascript'],
    ['/finance-analytics/styles.css', 'text/css'], ['/finance-analytics/example.js', 'text/javascript'],
    ['/finance-analytics/example.html', 'text/html'],
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.ok(response.headers.get('content-type').startsWith(type), route);
    assert.ok((await response.text()).length > 0, route);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  }
  const response = await (await openSession(base)).get('/demo-data.json');
  const data = await response.json();
  assert.equal(data.profiles.length, 1);
  assert.equal(data.profiles[0].customer_id, 'CUST00207');
  assert.equal(data.mortgage, undefined);
  assert.equal(data.history, undefined);
  assert.doesNotMatch(JSON.stringify(data), /CUST00127|CUST00103|CUST04457/);
  assert.equal(data.summary.count, 3626755);
});

test('health/readiness checks work and HEAD matches GET metadata without a body', async () => {
  for (const [route, status] of [['/healthz', 'ok'], ['/readyz', 'ready']]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status });
  }
  const get = await fetch(base + '/?embed=1');
  const head = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
  assert.equal(await head.text(), '');
  await get.arrayBuffer();
});

test('readiness fails when the runtime package is incomplete', async () => {
  const incomplete = createAppServer({ dataSource: stubDataSource(), coach: stubCoach(), publicRoot: fileURLToPath(new URL('../archive/', import.meta.url)) });
  incomplete.listen(0, '127.0.0.1');
  await once(incomplete, 'listening');
  try {
    const url = `http://127.0.0.1:${incomplete.address().port}`;
    assert.equal((await fetch(url + '/healthz')).status, 200);
    assert.equal((await fetch(url + '/readyz')).status, 503);
  } finally {
    incomplete.closeAllConnections();
    await new Promise(resolve => incomplete.close(resolve));
  }
});

test('source files, hidden files and invalid paths are not exposed over HTTP', async () => {
  for (const route of ['/server.mjs', '/package.json', '/Dockerfile', '/deploy/cloud-run.psd1', '/archive/five-concepts/app.js', '/.env', '/.git/config', '/%2e%2e%5cserver.mjs', '/%00.json', '/%ZZ']) {
    const response = await fetch(base + route);
    assert.ok([400, 403, 404].includes(response.status), route);
    await response.arrayBuffer();
  }
  // Use raw http so a client URL parser cannot normalize away encoded traversal.
  const code = await new Promise((resolve, reject) => {
    http.get(base + '/%2e%2e%2fserver.mjs', response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(code, 403);
});

test('static service rejects mutations instead of pretending to accept chat requests', async () => {
  const response = await fetch(base + '/v1/chat', { method: 'POST', body: '{}' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('AI summary routes forward validated depth without accepting customer overrides', async () => {
  const selected = await openSession(base);
  for (const level of ['simple', 'standard', 'detailed']) {
    for (const route of [`/api/insights?level=${level}&retry=1`, `/api/summaries?topic=spending&month=2026-09&level=${level}`]) {
      const response = await selected.get(route);
      assert.equal(response.status, 200, route);
      const body = await response.json();
      assert.equal(body.level, level);
      assert.equal(body.customer_id, selected.customer_id);
      assert.equal(body.selection_id, selected.selection_id);
    }
  }
  assert.equal((await (await selected.get('/api/insights')).json()).level, 'standard');
  for (const query of ['level=', 'level=unknown', 'level=__proto__', 'level=simple&level=detailed', 'customer_id=CUST00127&level=simple']) {
    for (const route of [`/api/insights?${query}`, `/api/summaries?topic=week&${query}`]) {
      assert.equal((await selected.get(route)).status, 400, route);
    }
  }
  for (const query of ['retry=0', 'retry=1&retry=1']) assert.equal((await selected.get('/api/insights?' + query)).status, 400);
  for (const route of ['/demo-data.json?level=simple', '/wrapped-data.json?level=simple']) {
    assert.equal((await selected.get(route)).status, 400, route);
  }
  assert.equal((await fetch(base + '/api/insights?level=simple')).status, 401);
  assert.equal((await selected.get('/api/insights?level=simple', { 'X-Demo-Selection': 'stale' })).status, 409);
});
