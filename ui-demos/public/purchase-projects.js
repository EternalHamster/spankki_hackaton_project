export const MAX_PURCHASE_PROJECTS = 3;
const PREFIX = 'oma-talous-projects-v1:';
const PROPOSAL_KEYS = ['id', 'title', 'price_eur', 'requested_months', 'monthly_eur', 'projected_months', 'verdict', 'as_of', 'conditions', 'tips'];
const PROJECT_KEYS = [...PROPOSAL_KEYS, 'saved_eur', 'created_at', 'memory_revision'];
const TIP_KEYS = ['category', 'line', 'label', 'amount_eur', 'text'];
const CATEGORIES = new Set(['Restaurants', 'Lifestyle', 'Entertainment', 'Travel']);
const VERDICTS = new Set(['already_affordable', 'yes', 'yes_with_changes', 'takes_longer', 'not_now']);
const objectWith = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const customer = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const revision = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value);
const cents = value => Math.round(value * 100);
const money = (value, positive = false) => typeof value === 'number' && Number.isFinite(value) &&
  value >= (positive ? 0.01 : 0) && value <= 1000000 && Math.abs(value * 100 - cents(value)) < 0.000001;
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const isoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const pickProposal = value => Object.fromEntries(PROPOSAL_KEYS.map(key => [key, value[key]]));
const cloneProposal = value => ({ ...pickProposal(value), conditions: [...value.conditions],
  tips: value.tips.map(tip => Object.fromEntries(TIP_KEYS.map(key => [key, tip[key]]))) });
const cloneProject = value => ({ ...cloneProposal(value), saved_eur: value.saved_eur, created_at: value.created_at,
  memory_revision: value.memory_revision });
const validTip = value => objectWith(value, TIP_KEYS) && CATEGORIES.has(value.category) &&
  text(value.line, 40) && text(value.label, 80) && money(value.amount_eur, true) && text(value.text, 240);

export function validProjectProposal(value) {
  return objectWith(value, PROPOSAL_KEYS) && uuid(value.id) && text(value.title, 80) && money(value.price_eur, true) &&
    Number.isInteger(value.requested_months) && value.requested_months >= 1 && value.requested_months <= 60 &&
    money(value.monthly_eur) && (value.projected_months === null || (Number.isInteger(value.projected_months) &&
      value.projected_months >= 0 && value.projected_months <= 6000)) && VERDICTS.has(value.verdict) && isoDate(value.as_of) &&
    Array.isArray(value.conditions) && value.conditions.length <= 6 && Array.from(value.conditions).every(item => text(item, 240)) &&
    Array.isArray(value.tips) && value.tips.length <= 3 && Array.from(value.tips).every(validTip);
}

function validProject(value) {
  return objectWith(value, PROJECT_KEYS) && validProjectProposal(pickProposal(value)) && money(value.saved_eur) &&
    cents(value.saved_eur) <= cents(value.price_eur) && isoTime(value.created_at) &&
    (value.memory_revision === '' || revision(value.memory_revision));
}

export function validProjectContext(value) {
  return Array.isArray(value) && value.length <= MAX_PURCHASE_PROJECTS && Array.from(value).every(validProject) &&
    new Set(value.map(project => project.id.toLowerCase())).size === value.length;
}

export function projectProgress(project) {
  if (!validProject(project)) throw new TypeError('Invalid purchase project');
  const target = cents(project.price_eur), saved = cents(project.saved_eur), monthly = cents(project.monthly_eur);
  const remaining = target - saved;
  return { remaining_eur: remaining / 100, percent: remaining === 0 ? 100 : Math.min(99.99, Math.round(saved / target * 10000) / 100),
    months_remaining: remaining === 0 ? 0 : monthly > 0 ? Math.ceil(remaining / monthly) : null };
}

export function projectHint(project, tip) {
  const { remaining_eur } = projectProgress(project);
  if (!validTip(tip)) throw new TypeError('Invalid purchase project tip');
  const remaining = cents(remaining_eur), extra = Math.min(cents(tip.amount_eur), remaining), monthly = cents(project.monthly_eur);
  const after = remaining - extra;
  return { extra_eur: extra / 100, months_after: after === 0 ? 0 : monthly > 0 ? Math.ceil(after / monthly) : null,
    days_faster: monthly > 0 ? Math.min(Math.floor(extra / monthly * 30.44), Math.ceil(remaining / monthly * 30.44)) : 0 };
}

const unavailable = () => ({ projects: [], revision: '', available: false });
let sequence = 0;
function newRevision() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fallback is only a revision token */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${(++sequence).toString(36)}`;
}

export function createPurchaseProjects(options = {}) {
  function storage() {
    try {
      const value = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
      return value && typeof value.getItem === 'function' && typeof value.setItem === 'function' ? value : null;
    } catch { return null; }
  }
  function locks() {
    try {
      const value = Object.hasOwn(options, 'locks') ? options.locks : globalThis.navigator?.locks;
      return value && typeof value.request === 'function' ? value : null;
    } catch { return null; }
  }
  function read(customerId) {
    if (!customer(customerId)) return unavailable();
    const target = storage();
    if (!target) return unavailable();
    try {
      const raw = target.getItem(PREFIX + customerId);
      if (raw === null) return { projects: [], revision: '', available: true };
      if (typeof raw !== 'string' || raw.length > 32768) return unavailable();
      const record = JSON.parse(raw);
      if (!objectWith(record, ['version', 'revision', 'projects']) || record.version !== 1 || !revision(record.revision) ||
          !validProjectContext(record.projects)) return unavailable();
      return { projects: record.projects, revision: record.revision, available: true };
    } catch { return unavailable(); }
  }

  // All tabs hold the same lock for the complete read/check/write. Keeping an empty
  // revision tombstone prevents an old confirmation from reviving a removed project.
  async function write(customerId, expectedRevision, change, { signal } = {}) {
    if (!customer(customerId) || (expectedRevision !== '' && !revision(expectedRevision))) {
      return { ...unavailable(), saved: false, reason: 'invalid' };
    }
    if (signal?.aborted) return { ...read(customerId), saved: false, reason: 'cancelled' };
    const manager = locks();
    if (!manager) return { ...read(customerId), available: false, saved: false, reason: 'unavailable' };
    try {
      return await manager.request(PREFIX + customerId, { mode: 'exclusive', ...(signal ? { signal } : {}) }, () => {
        const current = read(customerId);
        if (signal?.aborted) return { ...current, saved: false, reason: 'cancelled' };
        if (!current.available) return { ...current, saved: false, reason: 'unavailable' };
        if (current.revision !== expectedRevision) return { ...current, saved: false, reason: 'conflict' };
        const next = change(current.projects.map(cloneProject));
        if (next.error) return { ...current, saved: false, reason: next.error };
        if (!next.changed) return { ...current, saved: true };
        if (next.projects.length > MAX_PURCHASE_PROJECTS) return { ...current, saved: false, reason: 'full' };
        if (!validProjectContext(next.projects)) return { ...current, saved: false, reason: 'invalid' };
        const target = storage();
        if (!target) return { ...current, available: false, saved: false, reason: 'unavailable' };
        const token = newRevision();
        if (signal?.aborted) return { ...current, saved: false, reason: 'cancelled' };
        target.setItem(PREFIX + customerId, JSON.stringify({ version: 1, revision: token, projects: next.projects }));
        return { projects: next.projects, revision: token, available: true, saved: true };
      });
    } catch {
      return signal?.aborted ? { ...read(customerId), saved: false, reason: 'cancelled' }
        : { ...read(customerId), available: false, saved: false, reason: 'unavailable' };
    }
  }

  async function confirm(customerId, proposal, expectedRevision, mutationOptions) {
    const memoryRevision = mutationOptions?.memoryRevision === undefined ? '' : mutationOptions.memoryRevision;
    if (!validProjectProposal(proposal) || (memoryRevision !== '' && !revision(memoryRevision))) {
      return { ...read(customerId), saved: false, reason: 'invalid' };
    }
    const candidate = cloneProposal(proposal);
    return write(customerId, expectedRevision, projects => {
      const existing = projects.find(project => project.id.toLowerCase() === candidate.id.toLowerCase());
      if (existing) {
        if (JSON.stringify(pickProposal(existing)) === JSON.stringify(candidate) && existing.memory_revision === memoryRevision) {
          return { changed: false };
        }
        const updated = { ...candidate, saved_eur: Math.min(cents(existing.saved_eur), cents(candidate.price_eur)) / 100,
          created_at: existing.created_at, memory_revision: memoryRevision };
        return { changed: true, projects: projects.map(project => project === existing ? updated : project) };
      }
      const timestamp = new Date((options.now || Date.now)()).toISOString();
      return { changed: true, projects: [...projects, { ...candidate, saved_eur: 0, created_at: timestamp,
        memory_revision: memoryRevision }] };
    }, mutationOptions);
  }

  async function setSaved(customerId, id, totalSavedEuros, expectedRevision, mutationOptions) {
    if (!uuid(id) || !money(totalSavedEuros)) return { ...read(customerId), saved: false, reason: 'invalid' };
    return write(customerId, expectedRevision, projects => {
      const item = projects.find(project => project.id.toLowerCase() === id.toLowerCase());
      if (!item) return { error: 'not_found' };
      if (cents(totalSavedEuros) > cents(item.price_eur)) return { error: 'invalid' };
      if (cents(item.saved_eur) === cents(totalSavedEuros)) return { changed: false };
      item.saved_eur = cents(totalSavedEuros) / 100;
      return { changed: true, projects };
    }, mutationOptions);
  }

  async function remove(customerId, id, expectedRevision, mutationOptions) {
    if (!uuid(id)) return { ...read(customerId), saved: false, reason: 'invalid' };
    return write(customerId, expectedRevision, projects => {
      const rest = projects.filter(project => project.id.toLowerCase() !== id.toLowerCase());
      return rest.length === projects.length ? { error: 'not_found' } : { changed: true, projects: rest };
    }, mutationOptions);
  }

  return { read, confirm, setSaved, remove };
}
