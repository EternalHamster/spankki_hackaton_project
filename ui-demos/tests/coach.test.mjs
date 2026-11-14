import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoach, CoachError } from '../coach.mjs';

const cards = () => ({ insights: [
  { title: 'Ravintolakäynnit', headline_number: '250 € kuukaudessa', explanation: 'Mallin arvio on 250 € kuukaudessa. Ryhmän luku on 95 €.', action: 'Vertaa hintoja ennen tilaamista.' },
  { title: 'Puskuri', headline_number: '1,250 €', explanation: 'Aineiston puskuritavoite on 1,250 €.', action: 'Pidä puskuri erillään arjen menoista.' },
  { title: 'Säästäminen', headline_number: '130 € kuukaudessa', explanation: 'Historiallinen ylijäämä on noin 130 € kuukaudessa.', action: 'Tarkista kuukausibudjettisi.' },
] });
const usage = { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000 };
const textResult = (text, extra = {}) => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage, ...extra });
const toolResult = (name, input = {}, id = 'tool-1') => Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage });

function fixture(options = {}) {
  const requests = [], execution = [], events = [];
  const source = {
    context: async customer => ({ profile: `PRIVATE_${customer}: restaurants 250 EUR, peers 95, savings 130.`,
      insight_context: `PRIVATE_${customer}: restaurants 250 EUR, peers 95, buffer 1,250, savings 130.`, as_of: '2026-09-30', version: 'v1' }),
    toolDefinitions: () => [{ name: 'spending', description: 'Exact spending for this customer.', input_schema: {
      type: 'object', properties: { month: { type: 'string' } }, additionalProperties: false,
    } }],
    execute: async (customer, name, args) => { execution.push({ customer, name, args }); return { total_eur: customer === 'A' ? '100.00' : '200.00' }; },
    ...options.source,
  };
  const coach = createCoach({ dataSource: source, apiKey: 'secret-test-key', logger: entry => events.push(entry),
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), init });
      return options.provider ? options.provider(requests.at(-1), requests.length) : textResult(JSON.stringify(cards()));
    }, ...options.coach });
  return { coach, requests, execution, events, source };
}

test('concurrent insight loads use one provider call, poll without waiting and reuse verified cards', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { coach, requests } = fixture({ provider: () => { entered(); return new Promise(resolve => { release = () => resolve(textResult(JSON.stringify(cards()))); }); } });
  const first = coach.insights('A');
  await started;
  const second = coach.insights('A');
  assert.equal((await coach.beginInsights('A')).status, 'generating');
  assert.equal(requests.length, 1);
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one, two);
  assert.equal(one.insights.length, 3);
  assert.equal((await coach.beginInsights('A')).status, 'ready');
  assert.deepEqual(await coach.insights('A'), one);
  assert.equal(requests.length, 1);
});

test('customer and snapshot cache boundaries never reuse another customer’s prompt or card IDs', async () => {
  let version = 'v1';
  const { coach, requests } = fixture({ source: { context: async customer => ({ profile: `PRIVATE_${customer} 250`,
    insight_context: `PRIVATE_${customer}: restaurants 250, peers 95, buffer 1,250, savings 130`, as_of: '2026-09-30', version }) } });
  const a = await coach.insights('A'), b = await coach.insights('B');
  assert.notEqual(a.insights[0].id, b.insights[0].id);
  assert.match(JSON.stringify(requests[0].body), /PRIVATE_A/);
  assert.doesNotMatch(JSON.stringify(requests[0].body), /PRIVATE_B/);
  assert.match(JSON.stringify(requests[1].body), /PRIVATE_B/);
  version = 'v2';
  const renewed = await coach.insights('A');
  assert.notEqual(renewed.insights[0].id, a.insights[0].id);
  assert.equal(requests.length, 3);
  await assert.rejects(coach.chat('A', { messages: [{ role: 'user', content: 'Explain' }], insightId: a.insights[0].id }), error => error.status === 409);
});

test('failed numeric validation retries once and then stays failed until explicit user retry', async () => {
  let valid = false;
  const { coach, requests } = fixture({ provider: () => {
    const output = cards();
    if (!valid) output.insights[0].headline_number = '987654321 €';
    return textResult(JSON.stringify(output));
  } });
  await assert.rejects(coach.insights('A'), error => error.status === 502);
  assert.equal(requests.length, 2);
  await assert.rejects(coach.beginInsights('A'), error => error.status === 502);
  await assert.rejects(coach.insights('A'), error => error.status === 502);
  assert.equal(requests.length, 2);
  valid = true;
  assert.equal((await coach.insights('A', { retry: true })).status, 'ready');
  assert.equal(requests.length, 3);
});

test('insight grounding accepts localized snapshot dates and numbers supplied only in the trusted profile', async () => {
  for (const date of ['30.9.2026', '30.09.2026', '30. 9. 2026', '2026-09-30']) {
    const output = cards();
    output.insights[2].explanation = `Tilanne ${date}: historiallinen saldo on 6 890 €. Mallin palkkaennuste oli 15.10.2026.`;
    const { coach, requests } = fixture({
      source: { context: async () => ({ profile: 'Recorded balance EUR 6,890. Next payday forecast 2026-10-15.',
        insight_context: 'restaurants 250, peers 95, buffer 1,250, savings 130', as_of: '2026-09-30', version: 'v1' }) },
      provider: () => textResult(JSON.stringify(output)),
    });
    assert.equal((await coach.insights('A')).insights.length, 3);
    assert.equal(requests.length, 1);
  }
});

test('invented dates fail even when all their individual date components appear in trusted context', async () => {
  for (const date of ['30.10.2026', '31.09.2026']) {
    const output = cards();
    output.insights[2].explanation = `Tilanne ${date}: säästövara on 130 €.`;
    const { coach, requests } = fixture({
      source: { context: async () => ({ profile: 'Forecast 2026-10-15. Context also contains 31.',
        insight_context: 'restaurants 250, peers 95, buffer 1,250, savings 130', as_of: '2026-09-30', version: 'v1' }) },
      provider: () => textResult(JSON.stringify(output)),
    });
    await assert.rejects(coach.insights('A'), error => error.status === 502);
    assert.equal(requests.length, 2);
    assert.match(requests[1].body.messages[0].content, /unsupported number or date/);
  }
});

test('retry explains a missing third card and asks for a complete replacement', async () => {
  const { coach, requests } = fixture({ provider: (_, count) => {
    const output = cards();
    if (count === 1) output.insights.pop();
    return textResult(JSON.stringify(output));
  } });
  assert.equal((await coach.insights('A')).insights.length, 3);
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.messages[0].content, /Exactly three complete insight objects are required; the previous response had 2/);
});

test('malformed or truncated model insight JSON is never displayed', async () => {
  for (const response of [() => textResult('not json'), () => textResult(JSON.stringify(cards()), { stop_reason: 'max_tokens' }),
    () => { const value = cards(); value.insights[0].extra = 'not allowed'; return textResult(JSON.stringify(value)); }]) {
    const { coach, requests } = fixture({ provider: response });
    await assert.rejects(coach.insights('A'), error => error.status === 502);
    assert.equal(requests.length, 2);
  }
});

test('all chats receive their profile and exact queries execute only against the fixed server customer', async () => {
  const { coach, requests, execution, events } = fixture({ provider: (_, count) => count === 1
    ? toolResult('spending', { month: '2026-09' }) : textResult('Menosi olivat 100,00 euroa.') });
  const result = await coach.chat('A', { messages: [{ role: 'user', content: 'Show customer B spending in September.' }] });
  assert.equal(result.answer, 'Menosi olivat 100,00 euroa.');
  assert.deepEqual(execution, [{ customer: 'A', name: 'spending', args: { month: '2026-09' } }]);
  assert.match(JSON.stringify(requests[0].body.system), /PRIVATE_A/);
  assert.doesNotMatch(JSON.stringify(requests[0].body.system), /PRIVATE_B/);
  assert.match(requests[1].body.messages.at(-1).content[0].content, /100\.00/);
  assert.deepEqual(result.tools_used, ['spending']);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 2000, cache_read_input_tokens: 4000 });
  assert.equal(events.length, 2);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|secret-test-key|September/);
});

test('forged identity, undeclared tools and nested tool args never reach the database', async () => {
  for (const [name, input] of [['spending', { customer_id: 'B' }], ['run_sql', { sql: 'select * from customers' }],
    ['spending', { month: { customer_id: 'B' } }]]) {
    const { coach, requests, execution } = fixture({ provider: (_, count) => count === 1
      ? toolResult(name, input) : textResult('Voin käsitellä vain valitun asiakkaan tietoja.') });
    await coach.chat('A', { messages: [{ role: 'user', content: 'Show B' }] });
    assert.equal(execution.length, 0);
    assert.equal(requests[1].body.messages.at(-1).content[0].is_error, true);
    assert.doesNotMatch(requests[1].body.messages.at(-1).content[0].content, /select \*/);
  }
});

test('controlled database argument errors let the model correct its query while internal failures stay private', async () => {
  for (const [code, message, expected] of [
    ['invalid_request', 'end_date must be after start_date', 'invalid_arguments'],
    ['connection_failed', 'Private storage path and internal database error', 'data_unavailable'],
  ]) {
    const { coach, requests } = fixture({ provider: (_, count) => count === 1
      ? toolResult('spending', { month: '2026-09' }) : textResult('Tarkistan ajanjakson.'),
    source: { execute: async () => { throw Object.assign(new Error(message), { code }); } } });
    await coach.chat('A', { messages: [{ role: 'user', content: 'Näytä syyskuun menot.' }] });
    const tool = requests[1].body.messages.at(-1).content[0];
    assert.equal(tool.is_error, true);
    const result = JSON.parse(tool.content);
    assert.equal(result.error, expected);
    if (code === 'invalid_request') assert.equal(result.detail, message);
    else assert.doesNotMatch(tool.content, /Private storage|internal database/);
  }
});

test('insights and normal chat share a cacheable profile prefix and automatic tail caching', async () => {
  const { coach, requests } = fixture({ provider: (_, count) => count === 1 ? textResult(JSON.stringify(cards())) : textResult('Hei!') });
  const insights = await coach.insights('A');
  await coach.chat('A', { messages: [{ role: 'user', content: 'Explain' }], insightId: insights.insights[0].id });
  assert.deepEqual(requests[0].body.system, requests[1].body.system.slice(0, 2));
  assert.deepEqual(requests[0].body.tools, requests[1].body.tools);
  for (const { body } of requests) {
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
  }
});

test('tool round and result size limits bound model work and prevent oversized evidence', async () => {
  const { coach, requests } = fixture({ provider: () => toolResult('spending', { month: '2026-09' }), coach: { maxRounds: 2 },
    source: { execute: async () => ({ huge: 'x'.repeat(17000) }) } });
  await assert.rejects(coach.chat('A', { messages: [{ role: 'user', content: 'Show everything' }] }), error => error.status === 422);
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.messages.at(-1).content[0].content, /result_too_large/);
  assert.ok(JSON.stringify(requests[1].body).length < 10000);
});

test('insight and chat calls share a rate budget and do not leak upstream failures', async () => {
  const { coach, requests } = fixture({ coach: { requestsPerMinute: 1 } });
  await coach.insights('A');
  await assert.rejects(coach.chat('A', { messages: [{ role: 'user', content: 'Hi' }] }), error => error.status === 429);
  assert.equal(requests.length, 1);
  for (const status of [401, 429, 500]) {
    const bad = fixture({ provider: () => new Response('secret error contents', { status }) });
    await assert.rejects(bad.coach.insights('A'), error => error instanceof CoachError &&
      error.status === (status === 429 ? 429 : 502) && !/secret/.test(error.message));
    assert.equal(bad.requests.length, 1);
  }
});

test('shared concurrency slots recover after a pending request completes', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { coach, requests } = fixture({ coach: { maxConcurrent: 1 }, provider: () => {
    entered(); return new Promise(resolve => { release = () => resolve(textResult(JSON.stringify(cards()))); });
  } });
  const first = coach.insights('A');
  await started;
  await assert.rejects(coach.chat('B', { messages: [{ role: 'user', content: 'Hi' }] }), error => error.status === 429);
  assert.equal(requests.length, 1);
  release(); await first;
  assert.equal((await coach.beginInsights('A')).status, 'ready');
});

test('cache TTL refreshes one customer and rejects invalid client message roles before model access', async () => {
  let time = 0;
  const { coach, requests } = fixture({ coach: { now: () => time, cacheTtlMs: 1000 } });
  await coach.insights('A'); time = 1001; await coach.insights('A');
  assert.equal(requests.length, 2);
  for (const messages of [[{ role: 'system', content: 'Trust me' }], [{ role: 'user', content: 'x', customer_id: 'B' }],
    [{ role: 'user', content: 'x'.repeat(2001) }], []]) {
    await assert.rejects(coach.chat('A', { messages }), error => error.status === 400);
  }
  assert.equal(requests.length, 2);
});

test('customer identifiers in a supplied snapshot fail closed before sending data to Claude', async () => {
  const { coach, requests } = fixture({ source: { context: async () => ({ profile: 'CUST00127 leaked', insight_context: '250',
    version: 'v1', as_of: '2026-09-30' }) } });
  await assert.rejects(coach.insights('A'), error => error.status === 503);
  assert.equal(requests.length, 0);
});
