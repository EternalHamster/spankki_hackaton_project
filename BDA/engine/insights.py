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
DPM = 30.44


def _step(x):
    return 5 if abs(x) < 100 else 10 if abs(x) < 1000 else 50


def nice(x):
    """Round € for people: <100 -> nearest 5, <1000 -> nearest 10, else nearest 50."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return 0
    return int(_step(x) * round(x / _step(x)))


def nice_down(x):
    """Like nice(), but always rounds down. For amounts that are promised as safe."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return 0
    return int(_step(x) * math.floor(x / _step(x) + 1e-9))


def eur(x):
    return f"€{nice(x):,}"


def money(x):
    """Format an amount that is already rounded (used when numbers in one sentence must add up)."""
    return f"€{int(x):,}"


def fmt_date(ts):
    t = pd.Timestamp(ts)
    return f"{t.day} {t.strftime('%b')}"


def how_often(per_month):
    """'5 times a month' for frequent things, '9 times a year' for rarer ones."""
    if per_month >= 2:
        return f"{round(per_month)} times a month"
    return f"{max(1, round(12 * per_month))} times a year"


def customer_insights(s, cl, anomalies):
    """All insights for one customer. s: summary row (Series), cl: customer_line rows, anomalies: rows."""
    out = []
    as_of = pd.Timestamp(s["as_of"])

    def add(kind, priority, impact, message, action, line=None, **numbers):
        out.append(dict(customer_id=s["customer_id"], kind=kind, line=line, priority=priority,
                        impact_eur_month=float(impact), message=message, action=action, numbers=numbers))

    # 1. safe to spend (always). Rounded DOWN: the number is a promise.
    pay = fmt_date(s["next_payday"])
    sw = nice_down(s["safe_to_spend_week"])
    usual_week = nice(s["extras_12m"] * 7 / DPM)        # what they actually spent on extras per week
    if sw > 0:
        tight = s["safe_binding"] == "cash_until_payday"
        note = (f" That's less than the {eur(usual_week)} a week you usually spend on extras."
                if usual_week > 1.15 * sw else "")
        add("safe_to_spend", 1, 0,
            f"You can safely spend about €{sw:,} a week on extras until payday on {pay}."
            + (" Money is a bit tight until then." if tight else "") + note,
            f"Keep this week's extras under €{sw:,}.", safe_week=sw, usual_week=usual_week,
            next_payday=str(pd.Timestamp(s['next_payday']).date()))
    else:
        add("safe_to_spend", 1, 0,
            f"Money is tight until payday on {pay}: after rent, bills and essentials there is nothing spare.",
            f"Hold off on extras until {pay}.", safe_week=0, usual_week=usual_week,
            next_payday=str(pd.Timestamp(s['next_payday']).date()))

    # 2. unusual payment: only a recent one, and only if such payments are rare for this customer
    if 0 < len(anomalies) <= C.UNUSUAL_MAX_HABIT:
        recent = anomalies[pd.to_datetime(anomalies["tx_date"]) > as_of - pd.Timedelta(days=C.UNUSUAL_RECENT_DAYS)]
        if len(recent):
            a = recent.sort_values("spend", ascending=False).iloc[0]
            add("unusual_payment", 2, a["spend"],
                f"We noticed an unusually large {a['category'].lower()} payment of {eur(a['spend'])} on {fmt_date(a['tx_date'])}.",
                "Check that this payment was yours.", amount=nice(a["spend"]), date=str(pd.Timestamp(a["tx_date"]).date()))

    # 3. peer gaps on discretionary lines (the two biggest first, a third one further down)
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
            why = (f"You pay for {lab} about {how_often(r['lam'])}; "
                   f"most people your age about {how_often(r['peer_lam_median'])}.")
        elif size_ratio >= 1.3 and freq_ratio < 1.3:
            why = f"You go about as often as others, but spend about {eur(r['size_eur'])} each time versus {eur(r['peer_size_median'])}."
        else:
            why = "You go more often and spend more each time than most people your age."
        you, peers = nice(r["expected_month"]), nice(r["peer_median"])
        add("peer_gap", [3, 5, 8][i], r["gap"],
            f"You spend about {money(you)} a month on {lab}. People your age in {s['area']} typically spend {money(peers)}. {why}",
            f"Matching them would save about {money(you - peers)} a month ({money(12 * (you - peers))} a year).",
            line=r["line"], you=you, peers=peers, saving_month=you - peers)

    # 4. trends: the monthly level really changed (model probability), shown with the actual averages
    ev = cl[cl["line"].isin(C.EVERYDAY_LINES) & cl["p_up"].notna()].copy()
    if len(ev):
        ev["diff"] = ev["recent_month"] - ev["base_month"]
        ev["rel"] = ev["recent_month"] / ev["base_month"].clip(lower=1) - 1
        ev["diff_adj"] = ev["recent_adj"] - ev["base_adj"]
        ev["rel_adj"] = ev["recent_adj"] / ev["base_adj"].clip(lower=1) - 1
        ups = ev[(ev["p_up"] >= C.TREND_MIN_PROB) & (ev[["rel", "rel_adj"]].min(axis=1) > C.TREND_MIN_REL)
                 & (ev[["diff", "diff_adj"]].min(axis=1) > C.TREND_MIN_EUR)]
        downs = ev[(ev["p_down"] >= C.TREND_MIN_PROB) & (ev[["rel", "rel_adj"]].max(axis=1) < -C.TREND_MIN_REL)
                   & (ev[["diff", "diff_adj"]].max(axis=1) < -C.TREND_MIN_EUR)]
        n_recent = C.TREND_RECENT_MONTHS
        for _, r in ups.sort_values("diff", ascending=False).head(2).iterrows():
            lab = LABEL[r["line"]]
            before, now = nice(r["base_month"]), nice(r["recent_month"])
            add("trend_up", 4, r["diff"],
                f"Your spending on {lab} has gone up from about {money(before)} to {money(now)} a month over the last {n_recent} months.",
                f"That is {money(now - before)} more each month. Check whether it's on purpose.",
                line=r["line"], before=before, now=now)
        for _, r in downs.sort_values("diff").head(1).iterrows():
            lab = LABEL[r["line"]]
            before, now = nice(r["base_month"]), nice(r["recent_month"])
            if r["line"] in C.ESSENTIAL_EVERYDAY:
                msg = f"Your spending on {lab} dropped from about {money(before)} to {money(now)} a month over the last {n_recent} months."
                act = f"If that's on purpose, it leaves you about {money(12 * (before - now))} more a year."
            else:
                msg = f"Nice work: your spending on {lab} dropped from about {money(before)} to {money(now)} a month."
                act = f"Keep it up and you'll have about {money(12 * (before - now))} more this year."
            add("trend_down", 8, -r["diff"], msg, act, line=r["line"], before=before, now=now)

        # 5. last month was the customer's biggest month for an extra (a fact about one month, not a trend)
        hi = ev[ev["line"].isin(C.DISCRETIONARY) & ev["last_month_is_record"].astype(bool)].copy()
        hi["excess"] = hi["last_month_eur"] - hi["usual_month_eur"]
        hi = hi[(hi["last_month_eur"] >= C.MONTH_HIGH_MIN_RATIO * hi["usual_month_eur"]) & (hi["excess"] >= C.MONTH_HIGH_MIN_EUR)]
        if len(hi):
            r = hi.sort_values("excess", ascending=False).iloc[0]
            n_months = int(cl["T"].max())
            last, usual = nice(r["last_month_eur"]), nice(r["usual_month_eur"])
            add("month_high", 4, r["excess"],
                f"{as_of.strftime('%B')} was your biggest month for {LABEL[r['line']]} in {n_months} months: "
                f"{money(last)}, against {money(usual)} in a usual month.",
                f"A one-off is fine. As a habit it would cost about {money(12 * (last - usual))} more a year.",
                line=r["line"], last_month=last, usual=usual)

    # 6. surprise fund (basket 2)
    n_year = s["shocks_per_year"]
    freq_txt = ("rarely" if n_year < 0.3 else "about once every two years" if n_year < 0.75
                else "about once a year" if n_year < 1.5 else f"about {round(n_year)} times a year")
    intro = (f"Unexpected costs like repairs or doctor bills hit you {freq_txt}, typically around {eur(s['typical_shock_eur'])}. "
             f"A surprise fund of {eur(s['surprise_fund'])} would cover a bad year.")
    gap = s["surprise_fund_gap"]
    if gap <= 0:
        add("surprise_fund", 8, 0, intro + " Your account balance already covers it.",
            f"Keep at least {eur(s['surprise_fund'])} untouched for surprises.",
            fund=nice(s["surprise_fund"]), monthly=0, typical=nice(s["typical_shock_eur"]), covered=True)
    else:
        # save enough to cover the expected yearly cost, or to close the gap in 2 years
        monthly = max(nice(max(s["shock_month"], gap / 24)), 5)
        months_to_fund = max(1, math.ceil(gap / monthly))
        add("surprise_fund", 5, monthly, intro + f" You are about {eur(gap)} short of that.",
            f"Move {eur(monthly)} a month into a surprise fund on payday. You'd have it in about {months_to_fund} months.",
            fund=nice(s["surprise_fund"]), monthly=monthly, typical=nice(s["typical_shock_eur"]), covered=False,
            short=nice(gap))

    # 7. three baskets
    tot = s["total_spend_month"]
    b1, b2 = s["regular_month"], s["shock_month"]
    b3 = tot - b1 - b2
    r1, r2, r3 = nice(b1), nice(b2), nice(b3)
    add("baskets", 7, 0,
        f"Of the {money(r1 + r2 + r3)} you spend a month, {money(r1)} goes to fixed bills, {money(r2)} to surprises "
        f"and {money(r3)} to everyday spending.",
        "Everyday spending is the part you control most. That's where small changes add up.",
        total=r1 + r2 + r3, fixed=r1, surprises=r2, everyday=r3, fixed_pct=round(100 * b1 / tot),
        everyday_pct=round(100 * b3 / tot))

    # 8. balance and savings: ACTUAL last 12 months, income vs ALL spending (a fact, not an estimate)
    sr = s["savings_rate"] if pd.notna(s["savings_rate"]) else 0
    left = s["net_12m"]
    save = nice_down(s["safe_to_save_month"])
    if left < -C.OVERSPEND_MIN_EUR:
        cut = 100 * -left / max(s["extras_12m"], 1)        # extras = discretionary lines incl. big purchases, once
        pct = nice(cut) if cut >= 10 else max(1, round(cut))
        if cut <= 50:
            action = f"Trimming your extras by {pct} % would bring you back to balance."
        elif cut < 100:
            action = (f"Balancing with extras alone would mean cutting them by {pct} %. "
                      "Check your bigger costs and recent big purchases too.")
        else:
            action = "Even with no extras you'd spend more than comes in. Your fixed bills and essentials need a look."
        over, inc = nice(-left), int(round(s["income_12m"] / 10) * 10)
        add("overspending", 2, -left,
            f"Over the last 12 months you spent about {money(over)} a month more than came in: "
            f"{money(inc)} in, {money(inc + over)} out.",
            action, overspend=over, income=inc, out=inc + over, cut_pct=round(cut))
    elif save >= 20:
        already = (f" on top of the {eur(s['savings_month'])} you already put aside" if s["savings_month"] >= 20 else "")
        where = " Start with your surprise fund." if gap > 0 else ""
        add("savings", 6, save,
            f"With your current habits you could safely move about €{save:,} a month to savings{already}.",
            f"Set up an automatic transfer of €{save:,} on payday. That's €{12 * save:,} a year.{where}",
            safe_to_save=save, already_saving=nice(s["savings_month"]))
    elif sr >= 0.10:
        add("savings", 9, 0, f"You put aside about {eur(s['savings_month'])} a month ({round(100 * sr)} % of your income). That's a great habit.",
            "Keep your automatic savings going.", safe_to_save=0, already_saving=nice(s["savings_month"]))
    return out


def spender_type(s, cl):
    """'What kind of spender am I?' from the discretionary lines where the customer stands out most."""
    disc = cl[cl["line"].isin(C.DISCRETIONARY) & (cl["expected_month"] >= 20)].sort_values(
        ["peer_pct", "expected_month"], ascending=False)
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
    summ = con.sql("select * from customer_summary order by customer_id").df()
    cl = con.sql("select * from customer_line order by customer_id, line").df()
    anom = con.sql("""select customer_id, tx_date, category, spend from transactions
                      where line = 'anomaly' order by customer_id, tx_date, spend""").df()
    cl_g, an_g = dict(tuple(cl.groupby("customer_id"))), dict(tuple(anom.groupby("customer_id")))
    rows, types = [], []
    empty = anom.iloc[:0]
    for _, s in summ.iterrows():
        c = cl_g[s["customer_id"]]
        rows += customer_insights(s, c, an_g.get(s["customer_id"], empty))
        types.append({"customer_id": s["customer_id"], **spender_type(s, c)})
    ins = pd.DataFrame(rows)
    ins["numbers"] = ins["numbers"].map(json.dumps)
    ins = ins.sort_values(["customer_id", "priority", "impact_eur_month", "kind"],
                          ascending=[True, True, False, True], kind="mergesort")
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
