"""Full pipeline. Run from the BDA folder:  .venv/Scripts/python -m engine   (about 2 minutes)

1. build output/coach.duckdb from the raw CSVs in ../Data
2. fit the model (Statistics Finland priors cached in data/statfin/)
3. generate insights
4. validate against plain averages
5. export result tables as CSV to output/
"""
import time

import duckdb

from . import build_db, model, insights, validate
from .config import DB_PATH, OUTPUT_DIR

EXPORT_TABLES = ["customer_summary", "customer_line", "insights", "spender_type", "model_hyper"]
# model-internal columns left out of the CSV export (they stay in coach.duckdb)
INTERNAL = {"customer_line": ["slx", "sslx", "sx2", "shape", "rate_", "a", "b", "M", "T2", "cv2", "sigma2",
                              "size_var", "eur", "n", "T", "base_raw", "recent_raw"]}

t = time.time()
build_db.build()
model.run()
ins, _ = insights.run()
val = validate.run()
val.to_csv(OUTPUT_DIR / "validation.csv", index=False)

con = duckdb.connect(str(DB_PATH), read_only=True)
for name in EXPORT_TABLES:
    df = con.sql(f"select * from {name}").df()
    df = df.drop(columns=[c for c in INTERNAL.get(name, []) if c in df.columns])
    df.round(3).to_csv(OUTPUT_DIR / f"{name}.csv", index=False)
con.close()
print(f"done: {len(ins)} insights for {ins.customer_id.nunique()} customers in {time.time() - t:.0f}s")
print(f"outputs in {OUTPUT_DIR}")
