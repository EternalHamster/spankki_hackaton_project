const labels = { Housing: 'Asuminen', Utilities: 'Laskut', Groceries: 'Ruokaostokset', Health: 'Terveys',
  'Home & Tech': 'Koti ja tekniikka', Transportation: 'Liikkuminen', Restaurants: 'Ravintolat',
  Lifestyle: 'Ostokset ja itsestä huolehtiminen', Entertainment: 'Vapaa-aika', Travel: 'Matkailu' };
const discretionary = new Set(['Restaurants', 'Lifestyle', 'Entertainment', 'Travel']);
const fixed = new Set(['Housing', 'Utilities']);
const cents = value => {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error('Invalid spending amount');
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('Invalid spending amount');
  return amount;
};
const euros = amount => `${Math.floor(Math.abs(amount) / 100)}.${String(Math.abs(amount) % 100).padStart(2, '0')}`;

export function previousMonth(month) {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 2, 1)).toISOString().slice(0, 7);
}

/** Prefer a material change in a variable category over an unsurprising rent payment. */
export function spendingHighlight(month, current, previous = null) {
  function groups(rows) {
    if (!Array.isArray(rows) || rows.some(row => !Object.hasOwn(labels, row.category)) ||
        new Set(rows.map(row => row.category)).size !== rows.length) throw new Error('Invalid spending categories');
    return new Map(rows.map(row => [row.category, cents(row.total_eur)]));
  }
  const now = groups(current), before = previous === null ? null : groups(previous);
  const candidates = Object.keys(labels).filter(category => !fixed.has(category)).map(category => ({
    category, amount: now.get(category) || 0, prior: before?.get(category) || 0,
    change: (now.get(category) || 0) - (before?.get(category) || 0),
  }));
  const changed = before && candidates.filter(row => Math.abs(row.change) >= 5000 &&
    (row.prior === 0 || Math.abs(row.change) / row.prior >= .25))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.category.localeCompare(b.category))[0];
  const selected = changed || candidates.filter(row => row.amount > 0 && discretionary.has(row.category))
    .sort((a, b) => b.amount - a.amount)[0] || candidates.filter(row => row.amount > 0)
    .sort((a, b) => b.amount - a.amount)[0];
  if (!selected) return { reason: [...now.values()].some(value => value > 0) ? 'fixed_only' : 'no_spending' };
  return { reason: changed ? 'category_change' : 'category_focus', category: selected.category,
    label: labels[selected.category], amount_eur: euros(selected.amount), discretionary: discretionary.has(selected.category),
    ...(changed ? { previous_month: previousMonth(month), previous_eur: euros(selected.prior),
      change_eur: euros(selected.change), direction: selected.change > 0 ? 'up' : 'down' } : {}),
  };
}
