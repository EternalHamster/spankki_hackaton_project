"""Optional full-data check against the existing UI samples; no model calls."""
import argparse
import json
from datetime import date
from decimal import Decimal
from pathlib import Path

from money_coach.repository import DuckDBRepository


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=Path("data/finance.duckdb"))
    parser.add_argument("--ui-data", type=Path, default=Path("../ui-demos/public/demo-data.json"))
    parser.add_argument("--mapping", type=Path, default=Path("config/s-pankki.json"))
    args = parser.parse_args()
    repository = DuckDBRepository(args.database)
    data = json.loads(args.ui_data.read_text(encoding="utf-8"), parse_float=Decimal)
    categories = set(json.loads(args.mapping.read_text(encoding="utf-8"))["expense_categories"])
    checked = 0
    for profile in data["profiles"]:
        months = sorted({t["date"][:7] for t in profile["transactions"]})
        for month in months:
            start = date.fromisoformat(month + "-01")
            end = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
            expected = sum((-Decimal(t["amount"]) for t in profile["transactions"]
                            if t["date"].startswith(month) and t["category"] in categories and t["amount"] < 0), Decimal(0))
            result = repository.spending(profile["customer_id"], start, end, None)
            assert Decimal(result["total_eur"]) == expected, (profile["customer_id"], month, result["total_eur"], expected)
            checked += 1
    with repository.connection() as con:
        rows = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        assert rows == data["summary"]["count"]
        # Every customer/month/category summary must reconcile, not only the demo customers.
        mismatches = con.execute("""WITH actual AS (
            SELECT customer_id, date_trunc('month',tx_date)::DATE AS month, category, basket,
            SUM(expense_eur) AS total_eur, COUNT(*) AS transaction_count
            FROM transactions WHERE expense_eur > 0 GROUP BY ALL
        ) SELECT COUNT(*) FROM (
            (SELECT * FROM actual EXCEPT SELECT * FROM monthly_spending)
            UNION ALL (SELECT * FROM monthly_spending EXCEPT SELECT * FROM actual)
        )""").fetchone()[0]
        assert mismatches == 0
    print(f"Verified {rows:,} rows, all monthly summaries, and {checked} UI customer/month totals.")


if __name__ == "__main__":
    main()
