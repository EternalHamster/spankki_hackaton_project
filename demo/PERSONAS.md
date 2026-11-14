# Demo personas

Four customers from the synthetic dataset, each telling one clear story that the coach can explain.
Names are fictional; the customer IDs and every number are real data as of **30 Sep 2026** (the end of the data).
Model-based figures (safe-to-spend, safe-to-save, surprise fund, peer comparisons) come from the BDA model run of
14 Nov 2026; transaction facts come from the raw data.
Machine-readable version for the UI: [personas.json](personas.json). Not yet added to the UI.

| | Persona | Customer | Story | What it shows off |
|---|---|---|---|---|
| 1 | **Aino**, 22, Espoo | `CUST03673` | Money runs out before payday | Honest safe-to-spend, overspending explained |
| 2 | **Mikko**, 38, Helsinki | `CUST04891` | Doing fine, but money leaks after payday | Spender type, peer comparison, what-if on dining out |
| 3 | **Sanni**, 32, Espoo | `CUST03711` | Saving steadily towards a first home | Praise, safe-to-save, home readiness |
| 4 | **Pekka**, 59, Helsinki | `CUST04971` | A surprise bill a week before payday | The three baskets, surprise fund |

Together they cover the challenge's examples: safe-to-spend and safe-to-save, "what kind of spender am I", the 20%
dining-out what-if, all three baskets, a young adult (financial literacy), and a positive story so the coach is not
only about problems.

## 1. Aino: money runs out before payday

- Earns about **€1,240/month**, spends about **€1,370**. Over the last 12 months about **€120/month more went out than came in** (€1,320 in, €1,440 out).
- Overdrawn on **221 of 730 days** (15 separate times, longest 29 days, lowest **−€423**). Balance today **€330**.
- Safe to spend this week: **nothing spare** until payday on 15 Oct. Nothing extra to save either.
- **September was the biggest home & tech month in two years: €310** against €65 in a usual month.
- Restaurants are the largest purchase category (23%); 48% of purchases happen in the evening.
- No savings. A surprise fund of €950 is the suggested first step (about €720 short).

**Demo questions:** "What is safe for me to spend this week?" · "Why does my account keep going into the red?" ·
"Mihin rahani menevät?" (shows Finnish) · "How much would I save if I cut entertainment by 20%?"

## 2. Mikko: doing fine, but money leaks after payday

- Earns about **€2,300**, spends about **€2,000**, invests about **€275/month** and has **never been overdrawn**. Balance **€6,829**.
- **19% of card spending happens in the 3 days after payday**, about **1.9× an even pace**.
- Eats out about as often as peers but pays more each time: **restaurants €70 per visit vs €30** (€190/month vs €120),
  **takeaway €65 vs €30** (€120/month vs €65).
- Big one-off buys about 3 times a year (€120/month vs €50 for peers): €1,087 (Mar, home & tech), €1,836 (Jun, home & tech), €1,026 (Sep, lifestyle).
- Spender type: *Takeaway lover and Foodie (and a saver)*. Safe to spend €150 this week; could safely save €50/month more.

**Demo questions:** "What kind of spender am I?" · "How much could I save if I reduced dining out by 20%?" ·
"Do I spend more right after payday?"

## 3. Sanni: saving steadily towards a first home

- Earns about **€2,300**, spends about **€1,770**, automatically invests about **€400/month (18% of income)**. Never overdrawn.
- Balance grew from **€7,716 to €13,518** in 12 months. Spends little on extras: restaurants about €25/month vs €120 for peers.
- **Safe to save: about €350/month more** (€4,200 a year) with current habits. Surprise fund (€850) already covered.
- **Home readiness** (illustration with the bank's own affordability rule from the mortgage data: 6% stress rate, 25 years, 35% of income):
  income supports a loan of about **€125k**, so a home of about **€139k** with a 10% deposit of **€13.9k**. The balance is almost there.
  Must be framed as education, not a credit decision, and should point to the bank's advisor.

**Demo questions:** "How much have I saved this year?" · "Could I afford my own home?" · "Where could I still save?"

## 4. Pekka: a surprise bill a week before payday

- Earns about **€4,350**, spends about **€3,920**, invests about **€435/month**.
- **8 Aug 2026:** a **€1,294 home & tech payment** a week before payday left **€281**. Groceries took the account below zero on 10 Aug (lowest **−€83**) until salary arrived on 15 Aug. An earlier one: €2,158 in Feb 2026.
- Surprise costs hit about **4 times a year, typically €1,100**. A surprise fund of **€7,200** would cover a bad year; the balance is about **€4,350 short**: about **€340/month** on payday, ready in about 13 months.
- **Right now money is tight again:** nothing spare to spend until payday on 15 Oct. Overspent about €60/month over the last 12 months; the balance fell from €5,962 (April) to €2,944.
- Baskets: **48% fixed bills, 9% surprises, 44% everyday**.

**Demo questions:** "Why did my account go negative in August?" · "What is safe for me to spend this week?" ·
"What are my three baskets?" · "How do I prepare for surprise costs?"

## What the backend can and can't answer yet

The demo questions show the target. The current backend (5 tools, see `backend/README.md`) answers spending totals,
category-level baskets and simple what-ifs. Safe-to-spend, safe-to-save, spender type, peer comparison, surprise fund,
payday effect and home readiness need the BDA model's tools (`BDA/engine/coach.py`) or the profile card
(`coach_context/`) connected. Pekka's "why negative in August" also needs a transaction-level tool.

## How they were chosen

`python scripts/select_personas.py` scores all 5,100 customers for each story using `Features/customer_features.csv`
and `BDA/output/`, then the top candidates were checked month by month and against raw transactions. Every persona has a
salary in every month and no extreme balances. Rules per story:

- **Tight young adult:** age 20–27, spends ≥ 95% of income, overdrawn 10–60% of days, saves < 5%.
- **Payday splurger:** age 26–45, payday spending ≥ 1.8× an even pace, otherwise stable.
- **Saver:** age 26–35, saves 15–40% of income, never overdrawn, balance growing.
- **Surprise cost:** age 35–60, normal income, one health or home & tech payment ≥ €1,200 in 2026 that pushed the balance negative, and at most one overdraft month before it.

The four were re-checked after the BDA update of 14 Nov 2026 and are still the top candidates. That update removed
trend claims the model no longer finds reliable (e.g. Aino's entertainment and Pekka's dining "trends"); don't use them on stage.

Notes:
- Approved mortgage applicants were the first choice for the saver, but in this data they save 90–98% of income and spend only
  about €140/month, which an audience would not find believable. Sanni has a realistic profile instead.
- Synthetic data quirks to avoid on stage: restaurant spending is lumpy (€0 in some months, €800+ in others), and overdrawn
  balances often bottom out at the exact same figure each month (e.g. −€423 for Aino).
- The UI currently shows `CUST00207`, `CUST00127` and `CUST00103`, chosen for data checks. Switching to these personas is a separate step.
