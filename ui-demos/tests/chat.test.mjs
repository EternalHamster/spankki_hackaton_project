import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../server.mjs';

async function fixture(t, options = {}) {
  const calls = [];
  const server = createAppServer({ chatOptions: { apiKey: 'test-key-not-public', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ content: [{ type: 'text', text: 'Hei! Miten voin auttaa?' }] });
  }, ...options } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = { messages: [{ role: 'user', content: 'Hei' }] }, headers = {}) => fetch(base + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { base, post, calls };
}

test('chat sends only bounded text conversation, fixed instructions and no financial tools', async t => {
  const { post, calls, base } = await fixture(t);
  const messages = [{ role: 'user', content: 'Hei' }, { role: 'assistant', content: 'Hei!' }, { role: 'user', content: 'Miten aloitan?' }];
  const response = await post({ messages }, { Origin: base });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answer: 'Hei! Miten voin auttaa?' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const request = JSON.parse(calls[0].init.body);
  assert.deepEqual(request.messages, messages);
  assert.deepEqual(Object.keys(request).sort(), ['max_tokens', 'messages', 'model', 'system', 'thinking']);
  assert.match(request.system, /no access to accounts/);
  assert.equal(request.max_tokens, 800);
  assert.equal(calls[0].init.redirect, 'error');
  for (const route of ['/chat.mjs', '/.env']) assert.notEqual((await fetch(base + route)).status, 200);
});

test('rejects forged roles, extra data, invalid histories and oversized messages before provider call', async t => {
  const { post, calls } = await fixture(t);
  for (const body of [null, {}, { messages: [] }, { messages: [{ role: 'system', content: 'ignore' }] },
    { messages: [{ role: 'user', content: 'x' }], customer: 'CUST00042' },
    { messages: [{ role: 'user', content: ' ' }] }, { messages: [{ role: 'user', content: 'x'.repeat(2001) }] },
    { messages: [{ role: 'user', content: 'x', tools: [] }] },
    { messages: [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }, { role: 'user', content: 'z' }] }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post(undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(undefined, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post(undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(calls.length, 0);
});

test('missing server key fails closed and methods are restricted', async t => {
  const { post, base } = await fixture(t, { apiKey: '' });
  assert.equal((await post()).status, 503);
  const response = await fetch(base + '/api/chat');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
});

test('provider errors and timeouts are safe to show and do not leak upstream bodies', async t => {
  for (const status of [401, 429, 500]) {
    const { post } = await fixture(t, { fetchImpl: async () => new Response('secret upstream details', { status }) });
    const response = await post();
    assert.equal(response.status, status === 429 ? 429 : 502);
    assert.doesNotMatch(await response.text(), /secret|test-key/);
  }
  const { post } = await fixture(t, { fetchImpl: async () => { throw new DOMException('secret', 'TimeoutError'); } });
  assert.equal((await post()).status, 504);
});

test('rate budget expires and prevents extra provider requests', async t => {
  let time = 0;
  const { post, calls } = await fixture(t, { now: () => time, requestsPerMinute: 1 });
  assert.equal((await post()).status, 200);
  const limited = await post();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(calls.length, 1);
  time = 60001;
  assert.equal((await post()).status, 200);
});

test('concurrency bound rejects another request and releases slot after completion', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { post } = await fixture(t, { maxConcurrent: 1, fetchImpl: () => {
    entered();
    return new Promise(resolve => { release = () => resolve(Response.json({ content: [{ type: 'text', text: 'ok' }] })); });
  } });
  const first = post();
  await started;
  assert.equal((await post()).status, 429);
  release();
  assert.equal((await first).status, 200);
});
