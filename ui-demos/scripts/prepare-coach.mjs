import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createDataSource } from '../data-source.mjs';
import { createCoach, PROMPT_VERSION } from '../coach.mjs';
import { createPreparedCoach, coveredMonths, SPENDING_VERSION } from '../prepared.mjs';
import { DEMO_CUSTOMERS } from '../customers.mjs';
import { SAVING_ACTIONS_VERSION } from '../saving-actions.mjs';

const temporaryFile = target => target instanceof URL ? new URL(target.href + '.tmp') : target + '.tmp';

// Reuse the reviewed bundle's unrelated topics and cards. Interrupted spending runs
// have their own checkpoint and never publish a partially refreshed bundle.
export async function prepareSpendingOnly({ dataSource, coach, model, target, checkpoint, onProgress = () => {} }) {
  const source = await fs.readFile(target, 'utf8'), seed = JSON.parse(source);
  const snapshot = await dataSource.ready();
  // Only migration seed validation can accept the previous spending version.
  // Normal application readiness always requires the current SPENDING_VERSION.
  await createPreparedCoach({ dataSource, coach, file: target, model,
    spendingVersion: seed.spending_version ?? null }).ready();
  const months = coveredMonths(snapshot.coverage_from, snapshot.coverage_to || snapshot.as_of).reverse();
  const sourceHash = createHash('sha256').update(source).digest('hex');
  let progress;
  try { progress = JSON.parse(await fs.readFile(checkpoint, 'utf8')); } catch {}
  if (!progress || progress.mode !== 'spending-only' || progress.source_hash !== sourceHash ||
      progress.result?.spending_version !== SPENDING_VERSION || progress.result?.content_version !== PROMPT_VERSION ||
      progress.result?.data_version !== snapshot.version || progress.result?.model !== model ||
      !progress.completed || DEMO_CUSTOMERS.some(({ id }) => !Array.isArray(progress.completed[id]) ||
        new Set(progress.completed[id]).size !== progress.completed[id].length ||
        progress.completed[id].some(month => !months.includes(month)))) {
    progress = { mode: 'spending-only', source_hash: sourceHash,
      result: { ...structuredClone(seed), spending_version: SPENDING_VERSION },
      completed: Object.fromEntries(DEMO_CUSTOMERS.map(({ id }) => [id, []])) };
  }
  const result = progress.result;
  const save = () => fs.writeFile(checkpoint, JSON.stringify(progress, null, 2) + '\n');
  for (const { id } of DEMO_CUSTOMERS) {
    const missing = months.filter(month => !progress.completed[id].includes(month));
    while (missing.length) {
      const batch = missing.splice(0, 6);
      const content = await coach.summaryBatch(id, { months: batch, spendingOnly: true });
      if (content.data_version !== snapshot.version || content.as_of !== snapshot.as_of || content.model !== model ||
          !content.months || Object.keys(content.months).sort().join(',') !== [...batch].sort().join(',') ||
          batch.some(month => !content.months[month]?.spending || Object.keys(content.months[month]).join(',') !== 'spending')) {
        throw new Error('Generated spending content does not match the requested batch and snapshot');
      }
      for (const month of batch) result.customers[id].months[month].spending = content.months[month].spending;
      progress.completed[id].push(...batch);
      await save();
      onProgress({ prepared: 'spending', customer: id, months: batch, total_months: progress.completed[id].length });
    }
  }
  for (const { id } of DEMO_CUSTOMERS) {
    if (JSON.stringify(result.customers[id].insights) !== JSON.stringify(seed.customers[id].insights) ||
        JSON.stringify(result.customers[id].week) !== JSON.stringify(seed.customers[id].week) || months.some(month =>
          JSON.stringify(result.customers[id].months[month].saving) !== JSON.stringify(seed.customers[id].months[month].saving))) {
      throw new Error('Spending preparation must preserve all other prepared content');
    }
  }
  result.generated_at = new Date().toISOString();
  await save();
  const candidate = temporaryFile(target);
  await fs.writeFile(candidate, JSON.stringify(result, null, 2) + '\n');
  await createPreparedCoach({ dataSource, coach, file: candidate, model }).ready();
  if (await fs.readFile(target, 'utf8') !== source) throw new Error('Prepared source changed during generation; review before publishing');
  await fs.rename(candidate, target);
  await fs.unlink(checkpoint).catch(() => {});
  return { complete: true, customers: DEMO_CUSTOMERS.length, spending_answers: months.length * DEMO_CUSTOMERS.length,
    spending_version: SPENDING_VERSION, preserved: ['saving', 'week', 'insights'] };
}

async function main() {
if (!process.argv.includes('--generate')) throw new Error('Pass --generate to make billable Claude calls for the approved synthetic demo customers.');
const batchSize = Number(process.argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1] ?? 6);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 6) throw new Error('--batch-size must be an integer from 1 to 6.');
if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY must be supplied privately in the environment.');
const dataSource = createDataSource();
const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
let captured = 0;
const coach = createCoach({ dataSource, model, ...(process.argv.includes('--debug') ? { fetchImpl: async (url, options) => {
  const response = await fetch(url, options);
  if (response.ok) await fs.writeFile(new URL(`../.runtime/prepared-response-${++captured}.json`, import.meta.url),
    JSON.stringify({ request: JSON.parse(options.body), response: await response.clone().json() }, null, 2));
  return response;
} } : {}) });
const checkpoint = new URL('../.runtime/prepared-coach-progress.json', import.meta.url);
const target = new URL('../server-data/coach-answers.json', import.meta.url);
try {
  await fs.mkdir(new URL('../.runtime/', import.meta.url), { recursive: true });
  await dataSource.warm();
  if (process.argv.includes('--spending-only')) {
    const result = await prepareSpendingOnly({ dataSource, coach, model, target,
      checkpoint: new URL('../.runtime/prepared-spending-progress.json', import.meta.url),
      onProgress: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify(result));
    return;
  }
  const snapshot = await dataSource.ready();
  const months = coveredMonths(snapshot.coverage_from, snapshot.coverage_to).reverse();
  let result;
  try { result = JSON.parse(await fs.readFile(checkpoint, 'utf8')); } catch {}
  if (!result || result.content_version !== PROMPT_VERSION || result.spending_version !== SPENDING_VERSION || result.saving_version !== SAVING_ACTIONS_VERSION ||
      result.data_version !== snapshot.version || result.model !== model) {
    result = { schema_version: 1, content_version: PROMPT_VERSION, spending_version: SPENDING_VERSION, saving_version: SAVING_ACTIONS_VERSION, model, data_version: snapshot.version,
      coverage_from: snapshot.coverage_from, as_of: snapshot.as_of, generated_at: new Date().toISOString(), customers: {} };
  }
  const save = () => fs.writeFile(checkpoint, JSON.stringify(result, null, 2) + '\n');
  for (const { id } of DEMO_CUSTOMERS) {
    const customer = result.customers[id] ||= { months: {} };
    if (!customer.insights) {
      customer.insights = await coach.insights(id);
      await save(); console.log(JSON.stringify({ prepared: 'insights', customer: id }));
    }
    const missing = months.filter(month => !customer.months[month]?.spending || !customer.months[month]?.saving);
    while (missing.length || !customer.week) {
      const batch = missing.splice(0, batchSize);
      const content = await coach.summaryBatch(id, { months: batch, includeWeek: !customer.week });
      if (content.data_version !== snapshot.version || content.as_of !== snapshot.as_of || content.model !== model) throw new Error('Generated content has a different snapshot');
      Object.assign(customer.months, content.months);
      if (content.week) customer.week = content.week;
      await save(); console.log(JSON.stringify({ prepared: 'answers', customer: id, months: batch, total_months: Object.keys(customer.months).length }));
    }
  }
  result.generated_at = new Date().toISOString();
  await save();
  // Validate the complete temporary bundle, including the current card IDs, before publishing it.
  const reader = createPreparedCoach({ dataSource, coach, file: checkpoint, model });
  await reader.ready();
  await fs.writeFile(new URL('../server-data/coach-answers.json.tmp', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  await fs.rename(new URL('../server-data/coach-answers.json.tmp', import.meta.url), target);
  // Resume interrupted work only; never overwrite an editorially reviewed bundle from an old checkpoint.
  await fs.unlink(checkpoint).catch(() => {});
  console.log(JSON.stringify({ complete: true, customers: DEMO_CUSTOMERS.length, monthly_answers: months.length * 2 * DEMO_CUSTOMERS.length,
    weekly_answers: DEMO_CUSTOMERS.length, insight_cards: DEMO_CUSTOMERS.length * 3,
    content_version: PROMPT_VERSION, spending_version: SPENDING_VERSION, saving_version: SAVING_ACTIONS_VERSION }));
} finally { dataSource.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
