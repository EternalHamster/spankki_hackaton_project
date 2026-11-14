import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorationSummaries, explorationQuestion } from '../public/exploration.js';

const selection = { selection_id: 'selected-a', as_of: '2026-09-30' };
const input = { topic: 'spending', month: '2026-09', selection };
const response = (answer = 'Kuukauden yhteenveto.', selectionId = selection.selection_id) => ({
  ok: true, status: 200, json: async () => ({ answer, selection_id: selectionId }),
});

test('opened topics share pending/completed summaries, scoped by selection and month', async () => {
  const calls = [];
  const store = createExplorationSummaries({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response('Yhteenveto.', options.headers['X-Demo-Selection']);
  } });
  assert.equal(calls.length, 0, 'no model requests on the collapsed overview');
  const first = store.load(input), again = store.load(input);
  assert.equal(first, again);
  const result = await first;
  assert.equal(result.answer, 'Yhteenveto.');
  assert.equal(result.displayQuestion, 'Mihin rahani menivät? Tarkasteltava kuukausi: 2026-09.');
  assert.equal(calls[0].url, '/api/chat');
  assert.deepEqual(JSON.parse(calls[0].options.body), { messages: [{ role: 'user', content: result.question }] });
  assert.equal(await store.load(input), result);
  assert.equal(calls.length, 1);
  await store.load({ ...input, month: '2026-08' });
  await store.load({ ...input, selection: { ...selection, selection_id: 'selected-b' } });
  assert.equal(calls.length, 3);
  await store.load({ ...input, topic: 'week' });
  await store.load({ ...input, topic: 'week', month: '2026-08' });
  assert.equal(calls.length, 4, 'weekly estimate depends on the snapshot, not selected historical month');
});

test('mismatched selections never become a cached financial summary', async () => {
  let calls = 0;
  const store = createExplorationSummaries({ fetchImpl: async () => ++calls === 1 ? response('Wrong customer', 'selected-b') : response() });
  await assert.rejects(store.load(input), error => error.staleSelection === true);
  assert.equal((await store.load(input)).answer, 'Kuukauden yhteenveto.');
  assert.equal(calls, 2);
  for (const status of [401, 409]) {
    const expired = createExplorationSummaries({ fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }) });
    await assert.rejects(expired.load(input), error => error.staleSelection === true);
  }
});

test('failed or empty replies can be retried and are never replaced with a fake summary', async () => {
  for (const failure of [{ ok: false, status: 503, json: async () => ({}) }, response(' ')]) {
    let calls = 0;
    const store = createExplorationSummaries({ fetchImpl: async () => ++calls === 1 ? failure : response() });
    await assert.rejects(store.load(input));
    assert.equal((await store.load(input)).answer, 'Kuukauden yhteenveto.');
    assert.equal(calls, 2);
  }
});

test('customer reset aborts pending requests and discards successful summaries', async () => {
  let signal;
  const store = createExplorationSummaries({ fetchImpl: (_, options) => new Promise((_, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  const request = store.load(input);
  const rejected = assert.rejects(request, { name: 'AbortError' });
  store.reset();
  assert.equal(signal.aborted, true);
  await rejected;
  let calls = 0;
  const completed = createExplorationSummaries({ fetchImpl: async () => { calls++; return response(); } });
  await completed.load(input); completed.reset(); await completed.load(input);
  assert.equal(calls, 2);
});

test('affordability and savings questions request authoritative tools and historical periods', () => {
  assert.match(explorationQuestion('week', '2026-08', selection.as_of), /2026-09-30.*safe_to_spend/);
  assert.doesNotMatch(explorationQuestion('week', '2026-08', selection.as_of), /2026-08/);
  assert.match(explorationQuestion('saving', '2026-08', selection.as_of), /2026-08.*what_if/);
  assert.throws(() => explorationQuestion('unknown', input.month, selection.as_of));
});
