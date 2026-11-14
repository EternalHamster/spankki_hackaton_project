// Framework-free calculations. All dates use the source's calendar date, not the host timezone.
const DAY = 86400000;
export const dateOf = value => new Date(value + 'T12:00:00Z');
export const iso = date => date.toISOString().slice(0, 10);
export const addDays = (date, count) => iso(new Date(dateOf(date).getTime() + count * DAY));
export const monthEnd = month => iso(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0, 12)));
export const moveMonth = (month, count) => iso(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + count, 1, 12))).slice(0, 7);
const cents = amount => Math.round(amount * 100);
const total = (rows, kind) => rows.filter(t => t.kind === kind).reduce((n, t) => n + (kind === 'expense' ? -1 : 1) * cents(t.amount), 0) / 100;
export const percentChange = (current, previous) => previous > 0 ? (current - previous) / previous * 100 : null;

/** Validate once at the integration boundary; malformed data must not silently corrupt charts. */
export function prepareDataset({ transactions, coverage }) {
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dateOf(value).getTime()) && iso(dateOf(value)) === value;
  if (!coverage || !validDate(coverage.from) || !validDate(coverage.to) || coverage.from > coverage.to) throw new TypeError('coverage must contain valid inclusive from/to dates');
  if (!Array.isArray(transactions)) throw new TypeError('transactions must be an array');
  const rows = transactions.map((t, i) => {
    if (!validDate(t.date) || !Number.isFinite(t.amount) || !['income', 'expense', 'transfer'].includes(t.kind)) throw new TypeError(`Invalid transaction at index ${i}`);
    if ((t.kind === 'expense' && t.amount > 0) || (t.kind === 'income' && t.amount < 0)) throw new TypeError(`Invalid amount sign at index ${i}`);
    if (t.date < coverage.from || t.date > coverage.to) throw new RangeError(`Transaction outside coverage at index ${i}`);
    return { ...t, category: String(t.category || 'Other'), label: String(t.label || t.category || 'Muu') };
  }).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  return { transactions: rows, coverage: { ...coverage } };
}

export function periodStats(dataset, from, to) {
  const start = from > dataset.coverage.from ? from : dataset.coverage.from;
  const end = to < dataset.coverage.to ? to : dataset.coverage.to;
  const available = start <= end;
  const rows = available ? dataset.transactions.filter(t => t.date >= start && t.date <= end) : [];
  return { from, to, start, end, available, complete: available && start === from && end === to, rows, spending: available ? total(rows, 'expense') : null, income: available ? total(rows, 'income') : null };
}

export function breakdown(dataset, month, kind = 'expense') {
  const stats = periodStats(dataset, month + '-01', monthEnd(month));
  const groups = new Map();
  for (const t of stats.rows.filter(t => t.kind === kind)) {
    const group = groups.get(t.category) || { category: t.category, label: t.label, cents: 0 };
    group.cents += Math.abs(cents(t.amount)); groups.set(t.category, group);
  }
  const entries = [...groups.values()].map(g => ({ category: g.category, label: g.label, value: g.cents / 100 })).sort((a, b) => b.value - a.value);
  const sum = entries.reduce((n, g) => n + cents(g.value), 0) / 100;
  return { ...stats, total: sum, entries: entries.map(g => ({ ...g, share: sum ? g.value / sum * 100 : 0 })) };
}

export function annualSpending(dataset, year) {
  const months = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const previousKey = `${year - 1}-${String(i + 1).padStart(2, '0')}`;
    return { key, ...periodStats(dataset, key + '-01', monthEnd(key)), previous: periodStats(dataset, previousKey + '-01', monthEnd(previousKey)) };
  });
  // Compare only whole months covered in both years. Never compare nine months with twelve.
  const comparable = months.filter(m => m.complete && m.previous.complete);
  const currentTotal = months.filter(m => m.available).reduce((n, m) => n + cents(m.spending), 0) / 100;
  const comparedCurrent = comparable.reduce((n, m) => n + cents(m.spending), 0) / 100;
  const previousTotal = comparable.reduce((n, m) => n + cents(m.previous.spending), 0) / 100;
  return { months, currentTotal, previousTotal, comparableMonths: comparable.length, change: comparable.length ? percentChange(comparedCurrent, previousTotal) : null };
}

export function spendingRhythm(dataset, month) {
  function split(key) {
    const stats = periodStats(dataset, key + '-01', monthEnd(key));
    const amounts = [0, 0], days = [0, 0];
    const weekend = date => [0, 6].includes(dateOf(date).getUTCDay()) ? 1 : 0;
    for (const t of stats.rows.filter(t => t.kind === 'expense')) amounts[weekend(t.date)] += -cents(t.amount);
    if (stats.available) for (let d = stats.start; d <= stats.end; d = addDays(d, 1)) days[weekend(d)]++;
    const sum = amounts[0] + amounts[1];
    return { ...stats, amounts: amounts.map(n => n / 100), days, shares: amounts.map(n => sum ? n / sum * 100 : null), daily: amounts.map((n, i) => days[i] ? n / 100 / days[i] : null) };
  }
  const current = split(month), previousMonth = moveMonth(month, -1), previous = split(previousMonth);
  return { current, previous, previousMonth, change: current.complete && previous.complete ? percentChange(current.amounts[1], previous.amounts[1]) : null };
}

export function periodBounds(anchor, view, coverage) {
  const month = anchor.slice(0, 7), year = anchor.slice(0, 4);
  if (view === 'day') return { from: anchor, to: anchor };
  if (view === 'week') { const from = addDays(anchor, -((dateOf(anchor).getUTCDay() + 6) % 7)); return { from, to: addDays(from, 6) }; }
  if (view === 'month') return { from: month + '-01', to: monthEnd(month) };
  if (view === 'year') return { from: year + '-01-01', to: year + '-12-31' };
  return { from: coverage.from.slice(0, 4) + '-01-01', to: coverage.to.slice(0, 4) + '-12-31' };
}
export function shiftAnchor(anchor, view, direction) {
  if (view === 'day') return addDays(anchor, direction);
  if (view === 'week') return addDays(anchor, direction * 7);
  if (view === 'month') return moveMonth(anchor.slice(0, 7), direction) + '-01';
  if (view === 'year') return `${+anchor.slice(0, 4) + direction}-01-01`;
  return anchor;
}
export function canShift(dataset, anchor, view, direction) {
  if (view === 'years') return false;
  const { from, to } = periodBounds(shiftAnchor(anchor, view, direction), view, dataset.coverage);
  return to >= dataset.coverage.from && from <= dataset.coverage.to;
}
export function historySeries(dataset, anchor, view = 'month') {
  const bounds = periodBounds(anchor, view, dataset.coverage);
  const stats = periodStats(dataset, bounds.from, bounds.to);
  const priorAnchor = shiftAnchor(anchor, view, -1);
  const priorBounds = periodBounds(priorAnchor, view, dataset.coverage);
  const previous = view === 'years' ? null : periodStats(dataset, priorBounds.from, priorBounds.to);
  let bins;
  if (view === 'day') {
    const hour = t => /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(t.time || '') ? +t.time.slice(0, 2) : 24;
    const unknown = [...stats.rows, ...(previous?.rows || [])].some(t => hour(t) === 24 && t.kind !== 'transfer');
    bins = Array.from({ length: unknown ? 25 : 24 }, (_, i) => {
      const rows = stats.rows.filter(t => hour(t) === i), prior = previous.rows.filter(t => hour(t) === i);
      return { key: `${anchor}/${i}`, label: i === 24 ? 'Ei aikaa' : `${String(i).padStart(2, '0')}`, from: anchor, to: anchor, rows, available: stats.available, complete: stats.complete, spending: stats.available ? total(rows, 'expense') : null, income: stats.available ? total(rows, 'income') : null, comparison: previous.complete ? total(prior, 'expense') : null };
    });
  } else {
    const dates = [];
    if (view === 'week' || view === 'month') for (let d = bounds.from; d <= bounds.to; d = addDays(d, 1)) dates.push([d, d]);
    if (view === 'year') for (let i = 1; i <= 12; i++) { const key = `${anchor.slice(0, 4)}-${String(i).padStart(2, '0')}`; dates.push([key + '-01', monthEnd(key)]); }
    if (view === 'years') for (let y = +bounds.from.slice(0, 4); y <= +bounds.to.slice(0, 4); y++) dates.push([`${y}-01-01`, `${y}-12-31`]);
    bins = dates.map(([from, to], index) => {
      const bin = periodStats(dataset, from, to);
      let prior = null;
      if (view === 'week') { const d = addDays(from, -7); prior = periodStats(dataset, d, d); }
      if (view === 'month') {
        const d = moveMonth(anchor.slice(0, 7), -1) + from.slice(7);
        if (d <= monthEnd(d.slice(0, 7))) prior = periodStats(dataset, d, d);
      }
      if (view === 'year') { const key = `${+from.slice(0, 4) - 1}-${from.slice(5, 7)}`; prior = periodStats(dataset, key + '-01', monthEnd(key)); }
      return { ...bin, key: from, label: view === 'years' ? from.slice(0, 4) : view === 'year' ? String(index + 1) : String(+from.slice(8)), comparison: prior?.complete ? prior.spending : null };
    });
  }
  return { ...stats, previous, view, anchor, bins };
}
