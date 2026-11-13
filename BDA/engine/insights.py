"""Turn model outputs into plain, actionable insights (one round number + one action each).

Uncertainty never appears in the text: it only decides WHETHER an insight is shown
(thresholds in config.py). The LLM rephrases these; it should never invent numbers.
"""
import json
import math
import pandas as pd
import duckdb

from . import config as C

LABEL = {k: v[2] for k, v in C.LINES.items()}
ARCHETYPE = {
    "restaurants": "Foodie", "fast_food": "Takeaway lover", "bars": "Social butterfly",
    "travel": "Traveller", "lifestyle": "Shopper", "entertainment": "Experience seeker",
    "taxi": "On-the-go", "parking": "Driver", "transport_other": "On-the-go",
    "home_tech": "Home & gadget investor", "big_purchase": "Big-ticket buyer",
}


def nice(x):
    """Round € for people: <100 -> nearest 5, <1000 -> nearest 10, else nearest 50."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return 0
    step = 5 if abs(x) < 100 else 10 if abs(x) < 1000 else 50
    return int(step * round(x / step))


def eur(x):
    return f"€{nice(x):,}"


def fmt_date(ts):
    t = pd.Timestamp(ts)
    return f"{t.day} {t.strftime('%b')}"


def customer_insights(s, cl, anomalies):
    """All insights for one customer. s: summary row (Series), cl: customer_line rows, anomalies: rows."""
    out = []

    def add(kind, priority, impact, message, action, line=None, **numbers):
        out.append(dict(customer_id=s["customer_id"], kind=kind, line=line, priority=priority,
                        impact_eur_month=float(impact), message=message, action=action, numbers=numbers))

    # 1. safe to spend (always)
    pay = fmt_date(s["next_payday"])
    sw = nice(s["safe_to_spend_week"])
    if sw > 0:
        tight = s["safe_binding"] == "cash_until_payday"
        add("safe_to_spend", 1, 0,
            f"You can safely spend about €{sw} a week on extras until payday on {pay}."
            + (" Money is a bit tight until then." if tight else ""),
            f"Keep this week's extras under €{sw}.", safe_week=sw, next_payday=str(pd.Timestamp(s['next_payday']).date()))
    else:
        add("safe_to_spend", 1, 0,
            f"Money is tight until payday on {pay}: after rent, bills and essentials there is nothing spare.",
            f"Hold off on extras until {pay}.", safe_week=0, next_payday=str(pd.Timestamp(s['next_payday']).date()))

    # 2. unusual payments
    for _, a in anomalies.iterrows():
        add("unusual_payment", 2, a["spend"],
            f"We noticed an unusually large {a['category'].lower()} payment of {eur(a['spend'])} on {fmt_date(a['tx_date'])}.",
            "Check that this payment was yours.", amount=nice(a["spend"]), date=str(pd.Timestamp(a["tx_date"]).date()))

    # 3. peer gaps on discretionary lines
    disc = cl[cl["line"].isin(C.DISCRETIONARY)].copy()
    disc["gap"] = disc["expected_month"] - disc["peer_median"]
    gaps = disc[(disc["peer_ratio"] >= C.PEER_MIN_RATIO) & (disc["gap"] >= C.PEER_MIN_EUR)].sort_values("gap", ascending=False)
    for i, (_, r) in enumerate(gaps.head(3).iterrows()):
        lab = LABEL[r["line"]]
        freq_ratio = r["lam"] / max(r["peer_lam_median"], 1e-6)
        size_ratio = r["size_eur"] / max(r["peer_size_median"], 1e-6)
        if r["line"] == "big_purchase":
            why = f"You make a big one-off purchase about {max(1, round(r['lam'] * 12))} times a year."
        elif freq_ratio >= 1.3 and size_ratio < 1.3:
            why = f"You pay for {lab} about {r['lam']:.0f} times a month; most people your age do it {r['peer_lam_median']:.0f} times."
        elif size_ratio >= 1.3 and freq_ratio < 1.3:
            why = f"You go about as often as others, but spend about {eur(r['size_eur'])} each time versus {eur(r['peer_size_median'])}."
        else:
            why = "You go more often and spend more each time than most people your age."
        if r["lam"] < 1 and r["line"] != "big_purchase":
            why = why.replace(f"about {r['lam']:.0f} times a month", "regularly")
        add("peer_gap", 3 + i, r["gap"],
            f"You spend about {eur(r['expected_month'])} a month on {lab}. People your age in {s['area']} typically spend {eur(r['peer_median'])}. {why}",
            f"Matching them would save about {eur(r['gap'])} a month ({eur(12 * r['gap'])} a year).",
            line=r["line"], you=nice(r["expected_month"]), peers=nice(r["peer_median"]), saving_month=nice(r["gap"]))

    # 4. trends (own history, last 6 months vs before)
    ev = cl[cl["line"].isin(C.EVERYDAY_LINES)].copy()
    ev["diff"] = ev["recent_month"] - ev["base_month"]
    ev["rel"] = ev["recent_month"] / ev["base_month"].clip(lower=1) - 1
    ups = ev[(ev["p_up"] > C.TREND_MIN_PROB) & (ev["rel"] > C.TREND_MIN_REL) & (ev["diff"] > C.TREND_MIN_EUR)]
    downs = ev[(ev["p_up"] < 1 - C.TREND_MIN_PROB) & (ev["rel"] < -C.TREND_MIN_REL) & (-ev["diff"] > C.TREND_MIN_EUR)]
    for i, (_, r) in enumerate(ups.sort_values("diff", ascending=False).head(2).iterrows()):
        lab = LABEL[r["line"]]
        add("trend_up", 4 + i, r["diff"],
            f"Your spending on {lab} has gone up from about {eur(r['base_month'])} to {eur(r['recent_month'])} a month over the last 6 months.",
            f"That is {eur(r['diff'])} more each month. Check whether it's on purpose.",
            line=r["line"], before=nice(r["base_month"]), now=nice(r["recent_month"]))
    for _, r in downs.sort_values("diff").head(1).iterrows():
        lab = LABEL[r["line"]]
        add("trend_down", 8, -r["diff"],
            f"Nice work: your spending on {lab} dropped from about {eur(r['base_month'])} to {eur(r['recent_month'])} a month.",
            f"Keep it up and you'll have about {eur(-12 * r['diff'])} more this year.",
            line=r["line"], before=nice(r["base_month"]), now=nice(r["recent_month"]))

    # 5. surprise fund (basket 2): save enough to cover the expected cost, or build the fund in 2 years
    monthly = max(s["shock_month"], s["surprise_fund"] / 24)
    months_to_fund = math.ceil(s["surprise_fund"] / max(nice(monthly), 5))
    n_year = s["shocks_per_year"]
    freq_txt = ("rarely" if n_year < 0.3 else "about once every two years" if n_year < 0.75
                else "about once a year" if n_year < 1.5 else f"about {round(n_year)} times a year")
    add("surprise_fund", 6, monthly,
        f"Unexpected costs like repairs or doctor bills hit you {freq_txt}, typically around {eur(s['typical_shock_eur'])}. "
        f"A surprise fund of {eur(s['surprise_fund'])} would cover a bad year.",
        f"Move {eur(monthly)} a month into a surprise fund on payday. You'd have it in about {months_to_fund} months.",
        fund=nice(s["surprise_fund"]), monthly=nice(monthly), typical=nice(s["typical_shock_eur"]))

    # 6. three baskets
    tot = s["total_spend_month"]
    b1, b2 = s["regular_month"], s["shock_month"]
    b3 = tot - b1 - b2
    add("baskets", 7, 0,
        f"Of the {eur(tot)} you spend a month, {eur(b1)} goes to fixed bills, {eur(b2)} to surprises "
        f"and {eur(b3)} to everyday spending.",
        "Everyday spending is the part you control most. That's where small changes add up.",
        fixed=nice(b1), surprises=nice(b2), everyday=nice(b3), fixed_pct=round(100 * b1 / tot), everyday_pct=round(100 * b3 / tot))

    # 7. savings habit
    sr = s["savings_rate"] if pd.notna(s["savings_rate"]) else 0
    free = s["safe_week_budget"] * C_DPM / 7
    if sr >= 0.10:
        add("savings", 9, 0, f"You put aside about {eur(s['savings_month'])} a month ({round(100 * sr)} % of your income). That's a great habit.",
            "Keep your automatic savings going.", saving=nice(s["savings_month"]))
    elif free > 50:
        x = nice(min(0.5 * free, 0.1 * s["income_month"]))
        add("savings", 9, x, f"After your needs you have about {eur(free)} a month left.",
            f"Saving just €{x} a month on payday adds up to {eur(12 * x)} a year.", suggested=x)
    return out


C_DPM = 30.44


def spender_type(s, cl):
    """'What kind of spender am I?' from the discretionary lines where the customer stands out most."""
    disc = cl[cl["line"].isin(C.DISCRETIONARY) & (cl["expected_month"] >= 20)].sort_values("peer_pct", ascending=False)
    top = disc[disc["peer_pct"] >= 0.75].head(2)
    names = [ARCHETYPE[l] for l in top["line"]]
    names = list(dict.fromkeys(names))
    saver = pd.notna(s["savings_rate"]) and s["savings_rate"] >= 0.10
    if not names:
        label = "Balanced spender"
        detail = "Your spending is close to people your age in every area."
    else:
        label = " and ".join(names)
        detail = "You spend more than most people your age on " + " and ".join(LABEL[l] for l in top["line"]) + "."
    if saver:
        label += " (and a saver)"
    return {"label": label, "detail": detail, "top_lines": top["line"].tolist(),
            "everyday_share_pct": round(100 * s["basket3_share"])}


def run(db_path=C.DB_PATH):
    con = duckdb.connect(str(db_path))
    summ = con.sql("select * from customer_summary").df()
    cl = con.sql("select * from customer_line").df()
    anom = con.sql("select customer_id, tx_date, category, spend from transactions where line='anomaly'").df()
    cl_g, an_g = dict(tuple(cl.groupby("customer_id"))), dict(tuple(anom.groupby("customer_id")))
    rows, types = [], []
    empty = anom.iloc[:0]
    for _, s in summ.iterrows():
        c = cl_g[s["customer_id"]]
        rows += customer_insights(s, c, an_g.get(s["customer_id"], empty))
        types.append({"customer_id": s["customer_id"], **spender_type(s, c)})
    ins = pd.DataFrame(rows)
    ins["numbers"] = ins["numbers"].map(json.dumps)
    ins = ins.sort_values(["customer_id", "priority", "impact_eur_month"], ascending=[True, True, False])
    ins["rank"] = ins.groupby("customer_id").cumcount() + 1
    st = pd.DataFrame(types)
    st["top_lines"] = st["top_lines"].map(",".join)
    for name, df in [("insights", ins), ("spender_type", st)]:
        con.register("tmp_df", df)
        con.sql(f"create or replace table {name} as select * from tmp_df")
        con.unregister("tmp_df")
    con.close()
    return ins, st


if __name__ == "__main__":
    ins, st = run()
    print(f"{len(ins)} insights for {ins.customer_id.nunique()} customers")
    print(ins.groupby("kind").agg(rows=("kind", "size"), customers=("customer_id", "nunique")).to_string())
    print(st["label"].value_counts().head(10).to_string())
    for cid in ["CUST00001", "CUST00042", "CUST03003"]:
        print(f"\n### {cid}: {st.set_index('customer_id').loc[cid, 'label']}")
        for _, r in ins[ins.customer_id == cid].iterrows():
            print(f"  [{r['kind']}] {r['message']}\n      -> {r['action']}")
