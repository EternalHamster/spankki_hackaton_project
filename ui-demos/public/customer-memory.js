export const MAX_MEMORY_FACTS = 12;
const MAX_UPDATES = 6;
const PREFIX = 'oma-talous-memory-v1:';
const validKey = key => typeof key === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(key);
const validText = text => typeof text === 'string' && text.length > 0 && text.length <= 200 && text.trim() === text;
const objectWith = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validCustomer = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
const validRevision = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value);
const unavailable = () => ({ facts: [], revision: '', available: false });
let revisionSequence = 0;

export function validMemoryFacts(value) {
  return Array.isArray(value) && value.length <= MAX_MEMORY_FACTS &&
    Array.from(value).every(fact => objectWith(fact, ['key', 'text']) && validKey(fact.key) && validText(fact.text)) &&
    new Set(value.map(fact => fact.key)).size === value.length;
}

export function validMemoryUpdates(value) {
  return Array.isArray(value) && value.length <= MAX_UPDATES && Array.from(value).every(update =>
    update?.action === 'remember'
      ? objectWith(update, ['action', 'key', 'text']) && validKey(update.key) && validText(update.text)
      : update?.action === 'forget' && objectWith(update, ['action', 'key']) && validKey(update.key));
}

function newRevision() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* use a local revision below */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${(++revisionSequence).toString(36)}`;
}

// Only this browser stores these preferences. All cooperating tabs hold the same
// exclusive lock while checking the revision and writing the customer's record.
export function createCustomerMemory(options = {}) {
  function getStorage() {
    try {
      const storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
      return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
    } catch { return null; }
  }

  function getLocks() {
    try {
      const locks = Object.hasOwn(options, 'locks') ? options.locks : globalThis.navigator?.locks;
      return locks && typeof locks.request === 'function' ? locks : null;
    } catch { return null; }
  }

  function read(customerId) {
    if (!validCustomer(customerId)) return unavailable();
    const storage = getStorage();
    if (!storage) return unavailable();
    try {
      const raw = storage.getItem(PREFIX + customerId);
      if (raw === null) return { facts: [], revision: '', available: true };
      if (typeof raw !== 'string' || raw.length > 32768) return unavailable();
      const record = JSON.parse(raw);
      if (!objectWith(record, ['version', 'revision', 'facts']) || record.version !== 1 ||
          !validRevision(record.revision) || !validMemoryFacts(record.facts)) return unavailable();
      return { facts: record.facts, revision: record.revision, available: true };
    } catch { return unavailable(); }
  }

  async function write(customerId, expectedRevision, change, { signal } = {}) {
    if (!validCustomer(customerId) || (expectedRevision !== '' && !validRevision(expectedRevision))) {
      return { ...unavailable(), saved: false, reason: 'invalid' };
    }
    if (signal?.aborted) return { ...read(customerId), saved: false, reason: 'cancelled' };
    const locks = getLocks();
    if (!locks) return { ...read(customerId), available: false, saved: false, reason: 'unavailable' };
    try {
      return await locks.request(PREFIX + customerId, { mode: 'exclusive', ...(signal ? { signal } : {}) }, () => {
        const current = read(customerId);
        if (signal?.aborted) return { ...current, saved: false, reason: 'cancelled' };
        if (!current.available) return { ...current, saved: false, reason: 'unavailable' };
        if (current.revision !== expectedRevision) return { ...current, saved: false, reason: 'conflict' };
        const facts = change(current.facts.map(fact => ({ ...fact })));
        if (facts.length > MAX_MEMORY_FACTS) return { ...current, saved: false, reason: 'full' };
        if (!validMemoryFacts(facts)) return { ...current, saved: false, reason: 'invalid' };
        const storage = getStorage();
        if (!storage) return { ...current, available: false, saved: false, reason: 'unavailable' };
        const revision = newRevision();
        if (signal?.aborted) return { ...current, saved: false, reason: 'cancelled' };
        storage.setItem(PREFIX + customerId, JSON.stringify({ version: 1, revision, facts }));
        return { facts, revision, available: true, saved: true };
      });
    } catch {
      return signal?.aborted ? { ...read(customerId), saved: false, reason: 'cancelled' }
        : { ...read(customerId), available: false, saved: false, reason: 'unavailable' };
    }
  }

  async function apply(customerId, updates, expectedRevision, options) {
    if (!validMemoryUpdates(updates)) return { ...read(customerId), saved: false, reason: 'invalid' };
    const changes = updates.map(update => ({ ...update }));
    return write(customerId, expectedRevision, facts => {
      const entries = new Map(facts.map(fact => [fact.key, fact]));
      for (const update of changes) {
        if (update.action === 'forget') entries.delete(update.key);
        else entries.set(update.key, { key: update.key, text: update.text });
      }
      return [...entries.values()];
    }, options);
  }

  return {
    read, apply,
    remove: (customerId, key, expectedRevision, options) => apply(customerId, [{ action: 'forget', key }], expectedRevision, options),
    // Keep a revision even when empty: removing the storage key would let a reply
    // that started with an empty memory restore facts after the user cleared it.
    clear: (customerId, expectedRevision, options) => write(customerId, expectedRevision, () => [], options),
  };
}
