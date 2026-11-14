# Oma talous: Personal Economic Trainer

Junction 2026 · S-Pankki challenge: an AI money coach inside the S-mobiili app that lets a customer talk with
their own banking data and learn from it. This is an independent hackathon prototype on synthetic data, not an
official S-Pankki service.

The idea: **the numbers are calculated, the AI explains them.** A Bayesian spending model and deterministic
Python produce every figure (safe-to-spend, safe-to-save, surprise fund, peer comparisons). Claude only chooses
which figures to fetch and explains them in plain language, in Finnish or English.

## What's in the repo

| Folder | What it is | Status |
|---|---|---|
| [`Data/`](Data/) | The challenge's synthetic data (4 CSVs, read-only) | Given |
| [`Data_analysis_results`](Data_analysis_results), [`Data_key_insights.txt`](Data_key_insights.txt) | Data analysis: ranges, formats, balances, edge cases | Done |
| [`Features/`](Features/features_README.txt) | Deterministic per-customer metrics (monthly table + 90 features per customer) | Done |
| [`BDA/`](BDA/README.md) | Hierarchical Bayesian spending model with Statistics Finland priors; insights and LLM tools | Done, validated |
| [`backend/`](backend/README.md) | FastAPI + Claude (direct Anthropic API) + DuckDB coach, Cloud Run deployment | Running; chat tools not yet BDA-backed |
| [`coach_context/`](coach_context/README.md) | Profile card and insight context: compact per-customer summaries for the model's prompt | Connected to web insights and every chat |
| [`ui-demos/`](ui-demos/README.md) | **Oma talous** web app: three demo customers, prepared Claude insights/summaries, live chat, private DuckDB tools and Rahavuotesi | Local and Cloud Run runtime |
| [`wrapped/`](wrapped/README.md) | **Rahavuotesi**: Spotify Wrapped-style year in money, in the UI | Done (Finnish) |
| [`demo/`](demo/PERSONAS.md) | Four narrative personas with stories and demo questions | Separate from the three live UI selections |
| [`scripts/`](scripts/) | `build_features.py` (Features/), `select_personas.py` (demo/) | Done |

## How it fits together

```
Data/ (raw CSVs)
 ├─ scripts/build_features.py ─► Features/          deterministic metrics, also used to cross-check the rest
 ├─ BDA/engine ───────────────► BDA/output/         safe-to-spend, safe-to-save, surprise fund, peers, insights
 │                                 │
 │                                 ├─► coach_context/   profile card (~650 tokens) + insight context (~1,500 tokens)
 │                                 │        └─► backend /v1/insights (three key insights, dry run by default)
 │                                 └─► wrapped/cards.py
 ├─ wrapped/build_facts.py ───► wrapped/output/facts.json ─► ui-demos/server-data/wrapped-data.json
 ├─ backend ingest ───────────► DuckDB snapshot ─► backend /v1/chat (Claude + customer-scoped tools)
 └─ BDA/output/coach.duckdb ──► ui-demos/runtime/worker.py (persistent, read-only)
                                      ├─► selected-customer chart bootstrap ─► Oma talous UI
                                      ├─► prepare-coach.mjs + Claude ─► private coach-answers.json
                                      │                                    └─► /api/insights + /api/summaries (prepared reads)
                                      └─► compact profile + seven scoped tools ─► /api/chat (Claude)
```

## The data in one paragraph

3,626,755 transactions from 5,100 synthetic customers in Helsinki, Espoo and Vantaa, 1 Oct 2024 – 30 Sep 2026,
one account each, plus 200 mortgage applications with their negotiation history. Merchants are IDs only
(`MRC-GRO-0032`) with MCC codes; there are no names. Files start with a UTF-8 BOM and timestamps use the SAS
format `03OCT24:09:04:04`. October 2024 is a partial month for about half the accounts. The coach treats
**30 Sep 2026** (the end of the data) as "today". See [`Data_key_insights.txt`](Data_key_insights.txt).

## Components

### Spending model (`BDA/`)
Statistics Finland → peer group (age band × city) → customer → months → transactions. Each spending line is a
frequency × size model, with burstiness-aware credibility weighting. Outputs:
- **Safe to spend per week:** Monte Carlo until payday, including the chance of a late salary; holds in 95 % of
  backtested customer-months.
- **Safe to save per month.**
- **Surprise fund** target.
- **Peer comparison**, explaining whether the customer goes more often or pays more each time.
- **Spender type.**
- **Ranked coach messages.**

`BDA/engine/coach.py` exposes these as LLM tools. 27 self-checks pass, including a reproducibility check.

### Backend (`backend/`)
FastAPI service where Claude Haiku 5.5 calls approved, customer-scoped tools and DuckDB calculates the answers.
- **Customer isolation:** the customer ID never reaches the model.
- **Agent loop:** at most 4 model rounds and 900 output tokens per round.
- **Reasoning effort:** `low` by default (`CLAUDE_EFFORT`).
- **"Today":** pinned to the snapshot's last date (`COACH_AS_OF` overrides it).
- **Login:** demo bearer tokens stand in for it.

`POST /v1/insights` writes three key insights from the insight context; it is a dry run unless `INSIGHTS_LIVE=true`.
Deploys to Cloud Run with `deploy.cmd`.

### Prompt context (`coach_context/`)
- **`profile_card.py`:** a deterministic 500–860-token summary of one customer. It lets overview questions
  ("what kind of spender am I?") be answered without tool calls. It is designed to go after the shared, cached
  part of the prompt, so prompt caching keeps working. Safe amounts are rounded down, like BDA's.
- **`insight_context.py`:** the profile card plus the detail behind it, used to prepare the web app's key insights and by the separate backend's `/v1/insights`.

The web worker caches both contexts per customer and database snapshot. Every web chat includes the compact profile; detailed transaction questions use bounded tools instead of putting the full customer history into each prompt.

### Web app (`ui-demos/`)
A mobile-first **Oma talous** tab in S-mobiili's style. It shows:
- income, spending and balance per month,
- category rings and transactions,
- spending history from a single day up to several years,
- weekday versus weekend spending,
- the three baskets,
- a savings slider.

The front-page selector offers three synthetic demo customers. Node signs the selection in an HttpOnly cookie and checks a fresh selection nonce on every data, insight, summary, recap and chat request. Switching customers clears the old display and conversation; late responses cannot populate the new selection. Spending, saving and transactions have independent month selectors, with no global calendar; transaction filtering preserves the selected category. The original Rahavuotesi card remains below the key insights.

The coach prepares three actionable, dated insights for each customer: a weekly allowance estimate, the latest recorded month and the last 12 months, plus concise Finnish section summaries, before deployment. The private tracked bundle contains spending and saving answers for all 24 recorded months for each of the three customers (144 monthly answers), three weekly answers dated to the snapshot, and nine insight cards. Page load preloads the default month's three topic answers. Startup, page loads, section expansion and month changes only read prepared content; they do not call the model. The bundle is checked against the database hash, prompt version, model and complete customer/month coverage. Missing or stale content blocks deployment and readiness; regenerate it when the database, prompts or model change.

**Kysy** and insight follow-up chats remain live Claude calls. Both receive the selected customer's compact, dated profile. Seven bounded tools query that customer's historical spending, cash flow, transactions, safe-to-spend, scenarios, model details and group peer comparisons. The worker runs Python/DuckDB 2 read-only inside the same container; the visitor needs only a browser. Anthropic prompt caching reuses eligible chat prefixes. Exact selected-month scenarios use that month's transaction totals; the BDA context summarizes the 23 complete training months, recent trends and last-12-month figures within the 24-month recorded snapshot.

The public selector intentionally exposes all three synthetic personas. Server scoping prevents a chat/tool request from switching identity; other people appear only as group aggregates. Real customer data still requires verified authentication and a server-side ownership mapping. Database/context sources and the multi-customer prepared bundle stay outside the public directory. The frontend uses plain JavaScript ES modules with a strict CSP and no build step. Cloud Run uses 1 GiB, zero minimum instances and one maximum instance; cold starts rebuild local data caches and validate the packaged answers without generating new text.

### Rahavuotesi (`wrapped/`)
A full-screen, swipeable story of the customer's last 12 months (Oct 2025 – Sep 2026), in Finnish and in the
app's green. The cards include:
- the year in numbers and the top 5 categories,
- the favourite category and regular place,
- your time of week and the small purchases that add up,
- the biggest purchase and the biggest month,
- days in the green,
- savings and the comparison with last year,
- spending personality,
- one positive goal for next year, from BDA's safe-to-save, budget gap or surprise fund.

Every number is precomputed and reconciled with `Features/`, so no AI is needed to show it. Each card has a
"Kysy valmentajalta tästä" button that opens the chat with a ready-made question. The story auto-advances and
supports tap, swipe and hold, keyboard controls and reduced motion. The link `#rahavuosi` opens it directly.
The tone rules (never shame, essentials are never a "favourite") are tested for all 5,100 customers.

### Demo personas (`demo/`)
| Persona | Customer | Story |
|---|---|---|
| Aino, 22 | `CUST03673` | Money runs out before payday |
| Mikko, 38 | `CUST04891` | Doing fine, but money leaks after payday |
| Sanni, 32 | `CUST03711` | Saving steadily towards a first home |
| Pekka, 59 | `CUST04971` | A surprise bill a week before payday |

Their Rahavuotesi recaps are in the private source bundle. The live UI separately offers `CUST00207` (default), `CUST00127` and `CUST00103` through its demo selector. Each selection scopes charts, insights, chat and recap to that synthetic customer.

## Run it

Web app setup on Windows (Node 24, Python 3.12+, Git LFS):

```powershell
git lfs pull
cd ui-demos
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r runtime\requirements.txt
Copy-Item .env.example .env                 # set ANTHROPIC_API_KEY privately
node --env-file=.env scripts/check-prepared.mjs # validate the tracked bundle; no model calls
node --env-file=.env server.mjs            # http://127.0.0.1:4173/
```

Keep this DuckDB 2 environment isolated from the existing project/backend DuckDB 1.5.6 environment. Node automatically finds `ui-demos/.venv`. Cloud deployment packages the database and minimal Python code via `ui-demos/deploy/deploy.ps1`; production uses Secret Manager for the provider key and a stable session signing secret of at least 32 characters.

After changing the database, prompts or model, run `node --env-file=.env scripts/prepare-coach.mjs --generate` from `ui-demos/` before validation and deployment. This explicitly makes billable Claude calls using the three approved synthetic customers and writes `server-data/coach-answers.json`. It resumes compatible unfinished work from an ignored `.runtime/` checkpoint. The generated synthetic bundle is tracked; API keys and local checkpoints are not. See [ui-demos/README.md](ui-demos/README.md) for the complete preparation workflow.

```bash
# Regenerate derived data (stdlib Python unless noted)
python scripts/build_features.py            # Features/, ~2.5 min
python wrapped/build_facts.py               # wrapped/output/facts.json, ~3 min
python -m wrapped.export_ui                 # ui-demos/server-data/wrapped-data.json
cd BDA && .venv/Scripts/python -m engine    # spending model, ~4 min (see BDA/README.md for setup)
```

Backend setup, local run and Cloud Run deployment: [`backend/README.md`](backend/README.md) and
[`backend/DEPLOYMENT.md`](backend/DEPLOYMENT.md). UI deployment: [`ui-demos/DEPLOYMENT.md`](ui-demos/DEPLOYMENT.md).

## Tests

```bash
# From the repository root:
node ui-demos/scripts/check.mjs                           # UI, chat server, Rahavuotesi rendering
node ui-demos/scripts/check-prepared.mjs                  # prepared content matches DB/prompts/model; no model calls
ui-demos/.venv/Scripts/python -m unittest discover -s ui-demos/runtime -p test_worker.py -v
python -m unittest discover -s wrapped/tests -t .          # Rahavuotesi facts and cards, all customers
python -m unittest discover -s coach_context/tests -t .    # profile card, insight context
(cd backend && python -m pytest -q)                       # backend, offline with mocked HTTP
(cd BDA && .venv/Scripts/python -m engine.check --repro)   # spending model self-check
```

No test makes a paid API call.

## Not done yet

- **Real-customer authentication is not implemented.** Signed demo sessions select from three public synthetic personas; a production bank integration must map verified users to their own records.
- **The separate FastAPI backend has its own integration work.** The live UI uses its local DuckDB worker and BDA-backed tools; it does not call `/v1/chat`. The backend's `calculate_safe_to_spend` remains a placeholder.
- **Rahavuotesi is Finnish only.** A language button is planned.
- **The touch gestures haven't been tested on a real phone.**
- **Banking login:** demo tokens only. A real deployment needs verified S-mobiili sessions.

## Team

Michael Essine · GeraldoLamp (spending model) · hampter (backend, UI, deployment) · EternalHamster
