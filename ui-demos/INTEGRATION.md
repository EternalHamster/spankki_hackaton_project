# Portable financial analytics

Copy `public/finance-analytics/` into the future frontend. The runtime is two ES modules (`index.js`, `model.js`) and one scoped stylesheet; `index.d.ts` supplies TypeScript types for the public API. It has no dependencies, network calls, storage, framework, build step or coupling to the demo's navigation/chat. `example.html` is a runnable, isolated integration example and can be omitted from production.

## Mount, update, unmount

```html
<link rel="stylesheet" href="/finance-analytics/styles.css">
<div id="analytics"></div>
<script type="module">
  import { createFinanceAnalytics } from '/finance-analytics/index.js';

  const data = {
    coverage: { from: '2026-08-01', to: '2026-09-30' },
    transactions: [
      { date: '2026-09-01', time: '09:30:00', amount: 2400,
        kind: 'income', category: 'salary', label: 'Palkka' },
      { date: '2026-09-02', time: '18:15:00', amount: -43.90,
        kind: 'expense', category: 'groceries', label: 'Ruokaostokset' },
    ],
  };

  const widget = createFinanceAnalytics(document.querySelector('#analytics'), {
    data,
    selectedMonth: '2026-09',
    onSelectMonth(month) { /* optional: sync the host app's month selector */ },
    onSelectCategory(category) { /* optional: open the host app's transactions */ },
  });

  // On a changed month, customer or API response:
  widget.update({ selectedMonth: '2026-08' });
  widget.update({ data, selectedMonth: '2026-09' });
  // Before removing its host element:
  // widget.destroy();
</script>
```

Without `onSelectCategory`, the module opens its own transaction dialog. Month selection works within the module and optionally notifies the host. Each instance has independent state, dialog IDs and event listeners. `destroy()` removes the instance and its listeners; repeated calls are safe. The host should provide an otherwise-empty mounting element.

The current app integration is in `public/app.js`. `public/adapters/project-finance.js` is the **only project-specific data mapping**; replace it when connecting the real API. Keep authentication and fetching in the host app or backend.

## Data contract

| Field | Meaning |
| --- | --- |
| `coverage.from`, `coverage.to` | Inclusive `YYYY-MM-DD` dates for the interval the supplied transaction data fully covers. Do not infer these from the first/last transaction: an observed day can legitimately have no transactions. |
| `transactions[].date` | Recorded local calendar date, `YYYY-MM-DD`. Dates are grouped without host-timezone conversion. |
| `time` | Optional recorded local time, `HH:mm:ss`. Missing/invalid times appear in a separate unknown-time bucket in the day view. |
| `amount` | Finite signed EUR number. Expense amounts must be negative; income positive. |
| `kind` | `expense`, `income` or `transfer`. Transfers are excluded from all analytics charts. |
| `category` | Stable category identifier passed to `onSelectCategory`. |
| `label` | Display name for that category. Defaults to the category identifier. |
| `merchant` | Optional displayable merchant name or ID. |

Pass a complete transaction set for the declared interval, not a paginated subset. Merge/deduplicate paginated API results in the adapter first. Refund classification is a host-adapter decision; the current project adapter excludes nonnegative consumer-category entries rather than assuming they are earnings. Currency and UI text are EUR/Finnish in this version.

## React/Vite integration pattern

The module can be mounted in a React effect without rewriting the charts:

```jsx
import { useEffect, useRef } from 'react';
import { createFinanceAnalytics } from './finance-analytics/index.js';
import './finance-analytics/styles.css';

export function FinanceAnalytics({ data, selectedMonth, onSelectMonth, onSelectCategory }) {
  const host = useRef(null);
  const widget = useRef(null);
  const latest = useRef({ onSelectMonth, onSelectCategory });
  latest.current = { onSelectMonth, onSelectCategory };

  useEffect(() => {
    widget.current = createFinanceAnalytics(host.current, {
      data, selectedMonth,
      onSelectMonth: month => latest.current.onSelectMonth?.(month),
      ...(onSelectCategory ? {
        onSelectCategory: category => latest.current.onSelectCategory?.(category),
      } : {}),
    });
    return () => { widget.current?.destroy(); widget.current = null; };
  }, []);

  useEffect(() => {
    widget.current?.update({
      data, selectedMonth,
      onSelectCategory: onSelectCategory
        ? category => latest.current.onSelectCategory?.(category)
        : undefined,
    });
  }, [data, selectedMonth, onSelectCategory]);

  return <div ref={host} />;
}
```

This is an integration example, not an installed React dependency or a separate React app. Mount only on the client. The browser must support ES modules, SVG and native `<dialog>`.

## Theme and layout

All selectors are under `.fa-widget`; the module has no body/navigation styling. It fills its host and is designed for a mobile column. The app currently uses a 480px maximum width.

```css
.fa-widget {
  --fa-green: #007e43;
  --fa-mint: #eaf6ec;
  --fa-surface: #fff;
  --fa-ink: #222e27;
  --fa-muted: #708077;
}
```

Period controls, the chart selection slider and transaction drill-downs work by keyboard. Exact chart values are also available as tables. Chart SVGs are decorative where the same data has semantic HTML controls/tables.

## Calculation rules

- Sums accumulate integer cents. The adapter excludes transfers, investment movements and salary sweeps from spending/income charts.
- Annual comparisons use only complete calendar months covered in both years. For the demo's 2026 data this is January–September against January–September 2025.
- Unavailable periods are `null` and show “Ei aineistoa”; covered periods without transactions are zero. Partial years show their actual coverage dates. Lines break at unavailable comparison points.
- History views group by hour, Monday–Sunday week, day of month, month of year, or calendar year. Monthly comparisons align the same day number; nonexistent dates (e.g. 31 February) stay unavailable.
- Weekday/weekend percentages are shares of expense euros. The reference is the same customer's previous month, not a fabricated peer group. Per-day averages count all covered calendar days. Percentage changes require a positive, complete baseline.
- These are descriptive historical calculations. No predictions, bank operations or AI calls occur.

## Validation

```powershell
node --test tests/model.test.mjs tests/finance-analytics.test.mjs
```

Open `http://127.0.0.1:4173/finance-analytics/example.html` to check the module without the app stylesheet or project adapter. Its controls exercise `update`, `destroy` and remounting. Fixtures there are explicitly invented integration data; the main app uses the project samples.
