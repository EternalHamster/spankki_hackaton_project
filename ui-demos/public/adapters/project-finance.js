import { transactionKind } from '../model.js';

// The only project-specific mapping. Replace this adapter when a live API is available.
export function projectFinanceData(profile, summary, categoryLabels = {}) {
  return {
    coverage: { from: summary.from, to: summary.to },
    transactions: profile.transactions.map(t => ({
      date: t.date, time: t.time, amount: t.amount, category: t.category,
      label: categoryLabels[t.category] || t.category,
      kind: transactionKind(t),
      merchant: t.merchant || '',
    })),
  };
}
