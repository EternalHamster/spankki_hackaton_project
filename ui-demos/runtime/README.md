# Private DuckDB worker

`worker.py` is a persistent, local-only JSON-lines process owned by the Node web server. It opens `coach.duckdb` read-only, uses two DuckDB threads and a 256 MB DuckDB memory limit, and never exposes a network listener. It requires Python 3.12+ and the pinned packages in `requirements.txt` (DuckDB and pandas); older DuckDB releases cannot read this snapshot's storage format.

The Node server resolves the selected customer from its session and passes that identity separately from tool arguments. The worker additionally allowlists `CUST00207`, `CUST00127` and `CUST00103`. Each context source contains only one customer's rows, with shared comparisons coming only from aggregate peer tables. No arbitrary SQL or model-supplied customer identifier is accepted.

## Protocol

Every input and output is one UTF-8 JSON line. Standard output contains protocol responses only.

```json
{"id":1,"operation":"context","customer_id":"CUST00207"}
{"id":2,"operation":"tool","customer_id":"CUST00207","args":{"name":"get_spending","arguments":{"start_date":"2026-09-01","end_date":"2026-10-01"}}}
```

Successful replies are `{ "id": ..., "result": ... }`. Failures are `{ "id": ..., "error": { "code": "invalid_request" | "unavailable", "message": "..." } }`; database errors, credentials and raw request values are not returned.

| Operation | Result |
| --- | --- |
| `ready` | `status`, `as_of`, `version`, demo customer allowlist, `coverage_from`, `coverage_to` |
| `bootstrap` | `summary`, `profiles: [selectedProfile]`, `as_of`, `version`; profile transaction shape matches the existing UI |
| `context` | `profile`, `insight_context`, `as_of`, `version`, `coverage_from`, `coverage_to`; both prompt strings omit customer IDs |
| `tools` | Eight Anthropic-compatible tool definitions |
| `tool` | Selected customer's bounded tool result; `args` must contain only `name` and `arguments` |

Available tools: `get_spending`, `get_cash_flow`, `get_transactions`, `safe_to_spend`, `afford`, `what_if`, `compare_to_peers`, and `get_model_detail`. Date ranges are start-inclusive/end-exclusive and at most 1,096 days. Individual transaction results are limited to 20 rows per page. Exact totals use per-transaction decimal casts; scenarios use the existing model's rounding policy. Every tool result is explicitly dated and distinguishes model estimates from historical amounts.

`afford` requires `price_eur` (positive, at most €1,000,000) and `months` (whole number, 1–60). It calls the existing BDA affordability calculation through this worker's read-only connection, including when `COACH_DB_PATH` selects a different snapshot. Its verdict, monthly target, redirected savings, optional spending cuts, buffer note and alternative timeline are returned to the chat model intact. The model asks for missing inputs and explains these as a dated scenario. `safe_to_spend` remains the weekly spending check.

Historical coverage comes from `meta.first_month` through `meta.as_of`, read once at startup. The current snapshot covers October 1, 2024 through September 30, 2026, inclusive. A customer's first/last transaction dates are returned separately as `observed_transactions`; days without a transaction do not create coverage gaps. `outside_snapshot_range` signals a request extending beyond dataset coverage; the original `outside_observed_range` field is retained as an alias of that corrected flag. Invalid filters return controlled validation feedback with allowed fields/values, never raw arguments or database errors.

The raw snapshot contains 24 recorded calendar months. The fitted BDA model uses the 23 complete months from November 2024 through September 2026; its training excludes the first month because accounts opened on different days. Profile/context figures are model estimates over that history, last-12-month totals, recent trends and ranked snapshot insights, rather than facts about an arbitrary selected calendar month. Use period tools for exact selected-month facts and arithmetic.

## Configuration and caching

- `COACH_CODE_ROOT`: repository-shaped root containing `coach_context/` and `BDA/engine/config.py`; defaults to the source repository.
- `COACH_DB_PATH`: snapshot path; defaults to `COACH_CODE_ROOT/BDA/output/coach.duckdb`.
- `COACH_SNAPSHOT_VERSION`: optional deployment-supplied content version. Otherwise a SHA-256 hash of the database is computed once at startup.

The deployed database is immutable. Replace it with a new deployment and restart the worker to load a new snapshot. Contexts and browser bootstrap records are cached separately for each selected customer. Tool results use a bounded 256-entry cache keyed by snapshot version, customer, tool and arguments. The request dispatcher serializes access, including concurrent callers, so connection/caches cannot switch identity mid-request.

Install `runtime/requirements.txt` for DuckDB and pandas, which the existing BDA affordability calculator uses. `scripts/prepare-runtime.mjs` packages the context modules plus `BDA/engine/__init__.py`, `config.py`, `coach.py` and `insights.py`. No CSV scan or model fitting is performed at runtime; affordability reads the fitted `model_season` table alongside the selected customer's summary and spending lines.

## Verification

From the repository root, using the UI's DuckDB 2 environment:

```powershell
ui-demos\.venv\Scripts\python.exe -m unittest discover -s ui-demos/runtime -p test_worker.py -v
```

Tests check complete bootstrap parity with the original UI source, exact totals across all 72 demo customer/month combinations, request and tool validation, SQL-injection literals, bounded results, read-only storage, context/customer isolation, concurrent interleaving, and the line protocol. They make no model calls.

Run the separate real Node/Python/HTTP smoke explicitly from the repository root:

```powershell
node --test ui-demos/runtime/integration.mjs
```

It starts the real persistent worker, warms all three customer caches, checks readiness and signed selection sessions, reconciles HTTP bootstrap data with the existing fixture, and exercises context/tool access through fake insight/chat handlers. It also verifies stale selection rejection, historical coverage flags, customer isolation and clean shutdown, and reports startup and cached IPC timings. It does not call a model API or run in the default JavaScript test suite.
