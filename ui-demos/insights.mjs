import { readFile } from 'node:fs/promises';

// Deployment-only allowlist. A browser cannot select a different customer's identity.
export const DEMO_CUSTOMERS = ['CUST00207', 'CUST00127', 'CUST00103'];
const defaultFile = new URL('./server-data/insights.json', import.meta.url);

export function createInsightStore({ file = defaultFile } = {}) {
  let cached;
  async function load() {
    if (!cached) cached = readFile(file, 'utf8').then(JSON.parse).then(bundle => {
      if (bundle.schema_version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(bundle.as_of) ||
          !Object.keys(bundle.profiles).length || Object.keys(bundle.profiles).some(id => !DEMO_CUSTOMERS.includes(id))) throw new Error('Invalid insight bundle');
      for (const profile of Object.values(bundle.profiles)) {
        if (typeof profile.context !== 'string' || !profile.context.trim() || profile.context.length > 20000 ||
            !Array.isArray(profile.insights) || profile.insights.length !== 3 ||
            new Set(profile.insights.map(row => row.id)).size !== 3 ||
            profile.insights.some(row => row.numbers_verified !== true ||
              ['id', 'title', 'headline_number', 'explanation', 'action'].some(key => typeof row[key] !== 'string' || !row[key].trim()))) {
          throw new Error('Invalid insight profile');
        }
      }
      return bundle;
    }).catch(error => { cached = undefined; throw error; });
    return cached;
  }
  async function profile(customer) {
    if (!DEMO_CUSTOMERS.includes(customer)) return null;
    const bundle = await load();
    if (!Object.hasOwn(bundle.profiles, customer)) return null;
    return { as_of: bundle.as_of, profile: bundle.profiles[customer] };
  }
  return {
    ready: load,
    async cards(customer) {
      const selected = await profile(customer);
      if (!selected) return null;
      return { customer_id: customer, as_of: selected.as_of,
        insights: selected.profile.insights.map(({ id, title, headline_number, explanation, action }) =>
          ({ id, title, headline_number, explanation, action })) };
    },
    async context(customer, insightId) {
      const selected = await profile(customer);
      if (!selected) return null;
      const insight = selected.profile.insights.find(row => row.id === insightId);
      if (!insight) return null;
      return JSON.stringify({ as_of: selected.as_of, selected_insight: {
        title: insight.title, headline_number: insight.headline_number, explanation: insight.explanation, action: insight.action,
      }, supporting_context: selected.profile.context });
    },
  };
}
