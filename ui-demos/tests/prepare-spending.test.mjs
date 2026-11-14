import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareSpendingOnly } from '../scripts/prepare-coach.mjs';
import { PROMPT_VERSION } from '../coach.mjs';
import { SPENDING_VERSION, coveredMonths } from '../prepared.mjs';
import { DEMO_CUSTOMERS } from '../customers.mjs';

const model = 'test-model';
const snapshot = { version: 'test-db', coverage_from: '2026-03-01', coverage_to: '2026-09-30', as_of: '2026-09-30' };
const months = coveredMonths(snapshot.coverage_from, snapshot.coverage_to);
const summary = text => ({ bullets: [text, 'Toinen havainto.'], answer: `• ${text}\n• Toinen havainto.` });

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'prepare-spending-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = { schema_version: 1, content_version: PROMPT_VERSION, model, data_version: snapshot.version,
    coverage_from: snapshot.coverage_from, as_of: snapshot.as_of, generated_at: '2026-11-14T00:00:00Z',
    customers: Object.fromEntries(DEMO_CUSTOMERS.map(({ id }) => [id, {
      insights: { customer_id: id, insights: [{ id: `${id}-keep`, title: 'Säilytä kortti.' }] },
      week: summary('Säilytä viikkovastaus.'),
      months: Object.fromEntries(months.map(month => [month, {
        spending: summary(`Vanha menovastaus ${month}.`), saving: summary(`Säilytä säästövastaus ${month}.`),
      }])),
    }])) };
  const target = path.join(directory, 'answers.json'), checkpoint = path.join(directory, 'spending-progress.json');
  const source = JSON.stringify(seed, null, 2) + '\n'; await writeFile(target, source);
  const calls = [];
  const coach = {
    primeInsights: async (id, value) => assert.equal(value.customer_id, id),
    summaryBatch: async (id, request) => {
      calls.push({ id, request });
      assert.equal(request.spendingOnly, true); assert.equal(request.includeWeek, undefined);
      return { as_of: snapshot.as_of, data_version: snapshot.version, model,
        months: Object.fromEntries(request.months.map(month => [month, { spending: summary(`Uusi havainto ${month}.`) }])) };
    },
  };
  return { seed, source, target, checkpoint, coach, calls, dataSource: { ready: async () => snapshot }, model };
}

test('spending-only preparation upgrades legacy content while preserving saving, week and cards exactly', async t => {
  const fixture = await setup(t);
  const result = await prepareSpendingOnly(fixture);
  assert.equal(result.spending_answers, months.length * DEMO_CUSTOMERS.length);
  const published = JSON.parse(await readFile(fixture.target, 'utf8'));
  assert.equal(published.content_version, PROMPT_VERSION);
  assert.equal(published.spending_version, SPENDING_VERSION);
  assert.equal(fixture.calls.length, 6);
  for (const { id } of DEMO_CUSTOMERS) {
    assert.deepEqual(published.customers[id].insights, fixture.seed.customers[id].insights);
    assert.deepEqual(published.customers[id].week, fixture.seed.customers[id].week);
    for (const month of months) {
      assert.deepEqual(published.customers[id].months[month].saving, fixture.seed.customers[id].months[month].saving);
      assert.match(published.customers[id].months[month].spending.answer, /Uusi havainto/);
    }
  }
  await assert.rejects(readFile(fixture.checkpoint), { code: 'ENOENT' });
});

test('failed preparation keeps the published bundle intact and resumes only completed spending batches', async t => {
  const fixture = await setup(t), generate = fixture.coach.summaryBatch;
  let attempts = 0;
  fixture.coach.summaryBatch = async (...args) => {
    if (++attempts === 2) throw new Error('Simulated provider failure');
    return generate(...args);
  };
  await assert.rejects(prepareSpendingOnly(fixture), /Simulated provider failure/);
  assert.equal(await readFile(fixture.target, 'utf8'), fixture.source);
  assert.equal(fixture.calls.length, 1);
  fixture.coach.summaryBatch = generate;
  await prepareSpendingOnly(fixture);
  assert.equal(fixture.calls.length, 6, 'The six-month completed batch is not regenerated');
});

test('a changed source invalidates spending progress and a mismatched snapshot cannot be published', async t => {
  const fixture = await setup(t), generate = fixture.coach.summaryBatch;
  let attempts = 0;
  fixture.coach.summaryBatch = async (...args) => {
    if (++attempts === 2) throw new Error('Pause');
    return generate(...args);
  };
  await assert.rejects(prepareSpendingOnly(fixture), /Pause/);
  await writeFile(fixture.target, fixture.source + ' ');
  fixture.coach.summaryBatch = generate;
  await prepareSpendingOnly(fixture);
  assert.equal(fixture.calls.length, 7, 'Changed seed restarts all spending batches');
  const published = await readFile(fixture.target, 'utf8');
  fixture.coach.summaryBatch = async (...args) => ({ ...await generate(...args), data_version: 'different-db' });
  await assert.rejects(prepareSpendingOnly(fixture), /snapshot/);
  assert.equal(await readFile(fixture.target, 'utf8'), published);
});
