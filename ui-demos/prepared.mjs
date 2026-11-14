import fs from 'node:fs/promises';
import { DEMO_CUSTOMERS, isDemoCustomer } from './customers.mjs';
import { CoachError, PROMPT_VERSION, LEVELS, DEFAULT_LEVEL } from './coach.mjs';
import { summaryLimits } from './public/summary-depth.js';
import { isLanguage } from './public/language.js';

// Spending analysis can change without invalidating unrelated insight IDs or saved summaries.
export const SPENDING_VERSION = 'spending-patterns-v2';

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

function validSummary(value, topic) {
  const limit = summaryLimits('standard', topic).maxChars;
  return value && Array.isArray(value.bullets) && value.bullets.length >= 2 && value.bullets.length <= 3 &&
    value.bullets.every(text => typeof text === 'string' && text.trim() && text.length <= limit && !/CUST\d+/i.test(text)) &&
    typeof value.answer === 'string' && value.answer === value.bullets.map(text => `• ${text}`).join('\n');
}

/** Prepared text stays private. Identity comes only from the signed server session. */
export function createPreparedCoach({ dataSource, coach,
  file = new URL('./server-data/coach-answers.json', import.meta.url),
  model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5', contentVersion = PROMPT_VERSION,
  spendingVersion = SPENDING_VERSION, maxDepthEntries = 128 } = {}) {
  if (!Number.isInteger(maxDepthEntries) || maxDepthEntries < 1 || maxDepthEntries > 1024) throw new TypeError('Invalid depth cache size');
  let prepared;
  const depths = new Map();
  async function load() {
    if (!prepared) prepared = (async () => {
      const [snapshot, body] = await Promise.all([dataSource.ready(), fs.readFile(file, 'utf8').then(JSON.parse)]);
      const months = coveredMonths(snapshot.coverage_from, snapshot.coverage_to || snapshot.as_of);
      if (body.schema_version !== 1 || body.content_version !== contentVersion ||
          (body.spending_version ?? null) !== spendingVersion || body.model !== model ||
          body.data_version !== snapshot.version || body.as_of !== snapshot.as_of || body.coverage_from !== snapshot.coverage_from ||
          !Number.isFinite(Date.parse(body.generated_at)) || !body.customers ||
          Object.keys(body.customers).length !== DEMO_CUSTOMERS.length || Object.keys(body.customers).some(id => !isDemoCustomer(id))) {
        throw new Error('Prepared answers do not match the current snapshot and prompts');
      }
      for (const { id } of DEMO_CUSTOMERS) {
        const customer = body.customers[id];
        if (!customer || !validSummary(customer.week) || !customer.months || Object.keys(customer.months).length !== months.length ||
            months.some(month => !validSummary(customer.months[month]?.spending, 'spending') || !validSummary(customer.months[month]?.saving, 'saving'))) {
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
  function checkLevel(level) {
    if (!Object.hasOwn(LEVELS, level)) throw new CoachError(400, 'Valitse vastausten taso.');
  }
  function depth(id, kind, level, source, language) {
    const key = JSON.stringify([id, language, level, kind, source.topic || null, source.month || null]);
    const existing = depths.get(key);
    if (existing) { depths.delete(key); depths.set(key, existing); return existing.promise; }
    while (depths.size >= maxDepthEntries) {
      const victim = [...depths].find(([, entry]) => !entry.pending);
      if (!victim) throw new CoachError(429, 'Yhteenvetoja muodostetaan parhaillaan. Yritä hetken kuluttua uudelleen.');
      depths.delete(victim[0]);
    }
    const entry = { pending: true, promise: null };
    entry.promise = Promise.resolve().then(() => coach.adaptPrepared(id, { kind, level, source, language })).then(value => {
      entry.pending = false;
      return { ...source, ...value, level, language, source: 'adapted' };
    }).catch(error => {
      if (depths.get(key) === entry) depths.delete(key);
      throw error;
    });
    depths.set(key, entry);
    return entry.promise;
  }
  return {
    async ready() { const data = await load(); return { as_of: data.as_of, generated_at: data.generated_at }; },
    async insights(id, { level = DEFAULT_LEVEL, language = 'fi' } = {}) {
      checkLevel(level);
      if (!isLanguage(language)) throw new CoachError(400, 'Valitse kieli.');
      const { bundle, selected } = await customer(id);
      const source = { ...selected.insights, level, generated_at: bundle.generated_at, source: 'prepared' };
      return level === DEFAULT_LEVEL && language === 'fi' ? { ...source, language } : depth(id, 'insights', level, source, language);
    },
    async summary(id, { topic, month, level = DEFAULT_LEVEL, language = 'fi' } = {}) {
      checkLevel(level);
      if (!isLanguage(language)) throw new CoachError(400, 'Valitse kieli.');
      if (!['spending', 'saving', 'week'].includes(topic) || (topic === 'week' ? month !== undefined : !/^\d{4}-\d{2}$/.test(month || ''))) {
        throw new CoachError(400, 'Valitse aihe ja sopiva kuukausi.');
      }
      const { bundle, selected } = await customer(id);
      const answer = topic === 'week' ? selected.week : selected.months[month]?.[topic];
      if (!answer) throw new CoachError(400, 'Valitulta kuukaudelta ei ole tietoja.');
      const source = { ...answer, topic, ...(month ? { month } : {}), level, as_of: bundle.as_of,
        generated_at: bundle.generated_at, data_version: bundle.data_version, source: 'prepared' };
      return level === DEFAULT_LEVEL && language === 'fi' ? { ...source, language } : depth(id, 'summary', level, source, language);
    },
    async chat(id, options) { await customer(id); return coach.chat(id, options); },
  };
}
