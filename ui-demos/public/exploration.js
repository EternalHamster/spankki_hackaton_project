export const explorationTopics = [
  { id: 'afford', title: 'Onko minulla varaa tähän?', hint: 'Kerro haaveestasi – tehdään siitä suunnitelma', icon: 'bag' },
  { id: 'spending', title: 'Mihin rahani menivät?', hint: 'Ymmärrä menojasi ja niiden muutoksia', icon: 'chart' },
  { id: 'week', title: 'Paljonko voin käyttää tällä viikolla?', hint: 'Arvio käytettävissä olevasta rahasta', icon: 'wallet' },
  { id: 'saving', title: 'Miten voisin säästää enemmän?', hint: 'Löydä arkeesi sopiva pieni muutos', icon: 'coffee' },
];

export const affordTemplate = 'Haluaisin suunnitella hankintaa. Voitko auttaa?';

export function affordQuestion({ purchase, price, months }) {
  const item = String(purchase || '').trim(), amount = Number(String(price).replace(',', '.')), duration = Number(months);
  if (!item || item.length > 120 || !Number.isFinite(amount) || amount < 0.01 || amount > 1000000 ||
      !Number.isInteger(duration) || duration < 1 || duration > 60) {
    throw new TypeError('Lisää hankinta, hinta (0,01–1 000 000 €) ja aika (1–60 kuukautta).');
  }
  const euros = new Intl.NumberFormat('fi-FI', { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
  return `Onko minulla varaa ostaa ${item}, joka maksaa ${euros} €, ${duration} kuukauden kuluttua? Mitä se vaatisi kuukaudessa?`;
}

export function explorationQuestion(topic, month, asOf) {
  if (topic === 'spending') return `Mihin rahani menivät? Tarkasteltava kuukausi: ${month}.`;
  if (topic === 'week') return `Paljonko voin käyttää viikossa tilanteen ${asOf} mukaan?`;
  if (topic === 'saving') return `Miten voisin säästää enemmän? Tarkasteltava kuukausi: ${month}.`;
  throw new TypeError('Unknown exploration topic');
}

// These read-only requests retrieve text generated before deployment. No model call
// happens on opening a section; preload the default answers after customer selection.
export function createExplorationSummaries({ fetchImpl = fetch } = {}) {
  const entries = new Map();
  const store = {
    load({ topic, month, selection }) {
      const key = JSON.stringify([selection.selection_id, selection.as_of, topic, topic === 'week' ? null : month]);
      if (entries.has(key)) return entries.get(key).promise;
      const controller = new AbortController();
      const question = explorationQuestion(topic, month, selection.as_of);
      const entry = { controller };
      entry.promise = (async () => {
        const query = new URLSearchParams({ topic, ...(topic === 'week' ? {} : { month }) });
        const response = await fetchImpl('/api/summaries?' + query, {
          headers: { 'X-Demo-Selection': selection.selection_id },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        const result = await response.json();
        if ([401, 409].includes(response.status) || (response.ok &&
            (result.selection_id !== selection.selection_id || result.customer_id !== selection.customer_id))) {
          throw Object.assign(new Error('Demoasiakas vaihtui.'), { staleSelection: true });
        }
        if (!response.ok || !Array.isArray(result.bullets) || result.bullets.length < 2 || result.bullets.length > 3 ||
            result.bullets.some(text => typeof text !== 'string' || !text.trim() || text.length > 140)) {
          throw new Error('Yhteenvetoa ei saatu. Yritä uudelleen.');
        }
        const bullets = result.bullets.map(text => text.trim());
        return { question, displayQuestion: question, bullets, answer: bullets.map(text => `• ${text}`).join('\n'), selectionId: selection.selection_id };
      })().catch(error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      return entry.promise;
    },
    warm(selection, month) {
      return Promise.allSettled(explorationTopics.filter(({ id }) => id !== 'afford')
        .map(({ id: topic }) => store.load({ topic, month, selection })));
    },
    reset() {
      for (const entry of entries.values()) entry.controller.abort();
      entries.clear();
    },
  };
  return store;
}
