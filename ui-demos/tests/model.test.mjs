import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { metrics, basketTotals, defaultBaskets, scenarioSavings, mortgagePayment, weeklyBudget } from '../public/model.js';
const data = JSON.parse(fs.readFileSync(new URL('../public/demo-data.json', import.meta.url)));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < .00001, `${actual} ≠ ${expected}`);

test('September example reconciles to source transaction totals', () => {
  const s = metrics(data.profiles[0], '2026-09');
  near(s.income, 2342.18);
  near(s.spending, 1653.22);
  near(s.margin, 688.96);
  near(s.categories.Restaurants, 109.79);
  near(s.balance, 6890.29);
});

test('salary sweeps are not consumer spending and still reduce net cash flow', () => {
  const s = metrics(data.profiles.find(p => p.customer_id === 'CUST00103'), '2026-09');
  near(s.sweeps, 3287.95);
  near(s.spending, 400.82);
  near(s.margin, 3259.37);
  near(s.netFlow, -28.58);
  assert.ok(s.balance < 0);
});

test('all displayed months reconcile spending, baskets, transfers and cash flow', () => {
  for (const p of data.profiles) {
    for (const month of [...new Set(p.transactions.map(t => t.date.slice(0, 7)))]) {
      const s = metrics(p, month);
      near(basketTotals(s.categories).reduce((a,b)=>a+b,0), s.spending);
      near(s.margin - s.deposits - s.sweeps + s.withdrawals + s.otherFlow, s.netFlow);
      const reassigned = { ...defaultBaskets, Groceries: 2 };
      near(basketTotals(s.categories, reassigned).reduce((a,b)=>a+b,0), s.spending);
    }
  }
});

test('balances use chronological account records even when API rows arrive out of order', () => {
  const ordered = data.profiles[0];
  const reversed = { ...ordered, transactions: [...ordered.transactions].reverse() };
  for (const month of ['2024-10', '2025-09', '2026-09']) {
    assert.deepEqual(metrics(reversed, month), metrics(ordered, month));
  }
  const profile = { transactions: [
    { date: '2026-09-02', time: '10:00:00', account: 'B', amount: -0.1, balance: 99.9, category: 'Groceries' },
    { date: '2026-09-01', time: '15:00:00', account: 'A', amount: -0.2, balance: 199.8, category: 'Groceries' },
    { date: '2026-09-01', time: '09:00:00', account: 'A', amount: 200, balance: 200, category: 'Salary' },
    { date: '2026-10-01', time: '09:00:00', account: 'A', amount: 1, balance: 200.8, category: 'Salary' },
  ] };
  const summary = metrics(profile, '2026-09');
  assert.equal(summary.balance, 299.7);
  assert.equal(summary.spending, 0.3);
  assert.equal(summary.margin, 199.7);
  assert.equal(summary.netFlow, 199.7);
  assert.equal(summary.asOf, '2026-09-02');
});

test('scenario uses exact percentages and handles zero reductions', () => {
  near(scenarioSavings({ Restaurants: 109.79 }, { Restaurants: 20 }), 21.958);
  near(scenarioSavings({ Restaurants: 109.79 }, { Restaurants: 0 }), 0);
});

test('weekly planning clamps overspending and does not divide by zero', () => {
  near(weeklyBudget(1000, 400, 200, 4),100);
  near(weeklyBudget(-151.99, 400, 500, 4),0);
  near(weeklyBudget(1000, 0, 0, 0),1000);
});

test('mortgage annuity handles zero interest and rising rates', () => {
  near(mortgagePayment(120000, 0, 25),400);
  const payment = mortgagePayment(170500,4,25);
  let balance = 170500;
  for (let month = 0; month < 300; month++) balance = balance * (1 + 4 / 1200) - payment;
  near(balance, 0);
  assert.ok(mortgagePayment(170500,6,25) > mortgagePayment(170500,4,25));
  near(mortgagePayment(0,4,25),0);
  near(+data.mortgage.final_requested_loan_eur + +data.mortgage.final_equity_amount_eur, +data.mortgage.final_property_price_eur);
  assert.equal(data.history.filter(e=>e.event_type==='loan_decision').length,1);
});
