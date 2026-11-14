import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatDialog } from '../public/chat.js';
import { LEVEL_KEY } from '../public/answer-depth.js';

function dialogFixture(t, preference = 'standard', { proposal, projects = [], beforeResponse } = {}) {
  const replaceGlobal = (key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  };
  const stored = new Map([[LEVEL_KEY, preference]]), requests = [], nodes = new Map();
  replaceGlobal('addEventListener', () => {});
  replaceGlobal('localStorage', { getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value) });
  const selection = { customer_id: 'CUST00207', selection_id: 'selected-a', as_of: '2026-09-30' };
  const projectKey = 'oma-talous-projects-v1:' + selection.customer_id;
  if (projects.length) stored.set(projectKey, JSON.stringify({ version: 1, revision: 'initial', projects }));
  replaceGlobal('fetch', async (url, options) => {
    assert.equal(url, '/api/chat');
    requests.push(JSON.parse(options.body));
    beforeResponse?.(stored, projectKey);
    return { ok: true, status: 200, json: async () => ({ answer: 'Muokattu vastaus.', selection_id: selection.selection_id,
      ...(proposal ? { project_proposal: proposal } : {}) }) };
  });
  // A minimal dialog surface exercises the real event handlers and rendered controls.
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', value: '', dataset: {},
      listeners: new Map(), classList: { toggle() {} }, setAttribute() {}, focus() {},
      querySelector: node, querySelectorAll: () => [],
      addEventListener(type, callback) { this.listeners.set(type, callback); } });
    return nodes.get(selector);
  };
  const detail = { open: true, querySelector: node, querySelectorAll: () => [] };
  const show = createChatDialog({ detail, modal() {}, icon: () => '', getSelection: () => selection });
  const open = level => show.openExploration({ question: 'Miten voisin säästää?', displayQuestion: 'Säästövinkki',
    answer: 'Alkuperäinen vastaus.', bullets: ['Ensimmäinen havainto.', 'Toinen havainto.'],
    selectionId: selection.selection_id, level });
  const disabled = direction => {
    const button = node('#chat-messages').innerHTML.match(new RegExp(`<button[^>]*data-depth="${direction}"[^>]*>`));
    assert.ok(button, `Missing ${direction} button`);
    return /\bdisabled\b/.test(button[0]);
  };
  const rewrite = async direction => {
    const button = { disabled: disabled(direction), dataset: { depth: direction, answerIndex: '1' } };
    node('#chat-messages').listeners.get('click')({ target: { closest: () => button } });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { open, show, disabled, rewrite, requests, node, stored };
}

const goalProposal = changes => ({ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', title: 'Uusi pyörä', price_eur: 10,
  requested_months: 5, monthly_eur: 5, projected_months: 2, verdict: 'yes_with_changes', as_of: '2026-09-30',
  conditions: [], tips: [], ...changes });
const savedGoal = changes => ({ ...goalProposal(), saved_eur: 0, created_at: '2026-11-14T10:00:00.000Z',
  memory_revision: '', ...changes });
const savingsRows = html => Object.fromEntries([...html.matchAll(/<div[^>]*><dt>([^<]+)<\/dt><dd>([^<]+)<\/dd><\/div>/g)]
  .map(([, label, value]) => [label, value.replace(/\s+/g, ' ')]));

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

test('summary answers retain their supplied depth instead of inheriting the global setting', t => {
  const { open, disabled } = dialogFixture(t, 'simple');
  for (const [level, simpler, deeper] of [['simple', true, false], ['standard', false, false], ['detailed', false, true]]) {
    open(level);
    assert.equal(disabled('simpler'), simpler, level);
    assert.equal(disabled('deeper'), deeper, level);
  }
  for (const level of [undefined, null, 'unknown', 'constructor', 2]) {
    open(level);
    assert.equal(disabled('simpler'), true, 'legacy or invalid levels retain the plain-language fallback');
    assert.equal(disabled('deeper'), false);
  }
});

test('rewriting a detailed summary steps down in place while later questions keep the global level', async t => {
  const { open, disabled, rewrite, requests, node, stored } = dialogFixture(t, 'detailed');
  open('detailed');
  await rewrite('deeper');
  assert.equal(requests.length, 0, 'the deepest answer cannot be deepened again');
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
  assert.equal(disabled('simpler'), true);
  assert.equal(stored.get(LEVEL_KEY), 'detailed');
  node('#chat-question').value = 'Entä ensi kuussa?';
  node('#chat-question').listeners.get('input')();
  node('#chat-form').listeners.get('submit')({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[2].level, 'detailed');
  assert.equal(requests[2].rewrite, undefined);
  assert.equal((node('#chat-messages').innerHTML.match(/class="chat-message assistant"/g) || []).length, 2);
});
