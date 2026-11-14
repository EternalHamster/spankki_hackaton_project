import { locale } from './language.js';
import { getLanguage } from './language.js';
import { translate } from './translations.js';
import { SUMMARY_LIMITS, summaryLimits } from './summary-depth.js';

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
  const euros = new Intl.NumberFormat(locale(), { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
  return `Onko minulla varaa ostaa ${item}, joka maksaa ${euros} €, ${duration} kuukauden kuluttua? Mitä se vaatisi kuukaudessa?`;
}

export function explorationQuestion(topic, month, asOf) {
  if (topic === 'spending') return `Mihin rahani menivät? Tarkasteltava kuukausi: ${month}.`;
  if (topic === 'week') return `Paljonko voin käyttää viikossa tilanteen ${asOf} mukaan?`;
  if (topic === 'saving') return `Miten voisin säästää enemmän? Tarkasteltava kuukausi: ${month}.`;
  throw new TypeError('Unknown exploration topic');
}

// Cache each presentation depth separately. The server adapts prepared text when
// the selected depth has no cached version, without changing the underlying facts.
export function createExplorationSummaries({ fetchImpl = fetch } = {}) {
  const entries = new Map();
  const store = {
    load({ topic, month, selection, level = 'standard', language = getLanguage() }) {
      if (!Object.hasOwn(SUMMARY_LIMITS, level)) throw new TypeError('Unknown summary depth');
      const limits = summaryLimits(level, topic);
      const key = JSON.stringify([selection.selection_id, selection.as_of, language, level, topic, topic === 'week' ? null : month]);
      if (entries.has(key)) return entries.get(key).promise;
      const controller = new AbortController();
      const question = translate(explorationQuestion(topic, month, selection.as_of), language);
      const entry = { controller };
      entry.promise = (async () => {
        const query = new URLSearchParams({ topic, ...(topic === 'week' ? {} : { month }), level, language });
        const response = await fetchImpl('/api/summaries?' + query, {
          headers: { 'X-Demo-Selection': selection.selection_id },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
        });
        const result = await response.json();
        // A transport may finish despite abort. A cleared entry must never escape
        // to the UI or overwrite a fresh request for the same customer and depth.
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if ([401, 409].includes(response.status) || (response.ok &&
            (result.selection_id !== selection.selection_id || result.customer_id !== selection.customer_id))) {
          throw Object.assign(new Error('Demoasiakas vaihtui.'), { staleSelection: true });
        }
        if (!response.ok || (result.language ?? 'fi') !== language || result.level !== level || !Array.isArray(result.bullets) ||
            result.bullets.length < limits.minBullets || result.bullets.length > limits.maxBullets ||
            result.bullets.some(text => typeof text !== 'string' || !text.trim() || text.length > limits.maxChars)) {
          throw new Error('Yhteenvetoa ei saatu. Yritä uudelleen.');
        }
        const bullets = result.bullets.map(text => text.trim());
        return { question, displayQuestion: question, bullets, answer: bullets.map(text => `• ${text}`).join('\n'), selectionId: selection.selection_id, level, language };
      })().catch(error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      return entry.promise;
    },
    warm(selection, month, level = 'standard') {
      // The weekly plan is calculated from bootstrap facts, so it needs no prepared-text request.
      return Promise.allSettled(explorationTopics.filter(({ id }) => id === 'spending' || id === 'saving')
        .map(({ id: topic }) => store.load({ topic, month, selection, level })));
    },
    reset() {
      for (const entry of entries.values()) entry.controller.abort();
      entries.clear();
    },
  };
  return store;
}
