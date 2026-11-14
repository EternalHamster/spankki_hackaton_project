# Oma talous — S-mobiili-style data tab

A local, mobile-first UI demo for the S-Pankki Personal Economic Trainer challenge. The single **Oma talous** tab follows the user's S-mobiili screenshots: pale mint surfaces, white cards, green headings, simple line icons and fixed bottom navigation. The other navigation tabs only illustrate where the new feature fits; they are not rebuilt banking screens. This is an independent hackathon prototype, not an official S-Pankki service.

## Run locally

Requires Node.js 24 LTS. No dependency installation or frontend build is needed.

```powershell
cd C:\Users\nikik\Documents\hackathon_project\spankki_hackaton_project\ui-demos
node server.mjs
```

Open **http://127.0.0.1:4173/**. The server binds only to the local machine and serves only `public/`. Stop a foreground server with Ctrl+C. Set `$env:PORT = '4174'` before starting to use another port.

The project includes a tested static server, a multi-stage Dockerfile, local Docker Compose settings, and a Google Cloud Run deployment script. See [DEPLOYMENT.md](./DEPLOYMENT.md) for setup, settings, access and deployment commands. Preparing this package does not deploy a cloud service.

## Try the demo

- Switch among three synthetic customers and all 24 months (October 2024–September 2026).
- Inspect income, spending, the remaining income and the recorded account balance.
- Open spending categories and view the underlying transactions.
- Switch between income and spending breakdown rings.
- Compare annual spending with the preceding year, select a month from the chart, and inspect exact values in a table.
- Open **Menohistoria** for day/hour, week, month, year and multi-year views. Select a point, show income or the previous period, and drill down to transactions.
- Compare weekday/weekend spending with the customer's own previous month, including daily averages.
- Explore three illustrative spending baskets.
- Adjust the restaurant-spending reduction slider to calculate a possible monthly saving.
- Open the **Kysy** chat bubble. Suggested questions fill an editable draft for the later conversational feature.

**The chat is a UI preview only.** Sending is disabled, no questions are transmitted, and no local or cloud LLM is connected. There are no generated or scripted chat answers. Drafts live only in page memory and reset when the page reloads.

## Data and calculations

`scripts/prepare-data.mjs` streams the source CSV, counts all **3,626,755 transactions**, and extracts four synthetic customers into `public/demo-data.json`. The complete source covers **1 October 2024–30 September 2026**, **5,100 customers**, **200 mortgage cases**, and **3,452 mortgage events**. The current UI exposes these three sample customers:

- `CUST00207`: a positive September margin.
- `CUST00127`: a month with spending above income.
- `CUST00103`: a salary-sweep case showing why spending and account cash flow differ.

The fourth sample and one linked mortgage history remain in the prepared data for future use; the current UI does not display a mortgage flow. No personal names or account information from the screenshots are used. Merchant names are absent from the source, so transaction rows show the supplied merchant IDs.

- Income = nonnegative Salary + Other Income. Refunds and income reversals appear as other account movements in the cash-flow detail; the cards and charts share the same classification.
- Everyday spending = the ten consumer-spending categories, excluding investment deposits, investment withdrawals and salary sweeps.
- Remaining income = income − everyday spending. The detail sheet separately lists transfers and the net movement of all account transactions. Remaining income is not an account balance or a safe-to-spend estimate.
- Account balance = the latest recorded balance of each sample account up to the selected month, summed across accounts. It is historical, not live.
- Baskets use illustrative category rules. Regular needs include housing, groceries, utilities and transport; irregular needs include health and home/technology; discretionary choices include restaurants, lifestyle, entertainment and travel. The data does not establish whether individual purchases were necessary.
- Potential savings = the selected month's restaurant spending × the chosen reduction percentage. This is a historical scenario, not a forecast or money transfer.

All calculations run in the browser. There is no authentication, bank integration, external AI call or persistent storage.

## Regenerate and check

```powershell
node scripts/prepare-data.mjs
node scripts/check.mjs
```

Source CSVs remain unchanged. Preparation reads `../Data/tx_junction_transactions.csv`, `tx_customers_junction.csv`, `mtg_tx_customer_link_and_final_mtg_infio.csv`, and `mtg_negotiation_history.csv`.

The checks cover JavaScript syntax, exact sample totals, transfer separation, reconciliation across every sample/month, percentage scenarios, retained planning/mortgage helpers, chronological balances, malformed timestamps and HTTP integration. See [LOGIC_REVIEW.md](./LOGIC_REVIEW.md) for findings and limits. Run `node scripts/check.mjs` independently of data regeneration; the prepared sample JSON is included.

The previous five-concept presentation is preserved in `archive/five-concepts/` as source snapshots. That directory is outside the server's public root and is not served by the demo.

## Reuse in the future app

The new charts are isolated in `public/finance-analytics/`, with a single project adapter in `public/adapters/project-finance.js`. See [INTEGRATION.md](./INTEGRATION.md) for the data contract, mount/update/destroy API, theme variables, React integration pattern and standalone example. No library installation or cloud deployment is required.
