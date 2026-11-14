export const explorationTopics = [
  { id: 'spending', title: 'Mihin rahani menivät?', hint: 'Ymmärrä menojasi ja niiden muutoksia', icon: 'chart' },
  { id: 'week', title: 'Paljonko voin käyttää tällä viikolla?', hint: 'Arvio turvallisesta käyttövarastasi', icon: 'wallet' },
  { id: 'saving', title: 'Miten voisin säästää enemmän?', hint: 'Löydä arkeesi sopiva pieni muutos', icon: 'coffee' },
];

export function explorationQuestion(topic, month, asOf) {
  const brief = ' Vastaa suomeksi 2–3 lyhyellä virkkeellä ilman otsikkoa. Kerro lukujen ajanjakso ja yksi hyödyllinen seuraava askel.';
  if (topic === 'spending') return `Mihin rahani menivät kuukaudella ${month}? Hae toteutuneet menot ja kerro tärkein havainto.` + brief;
  if (topic === 'week') return `Mitä voin turvallisesti käyttää viikossa aineiston tilanteessa ${asOf}? Käytä safe_to_spend-työkalua. Kerro, että arvio on historiallinen eikä takuu tämän päivän käyttövarasta. Jos arviota ei ole, kerro se; älä johda käyttövaraa tilin saldosta tai kuukauden ylijäämästä.` + brief;
  if (topic === 'saving') return `Miten voisin säästää enemmän kuukauden ${month} toteutuneiden menojeni perusteella? Hae menot ja ehdota yhtä vapaaehtoisten menojen muutosta. Käytä what_if-työkalua mahdollisen säästön laskemiseen. Älä ehdota välttämättömien menojen leikkaamista.` + brief;
  throw new TypeError('Unknown exploration topic');
}

// Only opened questions generate a reply. Reopening shares the same pending/completed
// request; changing customer clears both cached answers and in-flight requests.
export function createExplorationSummaries({ fetchImpl = fetch } = {}) {
  const entries = new Map();
  return {
    load({ topic, month, selection }) {
      const key = JSON.stringify([selection.selection_id, selection.as_of, topic, topic === 'week' ? null : month]);
      if (entries.has(key)) return entries.get(key).promise;
      const controller = new AbortController();
      const question = explorationQuestion(topic, month, selection.as_of);
      const entry = { controller };
      entry.promise = (async () => {
        const response = await fetchImpl('/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Selection': selection.selection_id },
          body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
        });
        const result = await response.json();
        if ([401, 409].includes(response.status) || (response.ok && result.selection_id !== selection.selection_id)) {
          throw Object.assign(new Error('Demoasiakas vaihtui.'), { staleSelection: true });
        }
        if (!response.ok || typeof result.answer !== 'string' || !result.answer.trim()) {
          throw new Error('Yhteenvetoa ei saatu. Yritä uudelleen.');
        }
        const title = explorationTopics.find(item => item.id === topic).title;
        const period = topic === 'week' ? `Aineiston tilanne: ${selection.as_of}.` : `Tarkasteltava kuukausi: ${month}.`;
        return { question, displayQuestion: `${title} ${period}`, answer: result.answer.trim(), selectionId: selection.selection_id };
      })().catch(error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      return entry.promise;
    },
    reset() {
      for (const entry of entries.values()) entry.controller.abort();
      entries.clear();
    },
  };
}
