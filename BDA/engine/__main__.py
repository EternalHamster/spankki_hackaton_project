"""Full pipeline. Run from the BDA folder:  .venv/Scripts/python -m engine   (about 4 minutes)

1. build output/coach.duckdb from the raw CSVs in ../Data
2. fit the model (Statistics Finland priors cached in data/statfin/)
3. generate insights
4. validate: holdout accuracy + safe-to-spend calibration backtest
5. export result tables as CSV to output/, draw the plots
6. self-check (python -m engine.check)
"""
import sys
import time

import duckdb

from . import build_db, model, insights, validate, plots, check
from .config import DB_PATH, OUTPUT_DIR

EXPORT_TABLES = ["customer_summary", "customer_line", "insights", "spender_type", "model_hyper"]
# model-internal columns left out of the CSV export (they stay in coach.duckdb)
INTERNAL = {"customer_line": ["slx", "sslx", "sx2", "sn2", "shape", "rate_", "a", "b", "phi_g", "M", "T2", "cv2",
                              "sigma2", "disp_alpha", "disp_beta", "disp_lo", "disp_hi", "size_var", "eur", "n",
                              "T", "base_adj", "recent_adj"]}

t = time.time()
build_db.build()
model.run()
ins, _ = insights.run()
holdout, backtest = validate.holdout(), validate.backtest(n_back=3, n_sim=400)
holdout.to_csv(OUTPUT_DIR / "validation.csv", index=False)
backtest.to_csv(OUTPUT_DIR / "calibration.csv", index=False)
con = duckdb.connect(str(DB_PATH))                    # the test results live in the database too
for name, df in [("validation", holdout), ("calibration", backtest.assign(as_of=backtest["as_of"].astype(str)))]:
    con.register("tmp_df", df)
    con.sql(f"create or replace table {name} as select * from tmp_df")
    con.unregister("tmp_df")
con.close()

con = duckdb.connect(str(DB_PATH), read_only=True)
for name in EXPORT_TABLES:
    df = con.sql(f"select * from {name}").df()
    df = df.drop(columns=[c for c in INTERNAL.get(name, []) if c in df.columns])
    num = df.select_dtypes("number").columns
    df[num] = df[num].round(3)
    df.to_csv(OUTPUT_DIR / f"{name}.csv", index=False)
con.close()
plots.run()
print(f"done: {len(ins)} insights for {ins.customer_id.nunique()} customers in {time.time() - t:.0f}s")
print(f"outputs in {OUTPUT_DIR}")
sys.exit(0 if check.run() else 1)
