# Financial coach backend baseline

FastAPI -> Anthropic Python SDK -> approved financial tools -> read-only DuckDB snapshot.
The existing `ui-demos` webapp and its planned Google Cloud hosting remain as they are.
This backend supplies the future chat API; it does not enable the prototype's disabled chat button.

The PDF and continuation notes were used as design context. The current request takes precedence:
Claude replaces the earlier OpenAI/Ollama suggestions, and the eventual database schema is not assumed.

## Run locally with direct Claude credits (PowerShell, Python 3.11+)

From this `backend` directory:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -c constraints.txt -e '.[test]'
.\.venv\Scripts\python.exe -m money_coach.ingest --source ../Data/tx_junction_transactions.csv --mapping config/s-pankki.json --output data/finance.duckdb

# Set your real key only in the server environment. Never put it in frontend source.
$env:CLAUDE_PROVIDER = 'anthropic'
$env:ANTHROPIC_API_KEY = '<your Claude API key>'
$env:DEMO_MODE = 'true'
$demoToken = .\.venv\Scripts\python.exe -c 'import secrets; print(secrets.token_urlsafe(32))'
$env:DEMO_TOKENS_JSON = @{ $demoToken = 'CUST00207' } | ConvertTo-Json -Compress
$env:CORS_ORIGINS = 'http://127.0.0.1:4173'
.\.venv\Scripts\python.exe -m uvicorn money_coach.api:app --host 127.0.0.1 --port 8000
```

The import writes a new snapshot and refuses existing output paths. For refreshes, write
`data/finance-v2.duckdb`, stop/restart the server with `DUCKDB_PATH` pointing at it, and retain
the previous file for rollback. CSV source files are never modified. API workers never import data.
`.env.example` documents settings; it is not automatically loaded.

Use a second terminal with the same generated demo token (or stop the server and run it separately):

```powershell
$headers = @{ Authorization = "Bearer $demoToken" }
Invoke-RestMethod http://127.0.0.1:8000/v1/data-context -Headers $headers
Invoke-RestMethod http://127.0.0.1:8000/v1/chat -Method Post -Headers $headers -ContentType 'application/json' -Body '{"message":"How much did I spend on Restaurants in September 2026, and what would a 20% reduction save?"}'
```

Interactive API schema: `http://127.0.0.1:8000/docs`. `GET /healthz` is liveness;
`GET /readyz` checks the snapshot, model client and configured authentication without making a paid call.
`GET /v1/data-context` works without a Claude key once demo authentication is configured.
`POST /v1/chat` requires configured model credentials. All financial endpoints require a bearer session.
Readiness does not test remote IAM permissions, model access or available credit.

The current workspace also has dependencies installed in `../../.venv`; its Python can run these
commands without creating another environment.

## Use Claude through Google Cloud

The provider is explicit; failures never switch billing routes automatically. Both cloud routes keep
the same tools and agent code. Install cloud dependencies, then select one configuration:

```powershell
python -m pip install -c constraints.txt -e '.[cloud,test]'
gcloud auth application-default login
$env:GOOGLE_CLOUD_PROJECT = '<your-project-id>'
$env:CLAUDE_MODEL = 'claude-haiku-5-5'
```

For the Google-managed route, use:

```powershell
$env:CLAUDE_PROVIDER = 'vertex'
$env:GOOGLE_CLOUD_REGION = 'global'
```

This selects `AnthropicVertex`. Enable `aiplatform.googleapis.com`, activate Claude access in Model
Garden, and give the calling service identity the required prediction permissions. No Anthropic
workspace ID or API key is used. Haiku 5.5 uses the same model ID as the direct API. `global` offers
flexible routing; `eu` is the multi-region alternative if EU inference placement is needed. Confirm
model availability and endpoint pricing for your project in the
[Google-managed guide](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/google-managed).

For the Anthropic-managed route, use:

```powershell
$env:CLAUDE_PROVIDER = 'google_cloud'
$env:ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID = '<wrkspc_...>'
```

This selects `AnthropicGoogleCloud` with a global endpoint. Complete the Marketplace subscription
and organization setup, enable `claude.googleapis.com` and
`anthropic-managed-claude.cloudpartnerservices.goog`, and grant the runtime identity
`roles/claude.user`. Copy the workspace ID from that organization's Claude Console. See the
[Anthropic-managed setup guide](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/anthropic-managed).

On Cloud Run, use the attached service account through Application Default Credentials (ADC);
do not bake credential files into the image. Local development uses the gcloud ADC login above.
These credentials authenticate the backend to Claude; end-user banking authentication is separate.
Both cloud offerings charge the Google Cloud bill, according to the
[provider comparison](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/overview).
Do not assume the existing direct Anthropic API promotional credits cover cloud usage; retain
`CLAUDE_PROVIDER=anthropic` when using those credits. Cloud provisioning has not been performed.

## Adapt to the final database

The importer creates a stable internal contract: `transactions`, `monthly_spending`, and
`dataset_metadata`. These are derived snapshots, not a required schema for your source database.
Edit a JSON mapping to configure customer/date/category/amount columns, date format, sign convention,
expense/income categories and basket rules. `config/normalized-example.json` demonstrates different
column names and an already-positive `expense_eur` field.

```powershell
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

The coach's "today" is the last transaction date in the snapshot (2026-09-30 for the supplied data), so
relative questions such as "last month" resolve to months that have data. Set `COACH_AS_OF=YYYY-MM-DD`
to override it. If the snapshot cannot be read at startup, the real Europe/Helsinki date is used.

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

The Dockerfile is ready for a later Cloud Run build with this directory as the build context:

```powershell
docker build -t money-coach-backend .
```

It binds `0.0.0.0` on the injected `PORT`, as required by the
[Cloud Run container contract](https://cloud.google.com/run/docs/container-contract).
No deployment or cloud resources have been created. Keep the web frontend and backend as separate
deployment components. Use Google ADC for cloud inference (or Secret Manager for a direct Claude key), allow only the actual frontend origin,
and supply a versioned DuckDB snapshot from private Cloud Storage to local instance storage before
starting the API. The image deliberately excludes CSV data, database snapshots, secrets and tests.
Snapshot download/startup wiring and production session verification remain deployment integration work.
Do not treat Cloud Run's writable filesystem as durable storage or share a writable DuckDB across replicas.
Generate snapshots in a separate import job; each serving instance reads an immutable local copy.

## Verification

```powershell
python -m pytest -q
python scripts/verify_snapshot.py
```

Tests run offline with synthetic fixtures and mocked HTTP transport through the real Anthropic SDK.
They exercise alternate schemas/sign conventions/date formats, decimal totals, refund/transfer exclusion,
monthly/daily reconciliation, customer isolation under concurrent calls, SQL injection attempts, read-only
connections, atomic import failures, mixed currencies, tool-result protocol, model limits, API authentication,
request validation and rate limits. Live Claude responses and an actual Cloud Run deployment require
credentials and are separate integration checks.

The supplied dataset was imported locally: **3,626,755 rows / 5,100 customers**, covering
**2024-10-01 to 2026-09-30**. All monthly aggregates reconcile with canonical transactions, and
all **96** UI customer/month totals match. The **42,389** excluded unmapped rows correspond to
the source's investment deposits, investment withdrawals and salary sweeps. The generated
`data/finance.duckdb` stays local and is gitignored. `constraints.txt` records tested package versions.
