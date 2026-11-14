const categories = new Set(['Housing', 'Utilities', 'Groceries', 'Health', 'Home & Tech', 'Transportation',
  'Restaurants', 'Lifestyle', 'Entertainment', 'Travel']);
const optional = new Set(['Restaurants', 'Lifestyle', 'Entertainment', 'Travel']);
const dayparts = ['night', 'morning', 'afternoon', 'evening'];
const monthParts = ['early', 'middle', 'late'];
const fail = () => { throw new TypeError('Invalid recorded spending patterns'); };
const integer = (value, maximum = 1000000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const cents = value => {
  if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) fail();
  const [whole, fraction = ''] = String(value).split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount < 0) fail();
  return amount;
};
const euro = amount => `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
const divide = (amount, divisor) => Number((BigInt(amount) + BigInt(divisor) / 2n) / BigInt(divisor));
const share = (amount, total) => total ? Number((BigInt(amount) * 100n + BigInt(total) / 2n) / BigInt(total)) : 0;
const sum = rows => rows.reduce((total, row) => total + row.total, 0);

function calendar(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') || Number(month.slice(0, 4)) < 1900) fail();
  const start = new Date(month + '-01T00:00:00Z');
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const days = Math.round((end - start) / 86400000), weekdays = Array(7).fill(0);
  for (let day = 0; day < days; day++) weekdays[(new Date(+start + day * 86400000).getUTCDay() + 6) % 7]++;
  return { start: month + '-01', end: end.toISOString().slice(0, 10), days, weekdays, parts: [10, 10, days - 20] };
}

function validateStats(input, dates, allowedCategories) {
  if (!input || !integer(input.payments) || !integer(input.active_days, dates.days) ||
      !integer(input.timed_payments) || input.timed_payments > input.payments || input.active_days > input.payments) fail();
  const count = input.payments, total = cents(input.total_eur), biggest = cents(input.biggest_payment_eur);
  const topThree = cents(input.top_three_payments_eur);
  if (count === 0 ? total !== 0 || biggest !== 0 || topThree !== 0 || input.active_days !== 0 ||
      input.average_payment_eur !== null || input.median_payment_eur !== null
    : total <= 0 || !input.active_days || biggest <= 0 || biggest > total || topThree < biggest || topThree > total ||
      BigInt(topThree) > BigInt(biggest) * BigInt(Math.min(3, count)) ||
      (count <= 3 ? topThree !== total : topThree >= total) ||
      cents(input.average_payment_eur) !== divide(total, count) || cents(input.median_payment_eur) <= 0 ||
      cents(input.median_payment_eur) > biggest || BigInt(biggest) * BigInt(count) < BigInt(total)) fail();

  function buckets(rows, key, expected, calendarCounts = null) {
    if (!Array.isArray(rows) || rows.length !== expected.length || new Set(rows.map(row => row?.[key])).size !== rows.length) fail();
    const values = rows.map(row => {
      const index = expected.indexOf(row?.[key]);
      if (index < 0 || !integer(row.payments) || row.payments > count ||
          (calendarCounts && row.calendar_days !== calendarCounts[index])) fail();
      const amount = cents(row.total_eur);
      if ((row.payments === 0) !== (amount === 0) || amount > total) fail();
      return { key: row[key], payments: row.payments, total: amount, ...(calendarCounts ? { days: row.calendar_days } : {}) };
    });
    if (values.reduce((n, row) => n + row.payments, 0) !== count || sum(values) !== total) fail();
    return values;
  }
  if (!Array.isArray(input.categories) || input.categories.length > allowedCategories.size ||
      new Set(input.categories.map(row => row?.category)).size !== input.categories.length ||
      input.categories.some(row => !allowedCategories.has(row?.category))) fail();
  const groups = buckets(input.categories, 'category', input.categories.map(row => row.category));
  return { count, total, biggest, topThree, activeDays: input.active_days, timed: input.timed_payments,
    average: count ? cents(input.average_payment_eur) : null, median: count ? cents(input.median_payment_eur) : null,
    groups, weekdays: buckets(input.weekdays, 'day', [1, 2, 3, 4, 5, 6, 7], dates.weekdays),
    parts: buckets(input.month_parts, 'part', monthParts, dates.parts),
    dayparts: buckets(input.dayparts, 'part', dayparts) };
}

function metrics(stats) {
  return { payments: stats.count, active_days: stats.activeDays, total_eur: euro(stats.total),
    average_payment_eur: stats.average === null ? null : euro(stats.average),
    median_payment_eur: stats.median === null ? null : euro(stats.median),
    biggest_payment_eur: euro(stats.biggest), top_three_payments_eur: euro(stats.topThree),
    biggest_payment_share_percent: share(stats.biggest, stats.total),
    top_three_payments_share_percent: share(stats.topThree, stats.total) };
}

function categoryFocus(stats) {
  const sorted = [...stats.groups].filter(row => row.total > 0).sort((a, b) => b.total - a.total);
  if (!sorted.length) return null;
  const leaders = sorted.filter(row => row.total === sorted[0].total);
  if (leaders.length === 1) {
    if (BigInt(leaders[0].total) * 100n < BigInt(stats.total) * 40n ||
        BigInt(leaders[0].total - (sorted[1]?.total || 0)) * 100n < BigInt(stats.total) * 10n) return null;
  } else if (leaders.length !== 2 || BigInt(leaders[0].total) * 100n < BigInt(stats.total) * 30n) return null;
  return { type: leaders.length === 1 ? 'one_category' : 'equal_category_focus',
    categories: leaders.map(row => ({ category: row.key, payments: row.payments, total_eur: euro(row.total),
      share_percent: share(row.total, stats.total) })) };
}

function timingPeak(stats, rows, dates, kind) {
  if (stats.count < 8 || stats.activeDays < 4) return null;
  const normalized = kind !== 'daypart';
  const rateCompare = (a, b) => {
    const difference = BigInt(a.total) * BigInt(normalized ? b.days : 1) - BigInt(b.total) * BigInt(normalized ? a.days : 1);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  };
  const sorted = [...rows].sort((a, b) => -rateCompare(a, b));
  const winner = sorted[0], second = sorted[1];
  if (!winner.total || winner.payments < 3 || rateCompare(winner, second) === 0 ||
      BigInt(winner.total) * BigInt(normalized ? second.days : 1) * 5n <
      BigInt(second.total) * BigInt(normalized ? winner.days : 1) * 6n) return null;
  const minimumShare = kind === 'weekday' ? 30 : kind === 'month_part' ? 45 : 50;
  if (BigInt(winner.total) * 100n < BigInt(stats.total) * BigInt(minimumShare)) return null;
  if (normalized && BigInt(winner.total) * BigInt(dates.days) * 10n <
      BigInt(stats.total) * BigInt(winner.days) * BigInt(kind === 'weekday' ? 18 : 14)) return null;
  // Midnight timestamps can represent date-only records. Never describe that as
  // night shopping, nor infer a daypart from mostly unknown recorded clock times.
  if (!normalized && (stats.timed < 5 || stats.timed * 4 < stats.count * 3 ||
      (winner.key === 'night' && stats.timed < stats.count))) return null;
  const largest = Math.max(...rows.map(row => row.total));
  return { bucket: winner.key, basis: normalized ? 'euros_per_calendar_day' : 'euros_in_equal_six_hour_bucket',
    payments: winner.payments, total_eur: euro(winner.total), share_percent: share(winner.total, stats.total),
    ...(normalized ? { calendar_days: winner.days, average_eur_per_calendar_day: euro(divide(winner.total, winner.days)),
      period_average_eur_per_calendar_day: euro(divide(stats.total, dates.days)) } : {}),
    largest_raw_total_buckets: rows.filter(row => row.total === largest).map(row => row.key),
    largest_raw_total_eur: euro(largest) };
}

/** One-month payment evidence, never a personality label or a claim about visits. */
export function spendingPatterns(month, spendingToolResult) {
  if (!spendingToolResult?.patterns) return null;
  const dates = calendar(month), source = spendingToolResult.patterns;
  if (spendingToolResult.from !== dates.start || spendingToolResult.to_exclusive !== dates.end) fail();
  const complete = spendingToolResult.outside_snapshot_range === false ||
    (spendingToolResult.outside_snapshot_range === undefined && spendingToolResult.outside_observed_range === false);
  const all = validateStats(source.all, dates, categories), discretionary = validateStats(source.discretionary, dates, optional);
  if (discretionary.count > all.count || discretionary.total > all.total || discretionary.activeDays > all.activeDays ||
      discretionary.timed > all.timed || discretionary.biggest > all.biggest || discretionary.topThree > all.topThree ||
      (spendingToolResult.total_eur !== undefined && cents(spendingToolResult.total_eur) !== all.total) ||
      (spendingToolResult.payments !== undefined && spendingToolResult.payments !== all.count)) fail();
  for (const field of ['groups', 'weekdays', 'parts', 'dayparts']) {
    for (const row of discretionary[field]) {
      const parent = all[field].find(candidate => candidate.key === row.key);
      if ((!parent && (row.total || row.payments)) || (parent && (row.total > parent.total || row.payments > parent.payments))) fail();
    }
  }
  const sparseReasons = [...(!complete ? ['incomplete_month'] : []),
    ...(discretionary.count < 5 ? ['fewer_than_five_payments'] : []),
    ...(discretionary.activeDays < 3 ? ['fewer_than_three_active_days'] : [])];
  const sufficient = sparseReasons.length === 0;
  let mix = discretionary.count === 0 ? 'no_payments' : 'insufficient_sample';
  if (sufficient) {
    mix = BigInt(discretionary.topThree) * 100n >= BigInt(discretionary.total) * 75n &&
      BigInt(discretionary.biggest) * 100n >= BigInt(discretionary.total) * 35n &&
      BigInt(discretionary.biggest) >= BigInt(discretionary.median) * 3n ? 'few_larger_payments'
      : discretionary.count >= 8 && discretionary.activeDays >= 5 &&
        BigInt(discretionary.biggest) * 100n <= BigInt(discretionary.total) * 20n &&
        BigInt(discretionary.topThree) * 100n <= BigInt(discretionary.total) * 45n ? 'spread_across_payments' : 'mixed_payments';
  }
  return { month, scope: 'recorded_payments_in_selected_month', complete_month: complete,
    all: { ...metrics(all), discretionary_share_percent: share(discretionary.total, all.total) },
    discretionary: { ...metrics(discretionary), sample_sufficient: sufficient, sparse_reasons: sparseReasons,
      purchase_mix: mix, category_focus: sufficient ? categoryFocus(discretionary) : null,
      timing: { weekday: sufficient ? timingPeak(discretionary, discretionary.weekdays, dates, 'weekday') : null,
        month_part: sufficient ? timingPeak(discretionary, discretionary.parts, dates, 'month_part') : null,
        daypart: sufficient ? timingPeak(discretionary, discretionary.dayparts, dates, 'daypart') : null } },
    limitations: ['Describe only this recorded month; do not infer a lasting personality, impulsivity or future habit.',
      'All spending can be dominated by essential bills; optional purchase descriptions use only discretionary categories.',
      'Payment counts are not visit counts. Dates and clock times are recorded payment times, not proven purchase or visit times; timezone is unspecified.',
      'Weekday and month-part peaks compare euros per calendar day; largest raw totals are reported separately.',
      'Month parts are days 1–10, 11–20 and 21–end. Dayparts are recorded hours 00–06, 06–12, 12–18 and 18–24.'] };
}
