# Oma talous — S-mobiili-style data tab

A local, mobile-first UI demo for the S-Pankki Personal Economic Trainer challenge. The single **Oma talous** tab follows the user's S-mobiili screenshots: pale mint surfaces, white cards, green headings, simple line icons and fixed bottom navigation. The other navigation tabs only illustrate where the new feature fits; they are not rebuilt banking screens. This is an independent hackathon prototype, not an official S-Pankki service.

## Run locally

Requires Node.js 24 LTS. No dependency installation or frontend build is needed.

```powershell
cd C:\Users\nikik\Documents\hackathon_project\spankki_hackaton_project\ui-demos
node server.mjs
```

Open **http://127.0.0.1:4173/**. The server binds only to the local machine and serves static assets only from `public/` plus server-scoped data and chat endpoints. Stop a foreground server with Ctrl+C. Set `$env:PORT = '4174'` before starting to use another port.

The project includes a tested web server with insight cards and a Claude chat endpoint, a multi-stage Dockerfile, local Docker Compose settings, and a Google Cloud Run deployment script. See [DEPLOYMENT.md](./DEPLOYMENT.md) for setup, settings, access and deployment commands. Preparing this package does not deploy a cloud service.

## Try the demo

- View one server-configured synthetic demo customer across all 24 months (October 2024–September 2026).
- Click one of the three front-page insights to start a fresh chat about that insight.
- Inspect income, spending, the remaining income and the recorded account balance.
- Open spending categories and view the underlying transactions.
- Switch between income and spending breakdown rings.
- Compare annual spending with the preceding year, select a month from the chart, and inspect exact values in a table.
- Open **Menohistoria** for day/hour, week, month, year and multi-year views. Select a point, show income or the previous period, and drill down to transactions.
- Compare weekday/weekend spending with the customer's own previous month, including daily averages.
- Explore three illustrative spending baskets.
- Adjust the restaurant-spending reduction slider to calculate a possible monthly saving.
- Open **Rahavuotesi on valmis** for a swipeable year-in-review story of the last 12 months (see [../wrapped/README.md](../wrapped/README.md)). `#rahavuosi` in the URL opens it directly.
- Open **Kysy**, type a question and send it to Claude. Follow-up messages retain recent conversation context. Enter sends; Shift+Enter adds a line break.

**Chat is live when the server has `ANTHROPIC_API_KEY` configured.** The browser calls same-origin `POST /api/chat`; Node calls Claude with the conversation. General chat has no financial context. Clicking an insight also includes the configured demo customer's dated financial summary and group-level peer statistics. The server resolves the insight ID; the browser cannot supply a customer ID or replace the context. No raw transactions, other customer records, database or financial tools are sent. The server key stays in Secret Manager on Cloud Run. Conversations live in page memory, can be cleared with **Uusi keskustelu**, and reset on reload. Only the last five exchanges are included as context, within a 14,000-character budget.

## Data and calculations

`scripts/prepare-data.mjs` streams the source CSV, counts all **3,626,755 transactions**, and extracts four synthetic customers into private `server-data/demo-data.json`. The complete source covers **1 October 2024–30 September 2026**, **5,100 customers**, **200 mortgage cases**, and **3,452 mortgage events**. The public UI serves only `CUST00207` by default. `/demo-data.json` filters the private source to that one profile and excludes the mortgage and negotiation records. The Money Wrapped recap endpoint is scoped to the same customer; its multi-customer source bundle is also private. The customer switcher has been removed. `PUBLIC_DEMO_CUSTOMER_ID` is deployment configuration, not a request parameter; only allowlisted synthetic IDs are accepted, and matching prepared insights must exist.

No personal names or account information from the screenshots are used. Merchant names are absent from the source, so transaction rows show the supplied merchant IDs.

- Income = nonnegative Salary + Other Income. Refunds and income reversals appear as other account movements in the cash-flow detail; the cards and charts share the same classification.
- Everyday spending = the ten consumer-spending categories, excluding investment deposits, investment withdrawals and salary sweeps.
- Remaining income = income − everyday spending. The detail sheet separately lists transfers and the net movement of all account transactions. Remaining income is not an account balance or a safe-to-spend estimate.
- Account balance = the latest recorded balance of each sample account up to the selected month, summed across accounts. It is historical, not live.
- Baskets use illustrative category rules. Regular needs include housing, groceries, utilities and transport; irregular needs include health and home/technology; discretionary choices include restaurants, lifestyle, entertainment and travel. The data does not establish whether individual purchases were necessary.
- Potential savings = the selected month's restaurant spending × the chosen reduction percentage. This is a historical scenario, not a forecast or money transfer.

Financial calculations run in the browser. Insight chat uses only the prepared summary for the same configured customer. Comparisons contain group aggregates, never individual peer records. Neither chat nor the browser can select another customer. This is a public demo without banking authentication or application conversation storage: every visitor sees the same synthetic customer. Real customer data must not be deployed here until authenticated sessions map each visitor to their own customer on the server. Provider requests are capped at 30 per minute and four simultaneous calls per server instance, with 800 output tokens each; these are demo limits, not a durable spending quota.

## Regenerate and check

```powershell
node scripts/prepare-data.mjs
node scripts/check.mjs
```

Generate the three Finnish cards using the project Python environment, with `ANTHROPIC_API_KEY` set securely:

```powershell
python scripts/prepare_insights.py --live --customer CUST00207
```

This makes billable Claude calls and sends only that synthetic customer's summary and aggregate peer statistics. It validates card shape and numeric grounding before replacing `server-data/insights.json`. Review the wording before deployment: number verification does not verify every factual claim. The checked-in cards have been edited for clarity and to distinguish estimates from calendar-month spending. Cards are generated once, not on page loads. Recreate and review them when the underlying snapshot changes. Their date remains visible regardless of the selected month.

Source CSVs remain unchanged. Preparation reads `../Data/tx_junction_transactions.csv`, `tx_customers_junction.csv`, `mtg_tx_customer_link_and_final_mtg_infio.csv`, and `mtg_negotiation_history.csv`.

The checks cover JavaScript syntax, exact sample totals, transfer separation, reconciliation across every sample/month, percentage scenarios, retained planning/mortgage helpers, chronological balances, malformed timestamps, HTTP integration and customer-isolation checks (forged IDs/context, public downloads and provider payloads). See [LOGIC_REVIEW.md](./LOGIC_REVIEW.md) for findings and limits. Run `node scripts/check.mjs` independently of data regeneration; the prepared sample JSON is included.

The previous five-concept presentation is preserved in `archive/five-concepts/` as source snapshots. That directory is outside the server's public root and is not served by the demo.

## Reuse in the future app

The new charts are isolated in `public/finance-analytics/`, with a single project adapter in `public/adapters/project-finance.js`. See [INTEGRATION.md](./INTEGRATION.md) for the data contract, mount/update/destroy API, theme variables, React integration pattern and standalone example. No library installation or cloud deployment is required.
