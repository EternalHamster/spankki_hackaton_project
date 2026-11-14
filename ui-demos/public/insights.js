import { locale } from './language.js';
const dateLabel = value => new Date(value + 'T12:00:00Z').toLocaleDateString(locale(), { timeZone: 'UTC' });

// Periods follow the historical data date, never the visitor's clock or a chart selector.
export function insightPeriod(period, asOf) {
  const date = new Date(asOf + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf || '') || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== asOf) {
    throw new Error('Invalid insight snapshot date');
  }
  if (period === 'weekly') return { label: 'Viikkonosto', detail: `Viikkoarvio ${dateLabel(asOf)} tilanteesta` };
  if (period === 'monthly') return { label: 'Kuukausinosto', detail: `${dateLabel(asOf.slice(0, 7) + '-01')}–${dateLabel(asOf)}` };
  if (period === 'yearly') {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
    return { label: 'Vuosinosto', detail: `${dateLabel(start)}–${dateLabel(asOf)} · 12 kk` };
  }
  throw new Error('Invalid insight period');
}
