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
| [`coach_context/`](coach_context/README.md) | Profile card and insight context: compact per-customer summaries for the model's prompt | Done; profile card not connected yet |
| [`ui-demos/`](ui-demos/README.md) | S-mobiili-style **Oma talous** web app with live Claude chat and Rahavuotesi | Running locally and on Cloud Run |
| [`wrapped/`](wrapped/README.md) | **Rahavuotesi**: Spotify Wrapped-style year in money, in the UI | Done (Finnish) |
| [`demo/`](demo/PERSONAS.md) | Four demo personas with their stories and demo questions | Chosen; not in the UI yet |
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
 └─ ui-demos/scripts ─────────► ui-demos/server-data/demo-data.json ─► Oma talous UI ─► /api/chat (Claude; optional server-selected insight context)
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
- **`insight_context.py`:** the profile card plus the detail behind it, used by `/v1/insights`.

### Web app (`ui-demos/`)
A mobile-first **Oma talous** tab in S-mobiili's style. It shows:
- income, spending and balance per month,
- category rings and transactions,
- spending history from a single day up to several years,
- weekday versus weekend spending,
- the three baskets,
- a savings slider.

**Kysy** sends questions to Claude through the Node server (`/api/chat`). Three clickable front-page insights start a chat with the configured synthetic customer's dated summary and aggregate peer statistics. General chat has no financial context. The server selects one synthetic customer for all public visitors, rejects customer/context overrides, and scopes transaction data, insights and Rahavuotesi to that customer. Source bundles remain outside the public directory; authenticated sessions are required before real customer data is connected.
Plain JavaScript ES modules with a strict CSP and no build step.

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

Their Rahavuotesi recaps are in the private source bundle. The public UI exposes only its server-configured synthetic customer (`CUST00207` by default); there is no public customer switcher.

## Run it

```bash
# Web app (Node 24, no install): http://127.0.0.1:4173/
cd ui-demos && node server.mjs              # chat needs ANTHROPIC_API_KEY in the environment

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
cd ui-demos && node scripts/check.mjs                      # UI, chat server, Rahavuotesi rendering
python -m unittest discover -s wrapped/tests -t .          # Rahavuotesi facts and cards, all customers
python -m unittest discover -s coach_context/tests -t .    # profile card, insight context
cd backend && python -m pytest -q                          # backend, offline with mocked HTTP
cd BDA && .venv/Scripts/python -m engine.check --repro     # spending model self-check
```

No test makes a paid API call.

## Not done yet

- **Live tools are not connected to the UI chat.** Insight chats use a prepared single-customer summary. Next steps:
  - point it at the backend's `/v1/chat`,
  - put the profile card in the system prompt,
  - give the backend BDA's tools for safe-to-spend, safe-to-save, peers and surprise fund. The backend's own
    `calculate_safe_to_spend` is still a placeholder.
- **Authenticated multi-customer sessions are not implemented.** The public demo deliberately exposes one synthetic customer to all visitors.
- **Rahavuotesi is Finnish only.** A language button is planned.
- **The touch gestures haven't been tested on a real phone.**
- **Banking login:** demo tokens only. A real deployment needs verified S-mobiili sessions.

## Team

Michael Essine · GeraldoLamp (spending model) · hampter (backend, UI, deployment) · EternalHamster
