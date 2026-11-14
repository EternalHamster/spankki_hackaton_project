import fs from 'node:fs/promises';
import { createDataSource } from '../data-source.mjs';
import { createCoach, PROMPT_VERSION } from '../coach.mjs';
import { createPreparedCoach, coveredMonths } from '../prepared.mjs';
import { DEMO_CUSTOMERS } from '../customers.mjs';

if (!process.argv.includes('--generate')) throw new Error('Pass --generate to make billable Claude calls for the approved synthetic demo customers.');
if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY must be supplied privately in the environment.');
const dataSource = createDataSource();
const model = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
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
  const snapshot = await dataSource.ready();
  const months = coveredMonths(snapshot.coverage_from, snapshot.coverage_to).reverse();
  let result;
  try { result = JSON.parse(await fs.readFile(checkpoint, 'utf8')); } catch {}
  if (!result || result.content_version !== PROMPT_VERSION || result.data_version !== snapshot.version || result.model !== model) {
    result = { schema_version: 1, content_version: PROMPT_VERSION, model, data_version: snapshot.version,
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
      const batch = missing.splice(0, 6);
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
    weekly_answers: DEMO_CUSTOMERS.length, insight_cards: DEMO_CUSTOMERS.length * 3, content_version: PROMPT_VERSION }));
} finally { dataSource.close(); }
