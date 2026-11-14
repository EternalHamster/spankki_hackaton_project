import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getLanguage, setLanguage, locale, LANGUAGE_KEY } from '../public/language.js';
import { translate } from '../public/translations.js';
import { createCoach } from '../coach.mjs';
import { createPreparedCoach, SPENDING_VERSION } from '../prepared.mjs';
import { serve, stubCoach } from './helpers.mjs';
import { DEMO_CUSTOMERS } from '../customers.mjs';

test('language preference persists, rejects unknown values and keeps a visit choice when storage is blocked', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key), setItem: (key, value) => values.set(key, value),
  } });
  try {
    assert.equal(getLanguage(), 'fi');
    assert.deepEqual(setLanguage('en'), { language: 'en', persisted: true });
    assert.equal(values.get(LANGUAGE_KEY), 'en'); assert.equal(locale(), 'en-GB');
    assert.throws(() => setLanguage('de'));
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Blocked'); } });
    assert.deepEqual(setLanguage('fi'), { language: 'fi', persisted: false });
    assert.equal(getLanguage(), 'fi');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'fi', setItem() {} } });
    setLanguage('fi');
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; }
});

test('interface translation covers labels, dated copy, weekly plans and recap amounts without changing figures', () => {
  const source = 'Jaa jäljellä oleva €248.60 4 päivälle: enintään €62.15 päivässä.';
  assert.equal(translate(source, 'fi'), source);
  assert.equal(translate(source, 'en'), 'Spread the remaining €248.60 over 4 days: no more than €62.15 a day.');
  assert.equal(translate('Tärkeimmät havainnot', 'en'), 'Key insights');
  assert.equal(translate('Tilisi ei käynyt kertaakaan miinuksella. Hieno saavutus!', 'en'), 'Your account never went overdrawn. Well done!');
  assert.equal(translate('Seuraavat askeleesi · tiedot 30/09/2026 asti', 'en'), 'Your next steps · data through 30/09/2026');
  assert.equal(translate('A < B & C', 'en'), 'A < B & C');
  assert.equal(translate('May', 'en'), 'May');
  assert.equal(translate('S-Pankki Tavoitetili', 'en'), 'S-Pankki Goal Account');
  assert.equal(translate(' edellisen vuoden samoihin 9 kuukauteen verrattuna.', 'en'), ' compared with the same 9 months of the previous year.');
  assert.equal(translate('€250 / kk', 'en'), '€250 / month');
  assert.equal(translate('Tavoitetilisi demosaldo säilyy: €250.', 'en'), 'Your demo Goal Account balance is kept: €250.');
  assert.equal(translate('Muille tavoitteille on suunniteltu 100 €/kk. Tähän tavoitteeseen lisäksi 250 €/kk, eli tavoitteisiin yhteensä 350 €/kk.', 'en'),
    'You already have 100 €/month planned for other goals. This goal adds 250 €/month, bringing total goal savings to 350 €/month.');
});

test('goal translations distinguish extra savings from an updated pace without changing amounts', () => {
  assert.equal(translate('Muille tavoitteille jo suunniteltu', 'en'), 'Already planned for other goals');
  assert.equal(translate('Lisäksi tähän tavoitteeseen', 'en'), 'Extra for this goal');
  assert.equal(translate('Tavoitteisiin yhteensä', 'en'), 'Total for all goals');
  assert.equal(translate('+ €5.00 / kk', 'en'), '+ €5.00 / month');
  assert.equal(translate('Muille tavoitteille on suunniteltu 50,00 €/kk. Tähän tavoitteeseen lisäksi 5,00 €/kk, eli tavoitteisiin yhteensä 55,00 €/kk.', 'en'),
    'You already have 50,00 €/month planned for other goals. This goal adds 5,00 €/month, bringing total goal savings to 55,00 €/month.');
  assert.equal(translate('Muille tavoitteille on suunniteltu 50,00 €/kk. Tämän tavoitteen päivitetty säästövauhti on 5,00 €/kk, eli tavoitteisiin yhteensä 55,00 €/kk.', 'en'),
    'You already have 50,00 €/month planned for other goals. The updated saving pace for this goal is 5,00 €/month, bringing total goal savings to 55,00 €/month.');
  assert.equal(translate('Yhteistä suunnitelmaa rahoittavat menovähennykset: Ravintolat ja kahvilat 55,00 €/kk.', 'en'),
    'Spending reductions that fund the combined plan: Restaurants and cafés 55,00 €/month.');
});

function modelFixture(response) {
  const requests = [];
  const coach = createCoach({ apiKey: 'test-only', logger() {}, dataSource: {
    context: async () => ({ profile: 'Synthetic profile: 260 EUR.', insight_context: '260 EUR.', as_of: '2026-09-30', version: 'v1' }),
    toolDefinitions: async () => [],
    execute: async () => { throw new Error('No tools allowed in this language test'); },
  }, fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof response === 'string' ? response : JSON.stringify(response) }] }); } });
  return { coach, requests };
}
test('chat and one-answer rewrites use the selected application language even when the question asks for another', async () => {
  const { coach, requests } = modelFixture('Your allowance is an estimate.');
  const messages = [{ role: 'user', content: 'Vastaa suomeksi.' }];
  assert.equal((await coach.chat('demo', { messages, language: 'en' })).language, 'en');
  await coach.chat('demo', { messages, language: 'en', rewrite: { answer: 'Arvio on 260 euroa.' } });
  for (const body of requests) {
    assert.match(body.system.at(-1).text, /APPLICATION LANGUAGE: ENGLISH/);
    assert.match(body.system.at(-1).text, /overrides the language of the question/);
  }
  await assert.rejects(coach.chat('demo', { messages, language: 'de' }), error => error.status === 400);
});

test('English standard insights translate headline units while preserving identity, periods and amounts', async () => {
  const source = { as_of: '2026-09-30', data_version: 'v1', insights: ['weekly', 'monthly', 'yearly'].map((period, index) => ({
    id: `card-${index}`, period, title: 'Suunnittele ostoksesi', headline_number: 'Arvio 260 €/vko',
    explanation: 'Arvio on 260 euroa.', action: 'Varaa rahaa laskuihin.',
  })) };
  const output = { insights: source.insights.map(({ id, ...row }, index) => ({ ...row,
    title: ['Plan purchases', 'Review spending', 'Plan ahead'][index], headline_number: 'Estimate €260/week',
    explanation: 'The historical estimate is €260.', action: 'Set aside money for bills.',
  })) };
  const { coach, requests } = modelFixture(output);
  const adapted = await coach.adaptPrepared('demo', { kind: 'insights', source, level: 'standard', language: 'en' });
  assert.equal(adapted.language, 'en');
  assert.deepEqual(adapted.insights.map(row => row.id), source.insights.map(row => row.id));
  assert.equal(adapted.insights[0].headline_number, 'Estimate €260/week');
  assert.match(requests[0].system[0].text, /APPLICATION LANGUAGE: ENGLISH/);
  assert.equal(requests[0].tools, undefined);
  const bad = modelFixture({ insights: output.insights.map(row => ({ ...row, headline_number: 'Estimate €999/week' })) });
  await assert.rejects(bad.coach.adaptPrepared('demo', { kind: 'insights', source, level: 'standard', language: 'en' }), error => error.status === 502);
});

test('prepared summary variants are isolated by language and never reuse Finnish standard text for English', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'language-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'answers.json'), calls = [];
  const summary = { bullets: ['Arvio on 260 euroa.', 'Varaa rahaa laskuihin.'], answer: '• Arvio on 260 euroa.\n• Varaa rahaa laskuihin.' };
  const snapshot = { version: 'v1', as_of: '2026-09-30', coverage_from: '2026-09-01', coverage_to: '2026-09-30' };
  await fs.writeFile(file, JSON.stringify({ schema_version: 1, content_version: 'test', spending_version: SPENDING_VERSION,
    model: 'test', data_version: 'v1', as_of: snapshot.as_of, coverage_from: snapshot.coverage_from, generated_at: new Date().toISOString(),
    customers: Object.fromEntries(DEMO_CUSTOMERS.map(({ id }) => [id, { insights: {}, week: summary, months: { '2026-09': { spending: summary, saving: summary } } }])) }));
  const prepared = createPreparedCoach({ dataSource: { ready: async () => snapshot }, file, contentVersion: 'test', model: 'test', coach: {
    primeInsights: async () => {}, adaptPrepared: async (id, options) => { calls.push({ id, ...options }); return { ...summary, bullets: [options.language, options.level] }; },
  } });
  const id = DEMO_CUSTOMERS[0].id, options = { topic: 'week', level: 'standard' };
  assert.equal((await prepared.summary(id, { ...options, language: 'fi' })).source, 'prepared');
  const [one, two] = await Promise.all([prepared.summary(id, { ...options, language: 'en' }), prepared.summary(id, { ...options, language: 'en' })]);
  assert.equal(one, two); assert.equal(one.language, 'en'); assert.equal(calls.length, 1);
  await prepared.summary(id, { ...options, language: 'fi', level: 'simple' });
  await prepared.summary(id, { ...options, language: 'en', level: 'simple' });
  assert.equal(calls.length, 3);
});

test('HTTP validates languages on chat, summaries and insights and preserves the signed customer scope', async t => {
  const seen = [];
  const { session } = await serve(t, { coach: stubCoach({
    insights: async (id, options) => { seen.push(options.language); return { level: options.level, language: options.language, insights: [] }; },
    summary: async (id, options) => { seen.push(options.language); return { language: options.language, bullets: [] }; },
    chat: async (id, options) => { seen.push(options.language); return { answer: 'Hello.', language: options.language }; },
  }) });
  const own = await session();
  for (const route of ['/api/insights?language=en', '/api/summaries?topic=week&language=en']) {
    const response = await own.get(route); assert.equal(response.status, 200); assert.equal((await response.json()).language, 'en');
    assert.equal((await own.get(route.replace('language=en', 'language=de'))).status, 400);
    assert.equal((await own.get(route + '&language=fi')).status, 400);
  }
  assert.equal((await own.post({ messages: [{ role: 'user', content: 'Hei' }], language: 'en' })).status, 200);
  assert.equal((await own.post({ messages: [{ role: 'user', content: 'Hei' }], language: 'de' })).status, 400);
  assert.deepEqual(seen, ['en', 'en', 'en']);
});
