"""The agent depends on this interface, not an upstream database schema."""
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Protocol

import duckdb


class FinanceRepository(Protocol):
    def describe(self, customer_id: str) -> dict: ...
    def spending(self, customer_id: str, start: date, end: date, category: str | None) -> dict: ...


class DuckDBRepository:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connection(self):
        # One connection per tool operation, never shared across request threads.
        # A future pool must retain exclusive ownership per request/thread.
        if not self.path.is_file():
            raise ValueError("Database snapshot unavailable")
        con = duckdb.connect(str(self.path), read_only=True, config={"enable_external_access": "false"})
        try:
            yield con
        finally:
            con.close()

    def check(self):
        with self.connection() as con:
            con.execute("SELECT version FROM dataset_metadata").fetchone()
            con.execute("SELECT customer_id, expense_eur FROM transactions LIMIT 0")
            con.execute("SELECT customer_id, total_eur FROM monthly_spending LIMIT 0")

    def latest_date(self) -> date | None:
        """Last transaction date in the snapshot; the coach's 'today' for historical data."""
        with self.connection() as con:
            return con.execute("SELECT MAX(tx_date) FROM transactions").fetchone()[0]

    def describe(self, customer_id: str) -> dict:
        with self.connection() as con:
            row = con.execute("""SELECT MIN(tx_date), MAX(tx_date), COUNT(*) FROM transactions
                WHERE customer_id = ?""", [customer_id]).fetchone()
            categories = con.execute("""SELECT DISTINCT category FROM monthly_spending
                WHERE customer_id = ? ORDER BY category LIMIT 101""", [customer_id]).fetchall()
            version = con.execute("SELECT version FROM dataset_metadata").fetchone()[0]
        return {"currency": "EUR", "data_version": version, "coverage_from": str(row[0]) if row[0] else None,
                "coverage_to": str(row[1]) if row[1] else None, "transaction_count": row[2],
                "categories": [r[0] for r in categories[:100]], "categories_truncated": len(categories) > 100,
                "capabilities": ["spending", "baskets", "savings"],
                "safe_to_spend_available": False,
                "limitations": ["Historical data; no live balances or future commitments.",
                                "Spending is gross outgoing expenditure; refunds and transfers are excluded."]}

    def spending(self, customer_id: str, start: date, end: date, category: str | None) -> dict:
        # End is exclusive; complete calendar months use the precomputed table.
        with self.connection() as con:
            if start.day == end.day == 1:
                query = """SELECT category, basket, SUM(total_eur), SUM(transaction_count)
                    FROM monthly_spending WHERE customer_id = ? AND month >= ? AND month < ?
                    AND (? IS NULL OR lower(category) = lower(?)) GROUP BY category, basket ORDER BY category"""
            else:
                query = """SELECT category, basket, SUM(expense_eur), COUNT(*) FROM transactions
                    WHERE customer_id = ? AND tx_date >= ? AND tx_date < ? AND expense_eur > 0
                    AND (? IS NULL OR lower(category) = lower(?)) GROUP BY category, basket ORDER BY category"""
            rows = con.execute(query, [customer_id, start, end, category, category]).fetchall()
        # Rules cap categories at import, hence bounded result size without losing totals.
        from decimal import Decimal
        return {"start_date": str(start), "end_date_exclusive": str(end), "currency": "EUR",
                "total_eur": str(sum((r[2] for r in rows), Decimal("0.00"))),
                "transaction_count": sum(r[3] for r in rows),
                "categories": [{"category": r[0], "basket": r[1], "total_eur": str(r[2]),
                                "transaction_count": r[3]} for r in rows]}
