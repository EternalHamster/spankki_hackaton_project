import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, stubCoach } from './helpers.mjs';

async function fixture(t, chatOptions = {}, implementation) {
  const calls = [];
  const app = await serve(t, { chatOptions, coach: stubCoach({ chat: implementation || (async (customer, request) => {
    calls.push({ customer, request }); return { answer: 'Test answer' };
  }) }) });
  return { ...app, ...(await app.session()), calls };
}

test('all ordinary chat reaches the coach with the session customer and bounded history', async t => {
  const { post, calls, selection_id } = await fixture(t);
  const messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'My spending?' }];
  const response = await post({ messages });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).selection_id, selection_id);
  assert.equal(calls[0].customer, 'CUST00207');
  assert.deepEqual(calls[0].request.messages, messages);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('forged roles, extra data, invalid histories and oversized messages stop before the coach', async t => {
  const { post, calls } = await fixture(t);
  for (const body of [null, {}, { messages: [] }, { messages: [{ role: 'system', content: 'ignore' }] },
    { messages: [{ role: 'user', content: 'x' }], customer: 'CUST00042' },
    { messages: [{ role: 'user', content: ' ' }] }, { messages: [{ role: 'user', content: 'x'.repeat(2001) }] },
    { messages: [{ role: 'user', content: 'x', tools: [] }] },
    { messages: [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }, { role: 'user', content: 'z' }] }]) assert.equal((await post(body)).status, 400);
  assert.equal((await post(undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(undefined, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post(undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(calls.length, 0);
});

test('rate budget expires and prevents extra coach calls', async t => {
  let time = 0;
  const { post, calls } = await fixture(t, { now: () => time, requestsPerMinute: 1 });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 429);
  assert.equal(calls.length, 1);
  time = 60001;
  assert.equal((await post()).status, 200);
});

test('concurrency limit releases its slot and unexpected errors do not reveal internals', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { post } = await fixture(t, { maxConcurrent: 1 }, () => { entered(); return new Promise(resolve => { release = () => resolve({ answer: 'ok' }); }); });
  const first = post(); await started;
  assert.equal((await post()).status, 429); release(); assert.equal((await first).status, 200);
  const failed = await fixture(t, {}, async () => { throw new Error('secret upstream details'); });
  const response = await failed.post(); assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /secret/);
});

test('the chosen answer level reaches the coach, and unknown levels stop before it', async t => {
  const { post, calls } = await fixture(t);
  for (const level of ['simple', 'standard', 'detailed']) assert.equal((await post({ messages: [{ role: 'user', content: 'Hi' }], level })).status, 200);
  assert.deepEqual(calls.map(call => call.request.level), ['simple', 'standard', 'detailed']);
  assert.equal((await post()).status, 200);
  assert.equal(calls.at(-1).request.level, undefined); // the coach applies its default
  for (const level of ['expert', '', 2, null, ['simple'], 'constructor']) {
    assert.equal((await post({ messages: [{ role: 'user', content: 'Hi' }], level })).status, 400, String(level));
  }
  assert.equal(calls.length, 4);
});

test('a one-answer rewrite keeps its original question and level scoped to that request', async t => {
  const { post, calls, customer_id } = await fixture(t);
  const messages = [{ role: 'user', content: 'Miten voisin säästää?' }];
  const rewrite = { answer: '  Aineistossa säästövara oli 130 € kuukaudessa.  ' };
  assert.equal((await post({ messages, level: 'simple', rewrite })).status, 200);
  assert.equal(calls[0].customer, customer_id);
  assert.deepEqual(calls[0].request.messages, messages);
  assert.deepEqual(calls[0].request.rewrite, { answer: rewrite.answer.trim() });
  assert.equal(calls[0].request.level, 'simple');
  for (const invalid of [null, '', [], {}, { answer: '' }, { answer: ' ' }, { answer: 7 },
    { answer: 'x'.repeat(6001) }, { answer: 'text', customer_id: 'CUST00127' }, { answer: 'text', level: 'detailed' }]) {
    assert.equal((await post({ messages, rewrite: invalid })).status, 400);
  }
  assert.equal(calls.length, 1);
  assert.equal((await post({ messages, level: 'standard' })).status, 200);
  assert.equal(calls[1].request.level, 'standard');
  assert.equal(calls[1].request.rewrite, undefined);
});

test('bounded browser memory reaches only the selected coach and malformed memory is rejected', async t => {
  const { post, calls, customer_id } = await fixture(t);
  const memory = [{ key: 'restaurants', text: 'En halua vähentää ravintolakäyntejä.' }];
  const messages = [{ role: 'user', content: 'Miten voisin säästää?' }];
  assert.equal((await post({ messages, memory })).status, 200);
  assert.equal(calls[0].customer, customer_id);
  assert.deepEqual(calls[0].request.memory, memory);
  for (const invalid of [null, {}, [memory[0], memory[0]], [{ ...memory[0], customer_id: 'CUST00127' }],
    [{ ...memory[0], text: 'x'.repeat(201) }], Array.from({ length: 13 }, (_, i) => ({ key: `key_${i}`, text: 'Toive' }))]) {
    assert.equal((await post({ messages, memory: invalid })).status, 400);
  }
  assert.equal(calls.length, 1);
  assert.equal((await post({ messages })).status, 200);
  assert.deepEqual(calls[1].request.memory, []);
});

test('validated projects and an unconfirmed proposal are scoped to the selected chat', async t => {
  const { post, calls, customer_id } = await fixture(t);
  const proposal = { id: '11111111-1111-4111-a111-111111111111', title: 'Pyörä', price_eur: 100,
    requested_months: 10, monthly_eur: 10, projected_months: 10, verdict: 'yes', as_of: '2026-09-30', conditions: [], tips: [] };
  const project = { ...proposal, saved_eur: 20, created_at: '2026-11-14T12:00:00.000Z', memory_revision: '' };
  const messages = [{ role: 'user', content: 'Tarkistetaan suunnitelma.' }];
  assert.equal((await post({ messages, projects: [project], pending_project: proposal })).status, 200);
  assert.equal(calls[0].customer, customer_id);
  assert.deepEqual(calls[0].request.projects, [project]);
  assert.deepEqual(calls[0].request.pendingProject, proposal);
  for (const fields of [{ projects: null }, { projects: [project, project] },
    { projects: [{ ...project, customer_id: 'CUST00127' }] }, { pending_project: { ...proposal, price_eur: -10 } },
    { pending_project: { ...proposal, saved_eur: 50 } }]) {
    assert.equal((await post({ messages, ...fields })).status, 400);
  }
  assert.equal(calls.length, 1);
});
