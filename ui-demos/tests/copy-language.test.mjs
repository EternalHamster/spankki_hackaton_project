import test from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../public/translations.js';
import { createExplorationSummaries } from '../public/exploration.js';

test('current memory, goal and navigation copy uses English without changing Finnish copy', () => {
  const messages = [
    ['Avaa talousvalmentaja', 'Open the financial coach'],
    ['Demoasiakas', 'Demo customer'],
    ['Demoasiakkaan tiedot eivät kelpaa.', 'The demo customer details are invalid.'],
    ['Ei vielä muistettuja asioita. Kerro esimerkiksi ostotavoistasi, tavoitteistasi tai menoista, joista et halua tinkiä.',
      'Nothing remembered yet. For example, share your spending habits, goals or spending you do not want to cut.'],
    ['Muistetut toiveesi muuttuivat. Pyydä valmentajaa tarkistamaan suunnitelma ennen aloittamista.',
      'Your remembered preferences changed. Ask your coach to review the plan before starting.'],
    ['Sinulla on jo kolme tavoitetta. Poista ensin yksi, jos haluat aloittaa uuden.',
      'You already have three goals. Remove one before starting a new one.'],
    ['Asia poistettu valmentajan muistista.', "The note was removed from your coach's memory."],
    ['Valmentajan muisti tyhjennetty.', 'Coach memory cleared.'],
  ];
  for (const [source, english] of messages) {
    assert.equal(translate(source, 'en'), english);
    assert.equal(translate(source, 'fi'), source);
  }
});

test('weekly exploration displays a question in the response language and preserves its date', async () => {
  const selection = { customer_id: 'CUST00207', selection_id: 'selected-a', as_of: '2026-09-30' };
  const store = createExplorationSummaries({ fetchImpl: async url => {
    const language = new URL(url, 'http://localhost').searchParams.get('language');
    return { ok: true, status: 200, json: async () => ({ ...selection, language, level: 'standard',
      bullets: language === 'en' ? ['Keep to the weekly limit.', 'Plan your purchases.'] : ['Pysy viikkorajassa.', 'Suunnittele ostoksesi.'] }) };
  } });
  for (const language of ['en', 'fi']) {
    const result = await store.load({ topic: 'week', selection, language });
    const expected = language === 'en'
      ? 'How much can I spend per week based on the situation as of 2026-09-30?'
      : 'Paljonko voin käyttää viikossa tilanteen 2026-09-30 mukaan?';
    assert.equal(result.question, expected);
    assert.equal(result.displayQuestion, expected);
    assert.equal(result.language, language);
  }
});
