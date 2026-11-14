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
    ├── coach.duckdb          full database: data, every model parameter, results (222 MB, Git LFS)
    ├── customer_summary.csv  one row per customer: income, baskets, safe-to-spend, safe-to-save, surprise fund
    ├── customer_line.csv     customer × spending line: frequency, size, €/month, peers, Finland, trend
    ├── insights.csv          the coach's messages + actions, ranked per customer
    ├── spender_type.csv      "what kind of spender am I"
    ├── model_hyper.csv       peer-group parameters, incl. Statistics Finland weight
    ├── validation.csv        accuracy vs plain averages
    ├── calibration.csv       safe-to-spend backtest
    └── plots/                six result charts
```

## Run it

Run these from the `BDA` folder:

```bash
py -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m engine                    # build, fit, insights, validation, CSVs, plots, self-check (~4 min)
.venv/Scripts/python -m engine.coach CUST00042    # try every tool for one customer
.venv/Scripts/python -m engine.check --repro      # 29 checks, incl. "a second run gives identical numbers"
.venv/Scripts/python -m engine.validate           # full accuracy + calibration report
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
| `coach.py` | Tool functions + tool definitions + system prompt for the LLM |
| `validate.py` | Holdout accuracy, safe-to-spend calibration backtest, trend-alert count |
| `check.py` | Self-check: model vs raw transactions, message consistency, every tool on 191 customers |
| `plots.py` | Result charts |

## Baskets and spending lines

| Basket | Lines |
|---|---|
| 1 · Mandatory & regular | housing, utilities |
| 2 · Mandatory & irregular | shock = Health or Home & Tech payment above that category's 95th percentile (> €287 / > €777) |
| 3 · Everyday | groceries\*, health\*, public transport\*, fuel\* (\* = essential, never nagged about), restaurants, fast food (MCC 5814), bars (5813), taxi (4121), parking (7523), other transport, entertainment, lifestyle, travel, home & tech, big one-off purchases (Lifestyle/Travel/Entertainment above their 95th percentile) |
| Not spending | salary, other income, salary sweep, investment deposits/withdrawals |
| Flagged | grocery, restaurant or transport payments > €1,000 (324 rows, 63 customers). Counted in basket 3 as "unusual large payments", not modelled |

## The model

Structure: **Statistics Finland → peer group (7 age bands × Helsinki/Espoo/Vantaa) → customer → months → transactions**

**Spending lines**, a compound frequency × size model:

```
payments per month   N_it : mean λ_i, variance φ·λ_i     λ_i ~ Gamma(a_g, b_g)
€ per payment        x̄_i ~ Normal(m_i, cv²·M_g²/n_i),    m_i ~ Normal(M_g, t²·M_g²)
peer-group level     log M_g ~ Normal(log M0_g, 0.5²)     M0_g from Statistics Finland
expected € / month   E_i = λ_i · m_i
```

**Months are bursty.** In this data a customer's payments per month vary far more than a Poisson model allows
(groceries: variance ≈ 5.7 × the mean, fuel 4.5 ×, restaurants 2.5 ×), because whole months are "on" or "off".
So the rate update is a credibility formula: the weight on the customer's own history is `T / (T + b·φ_g)`,
where `φ_g` is the peer group's burstiness. Bursty lines lean more on peers; steady lines trust the customer.
Each customer also gets their own burstiness `φ_i`, used when simulating their future weeks.

**Regular income, rent, utilities and savings** use normal–normal shrinkage of monthly totals toward the peer group.
Income has a Statistics Finland prior on the peer-group mean. Regular income = salary, plus other income only if it
recurs (in at least a third of the months), so a one-off windfall does not raise the weekly budget.

**Payday** is a Beta-Binomial model. In this data the salary arrives on the usual day about 80 % of months and
at month end otherwise. Each customer gets a probability that the next salary is late (≈ 20 %).

The **hyperparameters** are estimated once from all 5,100 customers by method of moments. Every per-customer
posterior is closed-form, so one customer takes milliseconds. Only complete months are used (October 2024 is partial
for half the accounts, so it is dropped: 23 months).

**Derived outputs:**
- **Peer comparison:** the customer vs the median of their peer group, for every line including rent and utilities.
  The frequency/size split says *why* ("you go more often" or "you spend more each time").
- **Safe-to-spend per week:** Monte Carlo (2,000 draws) of balance − bills due − essentials − surprises until the
  salary arrives, where the salary is late with the customer's probability. Takes the 10th percentile minus a €100
  cushion, per week. It is capped at the monthly budget (regular income − needs − surprises − current saving), both
  long-run and over the last 12 months. Rounded *down* to €5: the number is a promise.
- **Safe-to-save per month:** the 20th percentile of the customer's long-run monthly surplus (regular income − all
  spending − current saving, last 12 months), rounded down to €10. Goes to the surprise fund first if the account
  balance does not cover it yet.
- **Surprise fund:** the 90th percentile of one year of shocks (at least one typical shock).
- **Trend:** has the monthly level really changed in the last 6 months? Monthly € are season-adjusted, the change is
  standardised by the customer's own month-to-month spread, and compared with the same statistic under random
  relabelings of the months. An alert needs a false-discovery-controlled probability ≥ 95 %, a change > 20 % and
  > €20/month.
- **Biggest month:** "September was your biggest month for restaurants in 23 months". A fact about one month,
  shown when it is ≥ 1.5 × the usual month and ≥ €50 above it. No claim that anything changed for good.
- **Overspending:** the customer's *actual* last 12 months (income − all spending − savings), not model estimates.
  Shrunk estimates are for predictions; statements about what someone *did* use their real numbers.
- **Spender type:** the discretionary lines where the customer is in the top 25 % of their peers.

## What is in coach.duckdb

The database is self-contained: the input data, every part of the model and every result.

| Table | Rows | What |
|---|---|---|
| `transactions`, `customer_month_line`, `customers`, `thresholds`, `meta` | 3.6 M / 2.6 M / 5,100 | Classified input data |
| `mtg_events`, `mtg_outcomes` | 3,452 / 200 | Mortgage tables as given (not used by the coach) |
| `statfin_priors` | 105 | Statistics Finland spending and income per age band, in data-period prices |
| `model_hyper` | 336 | Spending-line parameters per peer group × line |
| `customer_line` | 91,800 | Per customer × line: sufficient statistics, posterior, peers, trend |
| `customer_monthly_model` | 20,400 | Income, rent, utilities, savings: own mean and variance, peer-group mean and spread, posterior |
| `customer_payday` | 5,100 | Usual salary day, salaries seen, late salaries, late probability |
| `model_season` | 252 | Calendar-month factor per line |
| `model_trend_null` | 2,842 | Trend test's permutation null per line, as a quantile grid |
| `customer_simulation` | 5,100 | Quantiles (1–99 %) of the simulated weekly room (on time / late / mixed) and of a year of shocks |
| `model_config` | 34 | Every threshold and setting, CPI factor, months used, the late-salary Beta prior |
| `customer_summary`, `insights`, `spender_type` | 5,100 / 27,510 / 5,100 | Results the coach reads |
| `validation`, `calibration` | 34 / 12 | Holdout accuracy and safe-to-spend backtest |

Not stored: the individual simulation draws (2,000 per customer; their quantiles are) and the 510,000 raw
permutation values per line (their quantile grid is). Both are regenerated by `python -m engine`.

Re-fitting the model on the same database gives identical numbers. Rebuilding the database from the CSVs can
change a few trend probabilities and peer percentiles in the third decimal (parallel floating-point sums);
no insight or message changes.

## Does it work?

**1. Self-check** (`python -m engine.check --repro`): 29 of 29 pass. The important ones:
- For every customer, 12 months of (income − spending − savings) equals the change in the bank's own account
  balance, to the cent.
- Overspending warnings match actual cash flow for all 5,100 customers.
- Safe-to-spend never exceeds any of its limits, and the message never promises more than the model.
- Numbers inside one message add up (e.g. you − peers = saving).
- Every tool answers for 191 customers × 111 calls; bad requests come back as errors, not crashes.
- A second run gives identical numbers.

**2. Is safe-to-spend really safe?** (`calibration.csv`, plot 6). The model is re-run as of earlier month ends,
then compared with what really happened until the salary arrived. The cash limit is a 10th percentile, so it
should hold in at least 90 % of customer-months.

| Model | Held |
|---|---|
| **This model** | **95 %** |
| … ignoring late salaries | 78 % |
| … and ignoring bursty months (first version) | 74 % |

**3. Prediction accuracy** (`validation.csv`). Trained on the first 17 months, predicting each customer's € per month
and line in the last 6.

| Setting | Error vs the customer's own plain average (MAE) | RMSE |
|---|---|---|
| Customer with 17 months of history | about equal (1 % worse) | equal; better in 14 of 16 lines |
| **New customer with 3 months** | **13 % better** | **18 % better** |
| New customer: taxi, parking, public transport, bars, fuel | 23–27 % better | 28–33 % better |

So the gain is largest exactly where advice is hardest: young people and new customers with short histories.
(On rare, lumpy lines such as shocks, MAE favours predicting zero; RMSE is the fair score for a monthly average.)

**4. Trend alerts.** A naive "last 6 months vs before" test flags about 7,900 customer × line pairs out of 71,400,
and a placebo window flags just as many: that is noise from bursty months. The model keeps **9**, e.g. grocery
spending falling from €390 to €25 a month.

**Design choices that came out of testing:**
- A log-normal size model over-estimated spend by ~10 % on lines where the top 5 % is split off as shocks, so sizes
  are modelled on the € scale.
- Per-customer shrinkage weights (trusting each customer's own variance) were more accurate on average but biased:
  heavy spenders are also the burstiest, so they were pulled down too far. One weight per peer group is unbiased.

## Statistics Finland

Spending per consumption unit per month, by age, 2022, lifted to 2025 prices with CPI (× 1.083):

| Line | 17–24 | 25–34 | 35–44 | 45–54 | 55–64 | 65–74 | 75+ |
|---|---|---|---|---|---|---|---|
| groceries | 227 | 316 | 359 | 375 | 390 | 392 | 332 |
| restaurants (full service) | 39 | 82 | 88 | 60 | 67 | 47 | 30 |
| taxi | 0 | 3 | 2 | 5 | 6 | 4 | 5 |

The statistics enter as priors, but **with ~250 customers × 23 months per peer group the data dominates**.
Statistics Finland's weight on the peer-group level is 0.03–14 % (column `statfin_weight` in `model_hyper`).
That is the correct Bayesian outcome. Its practical value is:
1. a sensible prior for peer groups or lines with little data, and
2. the national benchmark `finland_average_month` in `compare_to_peers`.

The synthetic data is richer than real Finns in some lines (e.g. restaurants, taxis), so the coach compares against
peers in the data first and uses national figures only as context.

## Coach API (LLM tools)

```python
from engine import coach

coach.TOOLS           # 12 tool definitions: {"name", "description", "input_schema"} (JSON Schema)
coach.SYSTEM_PROMPT   # how the coach should talk: one number, one action, no uncertainty, three baskets
coach.call(customer_id, tool_name, arguments)   # runs a tool, always returns a dict ({"error": ...} on bad input)
```

The customer id comes from the logged-in session, never from the model: it is not part of any tool's input.

| Tool | Answers |
|---|---|
| `overview` | "How am I doing?" Top insights, spender type, safe-to-spend, the three baskets |
| `safe_to_spend` | "What is safe for me to spend this week?" |
| `safe_to_save` | "How much can I save?" and whether the surprise fund comes first |
| `spending` | "How much did I spend on taxis last month?" Exact facts, plus the usual month for comparison |
| `breakdown` | "Where did my money go in August?" By line, basket or bank category, with income and what was left |
| `history` | Month-by-month series for any line, income or savings (for charts) |
| `biggest_payments` | "What were my biggest purchases?" |
| `compare_to_peers` | Me vs people my age in my city vs Finland, frequency and size |
| `what_if` | "How much could I save if I reduced dining out by 20 %?" Per month, per year, effect on the monthly balance |
| `afford` | "I want a €500 TV in 6 months, what should I do?" A forecast: verdict, the amount to set aside each month, which extras to cut and by how much, or how many months it really takes |
| `baskets` | The three baskets with the lines inside each |
| `spender_type` | "What kind of spender am I?" |

`line` accepts any spending line or a group: `dining_out` (restaurants + fast food + bars), `transport`, `food`,
`extras`, `essentials`, `fixed_bills`. Periods are `month="2026-08"` or `start` / `end` dates; the default is the
last complete month. "Today" is the last date in the data (2026-09-30), so the next payday is 15 Oct for most customers.

## Known limitations

- Salary sweeps to another bank are currently read as saving, so customers who bank elsewhere look like heavy savers; next step is to detect that.
- The synthetic data has identical amount distributions across MCC codes within a category, so for example taxi
  rides cost the same as fuel payments. Only frequencies differ.
- Seasonality is mild (± 5–10 %; travel peaks in June–August, home & tech in November). Trend detection and
  safe-to-spend adjust for it; the long-run monthly averages do not need to (they cover whole years).
- Safe-to-spend is cautious on purpose (holds 95 % against a 90 % target). 21 % of customers get €0 until payday,
  mostly people who spend more than their regular income or who would run short if the salary came late.
- The synthetic data has almost no lasting changes in spending level, so trend alerts are rare here. Real data
  would produce more.
- Shocks are defined by a category-wide threshold. For a few very high spenders such payments are routine.
- Statistics Finland reports per consumption unit (household-adjusted). The data is per person. Close, but not identical.
- The area comes from the first two postal digits: 00 Helsinki, 01 Vantaa, 02 Espoo. That's approximate.
- Recurring subscriptions can't be detected, because housing and utility rows have no merchant ID.
- The mortgage tables are loaded into the database but not used by the coach yet.
