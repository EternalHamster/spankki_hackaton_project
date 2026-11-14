import test from 'node:test';
import assert from 'node:assert/strict';
import { savingActionFacts, savingAdviceError } from '../saving-actions.mjs';
import { createCoach } from '../coach.mjs';
const cash = changes => ({ income_eur: '2000.00', spending_eur: '1200.00', investment_out_eur: '200.00',
  investment_in_eur: '0.00', recorded_balance_eur: '4000.00', ...changes });
const spending = { categories: [{ category: 'Housing', total_eur: '1000.00', payments: 1, biggest_payment_eur: '1000.00' },
  { category: 'Restaurants', total_eur: '100.01', payments: 2, biggest_payment_eur: '60.00' },
  { category: 'Entertainment', total_eur: '99.99', payments: 3, biggest_payment_eur: '50.00' }] };
const funding = changes => ({ as_of: '2026-09-30', recorded_balance_eur: 4000,
  surprise_fund_target_eur: 2000, safe_to_save_eur_month: 100, ...changes });

test('small steps use only optional recorded purchases and exact half-up averages', () => {
  const plan = savingActionFacts('2026-09', cash(), spending);
  assert.equal(plan.priority, 'verify_buffer_first');
  assert.equal(plan.small_steps.length, 2);
  assert.equal(plan.small_steps[0].average_payment_eur, '50.01');
  assert.equal(plan.small_steps[1].average_payment_eur, '33.33');
  assert.ok(plan.small_steps.every(step => step.example_only && step.category !== 'Housing'));
  assert.match(plan.small_steps[0].action, /kotona valmistettuun/);
  assert.match(plan.limitation, /replacement purchases also cost money/);
  assert.deepEqual(savingActionFacts('2026-09', cash(), { categories: [{ category: 'Restaurants', total_eur: '100.01' }] }).small_steps, []);
  for (const payments of [-1, 0, 1.5, NaN]) assert.throws(() => savingActionFacts('2026-09', cash(),
    { categories: [{ category: 'Restaurants', total_eur: '100.01', payments }] }));
});

test('cash shortfalls and transfer strain take precedence over a positive monthly remainder', () => {
  for (const change of [{ income_eur: '1000' }, { recorded_balance_eur: '-1' }, { investment_out_eur: '900' }]) {
    const plan = savingActionFacts('2026-09', cash(change), spending, funding());
    assert.equal(plan.priority, 'essential_payments_first');
    assert.equal(plan.investment_scope, 'buffer_before_investing');
    assert.equal(plan.review_saving_transfers, true);
  }
  assert.equal(savingActionFacts('2026-09', cash(), spending, funding({ safe_to_save_eur_month: 0 })).priority, 'essential_payments_first');
  assert.equal(savingActionFacts('2026-09', cash({ income_eur: '1000', investment_in_eur: '10000' }), spending, funding()).priority,
    'essential_payments_first', 'withdrawals cannot make overspending a healthy saving budget');
});

test('investing is conditional only with dated buffer coverage and modeled saving capacity', () => {
  const good = savingActionFacts('2026-09', cash(), spending, funding());
  assert.equal(good.priority, 'buffer_estimate_covered');
  assert.equal(good.investment_scope, 'brief_conditional_option_only');
  assert.equal(savingActionFacts('2026-09', cash({ recorded_balance_eur: '500' }), spending, funding()).priority, 'build_buffer_first');
  for (const evidence of [null, funding({ surprise_fund_target_eur: null }), funding({ safe_to_save_eur_month: null }),
    funding({ as_of: '2026-08-31' })]) {
    const result = savingActionFacts('2026-09', cash(), spending, evidence);
    assert.equal(result.investment_scope, 'buffer_before_investing');
  }
  const older = savingActionFacts('2025-09', cash(), spending, funding());
  assert.equal(older.buffer_target_estimate_eur, undefined);
  assert.equal(older.priority, 'verify_buffer_first');
});

test('saving text keeps investment detail outside scope and requires buffer priority', () => {
  const notReady = { investment_scope: 'buffer_before_investing' }, ready = { investment_scope: 'brief_conditional_option_only' };
  assert.equal(savingAdviceError(['Säästä ensin puskuri ennen sijoittamista.', 'Valitse maksuton vaihtoehto.'], notReady), null);
  assert.equal(savingAdviceError(['Kun puskuri ja laskut on turvattu, sijoittaminen voi olla vaihtoehto.'], ready), null);
  for (const text of ['Sijoita rahastoon.', 'Sijoita 50 €.', 'Kun säästät, sijoittaminen kannattaa.', 'Sijoittaminen kannattaa.']) {
    assert.ok(savingAdviceError([text], notReady), text);
  }
  assert.ok(savingAdviceError(['Kun puskuri riittää, valitse ETF.'], ready));
  assert.equal(savingAdviceError(['Build a buffer before investing.'], notReady), null);
  assert.equal(savingAdviceError(['Once your buffer and bills are covered, investing could be an option.'], ready), null);
  assert.ok(savingAdviceError(['If you have spare cash, invest in stocks.'], ready));
  assert.ok(savingAdviceError(['Invest now.'], notReady));
});

test('summary preparation provides a concrete savings plan and shares one scoped funding read', async () => {
  const calls = []; let request;
  const meta = { as_of: '2026-09-30', data_version: 'v1' };
  const source = { context: async () => ({ profile: 'Synthetic dated profile.', insight_context: 'Own evidence.',
    as_of: meta.as_of, version: 'v1', coverage_from: '2026-09-01' }), toolDefinitions: async () => [],
    execute: async (customer, name, args) => {
      calls.push({ customer, name, args });
      if (name === 'safe_to_spend') return { ...meta, ...funding(), eur_week: 100, limited_by: 'budget' };
      if (name === 'get_cash_flow') return { ...meta, ...cash(), remaining_income_eur: '800.00' };
      return { ...meta, ...spending, total_eur: '1200.00' };
    } };
  const coach = createCoach({ dataSource: source, apiKey: 'test-only', logger: () => {}, fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ months: {
      '2026-09': { spending: ['Ravintoloihin kului 100,01 €.', 'Tämä koskee valittua kuukautta.'],
        saving: ['Vaihda yksi ravintolaostos kotiruokaan, jos se sopii sinulle.', 'Siirrä toteutunut säästö puskuriin laskujen jälkeen.',
          'Kun puskuri ja tulevat menot on turvattu, sijoittaminen voi olla vaihtoehto.'] },
    }, week: ['Arvio viikolle: 100 €.', 'Varaa ensin rahat laskuihin.'] }) }] });
  } });
  const result = await coach.summaryBatch('selected', { months: ['2026-09'], includeWeek: true });
  const facts = JSON.parse(request.messages[0].content.split('\n\nWrite prepared')[0].replace('EXACT TOPIC FACTS:\n', ''));
  assert.equal(facts.months['2026-09'].saving_plan.priority, 'buffer_estimate_covered');
  assert.equal(facts.months['2026-09'].saving_plan.small_steps[0].average_payment_eur, '50.01');
  assert.match(request.messages[0].content, /practical three-step plan/);
  assert.equal(calls.filter(call => call.name === 'safe_to_spend').length, 1);
  assert.ok(calls.every(call => call.customer === 'selected'));
  assert.equal(result.months['2026-09'].saving.bullets.length, 3);
});
