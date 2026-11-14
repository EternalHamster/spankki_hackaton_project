import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorationSummaries, explorationQuestion, explorationTopics, affordQuestion } from '../public/exploration.js';

const selection = { customer_id: 'CUST00207', selection_id: 'selected-a', as_of: '2026-09-30' };
const input = { topic: 'spending', month: '2026-09', selection };

test('purchase planning is first and carries the entered item, price and deadline into chat', () => {
  assert.equal(explorationTopics[0].id, 'afford');
  const question = affordQuestion({ purchase: '  sähköpyörä  ', price: '1500,50', months: '8' });
  assert.match(question, /ostaa sähköpyörä/);
  assert.match(question.replace(/\s/g, ''), /1500,50€/);
  assert.match(question, /8 kuukauden/);
  for (const changes of [{ purchase: ' ' }, { price: 'no price' }, { price: 0 }, { price: Infinity },
    { price: 1000001 }, { months: '' }, { months: 1.5 }, { months: 61 }]) {
    assert.throws(() => affordQuestion({ purchase: 'pyörä', price: 500, months: 6, ...changes }));
  }
});
const response = (answer = 'Kuukauden yhteenveto.', selectionId = selection.selection_id, level = 'standard') => ({
  ok: true, status: 200, json: async () => ({ bullets: [answer, 'Katso menosi.'], customer_id: selection.customer_id, selection_id: selectionId, level }),
});

test('opened topics share pending/completed summaries, scoped by selection and month', async () => {
  const calls = [];
  const store = createExplorationSummaries({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response('Yhteenveto.', options.headers['X-Demo-Selection']);
  } });
  assert.equal(calls.length, 0);
  const first = store.load(input), again = store.load(input);
  assert.equal(first, again);
  const result = await first;
  assert.equal(result.answer, '• Yhteenveto.\n• Katso menosi.');
  assert.equal(result.displayQuestion, 'Mihin rahani menivät? Tarkasteltava kuukausi: 2026-09.');
  assert.equal(calls[0].url, '/api/summaries?topic=spending&month=2026-09&level=standard&language=fi');
  assert.equal(result.level, 'standard');
  assert.equal(calls[0].options.body, undefined);
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
  assert.equal((await store.load(input)).answer, '• Kuukauden yhteenveto.\n• Katso menosi.');
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
    assert.equal((await store.load(input)).answer, '• Kuukauden yhteenveto.\n• Katso menosi.');
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

test('questions retain their own period without exposing implementation instructions', () => {
  assert.match(explorationQuestion('week', '2026-08', selection.as_of), /2026-09-30/);
  assert.doesNotMatch(explorationQuestion('week', '2026-08', selection.as_of), /2026-08/);
  assert.match(explorationQuestion('saving', '2026-08', selection.as_of), /2026-08/);
  assert.doesNotMatch(explorationQuestion('saving', '2026-08', selection.as_of), /what_if|malli|tietokanta/);
  assert.throws(() => explorationQuestion('unknown', input.month, selection.as_of));
});

test('customer preload fetches the two prepared monthly answers; the weekly plan needs no request', async () => {
  const urls = [];
  const store = createExplorationSummaries({ fetchImpl: async url => { urls.push(url); return response(); } });
  assert((await store.warm(selection, '2026-09')).every(result => result.status === 'fulfilled'));
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => !url.includes('topic=week')));
  await store.load(input);
  assert.equal(urls.length, 2);
});

test('summary caches and preloading follow depth without mixing answers across levels', async () => {
  const urls = [];
  const store = createExplorationSummaries({ fetchImpl: async url => {
    urls.push(url);
    const level = new URL(url, 'http://local').searchParams.get('level');
    return response(`Vastaus: ${level}.`, selection.selection_id, level);
  } });
  const standard = await store.load(input);
  const simple = await store.load({ ...input, level: 'simple' });
  const detailed = await store.load({ ...input, level: 'detailed' });
  assert.equal(standard.level, 'standard');
  assert.equal(simple.level, 'simple');
  assert.equal(detailed.level, 'detailed');
  assert.notEqual(simple.answer, detailed.answer);
  assert.equal(await store.load({ ...input, level: 'simple' }), simple);
  assert.equal(urls.length, 3);
  assert((await store.warm(selection, input.month, 'detailed')).every(row => row.status === 'fulfilled'));
  assert.equal(urls.length, 4, 'only the uncached saving answer is preloaded at detailed depth');
  assert.ok(urls.at(-1).includes('level=detailed'));
  assert.throws(() => store.load({ ...input, level: 'unknown' }), TypeError);
});

test('wrong-depth replies are rejected and detailed summaries allow a fuller explanation', async () => {
  let calls = 0;
  const store = createExplorationSummaries({ fetchImpl: async () => ++calls === 1
    ? response('Wrong depth') : response('Lyhyt vastaus.', selection.selection_id, 'simple') });
  await assert.rejects(store.load({ ...input, level: 'simple' }));
  assert.equal((await store.load({ ...input, level: 'simple' })).level, 'simple');
  assert.equal(calls, 2);
  for (const [level, size, allowed] of [['standard', 220, true], ['standard', 221, false], ['simple', 141, false],
    ['detailed', 500, true], ['detailed', 501, false]]) {
    const bounded = createExplorationSummaries({ fetchImpl: async () => response('a'.repeat(size), selection.selection_id, level) });
    const result = bounded.load({ ...input, level });
    if (allowed) assert.equal((await result).bullets[0].length, size);
    else await assert.rejects(result);
  }
  const unchangedSaving = createExplorationSummaries({ fetchImpl: async () => response('a'.repeat(141)) });
  await assert.rejects(unchangedSaving.load({ ...input, topic: 'saving' }));
});

test('late transport results after a depth reset cannot escape or evict the fresh cache entry', async () => {
  const pending = [];
  const store = createExplorationSummaries({ fetchImpl: () => new Promise(resolve => pending.push(resolve)) });
  const old = store.load({ ...input, level: 'simple' });
  const rejected = assert.rejects(old, { name: 'AbortError' });
  store.reset();
  const fresh = store.load({ ...input, level: 'simple' });
  pending[1](response('Uusi.', selection.selection_id, 'simple'));
  const result = await fresh;
  pending[0](response('Vanha.', selection.selection_id, 'simple'));
  await rejected;
  assert.equal((await store.load({ ...input, level: 'simple' })), result);
  assert.match(result.answer, /Uusi/);
  assert.equal(pending.length, 2);
});
