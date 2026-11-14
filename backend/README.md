# Financial coach backend

The backend uses the **direct Anthropic API** for Claude and **Google Cloud Run** for hosting.
The webapp sends requests to FastAPI. Claude chooses approved tools, Python/DuckDB calculates
financial results, and Claude explains the returned aggregates.

The source database schema stays configurable. Customer isolation, decimal calculations and the
existing webapp are unchanged. The frontend chat button is still a preview awaiting API integration.

## Setup and a minimal Claude test

Run these commands in Google Cloud SDK Shell on this Windows workspace:

```cmd
cd /d "C:\Users\nikik\Documents\hackathon_project\spankki_hackaton_project\backend"
set "PYTHON_EXE=C:\Users\nikik\Documents\hackathon_project\.venv\Scripts\python.exe"
"%PYTHON_EXE%" -m pip install -c constraints.txt -e ".[test]"
"%PYTHON_EXE%" -m money_coach.smoke
```

The test reads `ANTHROPIC_API_KEY` or asks for it with a hidden prompt; the prompted key is not saved.
It sends one `hi` to Haiku with no tools or financial records and at most 32 output tokens, then prints
text and usage. It performs a real billable API request using the key's Anthropic workspace credits.
Tests under `tests/` use mocked HTTP and never make paid requests.

For a fresh checkout, use Python 3.11+ to create an environment (`python -m venv .venv`) and install
with `.venv\Scripts\python.exe -m pip install -c constraints.txt -e ".[test]"` from this directory.

**Cloud deployment:** follow [DEPLOYMENT.md](DEPLOYMENT.md). It contains SDK Shell commands for
Secret Manager, a private Cloud Run service and a deployed chat test. Google CLI login is only for
managing hosting; Claude itself requires the Anthropic key. No Google model quota is involved.

The existing cloud service can now be updated with `deploy.cmd` from this directory. It preserves
its saved key binding and demo settings, packages current code/data and checks readiness automatically.
Use `deploy.cmd --check` to check the server, or `deploy.cmd --chat "hi"` for a billable chat test;
both retrieve the service URL and Google authentication automatically.

## Run the API locally

Set `ANTHROPIC_API_KEY` in the backend process environment. The `.env.example` lists the supported
settings but is not auto-loaded. For a synthetic local demo, also set `DEMO_MODE=true` and
`DEMO_TOKENS_JSON` to a JSON object mapping a random bearer secret (24+ characters) to a customer ID.
For example, the structure is `{"<random-demo-token>":"CUST00207"}`. Never use the Anthropic key as
the demo token. Set `CORS_ORIGINS=http://127.0.0.1:4173` if the local webapp calls the API.

```cmd
"%PYTHON_EXE%" -m money_coach.ingest --source ..\Data\tx_junction_transactions.csv --mapping config\s-pankki.json --output data\finance.duckdb
"%PYTHON_EXE%" -m uvicorn money_coach.api:app --host 127.0.0.1 --port 8000
```

Skip import if that snapshot already exists. To refresh, create a new versioned output path and
restart the server with `DUCKDB_PATH` pointing to it. Source files are never modified or imported
by API workers. The current workspace already has a synthetic snapshot in `data/finance.duckdb`.

The API schema is at `http://127.0.0.1:8000/docs`. Financial endpoints require
`Authorization: Bearer <random-demo-token>`:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Process liveness. |
| `GET /readyz` | Snapshot, model client and authentication configuration; no paid call. |
| `GET /v1/data-context` | Customer-scoped data coverage; works without a model key. |
| `POST /v1/chat` | Send `{"message":"hi"}`; requires `ANTHROPIC_API_KEY`. |

Readiness does not verify remote model access or remaining Anthropic credit. Authentication defaults
to deny-all. A key is only used on the server, never returned to the browser.

## Adapt to the final database

The importer creates a stable internal contract: `transactions`, `monthly_spending`, and
`dataset_metadata`. These are derived snapshots, not a required schema for your source database.
Edit a JSON mapping to configure customer/date/category/amount columns, date format, sign convention,
expense/income categories and basket rules. `config/normalized-example.json` demonstrates different
column names and an already-positive `expense_eur` field.

```cmd
python -m money_coach.ingest --source C:/path/customer-data.duckdb --source-kind duckdb --mapping config/normalized-example.json --output data/finance-v2.duckdb
```

For normalized multi-table sources, the data owner should expose a prejoined view containing the
customer ownership key, date, category and amount. Map that view using `table: "schema.view_name"`.
Do not join account ownership by guessing. For nested JSON, a non-DuckDB source, refunds that need
netting, or transaction-type classification, add a deterministic upstream transformation/view or
implement `FinanceRepository` and inject it into `create_app`. The agent/tool contract stays stable.

Supported amount conventions:

| Convention | Meaning |
| --- | --- |
| `negative_debits` | Negative amounts in expense categories are spending; positive income is income. |
| `positive_debits` | Positive amounts in expense categories are spending; negative income is income. |
| `expense_only` | Already normalized, nonnegative expense amounts; no income categories allowed. |

Only configured expense categories count as spending. Other categories (including the supplied
investment transfers and salary sweeps) are excluded and counted as unmapped rows in the import
report. Refunds in expense categories are excluded from gross outgoing spending. These semantics
match the current UI; they are not net cash flow. Category mapping is case sensitive at import;
category queries are case insensitive. Unknown query categories are explicitly flagged.

Amounts become `DECIMAL(18,2)` (rounded to cents during import). Dates must cast to DATE or match
`date_format` such as `%d/%m/%Y`. Null/invalid required values and non-EUR currency values fail the
whole import. With no currency column the operator explicitly asserts EUR in the mapping; no
currency is inferred and no conversion is performed. The adapter does not deduplicate: if the source
contains overlapping exports, deduplicate by a trusted transaction ID upstream. Unmapped categories
are reported, never guessed. Mapping rules and a snapshot version are recorded alongside the data.

Tools return exact decimal strings. Date ranges use an exclusive end and are limited to 366 days.
Full calendar months use precomputed category summaries; partial months query canonical transactions.
Customer-specific observed date coverage accompanies results; observed endpoints cannot prove that
all transactions are present. Empty customer data is distinct from zero spending.

## Claude tools and boundaries

- `get_data_context`: coverage, categories and supported capabilities for the authenticated customer.
- `get_spending`: aggregate totals and counts, with no raw transaction descriptions or account IDs.
- `get_three_baskets`: illustrative regular needs, irregular needs and everyday choices; unknowns remain unclassified.
- `simulate_savings`: exact percentage reduction for a historical category/period, rounded half up to cents.
- `calculate_safe_to_spend`: explicit `insufficient_data` with missing inputs and a null amount.

Safe-to-spend is intentionally a capability placeholder until trusted, dated balances per account,
upcoming commitments, confirmed income, reserves, buffer and planning horizon are integrated.
Never sum historical balance-after values or substitute remaining income for cash available.

There is no arbitrary SQL, shell, filesystem or bank-write tool. Customer identity is captured in
`FinanceTools`, never exposed as a model argument. SQL values are bound parameters and source
identifiers are quoted by the importer. Tool arguments reject extra properties, including customer IDs.
Connections are read-only and scoped to each operation for thread safety. A future measured connection
pool must keep exclusive connection ownership; do not share one connection across FastAPI threads.

The agent handles multiple tool calls and matching results, unknown tools and invalid arguments,
truncated output, incomplete turns and exhausted loops. Limits: four model rounds, eight tool calls,
900 output tokens per round, 4,000 message characters, four concurrent chats, and a 30-second timeout
per SDK attempt with one automatic retry. Token usage is returned for successful chats; provider
usage may also accrue on failed/retried requests. No client-supplied assistant or tool history is accepted.
Requests are stateless: ask self-contained questions for now. Add server-owned sessions scoped to
verified identity when conversational memory is implemented.

Demo rate limits default to 10 chats/customer/minute and 500 total chat attempts per process.
These reset on restart and multiply across instances; they are not an account-wide spending cap.
Before a public demo, use a shared gateway/rate limiter, cap cloud instances and configure provider
billing controls. Prompts, financial results and secrets are not logged by application code.

Default `CLAUDE_MODEL=claude-haiku-5-5` is configurable. As checked on 2026-11-14,
[Anthropic lists Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview) as its
lowest-cost current model: $0.10 input / $0.50 output per million tokens for prompts up to 100,000
tokens, with a higher price above that threshold. This uses the
[Anthropic Python SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/python) and
[custom tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
not the Claude Code Agent SDK. No paid API calls are needed for tests or importing.

## Webapp and Google Cloud integration

The mobile webapp remains unchanged, including its preview-only chat. Its future chat handler sends
only `{ "message": "..." }` to `/v1/chat` with a verified bearer session, and renders the `answer` as text
(never unsanitized HTML). The response also includes `model`, `usage`, `tools_used` and `request_id`.
Do not send customer IDs, API keys or client-constructed tool results. The demo customer selector
is not authentication; a synthetic demo harness can distribute a separate short-lived secret per customer.

Authentication defaults to deny-all. `DEMO_MODE=true` explicitly enables the server-owned secret-to-ID
map for synthetic local demos. For a deployed service, implement a verifier that checks the banking
session/identity token (signature, issuer, audience and expiration), maps its subject to customer ownership
server-side, and inject it using `create_app(authenticate=verify_session)`. Demo auth is not a banking login.

The standard Dockerfile installs the direct Anthropic SDK and contains application code only.
Cloud Run injects `ANTHROPIC_API_KEY` from a versioned Secret Manager secret. The API uses the same
client configuration locally and on Cloud Run. Model usage is billed by Anthropic; hosting is billed
by Google Cloud. Provider-selection settings and cloud model authentication are no longer supported.

For the synthetic hackathon demo, `scripts/prepare_cloud_run.py` creates a separate, gitignored build
containing a validated snapshot. Its generated demo credentials stay outside the uploaded source.
[DEPLOYMENT.md](DEPLOYMENT.md) has the complete preparation, deployment and test steps.
For production, supply private versioned snapshots to local instance storage during startup and
implement verified user sessions. Do not share a writable DuckDB database across serving replicas.

## Verification

```cmd
python -m pytest -q
python scripts/verify_snapshot.py
```

Tests run offline with synthetic fixtures and mocked HTTP transport through the real Anthropic SDK.
They exercise alternate schemas/sign conventions/date formats, decimal totals, refund/transfer exclusion,
monthly/daily reconciliation, customer isolation under concurrent calls, SQL injection attempts, read-only
connections, atomic import failures, mixed currencies, tool-result protocol, model limits, API authentication,
request validation, rate limits, direct API routing, smoke-test errors and secret-free build packaging. Live Claude responses and an actual Cloud Run deployment require
credentials and are separate integration checks.

The supplied dataset was imported locally: **3,626,755 rows / 5,100 customers**, covering
**2024-10-01 to 2026-09-30**. All monthly aggregates reconcile with canonical transactions, and
all **96** UI customer/month totals match. The **42,389** excluded unmapped rows correspond to
the source's investment deposits, investment withdrawals and salary sweeps. The generated
`data/finance.duckdb` stays local and is gitignored. `constraints.txt` records tested package versions.
