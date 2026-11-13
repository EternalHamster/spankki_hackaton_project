"""Out-of-sample check: does the hierarchical model predict future spending better than plain averages?

Train on months 1-18, predict each customer's average monthly spend per line in months 19-24.
  full history : customer has all 18 training months
  new customer : customer has only the last 3 training months (hyperparameters still from everyone)
Compared against the customer's own raw average over the same months.
"""
import numpy as np
import pandas as pd
import duckdb

from . import config as C
from .model import month_index, suff_stats, fit_compound, posterior_compound, COMPOUND_LINES
from .statfin import load_priors


def run(db_path=C.DB_PATH):
    con = duckdb.connect(str(db_path), read_only=True)
    spend, _, _ = load_priors()
    months = month_index(con)
    train_end, test_start = months[17], months[18]
    actual = suff_stats(con, test_start, months[-1])
    actual["actual"] = actual["eur"] / actual["T"]
    key = ["customer_id", "line"]

    hyper = fit_compound(suff_stats(con, months[0], train_end), spend)
    rows = []
    for label, start in [("full history (18 months)", months[0]), ("new customer (3 months)", months[15])]:
        st = suff_stats(con, start, train_end)
        p = posterior_compound(st, hyper).merge(actual[key + ["actual"]], on=key)
        for line in COMPOUND_LINES + ["ALL LINES"]:
            d = p if line == "ALL LINES" else p[p["line"] == line]
            er, em = d["raw_month"] - d["actual"], d["expected_month"] - d["actual"]
            mae_raw, mae_mod = er.abs().mean(), em.abs().mean()
            rmse_raw, rmse_mod = np.sqrt((er ** 2).mean()), np.sqrt((em ** 2).mean())
            rows.append((label, line, mae_raw, mae_mod, 1 - mae_mod / mae_raw,
                         rmse_raw, rmse_mod, 1 - rmse_mod / rmse_raw, er.mean(), em.mean()))
    res = pd.DataFrame(rows, columns=["setting", "line", "mae_raw_avg", "mae_model", "improvement",
                                      "rmse_raw", "rmse_model", "rmse_impr", "bias_raw", "bias_model"])
    con.close()
    return res


if __name__ == "__main__":
    r = run()
    pd.set_option("display.width", 160)
    for s, d in r.groupby("setting", sort=False):
        print(f"\n== {s}: mean absolute error, € per month, months 19-24")
        pct = lambda s: (100 * s).round(1).astype(str) + " %"
        print(d.drop(columns="setting").assign(improvement=lambda x: pct(x["improvement"]),
                                               rmse_impr=lambda x: pct(x["rmse_impr"]))
              .round(1).to_string(index=False))
