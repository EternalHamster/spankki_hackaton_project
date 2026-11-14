// Real DuckDB regression for the reported bike-to-car conversation.
//   node scripts/check-goal-flow.mjs        # no provider calls
//   node scripts/check-goal-flow.mjs --live # five billable chats; key from the environment only
import assert from 'node:assert/strict';
import { createDataSource } from '../data-source.mjs';
import { createProjectPlanner } from '../coach-projects.mjs';
import { createCoach } from '../coach.mjs';
import { createPurchaseProjects, validProjectProposal } from '../public/purchase-projects.js';

const customerId = 'CUST00207';
const bikeId = '11111111-1111-4111-8111-111111111111';
const replacementMessage = "I decided that I don't need the bike, I want a car worth 7000e with 12 months of saving";
const carInput = months => ({ title: 'Car', price_eur: 7000, months, protected_categories: [] });
const live = process.argv.includes('--live');
const dataSource = createDataSource();

function browserStore() {
  const values = new Map();
  return createPurchaseProjects({
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    locks: { request: async (_name, _options, callback) => callback() },
    now: () => Date.parse('2026-11-14T12:00:00.000Z'),
  });
}

async function seedBike(snapshot) {
  const store = browserStore();
  const bike = { id: bikeId, title: 'Bike', price_eur: 2000, requested_months: 12,
    monthly_eur: 170, projected_months: 12, verdict: 'yes_with_changes', as_of: snapshot.as_of,
    conditions: [], tips: [] };
  const seeded = await store.confirm(customerId, bike, '');
  assert.equal(seeded.saved, true, 'The browser fixture must store the active bike goal');
  return store;
}

function assertCar(proposal, months, pace, duration, verdict) {
  assert.equal(validProjectProposal(proposal), true, 'Expected a valid car confirmation card');
  assert.equal(proposal.price_eur, 7000, 'The car price must survive follow-up messages');
  assert.equal(proposal.requested_months, months, 'The requested car duration must survive follow-up messages');
  assert.equal(proposal.monthly_eur, pace, 'The card must use the real worker savings pace');
  assert.equal(proposal.projected_months, duration, 'The card must calculate duration from the rounded monthly pace');
  assert.equal(proposal.verdict, verdict, 'The card must preserve the worker feasibility verdict');
}

async function workerRegression(snapshot) {
  const store = await seedBike(snapshot);
  const projects = store.read(customerId).projects;
  const blockedPlanner = createProjectPlanner({ dataSource, customerId, snapshot, projects, userMessage: replacementMessage });
  const blocked = await blockedPlanner.execute(carInput(48));
  assert.equal(blocked.error, 'plan_not_feasible', 'Keeping the old bike reservation must reproduce the screenshot failure');
  assert.equal(blocked.analysis.verdict, 'not_now');
  assert.equal(blocked.analysis.reserved_monthly_eur, 170);
  assert.equal(blocked.analysis.budget_short_month, 170);
  assert.equal(blocked.analysis.needed_month, 150);

  const planner = createProjectPlanner({ dataSource, customerId, snapshot, projects, userMessage: replacementMessage });
  const removal = await planner.remove({ project_id: bikeId, evidence: "I don't need the bike" });
  assert.equal(removal.error, undefined, 'An explicit cancellation must allow removing the bike');
  assert.deepEqual(planner.removals(), [bikeId]);
  const oneYear = await planner.execute(carInput(12));
  assert.equal(oneYear.analysis.reserved_monthly_eur, 0, 'Removal must release capacity within the same coach turn');
  assertCar(oneYear.proposal, 12, 220, 32, 'takes_longer');
  const fourYears = await planner.execute(carInput(48));
  assert.equal(fourYears.analysis.reserved_monthly_eur, 0);
  assertCar(fourYears.proposal, 48, 150, 47, 'yes_with_changes');

  const removed = await store.removeMany(customerId, planner.removals(), store.read(customerId).revision);
  assert.equal(removed.saved, true, 'The successful reply must persist the cancellation');
  assert.equal(store.read(customerId).projects.length, 0, 'The cancelled bike must leave browser storage');
  const confirmed = await store.confirm(customerId, fourYears.proposal, removed.revision);
  assert.equal(confirmed.saved, true);
  assert.equal(confirmed.projects.length, 1);
  assert.equal(confirmed.projects[0].title, 'Car');
  assert.equal(confirmed.projects[0].saved_eur, 0, 'A new goal must not invent a starting balance');
  console.log('Real-worker regression passed: bike reserves EUR 170 -> car blocked; removal -> EUR 220/month for 32 months, or EUR 150/month for 47 months against the 48-month request.');
}

async function liveRegression(snapshot) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('--live requires ANTHROPIC_API_KEY in the environment; no credentials were retrieved.');
  const calculations = [];
  const coach = createCoach({ dataSource: { ...dataSource, purchasePlan: async (customer, input) => {
    calculations.push({ ...input });
    return dataSource.purchasePlan(customer, input);
  } }, logger() {} });
  async function ask(label, store, messages, pendingProject = null) {
    const before = store.read(customerId);
    const result = await coach.chat(customerId, { messages, projects: before.projects, pendingProject,
      language: 'en', level: 'standard', memory: [] });
    console.log(JSON.stringify({ case: label, tools: result.tools_used,
      answer: result.answer.replace(/\s+/g, ' ').slice(0, 650) }));
    if (result.project_removals?.length) {
      const applied = await store.removeMany(customerId, result.project_removals, before.revision);
      assert.equal(applied.saved, true, `${label}: browser must apply the scoped removal`);
    }
    messages.push({ role: 'assistant', content: result.answer });
    return result;
  }

  const store = await seedBike(snapshot);
  const messages = [{ role: 'user', content: replacementMessage }];
  const first = await ask('replace bike with car', store, messages);
  assertCar(first.project_proposal, 12, 220, 32, 'takes_longer');
  assert.ok(first.project_removals?.includes(bikeId) || first.project_proposal.id === bikeId,
    'The abandoned bike must be cancelled or explicitly repurposed, never reserved against the car');
  let pending = first.project_proposal;
  messages.push({ role: 'user', content: "Okay I'll save up for it for 4 years" });
  const second = await ask('extend car to four years', store, messages, pending);
  assertCar(second.project_proposal, 48, 150, 47, 'yes_with_changes');
  pending = second.project_proposal;
  messages.push({ role: 'user', content: 'Then I will cut my monthly budget even more to achieve it' });
  const third = await ask('offer deeper cuts', store, messages, pending);
  pending = third.project_proposal;
  assertCar(pending, 48, 150, 47, 'yes_with_changes');
  assert.ok(calculations.length >= 2, 'The live coach must calculate both requested durations');
  assert.ok(calculations.every(input => input.reserved_monthly_eur === 0),
    'No live car calculation may retain the abandoned bike reservation');
  const saved = await store.confirm(customerId, pending, store.read(customerId).revision);
  assert.equal(saved.saved, true, 'The final car card must confirm successfully');
  assert.equal(saved.projects.length, 1, 'Confirming the car must leave exactly one active goal');
  assert.equal(saved.projects[0].price_eur, 7000);
  assert.doesNotMatch(saved.projects[0].title, /bike|pyörä/i);

  const directStore = await seedBike(snapshot);
  const direct = await ask('explicit deletion', directStore, [{ role: 'user', content: 'Delete my bike goal.' }]);
  assert.deepEqual(direct.project_removals, [bikeId], 'A direct deletion request must return the bike removal');
  assert.equal(directStore.read(customerId).projects.length, 0);

  const hypotheticalStore = await seedBike(snapshot);
  const hypothetical = await ask('hypothetical deletion', hypotheticalStore,
    [{ role: 'user', content: 'What would happen if I deleted the bike?' }]);
  assert.deepEqual(hypothetical.project_removals || [], [], 'A hypothetical question must not delete a goal');
  assert.equal(hypotheticalStore.read(customerId).projects.length, 1);
  console.log('Live regression passed: screenshot conversation, confirmation, explicit deletion and hypothetical preservation (five chats).');
}

try {
  if (process.argv.slice(2).some(argument => argument !== '--live')) throw new Error('Usage: node scripts/check-goal-flow.mjs [--live]');
  const snapshot = await dataSource.context(customerId);
  await workerRegression(snapshot);
  if (live) await liveRegression(snapshot);
} catch (error) {
  console.error(`Goal-flow regression failed: ${error instanceof assert.AssertionError ? error.message : 'status' in Object(error)
    ? `coach request failed (HTTP ${error.status})` : error.message}`);
  process.exitCode = 1;
} finally {
  dataSource.close();
}
