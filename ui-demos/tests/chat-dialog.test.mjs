import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatDialog } from '../public/chat.js';
import { LEVEL_KEY } from '../public/answer-depth.js';
import { LANGUAGE_KEY } from '../public/language.js';
import { translate } from '../public/translations.js';

function dialogFixture(t, preference = 'standard', { proposal, projects = [], beforeResponse, respond } = {}) {
  const replaceGlobal = (key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  };
  const stored = new Map([[LEVEL_KEY, preference]]), requests = [], nodes = new Map();
  let storageWritesFail = false, projectChanges = 0;
  replaceGlobal('addEventListener', () => {});
  replaceGlobal('localStorage', { getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { if (storageWritesFail) throw new Error('Storage unavailable'); stored.set(key, value); } });
  replaceGlobal('navigator', { locks: { request: async (_key, _options, callback) => callback() } });
  const selection = { customer_id: 'CUST00207', selection_id: 'selected-a', as_of: '2026-09-30' };
  let selected = selection, staleSelections = 0;
  const projectKey = 'oma-talous-projects-v1:' + selection.customer_id;
  if (projects.length) stored.set(projectKey, JSON.stringify({ version: 1, revision: 'initial', projects }));
  replaceGlobal('fetch', async (url, options) => {
    assert.equal(url, '/api/chat');
    const request = JSON.parse(options.body);
    requests.push(request);
    beforeResponse?.(stored, projectKey);
    if (respond) return respond(request, options);
    return { ok: true, status: 200, json: async () => ({ answer: 'Muokattu vastaus.', selection_id: selection.selection_id,
      language: request.language,
      ...(proposal ? { project_proposal: proposal } : {}) }) };
  });
  // A minimal dialog surface exercises the real event handlers and rendered controls.
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', value: '', dataset: {},
      listeners: new Map(), classList: { toggle() {} }, setAttribute() {},
      focusCalls: [], focus(options) { this.focusCalls.push(options); },
      querySelector: node, querySelectorAll: () => [],
      addEventListener(type, callback) { this.listeners.set(type, callback); } });
    return nodes.get(selector);
  };
  const detail = { open: true, querySelector: node, querySelectorAll: () => [] };
  let modalHTML = '';
  const show = createChatDialog({ detail, modal(_title, html) { modalHTML = html; }, icon: () => '', getSelection: () => selected,
    onSelectionStale() { staleSelections++; }, onProjectsChanged() { projectChanges++; } });
  const open = level => show.openExploration({ question: 'Miten voisin säästää?', displayQuestion: 'Säästövinkki',
    answer: 'Alkuperäinen vastaus.', bullets: ['Ensimmäinen havainto.', 'Toinen havainto.'],
    selectionId: selection.selection_id, level });
  const disabled = direction => {
    const button = node('#chat-messages').innerHTML.match(new RegExp(`<button[^>]*data-depth="${direction}"[^>]*>`));
    assert.ok(button, `Missing ${direction} button`);
    return /\bdisabled\b/.test(button[0]);
  };
  const rewrite = async (direction, staleIndex) => {
    const rendered = node('#chat-messages').innerHTML.match(new RegExp(`<button[^>]*data-depth="${direction}"[^>]*data-answer-index="(\\d+)"`));
    const button = { disabled: staleIndex === undefined && disabled(direction), dataset: { depth: direction, answerIndex: String(staleIndex ?? rendered?.[1]) } };
    node('#chat-messages').listeners.get('click')({ target: { closest: () => button } });
    await new Promise(resolve => setImmediate(resolve));
  };
  const typeDraft = value => { node('#chat-question').value = value; node('#chat-question').listeners.get('input')(); };
  const send = async value => {
    typeDraft(value);
    node('#chat-form').listeners.get('submit')({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { open, show, disabled, rewrite, requests, node, stored, typeDraft, send,
    changeSelection(value) { selected = value; }, get staleSelections() { return staleSelections; },
    failStorageWrites() { storageWritesFail = true; }, get projectChanges() { return projectChanges; },
    get modalHTML() { return modalHTML; } };
}

const goalProposal = changes => ({ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', title: 'Uusi pyörä', price_eur: 10,
  requested_months: 5, monthly_eur: 5, projected_months: 2, verdict: 'yes_with_changes', as_of: '2026-09-30',
  conditions: [], tips: [], ...changes });
const savedGoal = changes => ({ ...goalProposal(), saved_eur: 0, created_at: '2026-11-14T10:00:00.000Z',
  memory_revision: '', ...changes });
const savingsRows = html => Object.fromEntries([...html.matchAll(/<div[^>]*><dt>([^<]+)<\/dt><dd>([^<]+)<\/dd><\/div>/g)]
  .map(([, label, value]) => [label, value.replace(/\s+/g, ' ')]));

test('opening a prepared answer leaves the question field unfocused for reading', t => {
  const view = dialogFixture(t);
  view.open('standard');
  assert.match(view.node('#chat-messages').innerHTML, /Ensimmäinen havainto/);
  assert.deepEqual(view.node('#chat-question').focusCalls, []);
});

test('chat completion never pulls focus back to the question field', async t => {
  for (const outcome of ['reply', 'error', 'automatic question', 'boundary follow-up']) {
    await t.test(outcome, async subtest => {
      const view = dialogFixture(subtest, 'standard', outcome === 'error' ? {
        respond: () => ({ ok: false, status: 503, json: async () => ({ error: 'Try again.' }) }),
      } : {});
      if (outcome === 'automatic question') {
        view.show('Miten voisin säästää?', { autoSend: true });
        await new Promise(resolve => setImmediate(resolve));
      } else if (outcome === 'boundary follow-up') {
        view.open('simple');
        await view.rewrite('simpler');
      } else {
        view.show();
        await view.send('Miten voisin säästää?');
      }
      assert.equal(view.requests.length, 1);
      assert.equal(view.node('#chat-question').disabled, false);
      assert.deepEqual(view.node('#chat-question').focusCalls, []);
      if (outcome === 'error') {
        assert.equal(view.node('#chat-error').textContent, 'Try again.');
        assert.equal(view.node('#chat-question').value, 'Miten voisin säästää?');
      } else {
        assert.match(view.node('#chat-messages').innerHTML, /Muokattu vastaus/);
      }
    });
  }
});

test('goal card separates existing savings, the extra amount and the total using the calculated project snapshot', async t => {
  const proposal = goalProposal();
  const existing = savedGoal({ id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', price_eur: 1000, monthly_eur: 50 });
  const completed = savedGoal({ id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', saved_eur: 10, monthly_eur: 200 });
  const { show, node, requests } = dialogFixture(t, 'standard', { proposal, projects: [existing, completed],
    beforeResponse(stored, key) { stored.set(key, JSON.stringify({ version: 1, revision: 'changed', projects: [] })); } });
  show('Haluan uuden pyörän.', { autoSend: true });
  await new Promise(resolve => setImmediate(resolve));
  const html = node('#chat-project-proposal').innerHTML, rows = savingsRows(html);
  assert.equal(requests[0].projects.length, 2);
  assert.equal(rows['Muille tavoitteille jo suunniteltu'], '50,00 € / kk');
  assert.equal(rows['Lisäksi tähän tavoitteeseen'], '+ 5,00 € / kk');
  assert.equal(rows['Tavoitteisiin yhteensä'], '55,00 € / kk');
  assert.match(html, /Jos haluat myös tämän tavoitteen/);
});

test('replanning replaces the previous pace and fully funded goals require no further monthly savings', async t => {
  const other = savedGoal({ id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', price_eur: 1000, monthly_eur: 50 });
  for (const complete of [false, true]) {
    await t.test(complete ? 'fully funded' : 'updated pace', async subtest => {
      const proposal = goalProposal({ projected_months: complete ? 0 : 2 });
      const previous = savedGoal({ monthly_eur: 20, saved_eur: complete ? 10 : 0 });
      const { show, node } = dialogFixture(subtest, 'standard', { proposal, projects: [previous, other] });
      show('Päivitä tavoite.', { autoSend: true });
      await new Promise(resolve => setImmediate(resolve));
      const html = node('#chat-project-proposal').innerHTML, rows = savingsRows(html);
      assert.equal(rows['Muille tavoitteille jo suunniteltu'], '50,00 € / kk');
      assert.equal(rows['Tälle tavoitteelle jatkossa'], complete ? '0,00 € / kk' : '5,00 € / kk');
      assert.equal(rows['Tavoitteisiin yhteensä'], complete ? '50,00 € / kk' : '55,00 € / kk');
      assert.match(html, complete ? /ei tarvita lisää kuukausisäästöä/ : /korvaa aiemman/);
      assert.doesNotMatch(html, /Lisäksi tähän tavoitteeseen/);
    });
  }
});

test('the first goal shows its own monthly amount without an empty existing-goals breakdown', async t => {
  const { show, node } = dialogFixture(t, 'standard', { proposal: goalProposal() });
  show('Haluan uuden pyörän.', { autoSend: true });
  await new Promise(resolve => setImmediate(resolve));
  const rows = savingsRows(node('#chat-project-proposal').innerHTML);
  assert.equal(rows['Tähän tavoitteeseen'], '5,00 € / kk');
  assert.equal(rows['Muille tavoitteille jo suunniteltu'], undefined);
  assert.equal(rows['Tavoitteisiin yhteensä'], undefined);
});

const projectKey = 'oma-talous-projects-v1:CUST00207';
async function confirmProposal(view) {
  const host = view.node('#chat-project-proposal');
  await host.listeners.get('click')({ currentTarget: host,
    target: { closest: selector => selector === '[data-project-confirm]' ? {} : null } });
}
const chatResponse = (request, result) => ({ ok: true, status: 200,
  json: async () => ({ answer: 'The bike goal was removed.', selection_id: 'selected-a', language: request.language, ...result }) });

test('replacing the bike with a car clearly reviews the change and preserves its account on confirmation', async t => {
  const bike = savedGoal({ title: 'Pyörä', price_eur: 1500, monthly_eur: 170, saved_eur: 300 });
  const proposal = goalProposal({ title: 'Auto', price_eur: 7000, requested_months: 48, projected_months: 47, monthly_eur: 145 });
  const view = dialogFixture(t, 'standard', { proposal, projects: [bike] });
  view.show();
  await view.send('En tarvitse enää pyörää, haluan auton.');
  const html = view.node('#chat-project-proposal').innerHTML;
  assert.match(html, /Tämä korvaa tavoitteen ”Pyörä”, kun vahvistat muutoksen\./);
  assert.match(html, /uusi kuukausisumma korvaa aiemman/);
  assert.match(html.replace(/\s/g, ' '), /demosaldo säilyy: 300,00 €/);
  assert.deepEqual(JSON.parse(view.stored.get(projectKey)).projects, [bike], 'review does not change the goal');
  await confirmProposal(view);
  const projects = JSON.parse(view.stored.get(projectKey)).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, bike.id);
  assert.equal(projects[0].title, 'Auto');
  assert.equal(projects[0].monthly_eur, 145);
  assert.equal(projects[0].saved_eur, 300);
  assert.equal(projects[0].created_at, bike.created_at);
  assert.equal(view.node('#chat-project-proposal').innerHTML, '');
  assert.equal(translate('Tämä korvaa tavoitteen ”Bike”, kun vahvistat muutoksen.', 'en'),
    'This replaces your goal “Bike” when you confirm the change.');
});

test('a successful coach deletion persists before showing success and releases the goal on the next request', async t => {
  const bike = savedGoal({ title: 'Bike', price_eur: 1500, monthly_eur: 170 });
  const other = savedGoal({ id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', title: 'Trip', price_eur: 1000 });
  let replies = 0;
  const view = dialogFixture(t, 'standard', { projects: [bike, other],
    respond: request => chatResponse(request, { project_removals: replies++ === 0 ? [bike.id] : [] }) });
  view.show();
  await view.send('Delete my bike goal.');
  assert.deepEqual(JSON.parse(view.stored.get(projectKey)).projects, [other]);
  assert.match(view.node('#chat-messages').innerHTML, /The bike goal was removed/);
  assert.match(view.node('#chat-messages').innerHTML, /Poistettu tämän selaimen tallennetuista tavoitteista: “Bike”/);
  assert.equal(view.projectChanges, 1);
  await view.send('Now plan a car.');
  assert.deepEqual(view.requests[1].projects, [other]);
});

test('deleting a goal and proposing a new one uses the new revision and remaining commitments for confirmation', async t => {
  const bike = savedGoal({ title: 'Bike', price_eur: 1500, monthly_eur: 170 });
  const proposal = goalProposal({ id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', title: 'Car',
    price_eur: 7000, monthly_eur: 150, requested_months: 48, projected_months: 47 });
  const view = dialogFixture(t, 'standard', { projects: [bike],
    respond: request => chatResponse(request, { project_removals: [bike.id], project_proposal: proposal }) });
  view.show();
  await view.send('Delete the bike goal and plan a car.');
  assert.deepEqual(JSON.parse(view.stored.get(projectKey)).projects, []);
  const rows = savingsRows(view.node('#chat-project-proposal').innerHTML);
  assert.equal(rows['Muille tavoitteille jo suunniteltu'], undefined);
  assert.equal(rows['Tähän tavoitteeseen'], '150,00 € / kk');
  await confirmProposal(view);
  const projects = JSON.parse(view.stored.get(projectKey)).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, proposal.id);
  assert.equal(projects[0].title, 'Car');
  assert.equal(projects[0].saved_eur, 0);
});

test('a deletion receipt stays visible through rewrites without extending bounded model history or applying twice', async t => {
  const bike = savedGoal({ title: '<Bike>', price_eur: 1500, monthly_eur: 170 });
  const answer = 'x'.repeat(6000);
  let replies = 0;
  const view = dialogFixture(t, 'standard', { projects: [bike], respond: request => chatResponse(request,
    replies++ === 0 ? { answer, project_removals: [bike.id] }
      : { answer: 'A shorter answer.', ...(request.rewrite ? { project_removals: [bike.id] } : {}) }) });
  view.stored.set(LANGUAGE_KEY, 'en');
  view.show();
  await view.send('Delete my bike goal.');
  assert.match(view.node('#chat-messages').innerHTML, /Removed from your saved goals in this browser: “&lt;Bike&gt;”/);
  assert.doesNotMatch(view.node('#chat-messages').innerHTML, /<Bike>/);
  const savedRevision = JSON.parse(view.stored.get(projectKey)).revision;
  await view.rewrite('simpler');
  assert.equal(view.requests[1].rewrite.answer, answer);
  assert.equal(view.requests[1].rewrite.answer.length, 6000);
  assert.match(view.node('#chat-messages').innerHTML, /A shorter answer/);
  assert.match(view.node('#chat-messages').innerHTML, /Removed from your saved goals in this browser/);
  assert.equal(JSON.parse(view.stored.get(projectKey)).revision, savedRevision);
  assert.equal(view.projectChanges, 1, 'a rewrite cannot repeat removal');
  await view.send('Thanks.');
  assert.equal(view.requests[2].messages[1].content, 'A shorter answer.');
  assert.equal(view.requests[2].messages[1].projectRemovalReceipt, undefined);
  assert.equal(view.node('#chat-error').textContent, '');
});

test('failed or stale coach deletions retain goals and suppress claimed success and a new proposal', async t => {
  for (const failure of ['conflict', 'unavailable', 'invalid']) {
    await t.test(failure, async subtest => {
      const bike = savedGoal({ title: 'Bike', price_eur: 1500, monthly_eur: 170 });
      const view = dialogFixture(subtest, 'standard', { projects: [bike],
        beforeResponse(stored, key) {
          if (failure === 'conflict') stored.set(key, JSON.stringify({ version: 1, revision: 'changed', projects: [bike] }));
        },
        respond: request => chatResponse(request, { project_removals: failure === 'invalid' ? ['not-an-id'] : [bike.id],
          project_proposal: goalProposal({ title: 'Car' }) }) });
      view.show();
      if (failure === 'unavailable') view.failStorageWrites();
      await view.send('Delete my bike goal.');
      assert.deepEqual(JSON.parse(view.stored.get(projectKey)).projects, [bike]);
      assert.doesNotMatch(view.node('#chat-messages').innerHTML, /The bike goal was removed/);
      assert.equal(view.node('#chat-project-proposal').innerHTML, '');
      assert.ok(view.node('#chat-error').textContent);
      assert.equal(view.projectChanges, 0);
    });
  }
});

test('the latest summary keeps both depth controls available at every level', t => {
  const { open, disabled } = dialogFixture(t, 'simple');
  for (const level of ['simple', 'standard', 'detailed']) {
    open(level);
    assert.equal(disabled('simpler'), false, level);
    assert.equal(disabled('deeper'), false, level);
  }
  for (const level of [undefined, null, 'unknown', 'constructor', 2]) {
    open(level);
    assert.equal(disabled('simpler'), false);
    assert.equal(disabled('deeper'), false);
  }
});

test('Simple chat hides source dates and keeps secondary information behind a disclosure', async t => {
  const view = dialogFixture(t, 'simple', { proposal: goalProposal() });
  view.show();
  assert.doesNotMatch(view.modalHTML, /30\.9\.2026|aineisto /);
  assert.match(view.modalHTML, /<details class="chat-data-note">/);
  assert.match(view.modalHTML, /Kysy menoista, säästämisestä tai omasta tavoitteestasi/);
  view.show.openInsight({ customerId: 'CUST00207', asOf: '2026-09-30', level: 'simple',
    card: { id: 'yearly', period: 'yearly', title: 'Valitse suosikkisi', headline_number: '130 €',
      explanation: 'Ravintoloihin kului eniten.', action: 'Valitse yksi käynti vähemmän.' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(view.modalHTML, /2025|2026|12 kk|chat-context-note/);
  assert.match(view.modalHTML, /Vuosinosto/);
  assert.doesNotMatch(view.node('#chat-project-proposal').innerHTML, /30\.9\.2026/);
  assert.match(view.node('#chat-project-proposal').innerHTML, /Arvio aiemmista tiedoista/);
});

test('summary presentation follows its supplied depth and keeps dates in coach context', t => {
  const view = dialogFixture(t, 'detailed');
  view.show.openExploration({ question: 'Mihin rahani menivät? Tarkasteltava kuukausi: 2026-08.',
    displayQuestion: 'Mihin rahani menivät?', answer: 'Ravintoloihin kului eniten.',
    bullets: ['Ravintoloihin kului eniten.', 'Valitse yksi käynti vähemmän.'],
    selectionId: 'selected-a', level: 'simple' });
  assert.doesNotMatch(view.modalHTML, /30\.9\.2026/);
  assert.doesNotMatch(view.node('#chat-messages').innerHTML, /2026-08/);
  view.open('standard');
  assert.match(view.modalHTML, /30\.9\.2026/);
  assert.doesNotMatch(view.modalHTML, /chat-data-note/);
});

test('rewriting a detailed summary steps down in place while later questions keep the global level', async t => {
  const { open, disabled, rewrite, requests, node, stored } = dialogFixture(t, 'detailed');
  open('detailed');
  await rewrite('simpler');
  assert.equal(requests[0].level, 'standard');
  assert.deepEqual(requests[0].rewrite, { answer: 'Alkuperäinen vastaus.' });
  assert.deepEqual(requests[0].messages, [{ role: 'user', content: 'Miten voisin säästää?' }]);
  assert.equal(disabled('simpler'), false);
  assert.equal(disabled('deeper'), false);
  assert.doesNotMatch(node('#chat-messages').innerHTML, /Ensimmäinen havainto/);
  await rewrite('simpler');
  assert.equal(requests[1].level, 'simple');
  assert.deepEqual(requests[1].rewrite, { answer: 'Alkuperäinen vastaus.' });
  assert.equal(disabled('simpler'), false);
  assert.equal(stored.get(LEVEL_KEY), 'detailed');
  node('#chat-question').value = 'Entä ensi kuussa?';
  node('#chat-question').listeners.get('input')();
  node('#chat-form').listeners.get('submit')({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[2].level, 'detailed');
  assert.equal(requests[2].rewrite, undefined);
  assert.equal((node('#chat-messages').innerHTML.match(/class="chat-message assistant"/g) || []).length, 2);
  assert.equal((node('#chat-messages').innerHTML.match(/class="chat-depth-actions"/g) || []).length, 1);
  assert.doesNotMatch(node('#chat-messages').innerHTML, /data-answer-index="1"/);
  assert.match(node('#chat-messages').innerHTML, /data-answer-index="3"/);
  await rewrite('simpler', 1);
  assert.equal(requests.length, 3, 'stale controls cannot rewrite an older reply');
});

test('boundary controls send ordinary localized follow-ups without changing the global depth or draft', async t => {
  for (const [language, level, direction, question] of [
    ['fi', 'simple', 'simpler', 'Selitä tämä vielä yksinkertaisemmin.'],
    ['fi', 'detailed', 'deeper', 'Kerro tästä vielä tarkemmin.'],
    ['en', 'simple', 'simpler', 'Explain this even more simply.'],
    ['en', 'detailed', 'deeper', 'Give me more detail about this.'],
  ]) {
    await t.test(`${language} ${direction}`, async subtest => {
      const view = dialogFixture(subtest, 'standard');
      view.stored.set(LANGUAGE_KEY, language);
      view.open(level);
      view.typeDraft('Unfinished purchase question');
      await view.rewrite(direction);
      assert.equal(view.requests.length, 1);
      const request = view.requests[0];
      assert.equal(request.level, level);
      assert.equal(request.language, language);
      assert.equal(request.rewrite, undefined);
      assert.deepEqual(request.messages, [
        { role: 'user', content: 'Miten voisin säästää?' },
        { role: 'assistant', content: 'Alkuperäinen vastaus.' },
        { role: 'user', content: question },
      ]);
      assert.equal(view.stored.get(LEVEL_KEY), 'standard');
      assert.equal(view.node('#chat-question').value, 'Unfinished purchase question');
      const html = view.node('#chat-messages').innerHTML;
      assert.ok(html.includes(question));
      assert.equal((html.match(/class="chat-message assistant"/g) || []).length, 2);
      assert.equal((html.match(/class="chat-depth-actions"/g) || []).length, 1);
      assert.match(html, /data-answer-index="3"/);
      assert.doesNotMatch(html, /data-answer-index="1"/);
      await view.rewrite(direction, 1);
      assert.equal(view.requests.length, 1, 'stale boundary controls cannot send another follow-up');
      await view.send('Another question');
      assert.equal(view.requests[1].level, 'standard');
    });
  }
});

test('a failed boundary follow-up keeps the answer and unfinished draft, then permits retry', async t => {
  let attempts = 0;
  const view = dialogFixture(t, 'standard', { respond: request => {
    attempts++;
    return attempts === 1 ? { ok: false, status: 503, json: async () => ({ error: 'Try again.' }) }
      : { ok: true, status: 200, json: async () => ({ answer: 'A clearer answer.', language: request.language, selection_id: 'selected-a' }) };
  } });
  view.open('simple');
  view.typeDraft('My own draft');
  await view.rewrite('simpler');
  assert.equal(view.node('#chat-question').value, 'My own draft');
  assert.equal(view.node('#chat-error').textContent, 'Try again.');
  assert.match(view.node('#chat-messages').innerHTML, /Ensimmäinen havainto/);
  assert.doesNotMatch(view.node('#chat-messages').innerHTML, /Selitä tämä vielä yksinkertaisemmin/);
  assert.equal(view.disabled('simpler'), false);
  await view.rewrite('simpler');
  assert.equal(view.requests.length, 2);
  assert.match(view.node('#chat-messages').innerHTML, /A clearer answer/);
  assert.equal(view.node('#chat-question').value, 'My own draft');
});

test('boundary controls block duplicate requests and discard replies after customer selection changes', async t => {
  let finish;
  const view = dialogFixture(t, 'standard', { respond: () => new Promise(resolve => { finish = resolve; }) });
  view.open('simple');
  await view.rewrite('simpler');
  assert.equal(view.disabled('simpler'), true);
  assert.equal(view.disabled('deeper'), true);
  await view.rewrite('simpler', 1);
  assert.equal(view.requests.length, 1);
  view.changeSelection({ customer_id: 'CUST00127', selection_id: 'selected-b', as_of: '2026-09-30' });
  view.show();
  finish({ ok: true, status: 200, json: async () => ({ answer: 'Old customer answer', selection_id: 'selected-a' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(view.node('#chat-messages').innerHTML, /Old customer answer|Alkuperäinen vastaus/);
  view.open('simple');
  assert.equal(view.staleSelections, 1, 'the old summary cannot reopen under another customer');
});

test('a customer change prevents a boundary click from sending the previous conversation', async t => {
  const view = dialogFixture(t, 'standard');
  view.open('simple');
  view.changeSelection({ customer_id: 'CUST00127', selection_id: 'selected-b', as_of: '2026-09-30' });
  await view.rewrite('simpler');
  assert.equal(view.requests.length, 0);
  assert.equal(view.staleSelections, 1);
});
