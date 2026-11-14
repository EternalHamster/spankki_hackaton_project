"""Offline, explicit schema adaptation. Never run imports in an API worker."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Literal
from uuid import uuid4

import duckdb
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Mapping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    table: str = "transactions"
    customer_id: str
    date: str
    category: str
    amount: str
    amount_convention: Literal["negative_debits", "positive_debits", "expense_only"]
    currency: Literal["EUR"] = "EUR"
    currency_column: str | None = None
    date_format: str | None = None
    expense_categories: list[str] = Field(min_length=1, max_length=100)
    income_categories: list[str] = Field(default_factory=list, max_length=100)
    baskets: dict[str, Literal["regular_needs", "irregular_needs", "everyday_choices"]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_categories(self):
        if set(self.expense_categories) & set(self.income_categories):
            raise ValueError("Expense and income categories must be disjoint")
        if self.amount_convention == "expense_only" and self.income_categories:
            raise ValueError("expense_only does not represent income")
        return self


def identifier(value: str) -> str:
    if not value or "\x00" in value:
        raise ValueError("Empty or invalid identifier")
    return '"' + value.replace('"', '""') + '"'


def build_snapshot(source: Path, output: Path, mapping: Mapping, source_kind: str = "csv") -> dict:
    """Write a new immutable snapshot; refuse overwrite and leave source untouched.

    A prejoined DuckDB table/view can represent any upstream account/customer schema.
    Identifier quoting is separate from bound values; no user/model SQL is accepted.
    """
    source, output = source.resolve(), output.resolve()
    if not source.is_file():
        raise ValueError("Source file does not exist")
    if output.exists() or source == output:
        raise ValueError("Output must be a new path; use a new snapshot version")
    if source_kind not in {"csv", "duckdb"}:
        raise ValueError("Unsupported source kind")
    output.parent.mkdir(parents=True, exist_ok=True)
    # Reserve atomically so concurrent imports cannot overwrite one another.
    output.touch(exist_ok=False)
    staging = output.with_name(output.name + "." + uuid4().hex + ".duckdb")
    con = duckdb.connect()
    try:
        if source_kind == "csv":
            con.read_csv(str(source), all_varchar=True).create_view("source_data")
        else:
            # ATTACH doesn't support bound parameters; quote this operator-owned path as a literal.
            path_literal = str(source).replace("'", "''")
            con.execute(f"ATTACH '{path_literal}' AS source_db (READ_ONLY)")
            table = ".".join(identifier(part) for part in mapping.table.split("."))
            con.execute(f"CREATE VIEW source_data AS SELECT * FROM source_db.{table}")
        columns = {row[0] for row in con.execute("DESCRIBE source_data").fetchall()}
        required = [mapping.customer_id, mapping.date, mapping.category, mapping.amount]
        if mapping.currency_column:
            required.append(mapping.currency_column)
        missing = set(required) - columns
        if missing:
            raise ValueError(f"Missing mapped columns: {sorted(missing)}")
        date_expr = f"TRY_CAST({identifier(mapping.date)} AS DATE)"
        params = []
        if mapping.date_format:
            date_expr = f"CAST(try_strptime(CAST({identifier(mapping.date)} AS VARCHAR), ?) AS DATE)"
            params.append(mapping.date_format)
        currency_expr = identifier(mapping.currency_column) if mapping.currency_column else "'EUR'"
        con.execute(f"""CREATE TABLE normalized AS SELECT
            TRIM(CAST({identifier(mapping.customer_id)} AS VARCHAR)) AS customer_id,
            {date_expr} AS tx_date,
            TRIM(CAST({identifier(mapping.category)} AS VARCHAR)) AS category,
            TRY_CAST({identifier(mapping.amount)} AS DECIMAL(18,2)) AS raw_amount,
            CAST({currency_expr} AS VARCHAR) AS currency
            FROM source_data""", params)
        invalid = con.execute("""SELECT COUNT(*) FROM normalized WHERE
            customer_id IS NULL OR customer_id = '' OR length(customer_id) > 200
            OR tx_date IS NULL OR category IS NULL OR category = '' OR length(category) > 120
            OR raw_amount IS NULL OR currency IS NULL OR currency != 'EUR'""").fetchone()[0]
        if invalid:
            raise ValueError(f"{invalid} invalid rows; fix mapping/data before importing (no silent drops)")
        if mapping.amount_convention == "expense_only":
            if con.execute("SELECT COUNT(*) FROM normalized WHERE raw_amount < 0").fetchone()[0]:
                raise ValueError("expense_only requires nonnegative amounts")
        con.execute("CREATE TABLE rules(category VARCHAR PRIMARY KEY, kind VARCHAR, basket VARCHAR)")
        rules = [(c, "expense", mapping.baskets.get(c, "unclassified")) for c in mapping.expense_categories]
        rules += [(c, "income", "unclassified") for c in mapping.income_categories]
        con.executemany("INSERT INTO rules VALUES (?, ?, ?)", rules)
        debit_sign = -1 if mapping.amount_convention == "negative_debits" else 1
        con.execute("""CREATE TABLE transactions AS SELECT customer_id, tx_date, n.category,
            CASE WHEN r.kind = 'expense' AND raw_amount * ? > 0 THEN raw_amount * ? ELSE 0 END::DECIMAL(18,2) AS expense_eur,
            CASE WHEN r.kind = 'income' AND raw_amount * ? < 0 THEN -raw_amount * ? ELSE 0 END::DECIMAL(18,2) AS income_eur,
            COALESCE(r.basket, 'unclassified') AS basket,
            r.kind IS NULL AS unmapped_category
            FROM normalized n LEFT JOIN rules r ON n.category = r.category""",
            [debit_sign] * 4)
        con.execute("""CREATE TABLE monthly_spending AS SELECT customer_id,
            date_trunc('month', tx_date)::DATE AS month, category, basket,
            SUM(expense_eur) AS total_eur, COUNT(*) AS transaction_count
            FROM transactions WHERE expense_eur > 0 GROUP BY ALL""")
        report = dict(zip(["rows", "customers", "from", "to", "unmapped_rows"], con.execute("""
            SELECT COUNT(*), COUNT(DISTINCT customer_id), MIN(tx_date), MAX(tx_date),
            COUNT(*) FILTER (WHERE unmapped_category) FROM transactions""").fetchone()))
        if not report["rows"]:
            raise ValueError("Empty source dataset")
        mapping_json = mapping.model_dump_json()
        version = hashlib.sha256((mapping_json + str(source.stat().st_mtime_ns) + str(source.stat().st_size)).encode()).hexdigest()[:16]
        con.execute("CREATE TABLE dataset_metadata(version VARCHAR, mapping_json VARCHAR, created_at TIMESTAMP)")
        con.execute("INSERT INTO dataset_metadata VALUES (?, ?, current_timestamp)", [version, mapping_json])
        # Keep the reserved output until the complete staging file is atomically published.
        output_literal = str(staging).replace("'", "''")
        con.execute(f"ATTACH '{output_literal}' AS target")
        for table in ("transactions", "monthly_spending", "dataset_metadata"):
            con.execute(f"CREATE TABLE target.{table} AS SELECT * FROM {table}")
        con.execute("DETACH target")
        os.replace(staging, output)
        return {**report, "version": version, "output": str(output)}
    except Exception:
        con.close()
        staging.unlink(missing_ok=True)
        output.unlink(missing_ok=True)
        raise
    finally:
        con.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--source-kind", choices=["csv", "duckdb"], default="csv")
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    mapping = Mapping.model_validate_json(args.mapping.read_text(encoding="utf-8"))
    print(json.dumps(build_snapshot(args.source, args.output, mapping, args.source_kind), default=str, indent=2))


if __name__ == "__main__":
    main()
