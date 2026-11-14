import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerMemory as createStore, validMemoryFacts, validMemoryUpdates, MAX_MEMORY_FACTS } from '../public/customer-memory.js';

// One origin-wide FIFO lock manager shared by every simulated browser tab.
function exclusiveLocks() {
  const queues = new Map();
  return { async request(name, { signal, mode }, callback) {
    assert.equal(mode, 'exclusive');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const previous = queues.get(name) || Promise.resolve();
    let release, abort;
    const current = new Promise(resolve => { release = resolve; });
    queues.set(name, current);
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
      // A cancelled waiter must not allow later jobs to pass the current owner.
      void previous.then(release, release);
      void current.then(() => { if (queues.get(name) === current) queues.delete(name); });
    }
  } };
}
const testLocks = exclusiveLocks();
const createCustomerMemory = options => createStore({ locks: testLocks, ...options });

const customer = 'CUST00207', other = 'CUST00127';
const restaurant = { key: 'restaurants', text: 'En halua vähentää ravintolakäyntejä.' };
const remember = fact => ({ action: 'remember', ...fact });
function storageFixture() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

async function holdCustomerLock(locks, id) {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = locks.request(`oma-talous-memory-v1:${id}`, { mode: 'exclusive' }, () => {
    entered();
    return new Promise(resolve => { release = resolve; });
  });
  await started;
  return { release, held };
}

test('customer facts persist across new conversations and fresh store instances without mixing customers', async () => {
  const storage = storageFixture(), memory = createCustomerMemory({ storage });
  assert.deepEqual(memory.read(customer), { facts: [], revision: '', available: true });
  const saved = await memory.apply(customer, [remember(restaurant)], '');
  assert.equal(saved.saved, true);
  assert.notEqual(saved.revision, '');
  const restored = createCustomerMemory({ storage }).read(customer);
  assert.deepEqual(restored.facts, [restaurant]);
  assert.equal(restored.revision, saved.revision);
  assert.deepEqual(memory.read(other), { facts: [], revision: '', available: true });
  await memory.apply(other, [remember({ key: 'holiday', text: 'Säästän lomaa varten.' })], '');
  assert.deepEqual(memory.read(customer).facts, [restaurant]);
  restored.facts[0].text = 'Changed only in this caller';
  assert.deepEqual(memory.read(customer).facts, [restaurant]);
});

test('remember replaces the same preference and keeps unrelated facts', async () => {
  const memory = createCustomerMemory({ storage: storageFixture() });
  const goal = { key: 'bicycle', text: 'Säästän polkupyörää varten.' };
  const first = await memory.apply(customer, [remember(restaurant), remember(goal)], '');
  const changed = { ...restaurant, text: 'Voin vähentää ravintolakäyntejä.' };
  const second = await memory.apply(customer, [remember(changed)], first.revision);
  assert.equal(second.saved, true);
  assert.deepEqual(second.facts, [changed, goal]);
  const removed = await memory.remove(customer, 'restaurants', second.revision);
  assert.equal(removed.saved, true);
  assert.deepEqual(removed.facts, [goal]);
});

test('fact and update schemas reject unknown fields, bad keys, duplicates and oversized content', () => {
  assert.equal(MAX_MEMORY_FACTS, 12);
  assert.equal(validMemoryFacts([]), true);
  assert.equal(validMemoryFacts([restaurant]), true);
  assert.equal(validMemoryUpdates([remember(restaurant), { action: 'forget', key: restaurant.key }]), true);
  for (const invalid of [null, {}, [null], Array(1), [restaurant, restaurant], [{ ...restaurant, customer_id: other }],
    [{ key: '', text: 'Fact' }], [{ key: '../customer', text: 'Fact' }], [{ key: 'x'.repeat(41), text: 'Fact' }],
    [{ key: 'x', text: '' }], [{ key: 'x', text: '  ' }], [{ key: 'x', text: ' Fact' }],
    [{ key: 'x', text: 'x'.repeat(201) }], Array.from({ length: 13 }, (_, i) => ({ key: `fact${i}`, text: 'Fact' }))]) {
    assert.equal(validMemoryFacts(invalid), false, JSON.stringify(invalid));
  }
  for (const invalid of [null, {}, [restaurant], [null], Array(1), [{ action: 'clear' }],
    [{ action: 'remember', key: 'x', text: 'Fact', customer_id: other }],
    [{ action: 'forget', key: 'x', text: 'Fact' }], [{ action: 'forget', key: '' }],
    Array.from({ length: 7 }, () => remember(restaurant))]) {
    assert.equal(validMemoryUpdates(invalid), false, JSON.stringify(invalid));
  }
});

test('full memory rejects new facts atomically without silently discarding old preferences', async () => {
  const memory = createCustomerMemory({ storage: storageFixture() });
  const facts = Array.from({ length: MAX_MEMORY_FACTS }, (_, i) => ({ key: `fact${i}`, text: `Preference ${i}` }));
  const first = await memory.apply(customer, facts.slice(0, 6).map(remember), '');
  const second = await memory.apply(customer, facts.slice(6).map(remember), first.revision);
  const rejected = await memory.apply(customer, [remember(restaurant)], second.revision);
  assert.equal(rejected.saved, false);
  assert.equal(rejected.reason, 'full');
  assert.deepEqual(memory.read(customer).facts, facts);
  assert.equal(memory.read(customer).revision, second.revision);
  const replacement = await memory.apply(customer, [remember({ key: 'fact0', text: 'Updated preference' })], second.revision);
  assert.equal(replacement.saved, true);
  assert.equal(replacement.facts.length, MAX_MEMORY_FACTS);
});

test('stale chat replies cannot replace later changes, deletions or cleared memory', async () => {
  const storage = storageFixture();
  const tab = createCustomerMemory({ storage }), otherTab = createCustomerMemory({ storage });
  const initial = tab.read(customer);
  const saved = await tab.apply(customer, [remember(restaurant)], initial.revision);
  const staleNew = await otherTab.apply(customer, [remember({ key: 'goal', text: 'Säästän asuntoa varten.' })], initial.revision);
  assert.equal(staleNew.reason, 'conflict');
  assert.deepEqual(staleNew.facts, [restaurant]);
  const removed = await otherTab.remove(customer, 'restaurants', saved.revision);
  assert.equal((await tab.apply(customer, [remember(restaurant)], saved.revision)).reason, 'conflict');
  assert.deepEqual(tab.read(customer).facts, []);
  const cleared = await otherTab.clear(customer, removed.revision);
  assert.notEqual(cleared.revision, removed.revision);
  assert.notEqual(cleared.revision, '');
  assert.equal((await tab.apply(customer, [remember(restaurant)], initial.revision)).reason, 'conflict');
  assert.equal((await tab.apply(customer, [remember(restaurant)], removed.revision)).reason, 'conflict');
  assert.deepEqual(tab.read(customer).facts, []);
  assert.equal((await otherTab.clear(other, '')).saved, true);
  assert.equal((await tab.apply(other, [remember(restaurant)], '')).reason, 'conflict');
});

test('unavailable storage and write failures never report a successful save', async () => {
  for (const storage of [null, {}, { getItem() { throw new Error('Blocked'); }, setItem() {} }]) {
    const memory = createCustomerMemory({ storage });
    assert.deepEqual(memory.read(customer), { facts: [], revision: '', available: false });
    assert.equal((await memory.apply(customer, [remember(restaurant)], '')).reason, 'unavailable');
    assert.equal((await memory.clear(customer, '')).saved, false);
  }
  const memory = createCustomerMemory({ storage: { getItem: () => null, setItem() { throw new Error('Quota'); } } });
  const result = await memory.apply(customer, [remember(restaurant)], '');
  assert.equal(result.saved, false);
  assert.equal(result.reason, 'unavailable');
  assert.deepEqual(result.facts, []);
});

test('a blocked localStorage getter is handled without breaking chat', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  const memory = createCustomerMemory();
  assert.equal(memory.read(customer).available, false);
  assert.equal((await memory.apply(customer, [remember(restaurant)], '')).saved, false);
});

test('corrupt records stay unavailable and are never silently overwritten', async () => {
  for (const raw of ['{broken', 'null', JSON.stringify({ version: 1, revision: 'r1', facts: [restaurant, restaurant] }),
    JSON.stringify({ version: 2, revision: 'r1', facts: [] }), JSON.stringify({ version: 1, revision: '', facts: [] }),
    JSON.stringify({ version: 1, revision: 'r1', facts: [], unexpected: true }), 'x'.repeat(32769)]) {
    const storage = storageFixture(), key = `oma-talous-memory-v1:${customer}`;
    storage.values.set(key, raw);
    const memory = createCustomerMemory({ storage });
    assert.deepEqual(memory.read(customer), { facts: [], revision: '', available: false });
    assert.equal((await memory.apply(customer, [remember(restaurant)], '')).reason, 'unavailable');
    assert.equal((await memory.clear(customer, '')).saved, false);
    assert.equal(storage.values.get(key), raw);
  }
});

test('invalid customer IDs, revisions and operations do not modify storage', async () => {
  const storage = storageFixture(), memory = createCustomerMemory({ storage });
  for (const id of ['', null, undefined, {}, '../other', 'space separated', 'x'.repeat(65)]) {
    assert.equal(memory.read(id).available, false);
    assert.equal((await memory.apply(id, [remember(restaurant)], '')).reason, 'invalid');
  }
  for (const revision of [null, undefined, {}, 1, 'bad revision', 'x'.repeat(81)]) {
    assert.equal((await memory.apply(customer, [remember(restaurant)], revision)).reason, 'invalid');
  }
  assert.equal((await memory.apply(customer, [{ action: 'replace', key: restaurant.key }], '')).reason, 'invalid');
  assert.equal((await memory.remove(customer, '', '')).reason, 'invalid');
  assert.equal(storage.values.size, 0);
});

test('two tabs serialize a concurrent clear and late chat save before checking revisions', async () => {
  const storage = storageFixture(), locks = exclusiveLocks();
  const tab = createStore({ storage, locks }), otherTab = createStore({ storage, locks });
  const first = await tab.apply(customer, [remember(restaurant)], '');
  const blocker = await holdCustomerLock(locks, customer);
  const clearing = otherTab.clear(customer, first.revision);
  const lateReply = tab.apply(customer, [remember(restaurant)], first.revision);
  assert.deepEqual(tab.read(customer).facts, [restaurant], 'both mutations must wait for the shared lock');
  blocker.release();
  const [cleared, stale] = await Promise.all([clearing, lateReply, blocker.held]);
  assert.equal(cleared.saved, true);
  assert.equal(stale.saved, false);
  assert.equal(stale.reason, 'conflict');
  assert.deepEqual(tab.read(customer).facts, []);
  assert.equal(tab.read(customer).revision, cleared.revision);
});

test('a reset cancels a save waiting for the lock and leaves later operations usable', async () => {
  const storage = storageFixture(), locks = exclusiveLocks(), controller = new AbortController();
  const memory = createStore({ storage, locks });
  const initial = await memory.apply(customer, [remember(restaurant)], '');
  const blocker = await holdCustomerLock(locks, customer);
  try {
    const pending = memory.apply(customer, [remember({ key: 'goal', text: 'Säästän lomaa varten.' })], initial.revision,
      { signal: controller.signal });
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.saved, false);
    assert.equal(cancelled.reason, 'cancelled');
    assert.deepEqual(memory.read(customer).facts, [restaurant]);
    assert.equal(memory.read(customer).revision, initial.revision);
  } finally { blocker.release(); await blocker.held; }
  assert.equal((await memory.clear(customer, initial.revision)).saved, true);
  const current = memory.read(customer);
  assert.equal((await memory.apply(customer, [remember(restaurant)], current.revision,
    { signal: controller.signal })).reason, 'cancelled');
  assert.equal((await memory.clear(customer, current.revision, { signal: controller.signal })).reason, 'cancelled');
  assert.equal((await memory.remove(customer, 'restaurants', current.revision,
    { signal: controller.signal })).reason, 'cancelled');
  assert.deepEqual(memory.read(customer), current);
});

test('missing or failing Web Locks refuse writes while existing memory remains readable', async () => {
  const storage = storageFixture();
  const saved = await createCustomerMemory({ storage }).apply(customer, [remember(restaurant)], '');
  const options = [{ storage, locks: null }, { storage, locks: {} },
    { storage, get locks() { throw new Error('Blocked lock getter'); } },
    { storage, locks: { request() { return Promise.reject(new Error('Locks denied')); } } }];
  for (const option of options) {
    const memory = createStore(option);
    assert.equal(memory.read(customer).available, true);
    assert.deepEqual(memory.read(customer).facts, [restaurant]);
    for (const result of [await memory.apply(customer, [remember({ key: 'goal', text: 'Säästän lomaa varten.' })], saved.revision),
      await memory.remove(customer, 'restaurants', saved.revision), await memory.clear(customer, saved.revision)]) {
      assert.equal(result.saved, false);
      assert.equal(result.reason, 'unavailable');
    }
    assert.equal(memory.read(customer).revision, saved.revision);
    assert.deepEqual(memory.read(customer).facts, [restaurant]);
  }
});

test('a blocked navigator getter makes default locks unavailable without throwing', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, get() { throw new Error('SecurityError'); } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
  const memory = createStore({ storage: storageFixture() });
  assert.equal(memory.read(customer).available, true);
  assert.equal((await memory.apply(customer, [remember(restaurant)], '')).reason, 'unavailable');
});
