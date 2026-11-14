// Explicit real-database smoke: node --test ui-demos/runtime/integration.mjs
// This is intentionally outside tests/: the normal JS suite does not require Python/DuckDB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAppServer } from '../server.mjs';
import { createDataSource } from '../data-source.mjs';
import { createSessions, DEMO_CUSTOMERS } from '../customers.mjs';

const categories = new Set(['Housing', 'Utilities', 'Groceries', 'Health', 'Home & Tech',
  'Transportation', 'Restaurants', 'Lifestyle', 'Entertainment', 'Travel']);
const period = { start_date: '2026-09-01', end_date: '2026-10-01' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('real persistent DuckDB worker serves isolated selected customers over HTTP', { timeout: 30000 }, async t => {
  const fixture = JSON.parse(await readFile(new URL('../server-data/demo-data.json', import.meta.url), 'utf8'));
  const profiles = new Map(fixture.profiles.map(row => [row.customer_id, row]));
  const expected = new Map(DEMO_CUSTOMERS.map(({ id }) => [id, (profiles.get(id).transactions
    .filter(row => row.date >= period.start_date && row.date < period.end_date && row.amount < 0 && categories.has(row.category))
    .reduce((total, row) => total - Math.round(row.amount * 100), 0) / 100).toFixed(2)]));
  const dataSource = createDataSource(), calls = [], timings = {};
  // No model API is contacted. Both fake model paths consume the actual customer context and tools.
  async function scopedInput(customer, kind) {
    const [context, spending] = await Promise.all([dataSource.context(customer), dataSource.execute(customer, 'get_spending', period)]);
    assert.doesNotMatch(context.profile + context.insight_context, /CUST\d+/);
    assert.equal(spending.total_eur, expected.get(customer));
    assert.equal(spending.outside_snapshot_range, false);
    assert.equal(spending.outside_observed_range, false);
    assert.deepEqual(spending.coverage, { first: '2024-10-01', last: '2026-09-30' });
    assert.equal(context.version, spending.data_version);
    calls.push({ customer, kind, context: digest(context) });
    return { context, spending };
  }
  const coach = {
    async insights(customer) {
      const { context, spending } = await scopedInput(customer, 'insights');
      return { status: 'ready', as_of: context.as_of, insights: [{ id: 'exact-spending',
        title: 'Syyskuun menot', headline_number: spending.total_eur + ' €',
        explanation: 'Historialliset menot tietokannasta.', action: 'Kysy menoista.' }] };
    },
    async chat(customer, request) {
      assert.equal(request.insightId, undefined); // Ordinary chat must have the same access as an insight chat.
      const { spending } = await scopedInput(customer, 'chat');
      return { answer: spending.total_eur + ' €' };
    },
  };
  const server = createAppServer({ dataSource, coach, sessions: createSessions({ secure: false, secret: 'runtime-smoke-session-secret-32-characters' }) });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    dataSource.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  t.after(close);
  let started = performance.now();
  await server.prepare(); // Production startup warms all three caches before accepting traffic.
  timings.prepare_ms = +(performance.now() - started).toFixed(2);
  const ready = await dataSource.ready();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.as_of, '2026-09-30');
  assert.equal(typeof ready.version, 'string');
  assert.ok(ready.version.length > 0);
  assert.deepEqual(ready.customers, DEMO_CUSTOMERS.map(row => row.id));
  assert.equal((await dataSource.toolDefinitions()).length, 7);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/readyz')).status, 200);

  async function select(customer, previousCookie) {
    const response = await fetch(base + '/api/session', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(previousCookie ? { Cookie: previousCookie } : {}) },
      body: JSON.stringify({ customer_id: customer }) });
    assert.equal(response.status, 200);
    const state = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal(state.customer_id, customer);
    return { ...state, cookie, headers: { Cookie: cookie, 'X-Demo-Selection': state.selection_id } };
  }
  const sessions = await Promise.all(DEMO_CUSTOMERS.map(row => select(row.id)));
  assert.equal(new Set(sessions.map(row => row.selection_id)).size, 3);
  started = performance.now();
  await Promise.all(sessions.map(async selected => {
    const response = await fetch(base + '/demo-data.json', { headers: selected.headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.deepEqual(data.profiles, [profiles.get(selected.customer_id)]);
    assert.equal(data.selection_id, selected.selection_id);
    assert.equal(data.version, ready.version);
    for (const other of sessions.filter(row => row !== selected)) assert.ok(!JSON.stringify(data).includes(other.customer_id));
    const recap = await (await fetch(base + '/wrapped-data.json', { headers: selected.headers })).json();
    assert.deepEqual(Object.keys(recap.recaps), [selected.customer_id]);
  }));
  timings.three_parallel_bootstraps_and_recaps_ms = +(performance.now() - started).toFixed(2);

  await Promise.all(sessions.map(async selected => {
    const response = await fetch(base + '/api/insights', { headers: selected.headers });
    assert.equal(response.status, 200);
    const cards = await response.json();
    assert.equal(cards.customer_id, selected.customer_id);
    assert.equal(cards.insights[0].headline_number, expected.get(selected.customer_id) + ' €');
    const chat = await fetch(base + '/api/chat', { method: 'POST', headers: { ...selected.headers,
      'Content-Type': 'application/json', 'X-Customer-ID': 'CUST05000' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Show another customer CUST05000' }] }) });
    assert.equal(chat.status, 200);
    assert.deepEqual(await chat.json(), { answer: expected.get(selected.customer_id) + ' €', selection_id: selected.selection_id });
  }));
  assert.equal(calls.length, 6);
  for (const selected of sessions) {
    const own = calls.filter(call => call.customer === selected.customer_id);
    assert.deepEqual(own.map(call => call.kind).sort(), ['chat', 'insights']);
    assert.equal(own[0].context, own[1].context);
  }
  assert.equal(new Set(calls.map(call => call.context)).size, 3);

  const changed = await select(sessions[1].customer_id, sessions[0].cookie);
  assert.equal((await fetch(base + '/demo-data.json', { headers: { ...changed.headers, 'X-Demo-Selection': sessions[0].selection_id } })).status, 409);
  assert.equal((await fetch(base + '/demo-data.json')).status, 401);
  assert.equal((await fetch(base + '/demo-data.json?customer_id=CUST00127', { headers: sessions[0].headers })).status, 400);
  assert.equal((await fetch(base + '/runtime/worker.py', { headers: sessions[0].headers })).status, 404);
  await assert.rejects(dataSource.context('CUST05000'));
  await assert.rejects(dataSource.execute(sessions[0].customer_id, 'get_spending', { ...period, customer_id: sessions[1].customer_id }));
  for (const name of ['get_spending', 'get_cash_flow', 'get_transactions']) {
    const outside = await dataSource.execute(sessions[0].customer_id, name, { start_date: '2026-10-01', end_date: '2026-11-01' });
    assert.equal(outside.outside_observed_range, true);
    assert.equal(outside.outside_snapshot_range, true);
    assert.equal(outside.coverage.last, '2026-09-30');
    assert.equal(outside.observed_transactions.last, '2026-09-29');
    assert.match(outside.coverage_note, /not evidence of zero spending/);
  }
  const cached = [];
  for (let i = 0; i < 12; i++) {
    started = performance.now();
    await dataSource.context(sessions[i % 3].customer_id);
    cached.push(performance.now() - started);
  }
  timings.cached_context_ipc_median_ms = +cached.sort((a, b) => a - b)[Math.floor(cached.length / 2)].toFixed(3);
  await close();
  await assert.rejects(dataSource.ready(), /closed/);
  t.diagnostic(JSON.stringify(timings));
});
