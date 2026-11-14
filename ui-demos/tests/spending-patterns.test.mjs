import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingPatterns } from '../spending-patterns.mjs';
import { createCoach } from '../coach.mjs';

const money = cents => (cents / 100).toFixed(2);
const event = (day, amount = 1000, category = 'Entertainment', hour = 13) => ({ day, amount, category, hour });
const discretionary = new Set(['Restaurants', 'Lifestyle', 'Entertainment', 'Travel']);
function source(events = [], month = '2026-09') {
  const first = new Date(month + '-01T00:00:00Z');
  const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  const days = (end - first) / 86400000;
  const weekday = day => (new Date(+first + (day - 1) * 86400000).getUTCDay() + 6) % 7 + 1;
  const monthPart = day => day <= 10 ? 'early' : day <= 20 ? 'middle' : 'late';
  const timePart = hour => ['night', 'morning', 'afternoon', 'evening'][Math.floor(hour / 6)];
  const stats = rows => {
    const amounts = rows.map(row => row.amount).sort((a, b) => a - b);
    const total = amounts.reduce((a, b) => a + b, 0), n = rows.length;
    const bucket = (key, values, classify, calendarClassify = null) => values.map(value => {
      const selected = rows.filter(row => classify(row) === value);
      return { [key]: value, payments: selected.length, total_eur: money(selected.reduce((s, row) => s + row.amount, 0)),
        ...(calendarClassify ? { calendar_days: Array.from({ length: days }, (_, index) => index + 1).filter(day => calendarClassify(day) === value).length } : {}) };
    });
    return { payments: n, active_days: new Set(rows.map(row => row.day)).size,
      timed_payments: rows.filter(row => row.hour !== 0).length, total_eur: money(total),
      average_payment_eur: n ? money(Math.floor(total / n) + (2 * (total % n) >= n ? 1 : 0)) : null,
      median_payment_eur: n ? money(n % 2 ? amounts[Math.floor(n / 2)] : Math.floor((amounts[n / 2 - 1] + amounts[n / 2] + 1) / 2)) : null,
      biggest_payment_eur: money(amounts.at(-1) || 0), top_three_payments_eur: money(amounts.slice(-3).reduce((a, b) => a + b, 0)),
      categories: bucket('category', [...new Set(rows.map(row => row.category))], row => row.category),
      weekdays: bucket('day', [1, 2, 3, 4, 5, 6, 7], row => weekday(row.day), weekday),
      month_parts: bucket('part', ['early', 'middle', 'late'], row => monthPart(row.day), monthPart),
      dayparts: bucket('part', ['night', 'morning', 'afternoon', 'evening'], row => timePart(row.hour)) };
  };
  const all = stats(events);
  return { from: month + '-01', to_exclusive: end.toISOString().slice(0, 10), outside_snapshot_range: false,
    total_eur: all.total_eur, payments: all.payments, patterns: { all, discretionary: stats(events.filter(row => discretionary.has(row.category))) } };
}

test('legacy adapters have no invented patterns and an empty month has no invented spending style', () => {
  assert.equal(spendingPatterns('2026-09', { categories: [] }), null);
  const result = spendingPatterns('2026-09', source());
  assert.equal(result.complete_month, true);
  assert.equal(result.all.total_eur, '0.00');
  assert.equal(result.discretionary.purchase_mix, 'no_payments');
  assert.equal(result.discretionary.sample_sufficient, false);
  assert.equal(result.discretionary.category_focus, null);
  assert.deepEqual(result.discretionary.timing, { weekday: null, month_part: null, daypart: null });
});

test('sparse and partial months keep exact metrics without inferring habits or timing', () => {
  for (const rows of [[event(1), event(2), event(3)], [event(1), event(1), event(1), event(2), event(2)]]) {
    const result = spendingPatterns('2026-09', source(rows)).discretionary;
    assert.equal(result.payments, rows.length);
    assert.equal(result.sample_sufficient, false);
    assert.equal(result.purchase_mix, 'insufficient_sample');
    assert.equal(result.category_focus, null);
    assert.ok(Object.values(result.timing).every(value => value === null));
  }
  const partial = source(Array.from({ length: 10 }, (_, i) => event(i + 1)));
  partial.outside_snapshot_range = true;
  const result = spendingPatterns('2026-09', partial);
  assert.equal(result.complete_month, false);
  assert.deepEqual(result.discretionary.sparse_reasons, ['incomplete_month']);
  assert.equal(result.discretionary.purchase_mix, 'insufficient_sample');
});

test('large essential bills do not become a few-large-discretionary-purchases narrative', () => {
  const rows = [event(1, 500000, 'Housing'), ...Array.from({ length: 10 }, (_, i) => event(i + 2))];
  const result = spendingPatterns('2026-09', source(rows));
  assert.equal(result.all.biggest_payment_eur, '5000.00');
  assert.equal(result.all.discretionary_share_percent, 2);
  assert.equal(result.discretionary.biggest_payment_eur, '10.00');
  assert.equal(result.discretionary.purchase_mix, 'spread_across_payments');
  assert.equal(result.discretionary.category_focus.categories[0].category, 'Entertainment');
  assert.match(result.limitations.join(' '), /one|month|personality/);
});

test('few larger payments require both concentration and size relative to the median', () => {
  const rows = [10000, 5000, 4000, 100, 100, 100, 100, 100].map((amount, i) => event(i + 1, amount));
  const result = spendingPatterns('2026-09', source(rows)).discretionary;
  assert.equal(result.purchase_mix, 'few_larger_payments');
  assert.equal(result.median_payment_eur, '1.00');
  assert.equal(result.top_three_payments_eur, '190.00');
  assert.equal(result.top_three_payments_share_percent, 97);
  const equal = spendingPatterns('2026-09', source(Array.from({ length: 5 }, (_, i) => event(i + 1))));
  assert.equal(equal.discretionary.purchase_mix, 'mixed_payments');
});

test('equal category leaders are reported together and a four-way tie is not a focus', () => {
  const two = Array.from({ length: 8 }, (_, i) => event(i + 1, 1000, i % 2 ? 'Restaurants' : 'Entertainment'));
  const focus = spendingPatterns('2026-09', source(two)).discretionary.category_focus;
  assert.equal(focus.type, 'equal_category_focus');
  assert.deepEqual(new Set(focus.categories.map(row => row.category)), new Set(['Restaurants', 'Entertainment']));
  assert.ok(focus.categories.every(row => row.share_percent === 50));
  const four = Array.from({ length: 8 }, (_, i) => event(i + 1, 1000, [...discretionary][i % 4]));
  assert.equal(spendingPatterns('2026-09', source(four)).discretionary.category_focus, null);
});

test('weekday peaks use euro intensity, distinguish raw totals, and account for unequal calendar counts', () => {
  // September has four Mondays but five Tuesdays. Monday has a materially higher
  // amount per calendar Monday even though Tuesday has the larger raw total.
  const rows = [...[7, 14, 21, 28].map(day => event(day, 11000)), ...[1, 8, 15, 22, 29].map(day => event(day, 9000))];
  const peak = spendingPatterns('2026-09', source(rows)).discretionary.timing.weekday;
  assert.equal(peak.bucket, 1);
  assert.equal(peak.basis, 'euros_per_calendar_day');
  assert.equal(peak.total_eur, '440.00');
  assert.equal(peak.calendar_days, 4);
  assert.equal(peak.average_eur_per_calendar_day, '110.00');
  assert.equal(peak.period_average_eur_per_calendar_day, '29.67');
  assert.deepEqual(peak.largest_raw_total_buckets, [2]);
  assert.equal(peak.largest_raw_total_eur, '450.00');
  const countWinner = [...[7, 14, 21, 28].map(day => event(day, 10000)),
    ...[1, 1, 8, 8, 15, 15, 22, 29].map(day => event(day, 100))];
  assert.equal(spendingPatterns('2026-09', source(countWinner)).discretionary.timing.weekday.bucket, 1);
});

test('a shorter end of February is normalized separately from the biggest raw month-part total', () => {
  const rows = [...[1, 2, 3, 4, 5].map(day => event(day, 10000)), ...[21, 22, 23, 24].map(day => event(day, 12250))];
  const peak = spendingPatterns('2026-02', source(rows, '2026-02')).discretionary.timing.month_part;
  assert.equal(peak.bucket, 'late');
  assert.equal(peak.calendar_days, 8);
  assert.equal(peak.average_eur_per_calendar_day, '61.25');
  assert.deepEqual(peak.largest_raw_total_buckets, ['early']);
  assert.equal(peak.largest_raw_total_eur, '500.00');
});

test('timing ties and a single exceptional payment do not establish a peak', () => {
  const tied = [5, 5, 12, 12, 6, 6, 13, 13].map(day => event(day));
  assert.equal(spendingPatterns('2026-09', source(tied)).discretionary.timing.weekday, null);
  const single = [event(7, 100000), ...[1, 2, 3, 4, 5, 6, 8].map(day => event(day, 100))];
  assert.equal(spendingPatterns('2026-09', source(single)).discretionary.timing.weekday, null);
});

test('recorded daypart peaks require supported clock times and never label date-only data as night shopping', () => {
  const dates = [1, 3, 5, 7, 9, 11, 13, 15];
  const midnight = dates.map(day => event(day, 1000, 'Entertainment', 0));
  assert.equal(spendingPatterns('2026-09', source(midnight)).discretionary.timing.daypart, null);
  const afternoon = dates.map(day => event(day, 1000, 'Entertainment', 13));
  assert.equal(spendingPatterns('2026-09', source(afternoon)).discretionary.timing.daypart.bucket, 'afternoon');
  const tied = dates.map((day, i) => event(day, 1000, 'Entertainment', i % 2 ? 13 : 7));
  assert.equal(spendingPatterns('2026-09', source(tied)).discretionary.timing.daypart, null);
  const uncertainNight = dates.map((day, i) => event(day, 1000, 'Entertainment', i === 0 ? 0 : 2));
  assert.equal(spendingPatterns('2026-09', source(uncertainNight)).discretionary.timing.daypart, null);
});

test('money evidence retains exact cents and invalid or inconsistent aggregates fail closed', () => {
  const tiny = spendingPatterns('2026-09', source([event(1, 1), event(2, 1), event(3, 2)]));
  assert.equal(tiny.all.total_eur, '0.04');
  assert.equal(tiny.all.average_payment_eur, '0.01');
  assert.equal(tiny.all.biggest_payment_share_percent, 50);
  const valid = source(Array.from({ length: 8 }, (_, i) => event(i + 1)));
  for (const mutate of [
    value => { value.from = '2026-09-02'; },
    value => { value.patterns.all.average_payment_eur = '11.00'; },
    value => { value.patterns.all.total_eur = 'Infinity'; },
    value => { value.patterns.all.active_days = 31; },
    value => { value.patterns.all.top_three_payments_eur = '90.00'; },
    value => { value.patterns.all.weekdays[0].calendar_days = 5; },
    value => { value.patterns.all.dayparts[0].part = 'evening'; },
    value => { value.patterns.all.categories[0].category = 'Unknown'; },
    value => { value.patterns.discretionary.timed_payments = 9; },
    value => { value.patterns.discretionary.weekdays[0].total_eur = '100.00'; },
  ]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.throws(() => spendingPatterns('2026-09', invalid), TypeError);
  }
});

test('spending-only model preparation receives eligible monthly patterns and accepts a fuller supported summary', async () => {
  const rows = [event(2, 500000, 'Housing'), ...[7, 14, 21, 28].map(day => event(day, 11000)),
    ...[1, 8, 15, 22, 29].map(day => event(day, 9000))];
  const spending = source(rows);
  spending.categories = spending.patterns.all.categories.map(row => ({ ...row,
    biggest_payment_eur: money(Math.max(...rows.filter(item => item.category === row.category).map(item => item.amount))) }));
  const meta = { as_of: '2026-09-30', data_version: 'pattern-test' };
  const cash = { income_eur: '7000.00', spending_eur: spending.total_eur, remaining_income_eur: '1110.00',
    investment_out_eur: '0.00', investment_in_eur: '0.00' };
  const supported = [
    'Syyskuun lisäostosi jakautuivat 9 maksulle ja 9 päivälle. Suurin maksu oli 110,00 €, joten tämän kuukauden lisäostojen summa syntyi useista maksuista eikä yhdestä hallitsevasta ostoksesta.',
    'Maanantaille kirjattiin keskimäärin 110,00 € lisäostoja kalenterimaanantaita kohti; tiistain raaka yhteissumma oli silti suurempi, 450,00 €.',
    'Edelliseen kuukauteen ei ole vertailua. Tässä kuussa lisäostot painottuivat vapaa-aikaan, joten pieni muutos yhdessä valinnaisessa ostoksessa voisi olla luonteva seuraava askel.',
  ];
  assert.ok(supported[0].length > 140 && supported[0].length <= 220);
  for (const inventAmount of [false, true]) {
    const requests = [], calls = [];
    const dataSource = {
      context: async () => ({ profile: 'Own historical profile.', insight_context: 'Own historical insights.',
        as_of: meta.as_of, version: meta.data_version, coverage_from: '2026-09-01' }),
      toolDefinitions: async () => [],
      execute: async (customer, name, args) => {
        calls.push({ customer, name, args });
        return { ...meta, ...(name === 'get_spending' ? spending : cash) };
      },
    };
    const coach = createCoach({ dataSource, apiKey: 'test-only', logger: () => {}, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const message = body.messages[0].content;
      const facts = JSON.parse(message.split('\n\nWrite prepared')[0].replace('EXACT TOPIC FACTS:\n', ''));
      requests.push({ body, facts, message });
      const bullets = inventAmount ? [supported[0].replace('110,00', '9876,54'), ...supported.slice(1)] : supported;
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ months: {
        '2026-09': { spending: bullets },
      } }) }] });
    } });
    const result = coach.summaryBatch('selected-demo', { months: ['2026-09'], spendingOnly: true });
    if (inventAmount) {
      await assert.rejects(result, error => error.status === 502);
      assert.equal(requests.length, 2, 'an unsupported amount is rejected after one bounded correction');
      assert.match(requests[1].message, /unsupported number\/date/);
    } else {
      const prepared = await result;
      assert.deepEqual(prepared.months['2026-09'].spending.bullets, supported);
      assert.equal(prepared.months['2026-09'].saving, undefined);
      assert.equal(requests.length, 1);
    }
    const patterns = requests[0].facts.months['2026-09'].spending_patterns;
    assert.equal(patterns.month, '2026-09');
    assert.equal(patterns.complete_month, true);
    assert.equal(patterns.discretionary.purchase_mix, 'spread_across_payments');
    assert.equal(patterns.discretionary.timing.weekday.bucket, 1);
    assert.equal(patterns.discretionary.timing.weekday.average_eur_per_calendar_day, '110.00');
    assert.deepEqual(patterns.discretionary.timing.weekday.largest_raw_total_buckets, [2]);
    assert.deepEqual(Object.keys(requests[0].facts.months), ['2026-09']);
    assert.deepEqual(requests[0].body.tool_choice, { type: 'none' });
    assert.equal(calls.length, 2, 'the first covered month has no invented prior-month comparison');
    assert.ok(calls.every(call => call.customer === 'selected-demo' &&
      call.args.start_date === '2026-09-01' && call.args.end_date === '2026-10-01'));
  }
});
