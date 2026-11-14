// The same response limits are checked by the model adapter and the browser.
export const SUMMARY_LIMITS = Object.freeze({
  simple: Object.freeze({ minBullets: 2, maxBullets: 2, maxChars: 120 }),
  standard: Object.freeze({ minBullets: 2, maxBullets: 3, maxChars: 140 }),
  detailed: Object.freeze({ minBullets: 2, maxBullets: 3, maxChars: 500 }),
});

// Spending needs room for purchase pattern, timing and comparison in ordinary language.
const spendingStandard = Object.freeze({ ...SUMMARY_LIMITS.standard, maxChars: 220 });
export const summaryLimits = (level, topic) => topic === 'spending' && level === 'standard'
  ? spendingStandard : SUMMARY_LIMITS[level];
