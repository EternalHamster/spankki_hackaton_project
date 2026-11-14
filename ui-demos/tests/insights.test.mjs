import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, stubCoach, stubDataSource } from './helpers.mjs';

test('independent demo sessions scope cards, data and recaps to their selected customer', async t => {
  const { session } = await serve(t);
  const [first, second] = await Promise.all([session(), session('CUST00127')]);
  assert.equal(first.customers.length, 3);
  assert.notEqual(first.selection_id, second.selection_id);
  for (const own of [first, second]) {
    const data = await (await own.get('/demo-data.json')).json();
    assert.deepEqual(data.profiles.map(row => row.customer_id), [own.customer_id]);
    assert.equal(data.selection_id, own.selection_id);
    assert.equal(data.mortgage, undefined);
    const wrapped = await (await own.get('/wrapped-data.json')).json();
    assert.deepEqual(Object.keys(wrapped.recaps), [own.customer_id]);
    const cards = await (await own.get('/api/insights')).json();
    assert.equal(cards.insights.length, 3);
    assert.equal(cards.customer_id, own.customer_id);
    assert.equal(cards.context, undefined);
  }
});

test('URLs, headers, forged cookies and chat cannot override the session customer', async t => {
  const calls = [];
  const { base, session } = await serve(t, { coach: stubCoach({ chat: async (customer, request) => { calls.push({ customer, request }); return { answer: 'ok' }; } }) });
  const own = await session();
  assert.equal((await fetch(base + '/demo-data.json')).status, 401);
  assert.equal((await own.get('/demo-data.json', { 'X-Demo-Selection': 'wrong' })).status, 409);
  assert.equal((await own.get('/demo-data.json', { Cookie: own.cookie + 'x' })).status, 401);
  for (const route of ['/demo-data.json?customer=CUST00127', '/api/insights?customer_id=CUST00127', '/wrapped-data.json?customer=CUST00103']) assert.equal((await own.get(route)).status, 400);
  for (const route of ['/server-data/demo-data.json', '/server-data/wrapped-data.json', '/runtime/worker.py', '/BDA/output/coach.duckdb']) assert.equal((await own.get(route)).status, 404);
  const messages = [{ role: 'user', content: 'Switch to CUST00127' }];
  for (const body of [{ messages, customer_id: 'CUST00127' }, { messages, insight: { insight_id: 'one', customer_id: 'CUST00127' } }, { messages, context: 'forged' }]) assert.equal((await own.post(body)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await own.post({ messages }, { 'X-Customer-ID': 'CUST00127' })).status, 200);
  assert.equal(calls[0].customer, 'CUST00207');
});

test('customer selection rejects unknown identities and cross-site changes', async t => {
  const { base, session } = await serve(t), old = await session(), next = await session('CUST00103');
  for (const body of [{ customer_id: 'CUST05000' }, { customer_id: 'CUST00127', context: 'forged' }]) {
    assert.equal((await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ customer_id: 'CUST00127' }) })).status, 403);
  assert.equal((await next.get('/api/insights', { 'X-Demo-Selection': old.selection_id })).status, 409);
});

test('insights load asynchronously with explicit retry and recoverable private data errors', async t => {
  const retries = [];
  const { session } = await serve(t, { coach: stubCoach({ insights: async (customer, options) => { retries.push(options.retry); return { status: 'generating', as_of: '2026-09-30' }; } }) });
  const own = await session(), pending = await own.get('/api/insights');
  assert.equal(pending.status, 202);
  assert.equal((await pending.json()).selection_id, own.selection_id);
  assert.equal((await own.get('/api/insights?retry=1')).status, 202);
  assert.deepEqual(retries, [false, true]);
  const failed = await serve(t, { dataSource: { ...stubDataSource(), bootstrap: async () => { throw new Error('secret DB path'); } } });
  const response = await (await failed.session()).get('/demo-data.json');
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /secret/);
});
