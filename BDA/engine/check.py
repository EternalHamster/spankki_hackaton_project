"""Self-check of the built database and the coach API.      run: python -m engine.check [--repro]

Verifies model outputs against the raw transactions, internal consistency of every number the coach
can say, and that every tool answers (or fails politely) for a sample of customers.
--repro also re-fits the model and checks that the results are identical (takes about a minute).
"""
import inspect
import json
import sys

import duckdb
import numpy as np
import pandas as pd

from . import config as C
from . import coach, model

RESULTS = []


def ok(name, passed, detail=""):
    RESULTS.append(bool(passed))
    print(f"  {'PASS' if passed else 'FAIL'}  {name}" + (f"   [{detail}]" if detail and not passed else ""))


def check_tables(con):
    print("model outputs")
    s = con.sql("select * from customer_summary order by customer_id").df()
    cl = con.sql("select * from customer_line").df()
    n = con.sql("select count(*) from customers").fetchall()[0][0]
    ok("one summary row per customer", len(s) == n == s["customer_id"].nunique(), f"{len(s)} vs {n}")
    ok("one row per customer x line", len(cl) == n * len(C.LINES) and not cl.duplicated(["customer_id", "line"]).any(), len(cl))
    need = ["income_month", "balance", "regular_month", "essentials_month", "shock_month", "total_spend_month",
            "safe_to_spend_week", "safe_to_save_month", "surprise_fund", "net_12m", "next_payday", "safe_binding"]
    ok("no missing values in summary", not s[need].isna().any().any(), s[need].isna().sum()[lambda x: x > 0].to_dict())
    ok("no missing estimates per line", not cl[["expected_month", "peer_median", "peer_pct"]].isna().any().any())
    ok("all estimates are non-negative", (cl["expected_month"] >= 0).all() and (s[["regular_month", "essentials_month",
       "shock_month", "savings_month", "safe_to_spend_week", "safe_to_save_month"]] >= 0).all().all())
    lim = s[["safe_week_cash", "safe_week_budget", "safe_week_budget_12m"]].min(axis=1).clip(lower=0)
    ok("safe-to-spend never exceeds any of its three limits", (s["safe_to_spend_week"] <= lim + 1e-6).all())
    ok("safe-to-spend is rounded down to €5", (s["safe_to_spend_week"] % 5 == 0).all() and (lim - s["safe_to_spend_week"] < 5).all())
    ok("safe-to-save never exceeds the average monthly surplus", (s["safe_to_save_month"] <= s["surplus_month"].clip(lower=0) + 1e-6).all())
    ok("basket shares add up to 100 %", np.allclose(s[["basket1_share", "basket2_share", "basket3_share"]].sum(axis=1), 1))
    ok("surprise fund covers at least one typical surprise", (s["surprise_fund"] >= s["typical_shock_eur"]).all())
    ok("payday is in the future", (pd.to_datetime(s["next_payday"]) > pd.to_datetime(s["as_of"])).all() and (s["days_to_payday"] >= 1).all())
    tables = {t[0] for t in con.sql("show tables").fetchall()}
    need_tables = {"model_hyper", "customer_monthly_model", "customer_payday", "customer_simulation", "model_season",
                   "model_trend_null", "statfin_priors", "model_config", "validation", "calibration"}
    ok("the database holds every part of the model", need_tables <= tables, sorted(need_tables - tables))
    if need_tables <= tables:
        m = con.sql("select customer_id, line, post_mean from customer_monthly_model").df().pivot(
            index="customer_id", columns="line", values="post_mean").reindex(s["customer_id"])
        sim = con.sql("select customer_id, room_week_q10, shocks_year_eur_q90 from customer_simulation").df().set_index(
            "customer_id").reindex(s["customer_id"])
        pd_ = con.sql("select * from customer_payday").df().set_index("customer_id").reindex(s["customer_id"])
        prior = dict(con.sql("select setting, value from model_config where setting like 'PAYDAY_%'").fetchall())
        a, b = float(prior["PAYDAY_ALPHA"]), float(prior["PAYDAY_BETA"])
        mid = (pd_["payday_dom"] < 31).to_numpy()
        ok("stored model parts reproduce the results",
           np.allclose(m["income"], s["income_month"]) and np.allclose(m["housing"] + m["utilities"], s["regular_month"])
           and np.allclose(sim["room_week_q10"], s["safe_week_cash"])
           and (np.ceil(np.maximum(sim["shocks_year_eur_q90"].to_numpy(), s["typical_shock_eur"].to_numpy()) / 50) * 50
                == s["surprise_fund"].to_numpy()).all()
           and np.allclose(((a + pd_["n_late"]) / (a + b + pd_["n_salaries"])).to_numpy()[mid], s["p_late_payday"].to_numpy()[mid]))
    ok("probabilities are between 0 and 1", cl["p_up"].dropna().between(0, 1).all() and cl["p_down"].dropna().between(0, 1).all()
       and s["p_late_payday"].between(0, 1).all())

    # facts must match the bank's own balance chain: 12 months of (income - spending - savings) = balance change
    months = pd.to_datetime(con.sql("select distinct month from customer_month_line order by 1").df()["month"]).tolist()
    start = months[-12]
    bal0 = con.sql(f"""select customer_id, arg_max(balance_after_eur, ts) b0 from transactions
                       where tx_date < DATE '{start:%Y-%m-%d}' group by 1""").df()
    d = s.merge(bal0, on="customer_id")
    # customers with two transactions on the same final timestamp are skipped (balance order is ambiguous)
    diff = (d["balance"] - d["b0"] - 12 * d["net_12m"]).abs()
    ok("12-month cash flow equals the change in account balance", (diff < 0.05).mean() > 0.995 and len(d) == n,
       f"max diff {diff.max():.2f}, share ok {(diff < 0.05).mean():.4f}")
    exp = con.sql(f"""select customer_id, sum(spend) / 12 x from transactions
                      where line in {coach._in(C.DISCRETIONARY)} and month >= DATE '{start:%Y-%m-%d}' group by 1""").df()
    d = s.merge(exp, on="customer_id", how="left").fillna({"x": 0})
    ok("extras per month match the transactions", np.allclose(d["extras_12m"], d["x"], atol=0.01))
    return s


def check_insights(con, s):
    print("insights")
    ins = con.sql("select * from insights").df()
    kinds = ins.groupby("customer_id")["kind"].agg(set)
    ok("every customer gets safe-to-spend, baskets and surprise fund",
       len(kinds) == len(s) and kinds.map(lambda k: {"safe_to_spend", "baskets", "surprise_fund"} <= k).all())
    text = ins["message"] + " " + ins["action"]
    bad = text[text.str.contains(r"nan|inf\b|€-|None|€0 a month|  ", regex=True)]
    ok("no broken text (nan, negative or zero amounts)", bad.empty, bad.head(2).tolist())
    ok("ranks are 1..n per customer", (ins.groupby("customer_id")["rank"].agg(lambda r: sorted(r) == list(range(1, len(r) + 1)))).all())
    ok("numbers are valid JSON", ins["numbers"].map(lambda x: isinstance(json.loads(x), dict)).all())
    sp = ins[ins["kind"] == "safe_to_spend"].merge(s[["customer_id", "safe_to_spend_week"]], on="customer_id")
    said = sp["numbers"].map(lambda x: json.loads(x)["safe_week"])
    ok("the safe-to-spend message never promises more than the model", (said <= sp["safe_to_spend_week"]).all())
    over = set(ins.loc[ins["kind"] == "overspending", "customer_id"])
    truth = set(s.loc[s["net_12m"] < -C.OVERSPEND_MIN_EUR, "customer_id"])
    ok("overspending warnings match actual cash flow exactly", over == truth, f"{len(over ^ truth)} differ")
    num = ins["numbers"].map(json.loads)
    pg, ov, bk = num[ins["kind"] == "peer_gap"], num[ins["kind"] == "overspending"], num[ins["kind"] == "baskets"]
    ok("numbers inside one message add up",
       pg.map(lambda x: x["you"] - x["peers"] == x["saving_month"] > 0).all()
       and ov.map(lambda x: x["out"] - x["income"] == x["overspend"] > 0).all()
       and bk.map(lambda x: x["fixed"] + x["surprises"] + x["everyday"] == x["total"]).all())
    per = ins[ins["kind"] == "unusual_payment"].groupby("customer_id").size()
    ok("at most one unusual-payment alert per customer", per.empty or per.max() <= 1)


def check_coach(con, s):
    print("coach API")
    rng = np.random.default_rng(0)
    ids = list(rng.choice(s["customer_id"], 150, replace=False))
    ids += list(s.sort_values("customer_id")["customer_id"].tail(25))                 # unusual customers
    ids += list(s.sort_values("safe_to_spend_week")["customer_id"].head(10))          # money is tight
    ids += list(s.sort_values("balance")["customer_id"].tail(5)) + ["CUST00042"]
    as_of = pd.Timestamp(s["as_of"].iloc[0])
    month = as_of.strftime("%Y-%m") if as_of.is_month_end else (as_of.replace(day=1) - pd.Timedelta(days=1)).strftime("%Y-%m")
    errors, bad = [], []
    for cid in ids:
        calls = [("overview", {}), ("overview", {"n": 20}), ("safe_to_spend", {}), ("safe_to_save", {}), ("baskets", {}),
                 ("spender_type", {}), ("compare_to_peers", {}), ("breakdown", {}), ("breakdown", {"by": "basket"}),
                 ("breakdown", {"by": "category", "start": "2026-01-01", "end": "2026-03-31"}),
                 ("history", {}), ("history", {"line": "income", "months": 24}), ("biggest_payments", {"n": 3}),
                 ("spending", {}), ("spending", {"category": "groceries", "month": month})]
        for line in coach.LINE_NAMES:
            calls += [("spending", {"line": line, "month": month}), ("what_if", {"line": line, "cut_pct": 20}),
                      ("compare_to_peers", {"line": line}), ("history", {"line": line, "months": 6})]
        res = {}
        for name, args in calls:
            r = coach.call(cid, name, args)
            try:
                json.dumps(r, allow_nan=False)
            except (TypeError, ValueError) as e:
                bad.append((cid, name, args, str(e)))
            if isinstance(r, dict) and "error" in r:
                errors.append((cid, name, args, r["error"]))
            res[(name, json.dumps(args, sort_keys=True))] = r
        get = lambda name, **a: res[(name, json.dumps(a, sort_keys=True))]

        row = s[s["customer_id"] == cid].iloc[0]
        w = get("what_if", line="dining_out", cut_pct=20)
        if not (w["now_month"] - w["saves_month"] == w["after_month"] and w["saves_year"] == 12 * w["saves_month"]
                and w["left_over_month_after"] - w["left_over_month_now"] == w["saves_month"]):
            bad.append((cid, "what_if arithmetic", w))
        if get("safe_to_spend")["safe_to_spend_week"] > row["safe_to_spend_week"] or \
                get("overview")["safe_to_spend_week"] != get("safe_to_spend")["safe_to_spend_week"]:
            bad.append((cid, "safe_to_spend mismatch"))
        if get("safe_to_save")["safe_to_save_month"] > row["safe_to_save_month"]:
            bad.append((cid, "safe_to_save above model"))
        raw = con.sql(f"""select coalesce(sum(spend), 0) from transactions where customer_id = '{cid}' and line = 'taxi'
                          and strftime(tx_date, '%Y-%m') = '{month}'""").fetchall()[0][0]
        if abs(get("spending", line="taxi", month=month)["total_eur"] - raw) > 0.01:
            bad.append((cid, "spending != transactions"))
        b = get("breakdown")
        if abs(sum(p["eur"] for p in b["parts"]) - b["spent_eur"]) > 0.05 or \
                abs(get("spending")["total_eur"] - b["spent_eur"]) > 0.01:
            bad.append((cid, "breakdown parts != total"))
        groups = sum(get("spending", line=l, month=month)["total_eur"] for l in ("restaurants", "fast_food", "bars"))
        if abs(groups - get("spending", line="dining_out", month=month)["total_eur"]) > 0.02:
            bad.append((cid, "dining_out != restaurants + fast_food + bars"))
        k = get("baskets")
        parts = k["fixed_bills"]["total"] + k["surprises"]["total"] + k["everyday"]["total"]
        if parts != k["total_spending_month"] or abs(sum(k[x]["share_pct"] for x in ("fixed_bills", "surprises", "everyday")) - 100) > 1:
            bad.append((cid, "baskets do not add up", k))
        if len(get("history", line="income", months=24)["months"]) != 24:
            bad.append((cid, "history length"))
    ok(f"every tool answers for {len(ids)} customers x {len(calls)} calls", not errors, errors[:2])
    ok("answers are valid JSON and internally consistent", not bad, bad[:2])

    polite = [coach.call("NOBODY", "overview"), coach.call("CUST00042", "what_if", {"line": "unicorns"}),
              coach.call("CUST00042", "what_if", {}), coach.call("CUST00042", "what_if", {"line": "taxi", "cut_pct": 500}),
              coach.call("CUST00042", "spending", {"month": "last tuesday"}), coach.call("CUST00042", "fly_to_moon"),
              coach.call("CUST00042", "spending", {"customer_id": "CUST00001"}),
              coach.call("CUST00042", "breakdown", {"by": "colour"})]
    ok("bad requests come back as errors, not crashes", all(isinstance(r, dict) and "error" in r for r in polite),
       [r for r in polite if "error" not in r][:1])
    sig_ok = all(set(t["input_schema"]["properties"]) == set(inspect.signature(coach._FUNCS[t["name"]]).parameters) - {"cid"}
                 for t in coach.TOOLS)
    ok("tool definitions match the functions", sig_ok and {t["name"] for t in coach.TOOLS} == set(coach._FUNCS))


def check_repro(s):
    print("reproducibility (re-fitting the model)")
    _, _, s2 = model.run(write=False, verbose=False)
    num = s.select_dtypes("number").columns
    a, b = s.sort_values("customer_id")[num].to_numpy(), s2.sort_values("customer_id")[num].to_numpy()
    ok("a second run gives identical numbers", a.shape == b.shape and np.allclose(a, b, equal_nan=True))


def run(repro=False):
    RESULTS.clear()
    print("self-check")
    con = duckdb.connect(str(C.DB_PATH), read_only=True)
    s = check_tables(con)
    check_insights(con, s)
    check_coach(con, s)
    con.close()
    if repro:
        check_repro(s)
    print(f"{sum(RESULTS)} of {len(RESULTS)} checks passed")
    return all(RESULTS)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if run(repro="--repro" in sys.argv) else 1)
