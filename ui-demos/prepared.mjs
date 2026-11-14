import fs from 'node:fs/promises';
import { DEMO_CUSTOMERS, isDemoCustomer } from './customers.mjs';
import { CoachError, PROMPT_VERSION } from './coach.mjs';

export function coveredMonths(from, to) {
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('Invalid snapshot coverage');
  const months = [];
  for (let year = Number(from.slice(0, 4)), month = Number(from.slice(5, 7)); months.length < 120;) {
    const value = `${year}-${String(month).padStart(2, '0')}`;
    if (value > to.slice(0, 7)) return months;
    months.push(value); month++; if (month > 12) { month = 1; year++; }
  }
  throw new Error('Snapshot is too large');
}

function validSummary(value) {
  return value && Array.isArray(value.bullets) && value.bullets.length >= 2 && value.bullets.length <= 3 &&
    value.bullets.every(text => typeof text === 'string' && text.trim() && text.length <= 140 && !/CUST\d+/i.test(text)) &&
    typeof value.answer === 'string' && value.answer === value.bullets.map(text => `• ${text}`).join('\n');
}

/** Prepared text stays private. Identity comes only from the signed server session. */
export function createPreparedCoach({ dataSource, coach,
  file = new URL('./server-data/coach-answers.json', import.meta.url),
  model = process.env.CLAUDE_MODEL || 'claude-haiku-5-5', contentVersion = PROMPT_VERSION } = {}) {
  let prepared;
  async function load() {
    if (!prepared) prepared = (async () => {
      const [snapshot, body] = await Promise.all([dataSource.ready(), fs.readFile(file, 'utf8').then(JSON.parse)]);
      const months = coveredMonths(snapshot.coverage_from, snapshot.coverage_to || snapshot.as_of);
      if (body.schema_version !== 1 || body.content_version !== contentVersion || body.model !== model ||
          body.data_version !== snapshot.version || body.as_of !== snapshot.as_of || body.coverage_from !== snapshot.coverage_from ||
          !Number.isFinite(Date.parse(body.generated_at)) || !body.customers ||
          Object.keys(body.customers).length !== DEMO_CUSTOMERS.length || Object.keys(body.customers).some(id => !isDemoCustomer(id))) {
        throw new Error('Prepared answers do not match the current snapshot and prompts');
      }
      for (const { id } of DEMO_CUSTOMERS) {
        const customer = body.customers[id];
        if (!customer || !validSummary(customer.week) || !customer.months || Object.keys(customer.months).length !== months.length ||
            months.some(month => !validSummary(customer.months[month]?.spending) || !validSummary(customer.months[month]?.saving))) {
          throw new Error('Prepared answers are incomplete');
        }
        await coach.primeInsights(id, customer.insights);
      }
      return body;
    })().catch(error => { prepared = null; throw error; });
    return prepared;
  }
  async function customer(id) {
    if (!isDemoCustomer(id)) throw new CoachError(400, 'Valitse demoasiakas listalta.');
    const bundle = await load();
    return { bundle, selected: bundle.customers[id] };
  }
  return {
    async ready() { const data = await load(); return { as_of: data.as_of, generated_at: data.generated_at }; },
    async insights(id) {
      const { bundle, selected } = await customer(id);
      return { ...selected.insights, generated_at: bundle.generated_at, source: 'prepared' };
    },
    async summary(id, { topic, month } = {}) {
      if (!['spending', 'saving', 'week'].includes(topic) || (topic === 'week' ? month !== undefined : !/^\d{4}-\d{2}$/.test(month || ''))) {
        throw new CoachError(400, 'Valitse aihe ja sopiva kuukausi.');
      }
      const { bundle, selected } = await customer(id);
      const answer = topic === 'week' ? selected.week : selected.months[month]?.[topic];
      if (!answer) throw new CoachError(400, 'Valitulta kuukaudelta ei ole tietoja.');
      return { ...answer, topic, ...(month ? { month } : {}), as_of: bundle.as_of,
        generated_at: bundle.generated_at, data_version: bundle.data_version, source: 'prepared' };
    },
    async chat(id, options) { await customer(id); return coach.chat(id, options); },
  };
}
