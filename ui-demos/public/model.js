export const spendingCategories = ['Housing', 'Utilities', 'Groceries', 'Health', 'Home & Tech', 'Transportation', 'Restaurants', 'Lifestyle', 'Entertainment', 'Travel'];
export const defaultBaskets = { Housing: 0, Utilities: 0, Groceries: 0, Transportation: 0, Health: 1, 'Home & Tech': 1, Restaurants: 2, Lifestyle: 2, Entertainment: 2, Travel: 2 };
export const sum = values => values.reduce((a, b) => a + b, 0);
// Transaction amounts have cent precision. Sum cents before returning EUR numbers.
const sumMoney = values => values.reduce((a, b) => a + Math.round(b * 100), 0) / 100;
// Share the same classification between summary cards and portable charts.
export function transactionKind(t) {
  if (spendingCategories.includes(t.category) && t.amount < 0) return 'expense';
  if (['Salary', 'Other Income'].includes(t.category) && t.amount >= 0) return 'income';
  return 'transfer';
}
export const money = (n, decimals = 0) => new Intl.NumberFormat('en-FI', { style: 'currency', currency: 'EUR', maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(n === 0 ? 0 : n);
export const monthLabel = (month, short = false) => new Date(month + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: short ? 'short' : 'long', ...(short ? {} : { year: 'numeric' }), timeZone: 'UTC' });
export function metrics(profile, month) {
  const ordered = [...profile.transactions].sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  const transactions = ordered.filter(t => t.date.startsWith(month));
  const spend = transactions.filter(t => transactionKind(t) === 'expense');
  const income = sumMoney(transactions.filter(t => transactionKind(t) === 'income').map(t => t.amount));
  const spending = -sumMoney(spend.map(t => t.amount));
  const categories = Object.fromEntries(spendingCategories.map(c => [c, -sumMoney(spend.filter(t => t.category === c).map(t => t.amount))]));
  const asOf = ordered.filter(t => t.date.slice(0, 7) <= month);
  const balances = new Map();
  for (const t of asOf) balances.set(t.account, t.balance);
  const deposits = -sumMoney(transactions.filter(t => t.category === 'Invest Deposit').map(t => t.amount));
  const sweeps = -sumMoney(transactions.filter(t => t.category === 'Salary Sweep').map(t => t.amount));
  const withdrawals = sumMoney(transactions.filter(t => t.category === 'Invest Withdraw').map(t => t.amount));
  const otherFlow = sumMoney(transactions.filter(t => transactionKind(t) === 'transfer' && !['Invest Deposit', 'Salary Sweep', 'Invest Withdraw'].includes(t.category)).map(t => t.amount));
  return { transactions, spend, income, spending, categories, balance: sumMoney([...balances.values()]), deposits, sweeps, withdrawals, otherFlow, margin: sumMoney([income, -spending]), netFlow: sumMoney(transactions.map(t => t.amount)), asOf: asOf.at(-1)?.date };
}
export function basketTotals(categories, mapping = defaultBaskets) {
  return [0, 1, 2].map(i => sumMoney(Object.entries(categories).filter(([c]) => mapping[c] === i).map(([, value]) => value)));
}
export function scenarioSavings(categories, cuts) {
  return sum(Object.entries(cuts).map(([c, cut]) => (categories[c] || 0) * Math.max(0, Math.min(100, Number(cut) || 0)) / 100));
}
export function mortgagePayment(principal, annualRate, years) {
  const months = years * 12, rate = annualRate / 1200;
  if (principal <= 0 || months <= 0) return 0;
  return rate === 0 ? principal / months : principal * rate / (1 - Math.pow(1 + rate, -months));
}
export function weeklyBudget(balance, reserved, buffer, weeks = 4) {
  return Math.max(0, balance - reserved - buffer) / Math.max(1, weeks);
}
