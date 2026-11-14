/** Calendar dates are inclusive ISO YYYY-MM-DD values; currency is EUR. */
export interface FinanceTransaction {
  date: string;
  time?: string;
  amount: number;
  kind: 'expense' | 'income' | 'transfer';
  category: string;
  label?: string;
  merchant?: string;
}
export interface FinanceDataset {
  coverage: { from: string; to: string };
  transactions: FinanceTransaction[];
}
export interface FinanceAnalyticsOptions {
  data: FinanceDataset;
  /** YYYY-MM; defaults to the final covered month. */
  selectedMonth?: string;
  /** Defaults to all sections; hosts can reveal just the charts relevant to a question. */
  sections?: Array<'breakdown' | 'annual' | 'history' | 'rhythm'>;
  /** Half-donut and integrated category labels, with full details available on demand. */
  compactBreakdown?: boolean;
  /** Show category percentage labels; defaults to true. */
  showPercentages?: boolean;
  onSelectMonth?: (month: string) => void;
  /** Omit to use the component's own transaction dialog. */
  onSelectCategory?: (category: string) => void;
}
export interface FinanceAnalyticsInstance {
  update(options?: Partial<FinanceAnalyticsOptions>): void;
  destroy(): void;
}
export function createFinanceAnalytics(host: HTMLElement, options: FinanceAnalyticsOptions): FinanceAnalyticsInstance;
