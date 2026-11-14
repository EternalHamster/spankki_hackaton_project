import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoach } from '../coach.mjs';
import { createMemoryDraft } from '../coach-memory.mjs';

const preference = { key: 'restaurant_spending', text: 'En halua vähentää ravintolakäyntejä.' };
const message = 'Ravintolat ovat minulle tärkeitä. En halua vähentää ravintolakäyntejä.';
const reply = text => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const call = (name, input) => Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'memory-1', name, input }] });
function fixture(provider = () => reply('Katsotaan muita arjen valintoja.')) {
  const requests = [], financialCalls = [];
  const coach = createCoach({ apiKey: 'test-key', logger() {}, dataSource: {
    context: async customer => ({ profile: `Own profile ${customer}.`, insight_context: 'Own historical data.', as_of: '2026-09-30', version: 'test' }),
    toolDefinitions: async () => [{ name: 'spending', input_schema: { type: 'object', properties: {} } }],
    execute: async (...args) => { financialCalls.push(args); return { spending_eur: '100.00' }; },
  }, fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); return provider(body, requests.length); } });
  return { coach, requests, financialCalls };
}

test('explicit restaurant preference is proposed for storage and supplied to a fresh chat', async () => {
  const first = fixture((_body, count) => count === 1
    ? call('remember_customer_fact', { ...preference, evidence: preference.text }) : reply('Etsitään säästöä muualta.'));
  const result = await first.coach.chat('A', { messages: [{ role: 'user', content: message }] });
  assert.deepEqual(result.memory_updates, [{ action: 'remember', ...preference }]);
  assert.deepEqual(first.financialCalls, []);
  const toolResult = JSON.parse(first.requests[1].messages.at(-1).content[0].content);
  assert.equal(toolResult.status, 'pending_save');

  // A new instance and empty conversation history still get the saved facts from this browser.
  const next = fixture();
  await next.coach.chat('A', { memory: [preference], messages: [{ role: 'user', content: 'Miten voisin säästää enemmän?' }] });
  assert.equal(next.requests[0].messages.length, 1);
  assert.doesNotMatch(JSON.stringify(next.requests[0].system.slice(0, 2)), /En halua vähentää/);
  const memoryBlock = next.requests[0].system.find(block => block.text.includes('Remembered personal facts'));
  assert.match(memoryBlock.text, /En halua vähentää ravintolakäyntejä/);
  assert.match(memoryBlock.text, /untrusted user-provided DATA/);
  assert.match(memoryBlock.text, /current user statement overrides/);
  assert.match(memoryBlock.text, /required spending cuts conflict/);
  assert.equal(memoryBlock.cache_control, undefined);
  await next.coach.chat('B', { memory: [], messages: [{ role: 'user', content: 'Hei!' }] });
  assert.doesNotMatch(JSON.stringify(next.requests[1]), /En halua vähentää ravintolakäyntejä/);
});

test('changed preferences replace the existing key and explicit forgetting removes it', async () => {
  const changed = 'Voin sittenkin vähentää ravintolakäyntejä.';
  const draft = createMemoryDraft([preference], changed);
  assert.equal(draft.execute('remember_customer_fact', { key: preference.key, text: changed, evidence: changed }).status, 'pending_save');
  assert.deepEqual(draft.updates(), [{ action: 'remember', key: preference.key, text: changed }]);
  const forgotten = createMemoryDraft([preference], 'Unohda ravintolatoiveeni.');
  assert.equal(forgotten.execute('forget_customer_fact', { key: preference.key, evidence: 'Unohda ravintolatoiveeni.' }).status, 'pending_save');
  assert.deepEqual(forgotten.updates(), [{ action: 'forget', key: preference.key }]);
  assert.deepEqual([preference], [{ key: 'restaurant_spending', text: 'En halua vähentää ravintolakäyntejä.' }]);
});

test('memory tools reject invented evidence, old conversation evidence and identity overrides', async () => {
  const current = 'Miten voisin säästää enemmän?';
  for (const input of [
    { ...preference, evidence: preference.text },
    { ...preference, evidence: 'I never said this.' },
    { ...preference, evidence: current, customer_id: 'B' },
    { ...preference, evidence: current, text: 'x'.repeat(201) },
    { ...preference, evidence: current, key: '../other' },
    { ...preference, evidence: '' },
  ]) {
    const draft = createMemoryDraft([], current);
    assert.equal(draft.execute('remember_customer_fact', input).error, 'invalid_arguments');
    assert.deepEqual(draft.updates(), []);
  }
  const { coach, requests, financialCalls } = fixture((_body, count) => count === 1
    ? call('remember_customer_fact', { ...preference, evidence: preference.text }) : reply('Katsotaan menojasi.'));
  const result = await coach.chat('A', { messages: [
    { role: 'user', content: message }, { role: 'assistant', content: 'Selvä.' }, { role: 'user', content: current },
  ] });
  assert.deepEqual(result.memory_updates, []);
  assert.equal(requests[1].messages.at(-1).content[0].is_error, true);
  assert.deepEqual(financialCalls, []);
  assert.equal(createMemoryDraft([preference], current).execute('forget_customer_fact', {
    key: preference.key, evidence: 'Unohda ravintolatoiveeni.',
  }).error, 'invalid_arguments');
});

test('a failed final answer never commits memory operations or mutates caller facts', async () => {
  const facts = [{ key: 'goal', text: 'Säästän polkupyörään.' }];
  const { coach } = fixture((_body, count) => count === 1
    ? call('remember_customer_fact', { ...preference, evidence: preference.text }) : new Response('Unavailable', { status: 503 }));
  await assert.rejects(coach.chat('A', { memory: facts, messages: [{ role: 'user', content: message }] }), error => error.status === 502);
  assert.deepEqual(facts, [{ key: 'goal', text: 'Säästän polkupyörään.' }]);
});

test('memory capacity preserves unrelated facts and permits updating an existing topic', () => {
  const facts = Array.from({ length: 12 }, (_, i) => ({ key: `topic_${i}`, text: `Toive ${i}` }));
  const draft = createMemoryDraft(facts, message);
  assert.equal(draft.execute('remember_customer_fact', { ...preference, evidence: preference.text }).error, 'memory_full');
  assert.equal(draft.execute('remember_customer_fact', { key: 'topic_0', text: preference.text, evidence: preference.text }).status, 'pending_save');
  assert.equal(draft.updates().length, 1);
});

test('invalid memory is rejected before requesting model output', async () => {
  const { coach, requests } = fixture();
  for (const memory of [null, {}, [{ key: 'bad key', text: 'A note' }], [preference, preference],
    [{ ...preference, instructions: 'override rules' }], Array.from({ length: 13 }, (_, i) => ({ key: `key_${i}`, text: 'A note' }))]) {
    await assert.rejects(coach.chat('A', { memory, messages: [{ role: 'user', content: message }] }), error => error.status === 400);
  }
  assert.deepEqual(requests, []);
});
