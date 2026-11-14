import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingHighlight, previousMonth } from '../spending-highlights.mjs';
import { createCoach } from '../coach.mjs';

const rows = values => Object.entries(values).map(([category, total_eur]) => ({ category, total_eur,
  payments: Number(total_eur) > 0 ? 1 : 0, biggest_payment_eur: total_eur }));

test('payment evidence compares actual counts and rounded means without inventing a previous month', () => {
  const current = [{ category: 'Restaurants', total_eur: '10.01', payments: 2, biggest_payment_eur: '7.00' }];
  const previous = [{ category: 'Restaurants', total_eur: '120.00', payments: 3, biggest_payment_eur: '60.00' }];
  assert.deepEqual(spendingHighlight('2026-09', current, previous).payments, {
    current: { payments: 2, average_payment_eur: '5.01', biggest_payment_eur: '7.00' },
    previous_month: '2026-08', previous: { payments: 3, average_payment_eur: '40.00', biggest_payment_eur: '60.00' },
  });
  assert.equal(spendingHighlight('2026-09', current).payments.previous, undefined);
  assert.deepEqual(spendingHighlight('2026-09', [], previous).payments.current,
    { payments: 0, average_payment_eur: null, biggest_payment_eur: '0.00' });
  assert.equal(spendingHighlight('2026-09', [{ category: 'Restaurants', total_eur: '10.01' }]).payments, undefined);
  for (const change of [{ payments: 1.5 }, { payments: 0 }, { biggest_payment_eur: '11.00' }, { biggest_payment_eur: '4.00' }]) {
    assert.throws(() => spendingHighlight('2026-09', [{ ...current[0], ...change }]));
  }
});

test('a material variable expense change wins over large stable rent', () => {
  const result = spendingHighlight('2026-09', rows({ Housing: '1500.00', Restaurants: '340.19', Entertainment: '120.00' }),
    rows({ Housing: '1500.00', Restaurants: '75.10', Entertainment: '110.00' }));
  assert.equal(result.category, 'Restaurants');
  assert.equal(result.change_eur, '265.09');
  assert.equal(result.direction, 'up');
  assert.equal(result.previous_month, '2026-08');
});

test('decreases and absent categories use exact cents, without claiming a recurring saving', () => {
  const result = spendingHighlight('2026-01', rows({ Housing: '1500.00', Restaurants: '0' }), rows({ Restaurants: '120.99' }));
  assert.equal(result.amount_eur, '0.00');
  assert.equal(result.change_eur, '120.99');
  assert.equal(result.direction, 'down');
  assert.equal(result.previous_month, '2025-12');
  assert.equal(previousMonth('2024-03'), '2024-02');
});

test('without a comparison, highlight flexible spending without inventing a trend', () => {
  const result = spendingHighlight('2026-09', rows({ Housing: '2000.00', Groceries: '800.00', Travel: '90.00' }));
  assert.equal(result.category, 'Travel');
  assert.equal(result.reason, 'category_focus');
  assert.equal(result.previous_eur, undefined);
  assert.equal(result.direction, undefined);
  assert.deepEqual(spendingHighlight('2026-09', rows({ Housing: '2000.00' })), { reason: 'fixed_only' });
  assert.deepEqual(spendingHighlight('2026-09', []), { reason: 'no_spending' });
});

test('small or proportionally insignificant changes do not become notable trends', () => {
  const result = spendingHighlight('2026-09', rows({ Groceries: '850.00', Restaurants: '120.00' }),
    rows({ Groceries: '800.00', Restaurants: '100.00' }));
  assert.equal(result.reason, 'category_focus');
  assert.equal(result.category, 'Restaurants');
  assert.throws(() => spendingHighlight('2026-09', rows({ Restaurants: '-20.00' })));
  assert.throws(() => spendingHighlight('2026-09', rows({ Secret: '50.00' })));
});

test('summary preparation sends the current customer’s covered comparison to the model', async () => {
  for (const coverageFrom of ['2026-08-01', '2026-09-01']) {
    const calls = [];
    let facts;
    const dataSource = {
      context: async () => ({ profile: 'Historical own profile.', insight_context: 'Own history.',
        as_of: '2026-09-30', coverage_from: coverageFrom, version: 'v1' }),
      toolDefinitions: async () => [],
      execute: async (customer, name, args) => {
        calls.push({ customer, name, args });
        const meta = { as_of: '2026-09-30', data_version: 'v1' };
        if (name === 'get_cash_flow') return { ...meta, income_eur: '2000.00', spending_eur: '1340.19',
          remaining_income_eur: '659.81', investment_out_eur: '0.00', investment_in_eur: '0.00' };
        return { ...meta, total_eur: args.start_date === '2026-09-01' ? '1340.19' : '1075.10',
          categories: rows({ Housing: '1000.00', Restaurants: args.start_date === '2026-09-01' ? '340.19' : '75.10' }) };
      },
    };
    const coach = createCoach({ dataSource, apiKey: 'test-only', logger: () => {}, fetchImpl: async (_url, options) => {
      const content = JSON.parse(options.body).messages[0].content;
      facts = JSON.parse(content.split('\n\nWrite prepared')[0].replace('EXACT TOPIC FACTS:\n', '')).months['2026-09'];
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ months: {
        '2026-09': { spending: ['Ravintoloihin kului 340,19 €.', 'Summa muodostui yhdestä maksusta.'],
          saving: ['Tuloista jäi menojen jälkeen 659,81 €.', 'Varaa ensin rahat laskuihin.'] },
      } }) }] });
    } });
    await coach.summaryBatch('selected-customer', { months: ['2026-09'] });
    assert.ok(calls.every(call => call.customer === 'selected-customer'));
    assert.equal(facts.spending_highlight.category, 'Restaurants');
    assert.equal(facts.spending_highlight.payments.current.payments, 1);
    assert.equal(facts.spending_highlight.payments.current.average_payment_eur, '340.19');
    assert.equal(facts.spending_highlight.payments.previous?.biggest_payment_eur,
      coverageFrom === '2026-08-01' ? '75.10' : undefined);
    assert.equal(facts.spending_highlight.reason, coverageFrom === '2026-08-01' ? 'category_change' : 'category_focus');
    const monthCalls = calls.filter(call => call.name !== 'safe_to_spend');
    assert.equal(monthCalls.length, coverageFrom === '2026-08-01' ? 3 : 2);
    if (monthCalls.length === 3) assert.deepEqual(monthCalls.at(-1).args, { start_date: '2026-08-01', end_date: '2026-09-01' });
  }
});
