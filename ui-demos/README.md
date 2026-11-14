# Oma talous — S-mobiili-style data tab

A mobile-first UI demo for the S-Pankki Personal Economic Trainer challenge. The **Oma talous** tab starts with an open question field and three expandable topics: spending, weekly affordability and saving. Charts appear inside the selected topic, alongside a short AI-generated summary and a follow-up conversation. Compact key-insight rows are explicitly labeled as AI-generated. Pale mint surfaces, consistent typography and fixed bottom navigation retain the banking app's identity. The other navigation tabs illustrate where the feature fits; they are not rebuilt banking screens. This is an independent hackathon prototype using synthetic data, not an official S-Pankki service.

## Run locally

Requires Node.js 24 LTS, Python 3.12+ and the Git LFS database snapshot at `../BDA/output/coach.duckdb`. There are no npm dependencies or frontend build steps. Create a separate Python environment for the UI worker: its `duckdb==2.0.0` dependency is needed to read the snapshot. Do not upgrade the existing project/backend environment that uses DuckDB 1.5.6.

```powershell
cd C:\Users\nikik\Documents\hackathon_project\spankki_hackaton_project\ui-demos
git lfs pull
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r runtime\requirements.txt
Copy-Item .env.example .env
# Set ANTHROPIC_API_KEY in the private .env to enable insights and chat.
node --env-file=.env server.mjs
```

Open **http://127.0.0.1:4173/**. Node automatically uses `ui-demos/.venv`; `COACH_PYTHON` can override the interpreter. The server warms the three customers' database contexts and chart data before accepting requests. Stop it with Ctrl+C. `HOST` defaults to loopback; change `PORT` for another local port.

The same service runs on Google Cloud Run. See [DEPLOYMENT.md](./DEPLOYMENT.md) for secrets, Docker and deployment. Preparing the package does not deploy it.

## Try the demo

- Select one of three synthetic demo customers from the front-page selector.
- Ask your own question in the opening field, or expand **Mihin rahani menivät?**, **Paljonko voin käyttää tällä viikolla?** or **Miten voisin säästää enemmän?**. Only the opened topic requests a short summary through the existing customer-scoped chat endpoint. Reopening reuses the pending/completed answer for that selection, topic and month; weekly estimates use the snapshot date instead of the month. Switching customers aborts and clears these requests. Errors show a retry action while charts remain usable.
- Continue a topic with **Kysy tästä valmentajalta**; the generated answer remains in the conversation history. Weekly affordability requests `safe_to_spend`, savings scenarios request `what_if`, and historical income/expense charts are explicitly distinguished from weekly spending capacity.
- Read the three Claude-generated insights, then click a card to start a chat about it.
- Ask about the selected customer's finances, including exact spending periods, transactions and affordability scenarios. **Jatka keskustelua** reopens the latest conversation. Both ordinary chat and insight chat have customer context.
- Inspect income, spending, remaining income and historical account balances across October 2024–September 2026.
- Open spending categories and their transactions, or switch income/spending breakdown rings.
- Compare annual spending, select chart months and inspect exact values in a table.
- Open **Menohistoria** for day/hour, week, month, year and multi-year views, with transaction drill-down.
- Compare weekday/weekend spending with the customer's own previous month and explore the three illustrative spending baskets.
- Adjust the restaurant-spending reduction slider to calculate a historical savings scenario.
- Open **Rahavuotesi** for the last 12 months' swipeable recap; `#rahavuosi` opens it directly. See [../wrapped/README.md](../wrapped/README.md).

Chat history lives in page memory and resets on reload, customer switch or **Uusi keskustelu**. Only the last five exchanges, within a 14,000-character budget, are sent as conversation history. Enter sends; Shift+Enter adds a line break.

## Data, insights and chat

Node starts one persistent Python worker over private standard-input/output pipes. The worker opens `BDA/output/coach.duckdb` read-only and caches each customer's chart bootstrap, compact profile and detailed insight context. It performs no runtime CSV scan or model fitting. The database contains the synthetic snapshot; no database download or Python backend is required on a visitor's computer.

On page load or customer selection, charts and insights load independently. `/demo-data.json` returns only the selected customer's chart/transaction profile. The first `/api/insights` request for a customer and snapshot waits for Claude generation while the browser shows a loading state; keeping that request open also keeps Cloud Run request CPU available. Three validated cards are cached in the Node process for one hour, keyed by customer, snapshot, model and prompt version. Concurrent requests share the same job. Failed generation stays failed until the user explicitly retries; no static fallback cards are presented as model output. First generation takes several seconds. Cloud Run cold starts and restarts also clear the in-memory caches.

For every `/api/chat` request, Node adds the selected customer's compact, dated profile. Claude can request seven bounded, read-only tools: `get_spending`, `get_cash_flow`, `get_transactions`, `safe_to_spend`, `what_if`, `compare_to_peers`, and `get_model_detail`. Exact financial calculations happen in Python/DuckDB. Individual transaction pages contain at most 20 rows, so the full transaction history is not placed in each model prompt. Insight chat additionally includes the selected card. Shared prompt instructions and customer profile use Anthropic ephemeral prompt caching; this is separate from the application's one-hour card cache, and a cache hit is not guaranteed.

`ANTHROPIC_API_KEY` enables these billable calls and stays on the server. The default model is `claude-haiku-5-5`. The instance allows at most four simultaneous provider calls and 30 provider calls per minute. Chat is bounded to four model rounds, six tool calls and 1,200 output tokens per round; insight generation allows 2,200 output tokens per attempt and up to two validation attempts. The total model flow has a 75-second deadline. These in-memory controls are not a durable spending quota.

## Customer scope

The demo selector allows `CUST00207`, `CUST00127` and `CUST00103`. `PUBLIC_DEMO_CUSTOMER_ID` chooses the initial selection only. `GET /api/session` creates a signed, HttpOnly session cookie; `POST /api/session` changes it to another allowlisted synthetic customer. Every selection has a fresh nonce, sent in `X-Demo-Selection` on data, recap, insight and chat requests. Expired sessions or stale selections cause the browser to reload its selection. Switching customers aborts pending work and clears charts, insights, recap and chat history before loading the new selection.

The server, not a prompt or tool argument, supplies customer identity to the worker. Tools reject customer overrides and arbitrary SQL. Other people appear only through aggregate peer statistics. Database files and multi-customer recap sources stay outside `public/`.

This is a public demo: any visitor may deliberately select any of the three synthetic personas. The signed cookie protects request scope; it is not banking authentication. Real data requires verified login and a server-side mapping from the authenticated user to their permitted customer, replacing the public allowlist selector. In production, the cookie signing secret must be a stable `DEMO_SESSION_SECRET` of at least 32 characters, supplied through Secret Manager.

## Data and calculations

The source covers **3,626,755 transactions**, **5,100 synthetic customers**, **200 mortgage cases** and **3,452 mortgage events**, dated **1 October 2024–30 September 2026**. The web demo uses three allowlisted customers from the read-only DuckDB snapshot. Money Wrapped uses a private prepared bundle filtered to the same selection. The snapshot date is historical, not a live bank balance. Merchant names are absent from the source, so transaction rows show supplied merchant IDs.

- Income = nonnegative Salary + Other Income. Refunds and income reversals are other account movements.
- Everyday spending = the ten consumer-spending categories, excluding investment deposits, investment withdrawals and salary sweeps.
- Remaining income = income − everyday spending. It is not account balance or safe-to-spend; the cash-flow detail separately shows transfers and net account movement.
- Account balance = the latest recorded balance of each account up to the selected month, summed across accounts.
- Baskets use illustrative category rules; the data does not establish whether individual purchases were necessary.
- The restaurant slider uses the selected month's spending × the chosen reduction. It is a historical scenario, not a forecast or money transfer.

Charts calculate from the selected bootstrap in the browser. Model tools calculate exact totals and scenarios on the server; prompt context distinguishes smoothed model estimates from historical amounts. Peer comparisons contain group aggregates only.

## Prepare and check

```powershell
node scripts/check.mjs
.venv\Scripts\python.exe -m unittest discover -s runtime -p test_worker.py -v
node scripts/prepare-runtime.mjs
```

The checks cover JavaScript syntax, financial calculations, HTTP/session isolation, model requests with mocked responses, worker validation and exact DuckDB totals. They make no paid model calls. `prepare-runtime.mjs` copies the database and minimal `coach_context`/BDA code into private `.runtime/` for Docker builds. `deploy/deploy.ps1` runs packaging and Node checks automatically. See [runtime/README.md](./runtime/README.md) for worker operations, caching and tests.

`scripts/prepare-data.mjs` remains a legacy CSV-to-JSON fixture exporter for validation; live chart data now comes from DuckDB. Source CSVs remain unchanged. Replace the database and redeploy to use a new snapshot; the worker reads an immutable snapshot for its process lifetime. Insight cards are generated at runtime and do not need an offline generation step.

The previous five-concept presentation remains in `archive/five-concepts/`, outside the public root. See [LOGIC_REVIEW.md](./LOGIC_REVIEW.md) for the original chart-calculation review.

## Reuse in the future app

Charts are isolated in `public/finance-analytics/`, with the project adapter in `public/adapters/project-finance.js`. [INTEGRATION.md](./INTEGRATION.md) documents their data contract, mount/update/destroy API, theme variables, React pattern and standalone example.
