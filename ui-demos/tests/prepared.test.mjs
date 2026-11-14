import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPreparedCoach, coveredMonths, SPENDING_VERSION } from '../prepared.mjs';
import { DEMO_CUSTOMERS } from '../customers.mjs';
import { serve, stubDataSource } from './helpers.mjs';

const ids = DEMO_CUSTOMERS.map(row => row.id);
const months = ['2026-08', '2026-09'];
const snapshot = { version: 'test-db', as_of: '2026-09-30', coverage_from: '2026-08-01', coverage_to: '2026-09-30' };
const summary = (...bullets) => ({ bullets, answer: bullets.map(text => `• ${text}`).join('\n') });

function bundle() {
  return { schema_version: 1, content_version: 'test-v', spending_version: SPENDING_VERSION, model: 'test-model', data_version: snapshot.version,
    coverage_from: snapshot.coverage_from, as_of: snapshot.as_of, generated_at: '2026-11-14T10:00:00Z',
    customers: Object.fromEntries(ids.map((id, i) => [id, {
      insights: { customer_id: id, status: 'ready', as_of: snapshot.as_of, data_version: snapshot.version,
        model: 'test-model', insights: [{ id: `card-${i}`, title: `Havainto ${i + 1}` }] },
      week: summary(`Tilannepäivän käyttövara on ${i + 1}0 euroa viikossa.`, 'Arvio perustuu syyskuun lopun tilanteeseen.'),
      months: Object.fromEntries(months.map((month, j) => [month, {
        spending: summary(`Kuukauden ${month} menot olivat ${(i + 1) * 100 + j} euroa.`, 'Luvut koskevat vain valittua kuukautta.'),
        saving: summary(`Kuukauden ${month} esimerkkisäästö on ${(i + 1) * 20 + j} euroa.`, 'Kyse on laskuesimerkistä, ei toteutuneesta säästöstä.'),
      }])),
    }])) };
}

async function fixture(t, body = bundle(), options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'coach-prepared-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'answers.json');
  await writeFile(file, JSON.stringify(body));
  const prime = [], chat = [], calls = { ready: 0, generated: 0 };
  const dataSource = { ...stubDataSource(), ready: async () => { calls.ready++; return { ...snapshot, ...options.snapshot }; } };
  const coach = {
    async primeInsights(id, value) {
      assert.equal(value.customer_id, id);
      prime.push({ id, value });
    },
    async chat(id, request) { chat.push({ id, request }); return { answer: `Kortti ${ids.indexOf(id) + 1}.` }; },
    async insights() { calls.generated++; throw new Error('Prepared reads must not generate insights'); },
    async summary() { calls.generated++; throw new Error('Prepared reads must not generate summaries'); },
    ...options.coach,
  };
  const prepared = createPreparedCoach({ dataSource, coach, file, contentVersion: 'test-v', model: 'test-model',
    ...(options.maxDepthEntries ? { maxDepthEntries: options.maxDepthEntries } : {}),
    ...(options.spendingVersion !== undefined ? { spendingVersion: options.spendingVersion } : {}) });
  return { prepared, dataSource, body, prime, chat, calls, file };
}

test('prepared reads validate once, prime all customer cards and use no generation calls', async t => {
  const { prepared, body, prime, calls, file } = await fixture(t);
  const readiness = await Promise.all(Array.from({ length: 8 }, () => prepared.ready()));
  assert.ok(readiness.every(value => value.as_of === snapshot.as_of));
  assert.equal(calls.ready, 1);
  assert.deepEqual(prime, ids.map(id => ({ id, value: body.customers[id].insights })));
  // Once validated, repeated reads use the immutable in-memory bundle.
  await writeFile(file, 'invalid after initial load');
  for (const id of ids) {
    const cards = await prepared.insights(id);
    assert.deepEqual(cards, { ...body.customers[id].insights, level: 'standard', language: 'fi', generated_at: body.generated_at, source: 'prepared' });
    for (const month of months) {
      for (const topic of ['spending', 'saving']) {
        const result = await prepared.summary(id, { topic, month });
        assert.deepEqual(result.bullets, body.customers[id].months[month][topic].bullets);
        assert.equal(result.answer, result.bullets.map(text => `• ${text}`).join('\n'));
        assert.equal(result.month, month);
        assert.equal(result.data_version, snapshot.version);
        assert.equal(result.source, 'prepared');
      }
    }
    assert.deepEqual((await prepared.summary(id, { topic: 'week' })).bullets, body.customers[id].week.bullets);
  }
  assert.equal(calls.generated, 0);
  assert.equal(calls.ready, 1);
  assert.equal(prime.length, 3);
});

test('snapshot, prompt and model mismatches and incomplete bundles fail readiness without generation', async t => {
  const changes = [
    ['database', data => { data.data_version = 'old-db'; }],
    ['prompt', data => { data.content_version = 'old-prompt'; }],
    ['missing_spending_version', data => { delete data.spending_version; }],
    ['old_spending_version', data => { data.spending_version = 'old-analysis'; }],
    ['model', data => { data.model = 'other-model'; }],
    ['schema', data => { data.schema_version = 2; }],
    ['as_of', data => { data.as_of = '2026-08-31'; }],
    ['coverage', data => { data.coverage_from = '2026-07-01'; }],
    ['generated_at', data => { data.generated_at = 'invalid'; }],
    ['missing_customer', data => { delete data.customers[ids[1]]; }],
    ['unknown_customer', data => { data.customers.CUST05000 = data.customers[ids[1]]; }],
    ['missing_month', data => { delete data.customers[ids[0]].months[months[1]]; }],
    ['wrong_month', data => { data.customers[ids[0]].months['2026-07'] = data.customers[ids[0]].months[months[0]]; delete data.customers[ids[0]].months[months[0]]; }],
    ['missing_topic', data => { delete data.customers[ids[0]].months[months[0]].saving; }],
    ['wrong_customer_cards', data => { data.customers[ids[0]].insights.customer_id = ids[1]; }],
    ['long_bullet', data => { data.customers[ids[0]].week = summary('x'.repeat(141), 'Toinen kohta.'); }],
    ['long_spending_bullet', data => { data.customers[ids[0]].months[months[0]].spending = summary('x'.repeat(221), 'Toinen kohta.'); }],
    ['too_few_bullets', data => { data.customers[ids[0]].week = summary('Vain yksi kohta.'); }],
    ['too_many_bullets', data => { data.customers[ids[0]].week = summary('Yksi.', 'Kaksi.', 'Kolme.', 'Neljä.'); }],
    ['customer_id_in_text', data => { data.customers[ids[0]].week = summary('Tietoja asiakkaasta CUST00127.', 'Toinen kohta.'); }],
    ['answer_differs', data => { data.customers[ids[0]].week.answer = 'Muutettu vastaus.'; }],
  ];
  for (const [name, change] of changes) {
    await t.test(name, async child => {
      const data = bundle(); change(data);
      const { prepared, calls } = await fixture(child, data);
      await assert.rejects(prepared.ready());
      await assert.rejects(prepared.summary(ids[0], { topic: 'week' }));
      assert.equal(calls.generated, 0);
    });
  }
});

test('legacy spending content requires an explicit migration read and still validates the base bundle', async t => {
  const legacy = bundle(); delete legacy.spending_version;
  const normal = await fixture(t, legacy);
  await assert.rejects(normal.prepared.ready());
  const migration = await fixture(t, legacy, { spendingVersion: null });
  await migration.prepared.ready();
  legacy.content_version = 'old-shared-prompt';
  const stale = await fixture(t, legacy, { spendingVersion: null });
  await assert.rejects(stale.prepared.ready());
});

test('prepared spending has room for pattern explanations while saving remains concise', async t => {
  const body = bundle();
  body.customers[ids[0]].months[months[0]].spending = summary('Kuvattu maksutapa. '.repeat(11).trim(), 'Maksujen ajankohta liittyy valittuun kuukauteen.');
  const { prepared } = await fixture(t, body);
  const result = await prepared.summary(ids[0], { topic: 'spending', month: months[0] });
  assert.ok(result.bullets[0].length > 140 && result.bullets[0].length <= 220);
  body.customers[ids[0]].months[months[0]].saving = summary('x'.repeat(141), 'Toinen kohta.');
  const invalidSaving = await fixture(t, body);
  await assert.rejects(invalidSaving.prepared.ready());
});

test('prepared reads reject unknown identities, periods and topics; chat keeps the selected card/customer', async t => {
  const { prepared, chat, prime } = await fixture(t);
  const messages = [{ role: 'user', content: 'Kerro lisää.' }];
  for (const id of ids) {
    await prepared.chat(id, { messages, insightId: `card-${ids.indexOf(id)}` });
  }
  assert.equal(prime.length, 3);
  assert.deepEqual(chat, ids.map((id, index) => ({ id, request: { messages, insightId: `card-${index}` } })));
  for (const request of [{ topic: 'week', month: months[0] }, { topic: 'spending' },
    { topic: 'spending', month: '2025-12' }, { topic: 'spending', month: '2026-99' },
    { topic: 'spending', month: '2026-9' }, { topic: 'sql', month: months[0] }]) {
    await assert.rejects(prepared.summary(ids[0], request), error => error.status === 400);
  }
  for (const run of [() => prepared.insights('CUST05000'), () => prepared.summary('CUST05000', { topic: 'week' }),
    () => prepared.chat('CUST05000', { messages })]) await assert.rejects(run(), error => error.status === 400);
  assert.equal(chat.length, 3);
});

test('prepared HTTP summaries and card chat are isolated by signed selection session', async t => {
  const setup = await fixture(t);
  const { base, session } = await serve(t, { dataSource: setup.dataSource, coach: setup.prepared });
  const sessions = await Promise.all(ids.map(id => session(id)));
  assert.equal((await fetch(base + '/readyz')).status, 200);
  await Promise.all(sessions.map(async selected => {
    for (const month of months) {
      for (const topic of ['spending', 'saving']) {
        const response = await selected.get(`/api/summaries?topic=${topic}&month=${month}`, { 'X-Customer-ID': 'CUST05000' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = await response.json();
        assert.equal(result.answer, setup.body.customers[selected.customer_id].months[month][topic].answer);
        assert.equal(result.customer_id, selected.customer_id);
        assert.equal(result.selection_id, selected.selection_id);
        for (const other of ids.filter(id => id !== selected.customer_id)) assert.ok(!JSON.stringify(result).includes(other));
      }
    }
    const week = await (await selected.get('/api/summaries?topic=week')).json();
    assert.equal(week.answer, setup.body.customers[selected.customer_id].week.answer);
    const cards = await (await selected.get('/api/insights')).json();
    const response = await selected.post({ messages: [{ role: 'user', content: 'Selitä havainto.' }], insight: { insight_id: cards.insights[0].id } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selection_id, selected.selection_id);
  }));
  assert.deepEqual(setup.chat.map(call => [call.id, call.request.insightId]).sort(), ids.map((id, i) => [id, `card-${i}`]).sort());
  const own = sessions[0];
  for (const query of ['topic=week&customer_id=CUST00127', 'topic=week&customer=CUST00127',
    'topic=week&topic=saving', 'topic=spending&month=2026-08&month=2026-09', 'topic=spending&month=2026-07',
    'topic=week&month=2026-09', 'topic=spending', 'topic=unknown', '']) {
    assert.equal((await own.get('/api/summaries?' + query)).status, 400, query);
  }
  assert.equal((await fetch(base + '/api/summaries?topic=week')).status, 401);
  assert.equal((await own.get('/api/summaries?topic=week', { 'X-Demo-Selection': sessions[1].selection_id })).status, 409);
  assert.equal((await own.get('/server-data/coach-answers.json')).status, 404);
  assert.equal(setup.calls.generated, 0);
  assert.equal(setup.prime.length, 3);
});

test('month enumeration includes all calendar months across year boundaries', () => {
  assert.deepEqual(coveredMonths('2024-12-01', '2025-02-28'), ['2024-12', '2025-01', '2025-02']);
  assert.equal(coveredMonths('2024-10-01', '2026-09-30').length, 24);
  assert.throws(() => coveredMonths('bad', '2026-09-30'));
  assert.throws(() => coveredMonths('2024-13-01', '2026-09-30'));
  assert.throws(() => coveredMonths('2026-02-30', '2026-09-30'));
  assert.throws(() => coveredMonths('2026-09-30', '2024-10-01'));
});

test('depth variants deduplicate and cache separately by customer, level, topic and month', async t => {
  const calls = [];
  const { prepared, body } = await fixture(t, bundle(), { coach: {
    async adaptPrepared(id, options) {
      calls.push({ id, ...options });
      return options.kind === 'insights' ? { insights: options.source.insights, level: options.level }
        : { ...summary(`${options.level}: ${options.source.bullets[0]}`, options.source.bullets[1]), level: options.level };
    },
  } });
  const request = { topic: 'spending', month: months[0], level: 'simple' };
  const parallel = await Promise.all(Array.from({ length: 5 }, () => prepared.summary(ids[0], request)));
  assert.equal(calls.length, 1);
  assert.ok(parallel.every(value => value === parallel[0]));
  assert.equal(parallel[0].level, 'simple');
  assert.equal(parallel[0].source, 'adapted');
  assert.match(parallel[0].answer, /simple:/);
  await prepared.summary(ids[0], { ...request, level: 'detailed' });
  await prepared.summary(ids[1], request);
  await prepared.summary(ids[0], { ...request, topic: 'saving' });
  await prepared.summary(ids[0], { ...request, month: months[1] });
  await prepared.summary(ids[0], { topic: 'week', level: 'simple' });
  const cards = await prepared.insights(ids[0], { level: 'simple' });
  assert.equal(calls.length, 7);
  assert.deepEqual(cards.insights, body.customers[ids[0]].insights.insights);
  assert.equal(cards.level, 'simple');
  await prepared.insights(ids[0], { level: 'simple', retry: true });
  await prepared.summary(ids[0], request);
  const standard = await prepared.summary(ids[0], { ...request, level: 'standard' });
  assert.equal(standard.source, 'prepared');
  assert.equal(standard.level, 'standard');
  assert.deepEqual(standard.bullets, body.customers[ids[0]].months[months[0]].spending.bullets);
  assert.equal(calls.length, 7);
  for (const level of ['unknown', '', null, '__proto__']) {
    await assert.rejects(prepared.summary(ids[0], { ...request, level }), error => error.status === 400);
    await assert.rejects(prepared.insights(ids[0], { level }), error => error.status === 400);
  }
  assert.equal(calls.length, 7);
});

test('depth failures are retryable without wrong-level fallback, and cache eviction never duplicates in-flight work', async t => {
  let calls = 0, release, fail = true;
  const { prepared } = await fixture(t, bundle(), { maxDepthEntries: 1, coach: {
    async adaptPrepared(id, options) {
      calls++;
      if (fail) throw new Error('temporary provider failure');
      await new Promise(resolve => { release = resolve; });
      return { ...summary('Muokattu vastaus.', 'Seuraava askel.'), level: options.level };
    },
  } });
  const request = { topic: 'saving', month: months[0], level: 'simple' };
  await assert.rejects(prepared.summary(ids[0], request), /temporary provider failure/);
  assert.equal((await prepared.summary(ids[0], { ...request, level: 'standard' })).source, 'prepared');
  fail = false;
  const pending = prepared.summary(ids[0], request);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const duplicate = prepared.summary(ids[0], request);
  await assert.rejects(prepared.summary(ids[0], { ...request, level: 'detailed' }), error => error.status === 429);
  release(); await Promise.all([pending, duplicate]);
  assert.equal(calls, 2);
  release = null;
  const replaced = prepared.summary(ids[0], { ...request, level: 'detailed' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(); assert.equal((await replaced).level, 'detailed');
  assert.equal(calls, 3);
});
