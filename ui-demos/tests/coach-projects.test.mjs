import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectPlanner } from '../coach-projects.mjs';
import { createCoach } from '../coach.mjs';
import { validProjectProposal } from '../public/purchase-projects.js';

const snapshot = { as_of: '2026-09-30', version: 'test-v1', profile: 'Own historical profile.', insight_context: 'Own historical evidence.' };
const input = { title: 'Sähköpyörä', price_eur: 1500, months: 6, protected_categories: [] };
function plan(args = input) { return { ...snapshot, price_eur: String(args.price_eur), months: args.months,
  needed_month: Math.ceil(args.price_eur / args.months / 5) * 5, set_aside_month: 175, verdict: 'takes_longer',
  months_needed: Math.ceil(args.price_eur / 175), from_current_saving_month: 0, surprise_fund_short: 0,
  cuts: [{ line: 'entertainment', label: 'entertainment', cut_month: 70 }], tips_month: '2026-09',
  tips: [{ category: 'Lifestyle', line: 'lifestyle', label: 'Ostokset', amount_eur: 15.5, text: 'Jättäisitkö yhden harkinnanvaraisen ostoksen väliin?' }],
  data_version: snapshot.version,
}; }
const stored = (proposal, saved_eur = 0) => ({ ...proposal, saved_eur, created_at: '2026-11-14T10:00:00.000Z', memory_revision: '' });
function fixture({ projects = [], calculate = args => plan(args) } = {}) {
  const calls = [];
  return { calls, planner: createProjectPlanner({ snapshot, customerId: 'CUST00207', projects,
    dataSource: { purchasePlan: async (customer, args) => { calls.push({ customer, args }); return calculate(args); } } }) };
}

test('proposals use the computed pace and duration, translated conditions and grounded tips', async () => {
  const { planner, calls } = fixture();
  const result = await planner.execute(input);
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(validProjectProposal(result.proposal), true);
  assert.equal(result.proposal.monthly_eur, 175);
  assert.equal(result.proposal.projected_months, 9);
  assert.equal(result.proposal.requested_months, 6);
  assert.match(result.proposal.conditions.join(' '), /Vapaa-aika/);
  assert.doesNotMatch(result.proposal.conditions.join(' '), /entertainment/);
  assert.equal(result.proposal.saved_eur, undefined);
  assert.equal(result.proposal.tips[0].amount_eur, 15.5);
  assert.equal(result.proposal.tips[0].text, plan().tips[0].text);
  assert.deepEqual(calls, [{ customer: 'CUST00207', args: { price_eur: 1500, months: 6, protected_categories: [], reserved_monthly_eur: 0 } }]);
});

test('historical spare cash never becomes saved progress and infeasible plans offer no confirmation', async () => {
  const already = fixture({ calculate: args => ({ ...plan(args), verdict: 'already_affordable', set_aside_month: 0, months_needed: 0, cuts: [] }) });
  const result = await already.planner.execute(input);
  assert.equal(result.proposal.monthly_eur, 250);
  assert.equal(result.proposal.projected_months, 6);
  assert.match(result.proposal.conditions[0], /nollasta/);
  const impossible = fixture({ calculate: args => ({ ...plan(args), verdict: 'not_now', set_aside_month: 0, months_needed: null }) });
  assert.equal((await impossible.planner.execute(input)).error, 'plan_not_feasible');
  assert.equal(impossible.planner.proposal(), null);
});

test('active projects reserve capacity while replanning excludes itself and uses only its remaining cost', async () => {
  const initial = (await fixture().planner.execute(input)).proposal;
  const other = { ...stored(initial), id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', monthly_eur: 50 };
  const current = stored(initial, 300);
  const { planner, calls } = fixture({ projects: [current, other] });
  const result = await planner.execute({ ...input, project_id: current.id, protected_categories: ['Restaurants'] });
  assert.equal(result.proposal.id, current.id);
  assert.equal(result.proposal.price_eur, 1500);
  assert.equal(result.already_recorded_eur, 300);
  assert.equal(calls[0].args.price_eur, 1200);
  assert.equal(calls[0].args.reserved_monthly_eur, 50);
  assert.deepEqual(calls[0].args.protected_categories, ['Restaurants']);
  assert.match(result.proposal.conditions.at(-1).replace(/\s/g, ' '),
    /Muille tavoitteille on suunniteltu 50,00 €\/kk\. Tämän tavoitteen päivitetty säästövauhti on 175,00 €\/kk, eli tavoitteisiin yhteensä 225,00 €\/kk\./);
  const newGoal = fixture({ projects: [current, { ...other, saved_eur: other.price_eur }] });
  await newGoal.planner.execute(input);
  assert.equal(newGoal.calls[0].args.reserved_monthly_eur, current.monthly_eur);
  const completed = fixture({ projects: [{ ...current, saved_eur: current.price_eur }] });
  const completedResult = await completed.planner.execute({ ...input, project_id: current.id });
  assert.equal(completedResult.proposal.projected_months, 0);
  assert.match(completedResult.proposal.conditions[0], /ei tarvita lisää kuukausisäästöä/);
  assert.equal(completed.calls.length, 0);
});

test('combined savings conditions do not attribute other goals to the new purchase', async () => {
  const existing = stored((await fixture().planner.execute(input)).proposal);
  const { planner } = fixture({ projects: [existing], calculate: args => ({ ...plan(args),
    from_current_saving_month: 520, budget_short_month: 270, surprise_fund_short: 90 }) });
  const result = await planner.execute(input);
  assert.equal(validProjectProposal(result.proposal), true);
  assert.equal(result.proposal.conditions.length, 6);
  const conditions = result.proposal.conditions.map(note => note.replace(/\s/g, ' '));
  assert.match(conditions.at(-1), /Muille tavoitteille on suunniteltu 175,00 €\/kk\. Tähän tavoitteeseen lisäksi 175,00 €\/kk, eli tavoitteisiin yhteensä 350,00 €\/kk\./);
  assert.match(conditions.find(note => note.includes('säästösiirtoja')), /Yhteisen suunnitelman.*520,00 €\/kk\. Summa sisältyy suunnitelmaan\./);
  assert.match(conditions.find(note => note.includes('vajetta')), /270,00 €\/kk vajetta muiden tavoitteiden ja arjen menojen rahoituksessa/);
  assert.match(conditions.find(note => note.includes('menovähennykset')), /Yhteistä suunnitelmaa rahoittavat/);
});

test('a small additional goal clearly separates its pace from other planned savings', async () => {
  const existing = { ...stored((await fixture().planner.execute(input)).proposal), monthly_eur: 50 };
  const { planner } = fixture({ projects: [existing], calculate: args => ({ ...plan(args),
    set_aside_month: 5, verdict: 'yes_with_changes', budget_short_month: 50,
    cuts: [{ line: 'restaurants', label: 'restaurants', cut_month: 55 }] }) });
  const result = await planner.execute({ ...input, price_eur: 10, months: 5 });
  assert.equal(result.proposal.monthly_eur, 5);
  assert.equal(result.proposal.projected_months, 2);
  assert.match(result.proposal.conditions.at(-1).replace(/\s/g, ' '),
    /Muille tavoitteille on suunniteltu 50,00 €\/kk\. Tähän tavoitteeseen lisäksi 5,00 €\/kk, eli tavoitteisiin yhteensä 55,00 €\/kk\./);
});

test('invalid arguments, unknown project identities and stale analysis never become proposals', async () => {
  const { planner, calls } = fixture();
  for (const changes of [{ customer_id: 'CUST00127' }, { months: 0 }, { months: 1.5 }, { price_eur: 3.141 },
    { protected_categories: ['Housing'] }, { protected_categories: ['Restaurants', 'Restaurants'] }, { project_id: 'unknown' }]) {
    assert.equal((await planner.execute({ ...input, ...changes })).error, 'invalid_arguments');
  }
  assert.equal(calls.length, 0);
  const stale = fixture({ calculate: args => ({ ...plan(args), data_version: 'old' }) });
  assert.equal((await stale.planner.execute(input)).error, 'data_unavailable');
  assert.equal(stale.planner.proposal(), null);
});

test('coach returns a structured pending proposal only after the final response succeeds', async () => {
  let fail = false, requests = 0;
  const coach = createCoach({ apiKey: 'test-key', logger() {}, dataSource: {
    context: async () => snapshot, toolDefinitions: async () => [], execute: async () => { throw Error('unexpected'); },
    purchasePlan: async (_customer, args) => plan(args),
  }, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); requests++;
    assert.match(body.system.map(block => block.text).join('\n'), /conversation, not a form/);
    assert.match(body.system.map(block => block.text).join('\n'), /simulated S-Pankki Tavoitetili opened by you/);
    assert.match(body.system.map(block => block.text).join('\n'), /Avaa Tavoitetili/);
    assert.match(body.system.map(block => block.text).join('\n'), /Do not ask users to manually log their savings/);
    return typeof body.messages.at(-1).content === 'string'
      ? Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'project-1', name: 'propose_purchase_project', input }] })
      : fail ? new Response('failed', { status: 503 }) : Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sopisiko tämä tavoite?' }] });
  } });
  const request = { messages: [{ role: 'user', content: 'Haluaisin 1500 € sähköpyörän kuudessa kuukaudessa.' }] };
  assert.equal(validProjectProposal((await coach.chat('CUST00207', request)).project_proposal), true);
  assert.equal(requests, 2);
  fail = true;
  await assert.rejects(coach.chat('CUST00207', request), error => error.status === 502);
});
