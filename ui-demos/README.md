# Oma talous — S-mobiili-style data tab

A mobile-first UI demo for the S-Pankki Personal Economic Trainer challenge. The **Oma talous** tab starts with an open question field and four expandable topics: purchase planning, spending, weekly spending room and saving. Charts appear inside the selected topic, alongside a short Finnish summary prepared by Claude before deployment and a button for live follow-up chat. Actionable insight cards show a dated weekly estimate, a monthly observation and a last-12-month observation. Each includes supporting evidence, a concrete first step and a planning chat, and is explicitly labeled as AI-generated. The original Rahavuotesi card sits below the insights. Pale mint surfaces, consistent typography and fixed bottom navigation retain the banking app's identity. The other navigation tabs illustrate where the feature fits; they are not rebuilt banking screens. This is an independent hackathon prototype using synthetic data, not an official S-Pankki service.

## Run locally

Requires Node.js 24 LTS, Python 3.12+ and the Git LFS database snapshot at `../BDA/output/coach.duckdb`. There are no npm dependencies or frontend build steps. Create a separate Python environment for the UI worker: its `duckdb==2.0.0` dependency is needed to read the snapshot. Do not upgrade the existing project/backend environment that uses DuckDB 1.5.6.

```powershell
cd C:\Users\nikik\Documents\hackathon_project\spankki_hackaton_project\ui-demos
git lfs pull
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r runtime\requirements.txt
Copy-Item .env.example .env
# Set ANTHROPIC_API_KEY privately for live chat and explicit content regeneration.
node --env-file=.env scripts/check-prepared.mjs
node --env-file=.env server.mjs
```

Open **http://127.0.0.1:4173/**. Node automatically uses `ui-demos/.venv`; `COACH_PYTHON` can override the interpreter. The server warms the three customers' database contexts and chart data and validates the prepared content before accepting requests, without model calls. A missing or stale bundle must be regenerated as described below. Stop the server with Ctrl+C. `HOST` defaults to loopback; change `PORT` for another local port.

The same service runs on Google Cloud Run. See [DEPLOYMENT.md](./DEPLOYMENT.md) for secrets, Docker and deployment. Preparing the package does not deploy it.

## Try the demo

- Select one of three synthetic demo customers from the front-page selector.
- Open **Onko minulla varaa tähän?** and describe what you would like, even if the budget is still open. **Jutellaan tästä** starts a conversation; the coach asks for missing price or timing one question at a time. Once enough is known, it calculates a plan and offers an **Aloita tavoite** confirmation card. Opening the section itself makes no model call.
- Confirmed purchase projects appear directly under that topic and remain visible when the conversation entry is collapsed. Up to three projects per customer persist in this browser. Record the total you have actually set aside under **Vinkit ja säästöjen kirjaus**; the progress bar and remaining-month estimate use those entries, never elapsed time or the historical account balance. Tips use recorded discretionary spending and show the effect of an extra saving beyond the planned monthly amount. **Jatka suunnittelua** can recalculate an existing goal while preserving its recorded savings. **Poista tavoite** removes it.
- Project calculations exclude protected spending categories from saved preferences and reserve the monthly amounts of other active goals. If preferences change, old tips and time estimates are hidden until the plan is reviewed and confirmed again. Plans retain their dated data source and any savings-redirection, budget or buffer conditions; they are not bank transfers or live affordability guarantees.
- Ask your own question in the opening field, or expand **Mihin rahani menivät?**, **Paljonko voin käyttää tällä viikolla?** or **Miten voisin säästää enemmän?**. The browser preloads all three default-month answers through the read-only `/api/summaries` endpoint. Opening a section or changing its month retrieves prepared text and makes no model call. Weekly estimates use the snapshot date instead of the selected month. Switching customers aborts and clears old requests; read errors offer a retry while charts remain usable.
- Continue a topic with **Kysy tästä valmentajalta**; its prepared answer becomes conversation context for live chat. Weekly affordability is explicitly dated to the snapshot, while spending and savings summaries use exact selected-month figures.
- Read the three AI insights labeled **Viikkonosto**, **Kuukausinosto** and **Vuosinosto**, then select **Suunnittele valmentajan kanssa** to turn the suggested action into a practical plan. These insights do not change with a section's month selector.
- Ask about the selected customer's finances, including exact spending periods, transactions and affordability scenarios. **Jatka keskustelua** reopens the latest conversation. Both ordinary chat and insight chat have customer context.
- Tell the coach a lasting preference, for example **En halua vähentää ravintolakäyntejä**. The coach can remember up to 12 short preferences, priorities, goals or constraints for that demo customer. **Valmentajan muisti** in chat shows the notes and lets you forget one or clear them all. They survive **Uusi keskustelu**, refreshes and customer switching in this browser; other browsers/devices do not share them, and clearing browser storage removes them.
- Set **Valmentajan vastausten taso** with the slider in **Minä → Asetukset**, also available from **Valmentajan asetukset** on the home screen: **Selkeä** (a few plain sentences, at most two amounts), **Perus** (default: key figures, one comparison, a short reason) or **Syvällinen** (figures, comparisons, uncertainty and how estimates are formed, with terms explained). This browser-wide default applies to new questions in every chat. Each answer has **Selitä yksinkertaisemmin** and **Kerro tarkemmin** controls that rewrite that answer in place without changing the default or other answers. If browser storage is unavailable, a changed default applies only for the current visit.
- Inspect income, spending, remaining income and historical account balances across October 2024–September 2026. Spending, saving and transactions have independent month selectors; there is no global calendar. Transaction month changes preserve the selected category.
- Open spending categories and their transactions, or switch income/spending breakdown rings.
- Compare annual spending, select chart months and inspect exact values in a table.
- Open **Menohistoria** for day/hour, week, month, year and multi-year views, with transaction drill-down.
- Open spending with a compact half-donut and integrated category labels. Its prepared AI explanation highlights a material category change (at least €50 and 25%) against the previous complete month, falling back to flexible spending when comparison is unavailable. Housing and utilities do not crowd out variable expenses.
- Expand the month-comparison/history details when needed. Question panels animate open and closed, with an immediate transition for reduced-motion preferences. Saving shows only its selected-month summary and follow-up chat.
- Open **Rahavuotesi** for the last 12 months' swipeable recap; `#rahavuosi` opens it directly. See [../wrapped/README.md](../wrapped/README.md).

Assistant messages render a safe subset of Markdown: bold, emphasis, inline code, paragraphs and lists. HTML and links remain escaped; user messages remain plain text.

Chat history lives in page memory and resets on reload, customer switch or **Uusi keskustelu**. Only the last five exchanges, within a 14,000-character budget, are sent as conversation history. Enter sends; Shift+Enter adds a line break.

## Data, insights and chat

Node starts one persistent Python worker over private standard-input/output pipes. The worker opens `BDA/output/coach.duckdb` read-only and caches each customer's chart bootstrap, compact profile and detailed insight context. It performs no runtime CSV scan or model fitting. The database contains the synthetic snapshot; no database download or Python backend is required on a visitor's computer.

On page load or customer selection, charts and prepared text load independently. `/demo-data.json` returns only the selected customer's chart/transaction profile. `/api/insights` returns that customer's three prepared cards; `GET /api/summaries?topic=spending&month=YYYY-MM`, `?topic=saving&month=YYYY-MM`, or `?topic=week` returns their concise bullet answer. All require the signed session and current selection nonce. The tracked `server-data/coach-answers.json` bundle contains 144 monthly answers (24 months × two topics × three customers), three weekly answers and three sets of three key insights. It remains private to the server.

Prepared content has no time-based regeneration or one-hour expiry. It changes only when explicitly regenerated. Before readiness and deployment, validation checks the database hash, prompt version, model, all customers and covered months, bullet structure and current insight IDs. Missing, incomplete or stale content fails validation. Startup, customer/page loads, expanding sections and switching months do not call Claude; cold starts read and validate the packaged bundle again.

For every live `/api/chat` request, Node adds the selected customer's compact, dated profile. Claude can request eight bounded, read-only tools: `get_spending`, `get_cash_flow`, `get_transactions`, `safe_to_spend`, `afford`, `what_if`, `compare_to_peers`, and `get_model_detail`. Exact financial calculations happen in Python/DuckDB. Individual transaction pages contain at most 20 rows, so the full transaction history is not placed in each model prompt. Insight chat additionally includes the selected card. Shared prompt instructions and customer profile use Anthropic ephemeral prompt caching; a cache hit is not guaranteed. The answer level is a short block after the cached profile, so all three levels share the same cached prefix; it changes explanation depth and vocabulary, never the facts, tools or safety rules. `node scripts/compare-levels.mjs [customer] [question…]` makes billable calls and prints the same questions answered at each level with token usage.

`ANTHROPIC_API_KEY` enables billable live chat and the explicit preparation script; it stays private. The default model is `claude-haiku-5-5`. The instance allows at most four simultaneous provider calls and 30 provider calls per minute. Chat is bounded to four model rounds, six tool calls and 600 / 900 / 1,500 output tokens per round (Selkeä / Perus / Syvällinen), with a 75-second flow deadline. These in-memory controls are not a durable spending quota.

## Customer scope

The demo selector allows `CUST00207`, `CUST00127` and `CUST00103`. `PUBLIC_DEMO_CUSTOMER_ID` chooses the initial selection only. `GET /api/session` creates a signed, HttpOnly session cookie; `POST /api/session` changes it to another allowlisted synthetic customer. Every selection has a fresh nonce, sent in `X-Demo-Selection` on data, recap, insight, summary and chat requests. Expired sessions or stale selections cause the browser to reload its selection. Switching customers aborts pending work and clears charts, insights, summaries, recap and chat history before loading the new selection.

The server, not a prompt or tool argument, supplies customer identity to the worker. Tools reject customer overrides and arbitrary SQL. Other people appear only through aggregate peer statistics. Database files, prepared answers and multi-customer recap sources stay outside `public/`. Summary URLs accept only their declared topic/month fields, never a customer override.

This is a public demo: any visitor may deliberately select any of the three synthetic personas. The signed cookie protects request scope; it is not banking authentication. Real data requires verified login and a server-side mapping from the authenticated user to their permitted customer, replacing the public allowlist selector. In production, the cookie signing secret must be a stable `DEMO_SESSION_SECRET` of at least 32 characters, supplied through Secret Manager.

## Data and calculations

The source covers **3,626,755 transactions**, **5,100 synthetic customers**, **200 mortgage cases** and **3,452 mortgage events**, dated **1 October 2024–30 September 2026**. The web demo uses three allowlisted customers from the read-only DuckDB snapshot. Money Wrapped uses a private prepared bundle filtered to the same selection. The snapshot date is historical, not a live bank balance. Merchant names are absent from the source, so transaction rows show supplied merchant IDs.

- Income = nonnegative Salary + Other Income. Refunds and income reversals are other account movements.
- Everyday spending = the ten consumer-spending categories, excluding investment deposits, investment withdrawals and salary sweeps.
- Remaining income = income − everyday spending. It is not account balance or safe-to-spend; the cash-flow detail separately shows transfers and net account movement.
- Account balance = the latest recorded balance of each account up to the selected month, summed across accounts.
- Baskets use illustrative category rules; the data does not establish whether individual purchases were necessary.
- Prepared saving summaries illustrate a 20% reduction in the selected month's largest discretionary category among Restaurants, Lifestyle, Entertainment and Travel. The reduction uses exact selected-month totals; the modeled `what_if` tool describes a separate scenario at usual spending levels.

Charts calculate from the selected bootstrap in the browser. Model tools calculate exact totals and scenarios on the server; prompt context distinguishes smoothed model estimates from historical amounts. The raw snapshot contains 24 calendar months; BDA fits the 23 complete months from November 2024 through September 2026. Insight cards use a required `period` field: `weekly` is the allowance estimate at the snapshot date, `monthly` uses explicitly recorded last-month figures (with usual spending only as a labeled comparison), and `yearly` uses the last 12 calendar months. Dates come from the snapshot, independently of topic month selectors. Titles lead with actions; evidence explains why, and an untruncated action gives the first step. Peer comparisons contain group aggregates only.

## Prepare and check

```powershell
node scripts/check.mjs
.venv\Scripts\python.exe -m unittest discover -s runtime -p test_worker.py -v
node --env-file=.env scripts/check-prepared.mjs
node scripts/prepare-runtime.mjs
```

The checks cover JavaScript syntax, financial calculations, HTTP/session isolation, prepared-content validity, model requests with mocked responses, worker validation and exact DuckDB totals. They make no paid model calls. `prepare-runtime.mjs` copies the database and minimal `coach_context`/BDA code into private `.runtime/` for Docker builds. `deploy/deploy.ps1` runs packaging, prepared-content validation and Node checks automatically. Docker also checks the prepared bundle against the real packaged database. See [runtime/README.md](./runtime/README.md) for worker operations, caching and tests.

Regenerate the bundle after changing the database, prompts or model. From this folder, with `ANTHROPIC_API_KEY` supplied privately in `.env`:

```powershell
node --env-file=.env scripts/prepare-coach.mjs --generate
node --env-file=.env scripts/check-prepared.mjs
```

`--generate` explicitly enables billable Claude calls for all three approved synthetic customers. The script prepares every covered month in batches and writes the complete validated bundle to `server-data/coach-answers.json`. This synthetic derived data is tracked and should accompany the corresponding code/data change. Interrupted runs resume compatible work from ignored `.runtime/prepared-coach-progress.json`; a changed database hash, prompt version or model starts a fresh checkpoint. Never commit `.env` or checkpoints. For debugging only, optional `--debug` writes synthetic request/response bodies, without headers, under ignored `.runtime/`.

`scripts/prepare-data.mjs` remains a legacy CSV-to-JSON fixture exporter for validation; live chart data comes from DuckDB. Source CSVs remain unchanged. To use a new snapshot, replace the database, regenerate and validate the prepared answers, then redeploy. The worker reads an immutable snapshot for its process lifetime.

The previous five-concept presentation remains in `archive/five-concepts/`, outside the public root. See [LOGIC_REVIEW.md](./LOGIC_REVIEW.md) for the original chart-calculation review.

## Reuse in the future app

Charts are isolated in `public/finance-analytics/`, with the project adapter in `public/adapters/project-finance.js`. [INTEGRATION.md](./INTEGRATION.md) documents their data contract, mount/update/destroy API, theme variables, React pattern and standalone example.
