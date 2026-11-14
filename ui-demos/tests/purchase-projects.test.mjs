import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseProjects, validProjectProposal, validProjectContext, projectProgress, projectHint,
  MAX_PURCHASE_PROJECTS } from '../public/purchase-projects.js';

const customer = 'CUST00207', other = 'CUST00127', prefix = 'oma-talous-projects-v1:';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tip = { category: 'Restaurants', line: 'restaurants', label: 'Ravintolat', amount_eur: 25,
  text: 'Jos jätät yhden vapaaehtoisen ostoksen väliin, voit siirtää säästyneen summan tavoitteeseen.' };
const proposal = (n = 1, changes = {}) => ({ id: id(n), title: 'Sähköpyörä', price_eur: 1500, requested_months: 6,
  monthly_eur: 250, projected_months: 6, verdict: 'yes', as_of: '2026-09-30', conditions: [], tips: [tip], ...changes });
const project = changes => ({ ...proposal(), saved_eur: 0, created_at: '2026-11-14T12:00:00.000Z', memory_revision: '', ...changes });
function storageFixture() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function exclusiveLocks() {
  const queues = new Map();
  return { async request(name, { signal, mode }, callback) {
    assert.equal(mode, 'exclusive');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const previous = queues.get(name) || Promise.resolve();
    let release, abort;
    const next = new Promise(resolve => { release = resolve; }); queues.set(name, next);
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
    });
    try {
      await (signal ? Promise.race([previous, cancelled]) : previous);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return await callback({ name, mode });
    } finally {
      signal?.removeEventListener('abort', abort);
      void previous.then(release, release);
      void next.then(() => { if (queues.get(name) === next) queues.delete(name); });
    }
  } };
}
const create = options => createPurchaseProjects({ locks: exclusiveLocks(), ...options });
async function hold(locks) {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = locks.request(prefix + customer, { mode: 'exclusive' }, () => {
    entered(); return new Promise(resolve => { release = resolve; });
  });
  await ready; return { held, release };
}

test('confirmed projects persist across reloads and remain isolated to the selected customer', async () => {
  const storage = storageFixture(), now = () => Date.parse('2026-11-14T12:00:00Z');
  const store = create({ storage, now });
  assert.deepEqual(store.read(customer), { projects: [], revision: '', available: true });
  const saved = await store.confirm(customer, proposal(), '');
  assert.equal(saved.saved, true);
  assert.deepEqual(saved.projects, [project()]);
  assert.notEqual(saved.revision, '');
  const restored = create({ storage }).read(customer);
  assert.deepEqual(restored.projects, [project()]);
  assert.equal(restored.revision, saved.revision);
  assert.deepEqual(store.read(other).projects, []);
  await store.confirm(other, proposal(2), '');
  assert.deepEqual(store.read(customer).projects, [project()]);
  restored.projects[0].tips[0].text = 'Caller mutation';
  restored.projects[0].conditions.push('Caller mutation');
  assert.deepEqual(store.read(customer).projects, [project()]);
});

test('only recorded savings advance progress, and corrected totals can move it back', async () => {
  const storage = storageFixture(); let time = Date.parse('2026-11-14T12:00:00Z');
  const store = create({ storage, now: () => time });
  const started = await store.confirm(customer, proposal(), '');
  time += 365 * 24 * 60 * 60 * 1000;
  assert.deepEqual(projectProgress(store.read(customer).projects[0]), { remaining_eur: 1500, percent: 0, months_remaining: 6 });
  const added = await store.setSaved(customer, id(1), 500, started.revision);
  assert.equal(added.saved, true);
  assert.deepEqual(projectProgress(added.projects[0]), { remaining_eur: 1000, percent: 33.33, months_remaining: 4 });
  const corrected = await store.setSaved(customer, id(1), 250, added.revision);
  assert.equal(corrected.saved, true);
  assert.deepEqual(projectProgress(corrected.projects[0]), { remaining_eur: 1250, percent: 16.67, months_remaining: 5 });
  assert.equal(corrected.projects[0].created_at, '2026-11-14T12:00:00.000Z');
});

test('projects retain the preference revision used at confirmation across savings edits', async () => {
  const store = create({ storage: storageFixture() });
  const memoryRevision = id(99);
  const started = await store.confirm(customer, proposal(), '', { memoryRevision });
  assert.equal(started.saved, true);
  assert.equal(started.projects[0].memory_revision, memoryRevision);
  assert.equal(validProjectContext(started.projects), true);
  const progressed = await store.setSaved(customer, id(1), 100, started.revision);
  assert.equal(progressed.projects[0].memory_revision, memoryRevision);
  assert.equal(store.read(customer).projects[0].memory_revision, memoryRevision);
  const duplicate = await store.confirm(customer, proposal(), progressed.revision, { memoryRevision });
  assert.equal(duplicate.saved, true);
  assert.equal(duplicate.projects[0].memory_revision, memoryRevision);
  assert.equal(duplicate.revision, progressed.revision);
  const revised = await store.confirm(customer, proposal(), duplicate.revision, { memoryRevision: id(100) });
  assert.equal(revised.saved, true);
  assert.equal(revised.projects[0].memory_revision, id(100), 'a newly confirmed plan records its current preference revision');
  assert.equal(revised.projects[0].saved_eur, 100);
  assert.equal((await store.confirm(customer, proposal(2), revised.revision, { memoryRevision: '../invalid' })).reason, 'invalid');
});

test('reconfirming the same proposal never duplicates a project or resets recorded savings', async () => {
  const store = create({ storage: storageFixture() });
  const started = await store.confirm(customer, proposal(), '');
  const progressed = await store.setSaved(customer, id(1), 456.78, started.revision);
  const duplicate = await store.confirm(customer, proposal(), progressed.revision);
  assert.equal(duplicate.saved, true);
  assert.equal(duplicate.revision, progressed.revision);
  assert.equal(duplicate.projects.length, 1);
  assert.equal(duplicate.projects[0].saved_eur, 456.78);
  assert.equal((await store.confirm(customer, proposal(), '')).reason, 'conflict');
});

test('confirmed replanning updates the existing project and preserves recorded savings even at capacity', async () => {
  const store = create({ storage: storageFixture(), now: () => Date.parse('2026-11-14T12:00:00Z') });
  let state = store.read(customer);
  for (let n = 1; n <= 3; n++) state = await store.confirm(customer, proposal(n), state.revision);
  state = await store.setSaved(customer, id(1), 456.78, state.revision);
  const original = state.projects[0];
  const revisedProposal = proposal(1, { requested_months: 12, monthly_eur: 125, projected_months: 12,
    tips: [{ ...tip, category: 'Lifestyle', line: 'lifestyle', label: 'Ostokset', amount_eur: 12 }],
    conditions: ['Ravintoloista ei tarvitse tinkiä.'] });
  const revised = await store.confirm(customer, revisedProposal, state.revision, { memoryRevision: id(100) });
  assert.equal(revised.saved, true);
  assert.equal(revised.projects.length, 3);
  assert.equal(revised.projects[0].saved_eur, 456.78);
  assert.equal(revised.projects[0].created_at, original.created_at);
  assert.equal(revised.projects[0].requested_months, 12);
  assert.equal(revised.projects[0].monthly_eur, 125);
  assert.deepEqual(revised.projects[0].tips, revisedProposal.tips);
  assert.equal(revised.projects[0].memory_revision, id(100));
  assert.deepEqual(revised.projects.slice(1), state.projects.slice(1));
  const repeated = await store.confirm(customer, revisedProposal, revised.revision, { memoryRevision: id(100) });
  assert.equal(repeated.revision, revised.revision);
  assert.equal(repeated.projects[0].saved_eur, 456.78);
  const smaller = await store.confirm(customer, proposal(1, { price_eur: 300 }), repeated.revision);
  assert.equal(smaller.saved, true);
  assert.equal(smaller.projects[0].saved_eur, 456.78, 'a cheaper target must not erase any demo account balance');
  assert.deepEqual(projectProgress(smaller.projects[0]), { remaining_eur: 0, percent: 100, months_remaining: 0 });
  assert.equal(smaller.projects[0].created_at, original.created_at);
  assert.equal((await store.confirm(customer, revisedProposal, state.revision)).reason, 'conflict');
});

test('three-project limit never silently evicts an ongoing project', async () => {
  assert.equal(MAX_PURCHASE_PROJECTS, 3);
  const store = create({ storage: storageFixture() }); let state = store.read(customer);
  for (let n = 1; n <= 3; n++) state = await store.confirm(customer, proposal(n), state.revision);
  const refused = await store.confirm(customer, proposal(4), state.revision);
  assert.equal(refused.saved, false); assert.equal(refused.reason, 'full');
  assert.deepEqual(store.read(customer).projects.map(item => item.id), [id(1), id(2), id(3)]);
  const removed = await store.remove(customer, id(2), state.revision);
  assert.equal((await store.confirm(customer, proposal(4), removed.revision)).saved, true);
});

test('proposal and saved-context validation reject extra identity fields and malformed financial values', () => {
  assert.equal(validProjectProposal(proposal()), true);
  assert.equal(validProjectContext([project()]), true);
  assert.equal(validProjectContext([]), true);
  for (const changes of [
    { customer_id: other }, { id: '../another-customer' }, { title: '' }, { title: ' Untrimmed' }, { title: 'x'.repeat(81) },
    { price_eur: 0 }, { price_eur: 1.001 }, { price_eur: Infinity }, { price_eur: '1500' }, { price_eur: 1000000.01 },
    { monthly_eur: -1 }, { monthly_eur: 1.234 }, { requested_months: 0 }, { requested_months: 61 }, { requested_months: 1.5 },
    { projected_months: -1 }, { projected_months: 6001 }, { projected_months: 1.5 }, { verdict: 'guaranteed' },
    { as_of: '2026-02-30' }, { as_of: 'now' }, { conditions: Array(1) }, { conditions: [''] },
    { conditions: ['x'.repeat(241)] }, { conditions: Array(7).fill('Condition') },
    { tips: [{ ...tip, category: 'Housing' }] }, { tips: [{ ...tip, amount_eur: -1 }] }, { tips: [{ ...tip, amount_eur: 0.001 }] },
    { tips: [{ ...tip, extra: true }] }, { tips: Array(4).fill(tip) }, { tips: Array(1) },
  ]) assert.equal(validProjectProposal(proposal(1, changes)), false, JSON.stringify(changes));
  for (const changes of [{ saved_eur: -1 }, { saved_eur: 1000000.01 }, { saved_eur: 1.234 }, { saved_eur: '20' },
    { created_at: '2026-02-30T12:00:00.000Z' }, { created_at: 'now' }, { memory_revision: undefined },
    { memory_revision: '../invalid' }, { memory_revision: null }, { extra: true }]) {
    assert.equal(validProjectContext([project(changes)]), false, JSON.stringify(changes));
  }
  assert.equal(validProjectContext([project(), project()]), false);
  assert.equal(validProjectContext([proposal()]), false);
  assert.equal(validProjectContext(Array(1)), false);
  assert.equal(validProjectProposal(proposal(1, { price_eur: 0.29 })), true, 'normal cent amounts tolerate binary floating-point representation');
});

test('demo monthly deposits update only the selected account, persist, and stop at the goal', async () => {
  const storage = storageFixture(), store = create({ storage });
  let current = await store.confirm(customer, proposal(1, { price_eur: 600, monthly_eur: 250 }), '');
  const originalRevision = current.revision;
  await store.confirm(other, proposal(2), '');
  current = await store.simulateMonthlyDeposit(customer, id(1), current.revision);
  assert.equal(current.saved, true);
  assert.equal(current.projects[0].saved_eur, 250);
  assert.equal(create({ storage }).read(customer).projects[0].saved_eur, 250);
  assert.equal(store.read(other).projects[0].saved_eur, 0);
  assert.equal((await store.simulateMonthlyDeposit(customer, id(1), originalRevision)).reason, 'conflict');
  current = await store.simulateMonthlyDeposit(customer, id(1), current.revision);
  assert.equal(current.projects[0].saved_eur, 500);
  current = await store.simulateMonthlyDeposit(customer, id(1), current.revision);
  assert.equal(current.projects[0].saved_eur, 600, 'last simulated deposit is capped at the remaining target');
  assert.deepEqual(projectProgress(current.projects[0]), { remaining_eur: 0, percent: 100, months_remaining: 0 });
  const complete = await store.simulateMonthlyDeposit(customer, id(1), current.revision);
  assert.equal(complete.revision, current.revision);
  assert.equal((await store.simulateMonthlyDeposit(customer, id(2), current.revision)).reason, 'not_found');
  assert.equal((await store.simulateMonthlyDeposit(customer, 'invalid-id', current.revision)).reason, 'invalid');
});

test('demo deposits use exact cents and cannot advance a project with no agreed saving pace', async () => {
  const store = create({ storage: storageFixture() });
  let current = await store.confirm(customer, proposal(1, { price_eur: 0.3, monthly_eur: 0.1 }), '');
  for (let step = 1; step <= 3; step++) {
    current = await store.simulateMonthlyDeposit(customer, id(1), current.revision);
    assert.equal(current.projects[0].saved_eur, step / 10);
  }
  current = await store.confirm(customer, proposal(2, { monthly_eur: 0 }), current.revision);
  assert.equal((await store.simulateMonthlyDeposit(customer, id(2), current.revision)).reason, 'invalid');
  assert.equal(store.read(customer).projects[1].saved_eur, 0);
});

test('progress and extra-saving projections use cents and handle zero pace and completion', () => {
  const tiny = project({ price_eur: 0.3, saved_eur: 0.1, monthly_eur: 0.1 });
  assert.deepEqual(projectProgress(tiny), { remaining_eur: 0.2, percent: 33.33, months_remaining: 2 });
  assert.deepEqual(projectProgress(project({ monthly_eur: 0, projected_months: null, verdict: 'not_now' })),
    { remaining_eur: 1500, percent: 0, months_remaining: null });
  assert.deepEqual(projectProgress(project({ saved_eur: 1500, monthly_eur: 0 })),
    { remaining_eur: 0, percent: 100, months_remaining: 0 });
  assert.equal(projectProgress(project({ price_eur: 1000000, saved_eur: 999999.99 })).percent, 99.99,
    'rounding must not mark an unfinished project as fully funded');
  const current = project({ saved_eur: 1490 });
  assert.deepEqual(projectHint(current, tip), { extra_eur: 10, months_after: 0, days_faster: 1 });
  assert.equal(current.saved_eur, 1490, 'a hypothetical tip never records a saving');
  assert.deepEqual(projectHint(project(), tip), { extra_eur: 25, months_after: 6, days_faster: 3 });
  assert.deepEqual(projectHint(project({ monthly_eur: 0 }), tip), { extra_eur: 25, months_after: null, days_faster: 0 });
  assert.deepEqual(projectHint(project({ saved_eur: 1500 }), tip), { extra_eur: 0, months_after: 0, days_faster: 0 });
  assert.throws(() => projectProgress(proposal()));
  assert.throws(() => projectHint(project(), { ...tip, amount_eur: Infinity }));
});

test('invalid progress edits and missing project IDs leave stored values untouched', async () => {
  const store = create({ storage: storageFixture() });
  const state = await store.confirm(customer, proposal(), '');
  for (const value of [-1, 1500.01, 1.234, Infinity, NaN, '20']) {
    const result = await store.setSaved(customer, id(1), value, state.revision);
    assert.equal(result.reason, 'invalid');
  }
  assert.equal((await store.setSaved(customer, id(2), 20, state.revision)).reason, 'not_found');
  assert.equal((await store.remove(customer, id(2), state.revision)).reason, 'not_found');
  assert.equal(store.read(customer).projects[0].saved_eur, 0);
  assert.equal(store.read(customer).revision, state.revision);
});

test('concurrent tabs serialize removal and reject stale progress or confirmation', async () => {
  const storage = storageFixture(), locks = exclusiveLocks();
  const first = create({ storage, locks }), second = create({ storage, locks });
  const started = await first.confirm(customer, proposal(), '');
  const blocked = await hold(locks);
  const removal = first.remove(customer, id(1), started.revision);
  const lateProgress = second.setSaved(customer, id(1), 200, started.revision);
  const lateConfirm = second.confirm(customer, proposal(), started.revision);
  blocked.release(); await blocked.held;
  assert.equal((await removal).saved, true);
  assert.equal((await lateProgress).reason, 'conflict');
  assert.equal((await lateConfirm).reason, 'conflict');
  const empty = first.read(customer);
  assert.deepEqual(empty.projects, []);
  assert.notEqual(empty.revision, '');
  assert.notEqual(empty.revision, started.revision);
});

test('a cancelled confirmation waiting for another tab cannot save into a later conversation', async () => {
  const storage = storageFixture(), locks = exclusiveLocks(), store = create({ storage, locks });
  const blocked = await hold(locks), controller = new AbortController();
  const pending = store.confirm(customer, proposal(), '', { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).reason, 'cancelled');
  blocked.release(); await blocked.held;
  assert.deepEqual(store.read(customer).projects, []);
  assert.equal((await store.confirm(customer, proposal(2), '')).saved, true);
});

test('queued operations snapshot the proposal rather than retaining a mutable caller object', async () => {
  const storage = storageFixture(), locks = exclusiveLocks(), store = create({ storage, locks });
  const blocked = await hold(locks), candidate = proposal();
  const pending = store.confirm(customer, candidate, '');
  candidate.title = 'Changed after confirmation'; candidate.tips[0] = { ...tip, amount_eur: 999 };
  blocked.release(); await blocked.held;
  const saved = await pending;
  assert.equal(saved.projects[0].title, 'Sähköpyörä');
  assert.equal(saved.projects[0].tips[0].amount_eur, 25);
});

test('blocked, corrupted and lockless storage never reports a successful save or overwrites data', async () => {
  const storage = storageFixture();
  for (const raw of ['{bad', JSON.stringify({ version: 2, revision: 'test', projects: [] }),
    JSON.stringify({ version: 1, revision: 'test', projects: [{ ...project(), saved_eur: 1000000.01 }] })]) {
    storage.values.set(prefix + customer, raw);
    const store = create({ storage });
    assert.equal(store.read(customer).available, false);
    assert.equal((await store.confirm(customer, proposal(), '')).reason, 'unavailable');
    assert.equal(storage.values.get(prefix + customer), raw);
  }
  for (const store of [
    create({ storage: null }), create({ storage: { getItem() { throw Error('blocked'); }, setItem() {} } }),
    create({ storage: { getItem: () => null, setItem() { throw Error('quota'); } } }),
    create({ storage: storageFixture(), locks: null }),
    create({ storage: storageFixture(), locks: { request() { throw Error('blocked'); } } }),
  ]) {
    const result = await store.confirm(customer, proposal(), '');
    assert.equal(result.saved, false); assert.equal(result.reason, 'unavailable');
  }
  const store = create({ storage: storageFixture() });
  assert.equal((await store.confirm('../customer', proposal(), '')).reason, 'invalid');
  assert.equal((await store.confirm(customer, proposal(), '../revision')).reason, 'invalid');
});
