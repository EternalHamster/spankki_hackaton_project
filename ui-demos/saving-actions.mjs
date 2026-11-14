// Exact, dated inputs for practical savings advice. These are examples, not transfers.
export const SAVING_ACTIONS_VERSION = 'saving-actions-v1';
export const SAVING_SCOPE_GUIDANCE = 'Prioritize essential payments and an accessible emergency buffer. Investing is outside this project: at most one short conditional mention after the buffer and upcoming expenses are covered; no products, strategies, allocations, investment amounts or return estimates.';
const actions = {
  Entertainment: 'Korvaa yksi maksullinen vapaa-ajan tekeminen maksuttomalla.',
  Restaurants: 'Vaihda yksi ravintolaostos kotona valmistettuun ateriaan, jos se sopii sinulle.',
  Lifestyle: 'Siirrä yksi vapaaehtoinen ostos myöhemmäksi.',
  Travel: 'Jätä yksi vapaaehtoinen matkailuun liittyvä lisäostos tekemättä.',
};
const money = value => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new TypeError('Invalid savings amount');
  const cents = Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new TypeError('Invalid savings amount');
  return match[1] ? -cents : cents;
};
const euros = cents => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

export function savingActionFacts(month, cash, spending, funding = null) {
  const remainder = money(cash.income_eur) - money(cash.spending_eur);
  const transfers = money(cash.investment_out_eur), withdrawals = money(cash.investment_in_eur);
  const afterTransfers = remainder - transfers + withdrawals;
  const datedFunding = funding?.as_of?.slice(0, 7) === month ? funding : null;
  const balance = cash.recorded_balance_eur != null ? money(cash.recorded_balance_eur)
    : datedFunding?.recorded_balance_eur != null ? money(datedFunding.recorded_balance_eur) : null;
  const target = datedFunding?.surprise_fund_target_eur != null ? money(datedFunding.surprise_fund_target_eur) : null;
  const capacity = datedFunding?.safe_to_save_eur_month != null ? money(datedFunding.safe_to_save_eur_month) : null;
  if ((target !== null && target < 0) || (capacity !== null && capacity < 0)) throw new TypeError('Invalid savings estimate');
  const tight = remainder <= 0 || afterTransfers < 0 || (balance !== null && balance <= 0) || capacity === 0;
  const bufferCovered = !tight && balance !== null && target > 0 && balance >= target && capacity > 0;
  const priority = tight ? 'essential_payments_first' : bufferCovered ? 'buffer_estimate_covered'
    : balance !== null && target > 0 && balance < target ? 'build_buffer_first' : 'verify_buffer_first';
  const choices = (spending.categories || []).filter(row => Object.hasOwn(actions, row.category)).flatMap(row => {
    const total = money(row.total_eur), count = row.payments;
    if (total < 0) throw new TypeError('Invalid optional spending');
    if (count === undefined) return []; // Legacy evidence cannot establish a typical purchase size.
    if (!Number.isSafeInteger(count) || count < 0 || count > 1000000 || (count === 0 && total !== 0)) {
      throw new TypeError('Invalid optional payment count');
    }
    if (!count || !total) return [];
    const average = Math.floor(total / count) + (2 * (total % count) >= count ? 1 : 0);
    return [{ category: row.category, payments: count, total_eur: euros(total), average_payment_eur: euros(average),
      action: actions[row.category], example_only: true }];
  }).sort((a, b) => money(b.total_eur) - money(a.total_eur) || a.category.localeCompare(b.category)).slice(0, 2);
  return { version: SAVING_ACTIONS_VERSION, month, priority, small_steps: choices,
    review_saving_transfers: transfers > 0 && (tight || afterTransfers <= 0),
    investment_scope: bufferCovered ? 'brief_conditional_option_only' : 'buffer_before_investing',
    ...(datedFunding ? { buffer_estimate_as_of: datedFunding.as_of } : {}),
    ...(target !== null ? { buffer_target_estimate_eur: euros(target) } : {}),
    limitation: 'A monthly remainder is not available bank cash. Average payment is an example of a purchase-sized step, not guaranteed net savings; replacement purchases also cost money. Only move the actual amount left after essential payments. A modeled covered buffer is historical and does not prove money is earmarked or available today.' };
}

export const SAVING_ACTION_GUIDANCE = `For saving, write a practical three-step plan using saving_plan, not just a remainder and percentage cut.
First, essential_payments_first means cover bills, food and necessary travel before additional saving or investing;
if review_saving_transfers is true, suggest adjusting the timing/amount of existing transfers to avoid running short.
build_buffer_first means build an easily accessible emergency buffer before considering investing.
verify_buffer_first means the buffer is not verified: suggest checking money reserved for bills and starting or topping up a separate buffer.
Only buffer_estimate_covered permits one brief CONDITIONAL mention that investing can be considered if the buffer,
near-term bills and planned purchases are still covered today. Never say the user should invest merely because a month had a surplus.
Do not recommend products, funds, stocks, allocations, returns, investment amounts or strategies; these are outside this project.
Next, choose one optional small_steps example that fits the recorded category. Describe its concrete action;
its average_payment_eur is the historical average purchase amount, not guaranteed saving. Restaurant alternatives
may have a replacement food cost; do not promise the full average as net savings. Do not infer a coffee, cinema or travel habit.
Finally, suggest moving only the actual amount saved into a separate buffer after essential payments are covered,
or checking the next discretionary purchase against the monthly budget. Offer the step as a choice, without pressure.
If there is no supported purchase-sized example, use cut_example as a monthly spending limit with its exact after_eur,
or a qualitative optional-purchase step; never invent a transaction amount, number of visits or automatic transfer.
Keep these three bullets concrete and within the supplied length limit. Each month's evidence stays in that month.
Existing saving transfers are already money set aside, not new savings. An account balance is not a verified free-to-invest amount.`;

export function savingAdviceError(bullets, plan = null) {
  const text = bullets.join(' ');
  if (/\b(?:ETF|osakke|osake|rahasto|krypto|bitcoin|indeksi|allokaa|tuotto|portfolio|stocks?\b|bonds?\b|mutual\s+fund|index\s+fund|crypto|allocation|returns?\b)/iu.test(text)) {
    return 'Investment products, allocations, strategies and returns are outside the project scope.';
  }
  const investing = bullets.filter(value => /sijoit|\binvest/iu.test(value));
  if (investing.length > 1 || investing.some(value => /\d|%|€/u.test(value))) {
    return 'Keep investing to one brief statement without an investment amount or detailed advice.';
  }
  for (const bullet of investing) {
    const bufferFirst = /ennen\s+sijoittamista|(?:ensin|ensinpä)\b.{0,70}puskur|puskur.{0,70}\bensin|älä\b.{0,30}sijoita|sijoittami\S*\s+ei\b|before\s+(?:you\s+)?invest|(?:buffer|emergency\s+fund).{0,35}\bfirst|\b(?:don't|do\s+not)\s+invest/iu.test(bullet);
    if (bufferFirst) continue;
    if (!/\b(?:jos|kun|vasta|if|once|when|only\s+after)\b/iu.test(bullet) || (plan && plan.investment_scope !== 'brief_conditional_option_only')) {
      return 'Put essential payments and the buffer first; only verified buffer coverage permits a brief conditional investing option.';
    }
  }
  return null;
}
