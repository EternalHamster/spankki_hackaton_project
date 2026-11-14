import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyPlan } from '../public/weekly-plan.js';
const selection = { as_of: '2026-09-30', selection_id: 'selected-a' };
const week = changes => ({ week_start: '2026-09-28', week_end: '2026-10-04', observed_through: selection.as_of,
  weekly_budget_eur: 260, spent_eur_week: 52, remaining_eur_week: 208, over_budget_eur_week: 0,
  days_remaining_in_week: 4, daily_remaining_eur: 52, ...changes });

test('weekly plan provides an actionable daily pace from the remaining envelope, not a model claim', () => {
  const result = weeklyPlan(week(), selection);
  assert.equal(result.source, 'calculated');
  assert.match(result.bullets[0], /208.*4 päivälle.*52.*päivässä/);
  assert.match(result.bullets[1], /vähennä sama summa/);
  assert.match(result.question, /ei ole tilin saldo/);
  assert.equal(result.selectionId, selection.selection_id);
  assert.equal(result.answer, result.bullets.map(text => `• ${text}`).join('\n'));
});

test('zero budget, exhausted budget and overspending give different next steps', () => {
  const zero = weeklyPlan(week({ weekly_budget_eur: 0, remaining_eur_week: 0, over_budget_eur_week: 52, daily_remaining_eur: 0 }), selection);
  assert.match(zero.bullets[0], /ei ole varaa uusiin lisäostoihin/);
  const used = weeklyPlan(week({ spent_eur_week: 260, remaining_eur_week: 0, daily_remaining_eur: 0 }), selection);
  assert.match(used.bullets[0], /raja on käytetty/);
  const over = weeklyPlan(week({ spent_eur_week: 275.34, remaining_eur_week: 0, over_budget_eur_week: 15.34, daily_remaining_eur: 0 }), selection);
  assert.match(over.bullets[0], /15\s*€.*ensi viikkoon/);
});

test('the final day and completed week never divide by zero or promise a bank balance', () => {
  const finalDay = weeklyPlan(week({ observed_through: '2026-10-03', days_remaining_in_week: 1, daily_remaining_eur: 208 }),
    { ...selection, as_of: '2026-10-03' });
  assert.match(finalDay.bullets[0], /viimeiselle päivälle/);
  const ended = weeklyPlan(week({ observed_through: '2026-10-04', days_remaining_in_week: 0, daily_remaining_eur: null }),
    { ...selection, as_of: '2026-10-04' });
  assert.match(ended.bullets[0], /Viikko on päättynyt/);
  assert.match(ended.bullets[0], /ei ole tilisi saldo/);
});

test('stale dates, nonfinite amounts and inconsistent remaining limits fail closed', () => {
  for (const change of [{ observed_through: '2026-09-29' }, { week_start: 'bad' }, { weekly_budget_eur: Infinity },
    { remaining_eur_week: 209 }, { daily_remaining_eur: 53 }, { days_remaining_in_week: -1 }, { spent_eur_week: -1 }]) {
    assert.throws(() => weeklyPlan(week(change), selection));
  }
});

test('weekly plan changes explanation depth while preserving its financial facts', () => {
  const simple = weeklyPlan(week(), selection, 'simple');
  const standard = weeklyPlan(week(), selection, 'standard');
  const detailed = weeklyPlan(week(), selection, 'detailed');
  assert.equal(simple.level, 'simple');
  assert.equal(standard.level, 'standard');
  assert.equal(detailed.level, 'detailed');
  assert.match(simple.bullets[0], /52.*päivässä/);
  assert.equal(simple.bullets.length, 2);
  assert.equal(detailed.bullets.length, 3);
  assert.match(detailed.bullets[2], /260.*52.*208.*4 päivälle.*alaspäin.*ei tilin saldo/);
  assert.equal(simple.question, detailed.question);
  assert.equal(simple.displayQuestion, 'Miten käytän loppuviikon lisäostovaran?');
  assert.match(simple.question, /2026-09-30/);
  assert.match(detailed.displayQuestion, /2026-09-30/);
  assert.notDeepEqual(simple.bullets, standard.bullets);
  assert.throws(() => weeklyPlan(week(), selection, 'other'));
});
