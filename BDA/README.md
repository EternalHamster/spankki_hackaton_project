# Spending engine

A hierarchical Bayesian model of each customer's money, with Statistics Finland as the top-level prior.
It produces plain, actionable insights and a small API that the chat's LLM calls as tools.
Uncertainty is used to decide *what* to say. It is never shown to the user.

## Folder layout

Everything the engine creates lives in `BDA/`. The only thing it reads from outside is the challenge's raw CSVs
in `../Data/`, which it never modifies.

```
BDA/
├── README.md             this file
├── requirements.txt
├── .venv/                Python environment (gitignored)
├── engine/               code
├── data/statfin/         Statistics Finland tables, cached (committed, so it also runs offline)
└── output/               all results
    ├── coach.duckdb          full database the coach API reads (232 MB, gitignored, regenerated)
    ├── customer_summary.csv  one row per customer: income, baskets, safe-to-spend, surprise fund
    ├── customer_line.csv     customer × spending line: frequency, size, €/month, peers, Finland, trend
    ├── insights.csv          the coach's messages + actions, ranked per customer
    ├── spender_type.csv      "what kind of spender am I"
    ├── model_hyper.csv       peer-group parameters, incl. Statistics Finland weight
    └── validation.csv        accuracy vs plain averages
```

## Run it

Run these from the `BDA` folder:

```bash
py -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m engine            # build, fit, insights, validation, CSV export (~1.5 min)
.venv/Scripts/python -m engine.coach CUST00042   # try every tool for one customer
```

Run `python -m engine.statfin --refresh` to re-download the Statistics Finland tables.

## Files

| File | What it does |
|---|---|
| `config.py` | Spending lines, baskets, peer groups, every threshold |
| `statfin.py` | Downloads Statistics Finland tables 14q4 (spending by age, 2022), 11py (income by age, 2024), 11xc (CPI) |
| `build_db.py` | CSV → DuckDB. Classifies each transaction into a spending line and one of the 3 baskets |
| `model.py` | The model (below). Writes `model_hyper`, `customer_line`, `customer_summary` |
| `insights.py` | Rules that turn model outputs into messages. Writes `insights`, `spender_type` |
| `coach.py` | Tool functions for the LLM, returning JSON with round numbers |
| `validate.py` | Holdout test against plain averages |

## Baskets and spending lines

| Basket | Lines |
|---|---|
| 1 · Mandatory & regular | housing, utilities |
| 2 · Mandatory & irregular | shock = Health or Home & Tech payment above that category's 95th percentile (> €287 / > €777) |
| 3 · Everyday | groceries\*, health\*, public transport\*, fuel\* (\* = essential, never nagged about), restaurants, fast food (MCC 5814), bars (5813), taxi (4121), parking (7523), other transport, entertainment, lifestyle, travel, home & tech, big one-off purchases (Lifestyle/Travel/Entertainment above their 95th percentile) |
| Not spending | salary, other income, salary sweep, investment deposits/withdrawals |
| Flagged | grocery, restaurant or transport payments > €1,000 (324 rows, 63 customers). Shown as "unusual payment", not modelled |

## The model

Structure: **Statistics Finland → peer group (7 age bands × Helsinki/Espoo/Vantaa) → customer → transactions**

**Spending lines**, a compound frequency × size model:

```
payments per month   N_it ~ Poisson(λ_i),            λ_i ~ Gamma(a_g, b_g)
€ per payment        x̄_i ~ Normal(m_i, cv²·M_g²/n_i), m_i ~ Normal(M_g, t²·M_g²)
peer-group level     log M_g ~ Normal(log M0_g, 0.5²)   M0_g from Statistics Finland
expected € / month   E_i = λ_i · m_i
```

**Income, rent, utilities and savings** use normal–normal shrinkage of monthly totals toward the peer group. Income has a Statistics Finland prior on the peer-group mean.

The **hyperparameters** (a, b, M, t², cv²) are estimated once from all 5,100 customers by method of moments. Every per-customer posterior is closed-form (conjugate), so one customer takes milliseconds.

**Derived outputs:**
- **Peer comparison:** the customer vs the median of their peer group. The frequency/size split says *why* ("you go more often" or "you spend more each time").
- **Trend:** the last 6 months vs the 18 before, each shrunk toward the customer's *own* long-run level. It's shown only if P(change) > 95 %, the change is > 20 % and it's > €20/month.
- **Safe-to-spend per week:** Monte Carlo (2,000 draws) of balance − bills due before payday − essentials − surprises. Takes the 10th percentile minus a €100 cushion, spread over the weeks to payday, and caps it at the monthly budget (income − needs − surprises − current saving). It is also capped at the last 12 months' actual budget, so it is never above what kept the customer balanced recently.
- **Surprise fund:** the 90th percentile of one year of shocks (at least one typical shock).
- **Overspending:** the customer's *actual* last 12 months (income − all spending − savings), not model estimates.
  Shrunk estimates are for predictions; statements about what someone *did* use their real numbers.
  Checked: warnings match actual cash flow for all 5,100 customers. The earlier model-based version had 360 false alarms.
- **Spender type:** the discretionary lines where the customer is in the top 25 % of their peers.

## Does it work? (`python -m engine.validate`)

The model was trained on months 1–18 and predicts each customer's € per month and line in months 19–24.

| Setting | Error vs plain average (MAE) | RMSE |
|---|---|---|
| Customer with 18 months of history | about equal (−0.5 %) | 0.1 % better |
| **New customer with 3 months** | **12 % better** | **14 % better** |
| New customer: taxi, bars, parking, public transport | 22–26 % better | 24–33 % better |

So the gain is largest exactly where advice is hardest: young people and new customers with short histories.

**Two design choices came out of this test:**
- A log-normal size model over-estimated spend by ~10 % on lines where the top 5 % is split off as shocks, so sizes are modelled on the € scale.
- Trend windows are shrunk toward the customer's own history. Shrinking them toward peers created fake trends.

## Statistics Finland

Spending per consumption unit per month, by age, 2022, lifted to 2025 prices with CPI (× 1.083):

| Line | 17–24 | 25–34 | 35–44 | 45–54 | 55–64 | 65–74 | 75+ |
|---|---|---|---|---|---|---|---|
| groceries | 227 | 316 | 359 | 375 | 390 | 392 | 332 |
| restaurants (full service) | 39 | 82 | 88 | 60 | 67 | 47 | 30 |
| taxi | 0 | 3 | 2 | 5 | 6 | 4 | 5 |

The statistics enter as priors, but **with ~250 customers × 24 months per peer group the data dominates**. Statistics Finland's weight on the peer-group level is 0.3–3.6 % (column `statfin_weight` in `model_hyper`). That is the correct Bayesian outcome. Its practical value is:
1. a sensible prior for peer groups or lines with little data, and
2. the national benchmark `finland_average_month` in `compare_to_peers`.

The synthetic data is richer than real Finns in some lines (e.g. restaurants, taxis), so the coach compares against peers in the data first and uses national figures only as context.

## Coach API (LLM tools)

```python
from engine import coach
coach.overview(cid)                       # top insights (message + action + numbers)
coach.safe_to_spend(cid)                  # €/week until payday, "money_is_tight" flag
coach.compare_to_peers(cid, "taxi")       # you vs peers vs Finland, frequency and size
coach.what_if(cid, "restaurants", 20)     # cut 20 % -> saves €/month, €/year
coach.spending(cid, line="taxi", month="2026-08")   # facts for "how much did I spend on X"
coach.baskets(cid)                        # the 3 baskets, per line
coach.spender_type(cid)                   # "What kind of spender am I?"
coach.lines()                             # valid line names
```

`coach.TOOLS_DOC` has one-line descriptions you can paste into the LLM tool definitions.
"Today" is the last date in the data (2026-09-30), so the next payday is 15 Oct for most customers.

## Known limitations

- The synthetic data has identical amount distributions across MCC codes within a category, so for example taxi rides cost the same as fuel payments. Only frequencies differ.
- There's no seasonality in the data (checked), so none is modelled.
- Statistics Finland reports per consumption unit (household-adjusted). The data is per person. Close, but not identical.
- The area comes from the first two postal digits: 00 Helsinki, 01 Vantaa, 02 Espoo. That's approximate.
- Recurring subscriptions can't be detected, because housing and utility rows have no merchant ID.
