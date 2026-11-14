"""Does the model work? Three out-of-sample checks.      run: python -m engine.validate

1. holdout()   Train on all but the last 6 months, predict each customer's average monthly spend per
               line in the last 6. Compared with the customer's own plain average, and with the same
               model without burstiness (plain Poisson).
                 full history : customer has all training months
                 new customer : customer has only the last 3 training months
2. backtest()  Safe-to-spend calibration. Re-run the whole model as of earlier month ends, then look at
               what really happened until the next salary arrived. The cash limit is a 10th percentile,
               so the customer's real room should be at least that big about 90 % of the time.
3. trend_check()  How many customers get a trend alert, and how many a naive test would have flagged.
"""
import numpy as np
import pandas as pd
import duckdb

from . import config as C
from . import model
from .model import month_index, suff_stats, fit_compound, posterior_compound, use_as_of, COMPOUND_LINES, _in, _d
from .statfin import load_priors

TEST_MONTHS = 6


def holdout(db_path=C.DB_PATH):
    con = duckdb.connect(str(db_path), read_only=True)
    use_as_of(con)
    spend, _, _ = load_priors()
    months = month_index(con)
    train_end, test_start = months[-TEST_MONTHS - 1], months[-TEST_MONTHS]
    actual = suff_stats(con, test_start, months[-1])
    actual["actual"] = actual["eur"] / actual["T"]
    key = ["customer_id", "line"]

    train = suff_stats(con, months[0], train_end)
    hyper = fit_compound(train, spend)
    hyper_poisson = fit_compound(train, spend, dispersion=False)
    n_train = len(months) - TEST_MONTHS
    rows = []
    for label, start in [(f"full history ({n_train} months)", months[0]), ("new customer (3 months)", months[-TEST_MONTHS - 3])]:
        st = suff_stats(con, start, train_end)
        p = posterior_compound(st, hyper).merge(actual[key + ["actual"]], on=key)
        p["poisson_month"] = posterior_compound(st, hyper_poisson)["expected_month"].to_numpy()
        for line in COMPOUND_LINES + ["ALL LINES"]:
            d = p if line == "ALL LINES" else p[p["line"] == line]
            er, em, ep = d["raw_month"] - d["actual"], d["expected_month"] - d["actual"], d["poisson_month"] - d["actual"]
            mae_raw, mae_mod = er.abs().mean(), em.abs().mean()
            rmse_raw, rmse_mod = np.sqrt((er ** 2).mean()), np.sqrt((em ** 2).mean())
            rows.append((label, line, mae_raw, mae_mod, 1 - mae_mod / mae_raw,
                         rmse_raw, rmse_mod, 1 - rmse_mod / rmse_raw, er.mean(), em.mean(),
                         ep.abs().mean(), np.sqrt((ep ** 2).mean())))
    res = pd.DataFrame(rows, columns=["setting", "line", "mae_raw_avg", "mae_model", "improvement",
                                      "rmse_raw", "rmse_model", "rmse_impr", "bias_raw", "bias_model",
                                      "mae_poisson", "rmse_poisson"])
    con.close()
    return res


VARIANTS = [("full model", {}),
            ("without late-salary model", {"late_payday": False}),
            ("without burstiness or late salary (old model)", {"late_payday": False, "dispersion": False})]


def backtest(db_path=C.DB_PATH, n_back=6, n_sim=500, variants=VARIANTS):
    """Coverage of the safe-to-spend cash limit at the last `n_back` month ends before the final month."""
    con = duckdb.connect(str(db_path), read_only=True)
    use_as_of(con)
    months = month_index(con)
    need_lines = C.REGULAR_LINES + C.ESSENTIAL_EVERYDAY + ["shock"]
    rows = []
    for k in range(1, n_back + 1):
        as_of = months[-k] - pd.Timedelta(days=1)            # last day of the month before months[-k]
        # what really happened: when the salary arrived, and what had to be paid before it
        arrival = con.sql(f"""select customer_id, min(tx_date) arrival from transactions
                              where category = 'Salary' and tx_date > {_d(as_of)} group by 1 order by 1""").df()
        paid = con.sql(f"""select customer_id, tx_date, spend from transactions
                           where line in {_in(need_lines)} and tx_date > {_d(as_of)}
                             and tx_date <= {_d(as_of + pd.Timedelta(days=45))}""").df()
        paid = paid.merge(arrival, on="customer_id")
        needs = paid[paid["tx_date"] < paid["arrival"]].groupby("customer_id")["spend"].sum()
        real = arrival.set_index("customer_id")
        real["needs"] = needs.reindex(real.index).fillna(0.0)
        for name, kw in variants:
            _, _, s = model.run(db_path, as_of=as_of, write=False, verbose=False, n_sim=n_sim, trend=False, **kw)
            s = s.set_index("customer_id").join(real, how="inner")
            days = (pd.to_datetime(s["arrival"]) - as_of).dt.days.clip(lower=1)
            room = (s["balance"] - s["needs"] - C.SAFE_CUSHION_EUR) / np.maximum(days / 7, 1)
            ok = room >= s["safe_week_cash"]
            tight = s["safe_week_cash"] < s[["safe_week_budget", "safe_week_budget_12m"]].min(axis=1)
            rows.append({"variant": name, "as_of": as_of.date(), "customers": len(s),
                         "coverage": ok.mean(), "coverage_cash_tight": ok[tight].mean(),
                         "cash_tight_share": tight.mean(),
                         "salary_late_share": (days > s["days_to_payday"] + C.LATE_PAYDAY_GAP_DAYS).mean()})
    con.close()
    res = pd.DataFrame(rows)
    total = (res.assign(w=res["customers"]).groupby("variant", sort=False)
                .apply(lambda d: pd.Series({"as_of": "ALL", "customers": d["customers"].sum(),
                                            "coverage": np.average(d["coverage"], weights=d["w"]),
                                            "coverage_cash_tight": np.average(d["coverage_cash_tight"], weights=d["w"] * d["cash_tight_share"]),
                                            "cash_tight_share": np.average(d["cash_tight_share"], weights=d["w"]),
                                            "salary_late_share": np.average(d["salary_late_share"], weights=d["w"])}),
                       include_groups=False).reset_index())
    return pd.concat([res, total], ignore_index=True)


def trend_check(db_path=C.DB_PATH):
    """Trend alerts: model (false-discovery controlled) vs a naive one-sided 5 % test per customer x line."""
    con = duckdb.connect(str(db_path), read_only=True)
    cl = con.sql("select line, trend_z, p_up, p_down from customer_line where p_up is not null").df()
    con.close()
    g = cl.groupby("line")
    return pd.DataFrame({"tests": g.size(),
                         "naive_alerts": g["trend_z"].apply(lambda z: int((z.abs() > 1.645).sum())),
                         "model_alerts": g.apply(lambda d: int(((d["p_up"] >= C.TREND_MIN_PROB) | (d["p_down"] >= C.TREND_MIN_PROB)).sum()),
                                                 include_groups=False)}).reset_index()


def run(db_path=C.DB_PATH):
    """Holdout table (kept for the pipeline and plots)."""
    return holdout(db_path)


if __name__ == "__main__":
    pd.set_option("display.width", 200)
    r = holdout()
    for s, d in r.groupby("setting", sort=False):
        print(f"\n== {s}: mean absolute error, € per month, last {TEST_MONTHS} months")
        pct = lambda s: (100 * s).round(1).astype(str) + " %"
        print(d.drop(columns="setting").assign(improvement=lambda x: pct(x["improvement"]),
                                               rmse_impr=lambda x: pct(x["rmse_impr"]))
              .round(1).to_string(index=False))
    print("\n== safe-to-spend calibration (target coverage 90 %)")
    b = backtest()
    print(b[b["as_of"].astype(str) == "ALL"].drop(columns="as_of").round(3).to_string(index=False))
    b.to_csv(C.OUTPUT_DIR / "calibration.csv", index=False)
    print("\n== trend alerts")
    print(trend_check().to_string(index=False))
