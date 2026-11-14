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
