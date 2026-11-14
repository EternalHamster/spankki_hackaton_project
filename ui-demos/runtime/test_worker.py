"""Integration checks against the immutable synthetic DuckDB snapshot; no model calls."""
import concurrent.futures
import importlib.util
import json
import subprocess
import sys
import unittest
from unittest.mock import patch
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("coach_ui_worker", HERE / "worker.py")
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class RuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = worker.CustomerRuntime()
        cls.source = json.loads((HERE.parent / "server-data/demo-data.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.runtime.close()

    def request(self, operation, customer="CUST00207", args=None):
        return self.runtime.dispatch({"id": 1, "operation": operation, "customer_id": customer, "args": args or {}})

    def tool(self, name, arguments, customer="CUST00207"):
        return self.request("tool", customer, {"name": name, "arguments": arguments})

    def test_bootstrap_preserves_every_own_transaction_and_no_other_profiles(self):
        for cid in worker.DEMO_CUSTOMERS:
            actual = self.request("bootstrap", cid)
            expected = next(row for row in self.source["profiles"] if row["customer_id"] == cid)
            self.assertEqual(actual["profiles"], [expected])
            self.assertEqual(actual["summary"]["count"], 3626755)
            self.assertEqual(actual["summary"]["customerCount"], 5100)
            self.assertEqual(actual["as_of"], "2026-09-30")
            weekly = actual["weekly_spending"]
            safe = self.tool("safe_to_spend", {}, cid)
            self.assertEqual((weekly["week_start"], weekly["week_end"], weekly["observed_through"]),
                             ("2026-09-28", "2026-10-04", "2026-09-30"))
            self.assertEqual(weekly["days_remaining_in_week"], 4)
            for key in ("eur_week", "usual_extras_eur_week", "spent_eur_week", "weekly_budget_eur",
                        "remaining_eur_week", "over_budget_eur_week", "daily_remaining_eur"):
                amount = weekly[key]
                self.assertIsInstance(amount, (int, float))
                self.assertGreaterEqual(amount, 0)
                self.assertEqual(amount, safe[key])
            for key in weekly:
                self.assertEqual(weekly[key], safe[key])
            for other in worker.DEMO_CUSTOMERS:
                if other != cid:
                    self.assertNotIn(other, json.dumps(actual))

    def test_weekly_spending_reconciles_actual_classified_records_for_each_customer(self):
        for cid in worker.DEMO_CUSTOMERS:
            weekly = self.runtime.weekly_spending(cid)
            rows = self.runtime.query("""select cast(tx_date as varchar) payment_date, line,
                cast(tx_amount_eur as decimal(18,2)) amount_eur from transactions
                where customer_id = ? order by tx_date""", [cid])
            expected = sum((-Decimal(row["amount_eur"]) for row in rows if
                            "2026-09-28" <= row["payment_date"] <= "2026-09-30" and
                            row["line"] in self.runtime.cfg.DISCRETIONARY and Decimal(row["amount_eur"]) < 0), Decimal(0))
            budget = Decimal(str(weekly["weekly_budget_eur"]))
            self.assertEqual(Decimal(str(weekly["spent_eur_week"])), expected)
            self.assertEqual(Decimal(str(weekly["remaining_eur_week"])), max(Decimal(0), budget - expected))
            self.assertEqual(Decimal(str(weekly["over_budget_eur_week"])), max(Decimal(0), expected - budget))
            self.assertLessEqual(Decimal(str(weekly["daily_remaining_eur"])) * 4,
                                 Decimal(str(weekly["remaining_eur_week"])))
            self.assertIn("not an account balance", weekly["planning_note"])

    def test_weekly_spending_dates_filters_zero_budget_and_daily_rounding(self):
        # Small independent SQL fixture covers boundary and refund cases even when
        # the real demonstration customers have no payment on a particular day.
        runtime = object.__new__(worker.CustomerRuntime)
        runtime.connection = worker.duckdb.connect(":memory:")
        runtime.cfg = self.runtime.cfg
        runtime.connection.execute("""create table transactions(customer_id varchar, tx_date date,
            line varchar, spend decimal(18,2), tx_amount_eur decimal(18,2))""")
        rows = [("CUST00207", day, line, amount, -amount) for day, line, amount in [
            ("2026-09-27", "restaurants", 7), ("2026-09-28", "restaurants", 1.01),
            ("2026-09-29", "taxi", 2.02), ("2026-09-29", "home_tech", 3.03),
            ("2026-09-30", "big_purchase", 4.04), ("2026-09-30", "entertainment", 5.05),
            ("2026-10-01", "lifestyle", 6), ("2026-09-29", "restaurants", -20),
            ("2026-09-29", "groceries", 99), ("2026-09-29", "shock", 50),
            ("2026-09-29", "savings_transfer", 1000), ("2026-09-29", "income", -2000),
            ("2026-12-31", "restaurants", .10), ("2027-01-01", "parking", .20),
            ("2027-01-04", "restaurants", 9),
        ]]
        rows.extend([("CUST00127", "2026-09-29", "restaurants", 100, -100),
                     ("CUST00207", "2026-09-29", "restaurants", 100, 100)])
        runtime.connection.executemany("insert into transactions values (?, ?, ?, ?, ?)", rows)
        detail = {"eur_week": 100, "usual_extras_eur_week": 90}
        try:
            runtime.as_of = "2026-09-30"
            weekly = runtime.weekly_spending("CUST00207", detail)
            self.assertEqual(weekly["spent_eur_week"], 15.15)
            self.assertEqual(weekly["remaining_eur_week"], 84.85)
            self.assertEqual(weekly["daily_remaining_eur"], 21.21)
            self.assertEqual(weekly["over_budget_eur_week"], 0)
            self.assertEqual(runtime.weekly_spending("CUST00127", detail)["spent_eur_week"], 100)
            runtime.as_of = "2026-09-28"
            zero = runtime.weekly_spending("CUST00207", {**detail, "eur_week": 0})
            self.assertEqual(zero["spent_eur_week"], 1.01)
            self.assertEqual(zero["remaining_eur_week"], 0)
            self.assertEqual(zero["daily_remaining_eur"], 0)
            self.assertEqual(zero["over_budget_eur_week"], 1.01)
            self.assertEqual(zero["days_remaining_in_week"], 6)
            runtime.as_of = "2027-01-03"
            sunday = runtime.weekly_spending("CUST00207", detail)
            self.assertEqual((sunday["week_start"], sunday["week_end"]), ("2026-12-28", "2027-01-03"))
            self.assertEqual(sunday["spent_eur_week"], .30)
            self.assertEqual(sunday["days_remaining_in_week"], 0)
            self.assertIsNone(sunday["daily_remaining_eur"])
            with self.assertRaises(worker.RequestError):
                runtime.weekly_spending("CUST99999", detail)
        finally:
            runtime.close()

    def test_context_queries_only_selected_rows_and_contains_no_ids(self):
        for cid in worker.DEMO_CUSTOMERS:
            context = self.request("context", cid)
            self.assertEqual((context["coverage_from"], context["coverage_to"]), ("2024-10-01", "2026-09-30"))
            source = self.runtime.source(cid)
            for collection in (source.summary, source.lines, source.insights, source.spender):
                self.assertEqual(list(collection), [cid])
            self.assertNotRegex(context["profile"] + context["insight_context"], r"CUST\d+")
            self.assertLess(len(context["profile"]), 6000)
            self.assertLess(len(context["insight_context"]), 16000)
            self.assertIn("Group-level numbers, no individuals", context["insight_context"])
            self.assertIn("Snapshot data coverage: 2024-10-01 through 2026-09-30 inclusive", context["profile"])
            self.assertTrue(all(row["n_cust"] >= 10 for group in source.hyper.values() for row in group.values()))

    def test_exact_spending_reconciles_every_customer_month_with_ui_source(self):
        for profile in self.source["profiles"]:
            if profile["customer_id"] not in worker.DEMO_CUSTOMERS:
                continue
            for month in sorted({row["date"][:7] for row in profile["transactions"]}):
                year, number = map(int, month.split("-"))
                end = f"{year + (number == 12):04}-{number % 12 + 1:02}-01"
                args = {"start_date": month + "-01", "end_date": end}
                result = self.tool("get_spending", args, profile["customer_id"])
                rows = [r for r in profile["transactions"] if r["date"].startswith(month)]
                payments = [r for r in rows if r["category"] in worker.SPENDING_CATEGORIES and r["amount"] < 0]
                expected = sum((-Decimal(str(r["amount"])) for r in payments), Decimal(0))
                self.assertEqual(Decimal(result["total_eur"]), expected, (profile["customer_id"], month))
                self.assertEqual(result["payments"], len(payments))
                for scope, scoped in (("all", payments), ("discretionary", [row for row in payments if row["category"] in worker.PURCHASE_CATEGORIES])):
                    stats = result["patterns"][scope]
                    amounts = sorted(-Decimal(str(row["amount"])) for row in scoped)
                    total = sum(amounts, Decimal(0))
                    self.assertEqual(stats["payments"], len(scoped))
                    self.assertEqual(stats["active_days"], len({row["date"] for row in scoped}))
                    self.assertEqual(Decimal(stats["total_eur"]), total)
                    self.assertEqual(Decimal(stats["top_three_payments_eur"]), sum(amounts[-3:], Decimal(0)))
                    self.assertEqual(Decimal(stats["biggest_payment_eur"]), max(amounts, default=Decimal(0)))
                    self.assertEqual(stats["average_payment_eur"], str((total / len(amounts)).quantize(Decimal(".01"), rounding=ROUND_HALF_UP)) if amounts else None)
                    median = (amounts[(len(amounts) - 1) // 2] + amounts[len(amounts) // 2]) / 2 if amounts else None
                    self.assertEqual(stats["median_payment_eur"], str(median.quantize(Decimal(".01"), rounding=ROUND_HALF_UP)) if amounts else None)
                    for buckets in ("categories", "weekdays", "month_parts", "dayparts"):
                        self.assertEqual(sum(row["payments"] for row in stats[buckets]), len(scoped))
                        self.assertEqual(sum((Decimal(row["total_eur"]) for row in stats[buckets]), Decimal(0)), total)
                    self.assertEqual(sum(row["calendar_days"] for row in stats["weekdays"]),
                                     (worker.date.fromisoformat(end) - worker.date.fromisoformat(month + "-01")).days)
                    self.assertEqual(sum(row["calendar_days"] for row in stats["month_parts"]),
                                     sum(row["calendar_days"] for row in stats["weekdays"]))
                self.assertEqual({row["category"] for row in result["categories"]}, {row["category"] for row in payments})
                for category in result["categories"]:
                    amounts = [-Decimal(str(row["amount"])) for row in payments if row["category"] == category["category"]]
                    self.assertEqual(set(category), {"category", "payments", "total_eur", "biggest_payment_eur"})
                    self.assertEqual(category["payments"], len(amounts))
                    self.assertEqual(Decimal(category["total_eur"]), sum(amounts, Decimal(0)))
                    self.assertEqual(Decimal(category["biggest_payment_eur"]), max(amounts))
                cash = self.tool("get_cash_flow", args, profile["customer_id"])
                self.assertEqual(Decimal(cash["spending_eur"]), expected)
                self.assertEqual(Decimal(cash["net_account_flow_eur"]), sum((Decimal(str(r["amount"])) for r in rows), Decimal(0)))

    def spending_pattern_fixture(self):
        runtime = object.__new__(worker.CustomerRuntime)
        runtime.connection = worker.duckdb.connect(":memory:")
        self.addCleanup(runtime.close)
        runtime.cfg, runtime.groups = self.runtime.cfg, self.runtime.groups
        runtime.version, runtime.as_of = "test-patterns", "2024-12-31"
        runtime.coverage = {"first": "2024-01-01", "last": "2024-12-31"}
        runtime._tool_cache, runtime._observed_transactions = worker.OrderedDict(), {}
        runtime.connection.execute("""create table transactions(customer_id varchar, tx_date date,
            ts timestamp, category varchar, line varchar, tx_amount_eur decimal(18,2), merchant_id varchar)""")
        rows = [("CUST00207", day, day + " " + clock, category, line, amount, "PRIVATE_MERCHANT")
                for day, clock, category, line, amount in [
            ("2024-02-08", "23:59:59", "Restaurants", "restaurants", "-99.00"),
            ("2024-02-09", "00:00:00", "Restaurants", "restaurants", "-0.01"),
            ("2024-02-09", "05:59:59", "Restaurants", "restaurants", "-0.02"),
            ("2024-02-10", "06:00:00", "Restaurants", "restaurants", "-0.10"),
            ("2024-02-10", "11:59:59", "Lifestyle", "lifestyle", "-0.10"),
            ("2024-02-11", "12:00:00", "Entertainment", "entertainment", "-0.20"),
            ("2024-02-20", "17:59:59", "Travel", "travel", "-0.20"),
            ("2024-02-21", "18:00:00", "Groceries", "groceries", "-1.00"),
            ("2024-02-22", "23:59:59", "Housing", "housing", "-1.00"),
            ("2024-02-23", "00:00:01", "Restaurants", "restaurants", "-0.20"),
            ("2024-02-24", "00:00:00", "Restaurants", "restaurants", "-1000.00"),
            ("2024-02-10", "13:00:00", "Restaurants", "restaurants", "0.50"),
            ("2024-02-10", "13:00:00", "Restaurants", "restaurants", "0.00"),
            ("2024-02-10", "13:00:00", "Salary", "income", "200.00"),
            ("2024-02-10", "13:00:00", "Invest Deposit", "savings_transfer", "-300.00"),
            ("2024-02-10", "13:00:00", "Salary Sweep", "savings_transfer", "-400.00"),
            ("2024-02-10", "13:00:00", "Unknown", "shock", "-500.00"),
            ("2024-02-29", "23:59:59", "Travel", "travel", "-0.31"),
            ("2024-03-01", "00:00:00", "Groceries", "groceries", "-0.42"),
        ]]
        rows.append(("CUST00127", "2024-02-10", "2024-02-10 13:00:00", "Restaurants", "restaurants", "-600.00", "OTHER_MERCHANT"))
        runtime.connection.executemany("insert into transactions values (?, ?, ?, ?, ?, ?, ?)", rows)
        return runtime

    def test_spending_patterns_exact_scoped_counts_and_clock_boundaries(self):
        runtime = self.spending_pattern_fixture()
        period = {"start_date": "2024-02-09", "end_date": "2024-02-24"}
        result = runtime.execute("CUST00207", "get_spending", period)
        all_spend, optional = result["patterns"]["all"], result["patterns"]["discretionary"]
        self.assertEqual((all_spend["payments"], all_spend["active_days"], all_spend["timed_payments"]), (9, 7, 8))
        self.assertEqual((all_spend["total_eur"], all_spend["average_payment_eur"], all_spend["median_payment_eur"],
                          all_spend["biggest_payment_eur"], all_spend["top_three_payments_eur"]), ("2.83", "0.31", "0.20", "1.00", "2.20"))
        self.assertEqual((optional["payments"], optional["active_days"], optional["timed_payments"]), (7, 5, 6))
        self.assertEqual((optional["total_eur"], optional["average_payment_eur"], optional["median_payment_eur"],
                          optional["biggest_payment_eur"], optional["top_three_payments_eur"]), ("0.83", "0.12", "0.10", "0.20", "0.60"))
        self.assertEqual([(r["part"], r["payments"], r["total_eur"]) for r in all_spend["dayparts"]],
                         [("night", 3, "0.23"), ("morning", 2, "0.20"), ("afternoon", 2, "0.40"), ("evening", 2, "2.00")])
        self.assertEqual([(r["part"], r["calendar_days"], r["payments"]) for r in all_spend["month_parts"]],
                         [("early", 2, 4), ("middle", 10, 2), ("late", 3, 3)])
        self.assertEqual([(r["day"], r["calendar_days"], r["payments"]) for r in all_spend["weekdays"]],
                         [(1, 2, 0), (2, 2, 1), (3, 2, 1), (4, 2, 1), (5, 3, 3), (6, 2, 2), (7, 2, 1)])
        self.assertEqual(len(all_spend["categories"]), 10)
        self.assertEqual(len(optional["categories"]), 4)
        self.assertEqual(next(r for r in all_spend["categories"] if r["category"] == "Health")["total_eur"], "0.00")
        self.assertEqual(result["total_eur"], all_spend["total_eur"])
        self.assertEqual(result["payments"], all_spend["payments"])
        self.assertNotRegex(json.dumps(result["patterns"]), r"CUST\d+|MERCHANT|merchant_id")
        self.assertIn("not visits", result["patterns"]["scope_note"])
        self.assertIn("timezone is unspecified", result["patterns"]["scope_note"])
        other = runtime.execute("CUST00127", "get_spending", period)["patterns"]["all"]
        self.assertEqual((other["payments"], other["total_eur"]), (1, "600.00"))
        for filter_, total, optional_total in (({"category": "restaurants"}, "0.33", "0.33"),
                                               ({"line": "food"}, "1.33", "0.33"),
                                               ({"category": "Groceries"}, "1.00", "0.00")):
            filtered = runtime.execute("CUST00207", "get_spending", {**period, **filter_})
            self.assertEqual(filtered["patterns"]["all"]["total_eur"], total)
            self.assertEqual(filtered["patterns"]["all"]["payments"], filtered["payments"])
            self.assertEqual(filtered["patterns"]["discretionary"]["total_eur"], optional_total)

    def test_spending_patterns_round_half_up_empty_sparse_and_leap_calendar(self):
        runtime = self.spending_pattern_fixture()
        tiny = runtime.execute("CUST00207", "get_spending", {"start_date": "2024-02-09", "end_date": "2024-02-10"})["patterns"]["all"]
        self.assertEqual((tiny["total_eur"], tiny["average_payment_eur"], tiny["median_payment_eur"], tiny["top_three_payments_eur"]),
                         ("0.03", "0.02", "0.02", "0.03"))
        self.assertEqual(tiny["timed_payments"], 1)
        leap = runtime.execute("CUST00207", "get_spending", {"start_date": "2024-02-28", "end_date": "2024-03-02"})["patterns"]
        self.assertEqual(leap["all"]["total_eur"], "0.73")
        self.assertEqual(leap["all"]["average_payment_eur"], "0.37")
        self.assertEqual(leap["all"]["median_payment_eur"], "0.37")
        self.assertEqual([(r["part"], r["calendar_days"]) for r in leap["all"]["month_parts"]], [("early", 1), ("middle", 0), ("late", 2)])
        self.assertEqual([r["calendar_days"] for r in leap["all"]["weekdays"]], [0, 0, 1, 1, 1, 0, 0])
        self.assertEqual(leap["discretionary"]["payments"], 1)
        for key in ("total_eur", "average_payment_eur", "median_payment_eur", "biggest_payment_eur", "top_three_payments_eur"):
            self.assertEqual(leap["discretionary"][key], "0.31")
        midnight = runtime.execute("CUST00207", "get_spending", {"start_date": "2024-03-01", "end_date": "2024-03-02"})["patterns"]["all"]
        self.assertEqual((midnight["payments"], midnight["timed_payments"]), (1, 0))
        for args in ({"start_date": "2024-02-12", "end_date": "2024-02-13"},
                     {"start_date": "2024-02-09", "end_date": "2024-02-24", "category": "Health"}):
            result = runtime.execute("CUST00207", "get_spending", args)
            for scope in ("all", "discretionary"):
                empty = result["patterns"][scope]
                self.assertEqual((empty["payments"], empty["active_days"], empty["timed_payments"]), (0, 0, 0))
                self.assertIsNone(empty["average_payment_eur"])
                self.assertIsNone(empty["median_payment_eur"])
                for key in ("total_eur", "biggest_payment_eur", "top_three_payments_eur"):
                    self.assertEqual(empty[key], "0.00")
                for key in ("categories", "weekdays", "month_parts", "dayparts"):
                    self.assertTrue(all(r["payments"] == 0 and r["total_eur"] == "0.00" for r in empty[key]))
        with self.assertRaises(worker.RequestError):
            runtime.execute("CUST00207", "get_spending", {"start_date": "2024-01-01", "end_date": "2028-01-01"})

    def test_every_tool_rejects_customer_overrides_and_unknown_arguments(self):
        for tool in worker.TOOLS:
            name = tool["name"]
            self.assertNotIn("customer_id", tool["input_schema"]["properties"])
            self.assertFalse(tool["input_schema"]["additionalProperties"])
            with self.assertRaises(worker.RequestError):
                self.tool(name, {"customer_id": "CUST00127"})
        for cid in (None, "CUST04457", "CUST99999", "CUST00207' OR 1=1--"):
            with self.assertRaises(worker.RequestError):
                self.request("context", cid)
        with self.assertRaises(worker.RequestError):
            self.tool("query_sql", {"sql": "select * from transactions"})

    def test_tool_results_are_bounded_and_exact_and_filter_injection_is_literal(self):
        period = {"start_date": "2026-09-01", "end_date": "2026-10-01"}
        self.assertEqual(self.tool("get_spending", period)["total_eur"], "1653.22")
        cash = self.tool("get_cash_flow", period)
        self.assertEqual(cash["recorded_balance_eur"], "6890.29")
        self.assertEqual(cash["latest_balance_date"], "2026-09-29")
        # A successful exact query must still disclose missing historical coverage.
        for name in ("get_spending", "get_cash_flow", "get_transactions"):
            beyond = self.tool(name, {"start_date": "2026-10-01", "end_date": "2026-11-01"})
            self.assertTrue(beyond["outside_observed_range"])
            self.assertEqual(beyond["coverage"], {"first": "2024-10-01", "last": "2026-09-30"})
            self.assertEqual(beyond["observed_transactions"]["last"], "2026-09-29")
            self.assertTrue(beyond["outside_snapshot_range"])
            self.assertIn("not evidence of zero spending", beyond["coverage_note"])
            covered = self.tool(name, {"start_date": "2026-08-01", "end_date": "2026-09-01"})
            self.assertFalse(covered["outside_observed_range"])
            # All three September months and their last day are fully inside the snapshot,
            # even when the customer's latest transaction is September 26 or 29.
            for cid in worker.DEMO_CUSTOMERS:
                for dates in (period, {"start_date": "2026-09-30", "end_date": "2026-10-01"},
                              {"start_date": "2024-10-01", "end_date": "2024-10-02"}):
                    complete = self.tool(name, dates, cid)
                    self.assertFalse(complete["outside_snapshot_range"])
                    self.assertFalse(complete["outside_observed_range"])
                    self.assertEqual(complete["coverage"]["last"], "2026-09-30")
        injected = self.tool("get_transactions", {**period, "category": "x' OR 1=1--"})
        self.assertEqual(injected["transactions"], [])
        page = self.tool("get_transactions", {**period, "limit": 5})
        self.assertEqual(len(page["transactions"]), 5)
        self.assertEqual(page["next_offset"], 5)
        self.assertNotRegex(json.dumps(page), r"CUST\d+")
        for args in ({**period, "limit": 10000}, {**period, "offset": -1}, {**period, "limit": True},
                     {"start_date": "2026-09-31", "end_date": "2026-10-01"},
                     {"start_date": "2020-01-01", "end_date": "2026-10-01"}):
            with self.assertRaises(worker.RequestError):
                self.tool("get_transactions", args)

    def test_every_declared_spending_filter_works_and_invalid_filters_explain_repair(self):
        period = {"start_date": "2026-09-01", "end_date": "2026-10-01"}
        for cid in worker.DEMO_CUSTOMERS:
            rows = self.runtime.query("""select line, category, cast(-tx_amount_eur as decimal(18,2)) amount
                from transactions where customer_id = ? and tx_date >= ? and tx_date < ? and tx_amount_eur < 0""",
                [cid, period["start_date"], period["end_date"]])
            rows = [row for row in rows if row["category"] in worker.SPENDING_CATEGORIES]
            for line in worker.LINE_PROPERTY["enum"]:
                scoped = [row for row in rows if row["line"] in self.runtime.resolve_line(line)]
                expected = sum((Decimal(row["amount"]) for row in scoped), Decimal(0))
                actual = self.tool("get_spending", {**period, "line": line}, cid)
                self.assertEqual(Decimal(actual["total_eur"]), expected, (cid, line))
                self.assertEqual(sum(row["payments"] for row in actual["categories"]), len(scoped))
                for category in actual["categories"]:
                    amounts = [Decimal(row["amount"]) for row in scoped if row["category"] == category["category"]]
                    self.assertEqual(Decimal(category["biggest_payment_eur"]), max(amounts), (cid, line, category["category"]))
                self.assertTrue(self.tool("what_if", {"line": line, "cut_percent": 20}, cid)["model_estimate"])
                self.assertGreaterEqual(self.tool("compare_to_peers", {"line": line}, cid)["group_size"], 10)
            for category in worker.SPENDING_CATEGORIES:
                expected = sum((Decimal(row["amount"]) for row in rows if row["category"] == category), Decimal(0))
                actual = self.tool("get_spending", {**period, "category": category.lower()}, cid)
                self.assertEqual(Decimal(actual["total_eur"]), expected, (cid, category))
        for args, message in (({**period, "basket": "everyday"}, "Allowed fields"),
                              ({**period, "line": "everyday"}, "Use a declared value for line"),
                              ({**period, "line": "restaurants", "category": "Restaurants"}, "Select category or line")):
            with self.assertRaisesRegex(worker.RequestError, message):
                self.tool("get_spending", args)

    def test_modeled_tools_keep_dated_assumptions_and_peer_aggregates(self):
        safe = self.tool("safe_to_spend", {"purchase_eur": 100})
        self.assertTrue(safe["model_estimate"])
        self.assertTrue(safe["historical_snapshot"])
        self.assertEqual(Decimal(safe["modeled_weekly_room_after_purchase_eur"]), Decimal(safe["eur_week"]) - 100)
        scenario = self.tool("what_if", {"line": "dining_out", "cut_percent": 20})
        self.assertEqual(scenario["after_month_eur"] + scenario["saves_month_eur"], scenario["current_month_eur"])
        peers = self.tool("compare_to_peers", {"line": "restaurants"})
        self.assertGreaterEqual(peers["group_size"], 10)
        self.assertEqual(len(peers["lines"]), 1)
        self.assertNotRegex(json.dumps(peers), r"CUST\d+")

    def test_afford_uses_existing_calculator_with_the_runtime_snapshot(self):
        from BDA.engine import coach
        for cid in worker.DEMO_CUSTOMERS:
            for price, months in ((100, 1), (1500, 6), (20000, 12), (1000000, 60)):
                # The public BDA function and runtime must produce the same plan.
                with patch.object(coach, "_q", self.runtime.query_frame):
                    expected = coach.afford(cid, price, months)
                with patch.object(coach, "_q", side_effect=AssertionError("Wrong database connection")):
                    result = self.tool("afford", {"price_eur": price, "months": months}, cid)
                self.assertEqual({key: result[key] for key in expected}, expected)
                self.assertTrue(result["historical_snapshot"])
                self.assertTrue(result["model_estimate"])
                self.assertEqual(result["as_of"], self.runtime.as_of)
                self.assertNotRegex(json.dumps(result, allow_nan=False), r"CUST\d+")
                self.assertTrue(all(cut["line"] in worker.MODEL_CONFIG.DISCRETIONARY for cut in result["cuts"]))

    def test_afford_rejects_missing_invalid_and_customer_supplied_arguments(self):
        for arguments in ({}, {"price_eur": 500}, {"months": 6},
                          *({"price_eur": price, "months": 6} for price in (0, -1, 1000001, True, "500", float("nan"), float("inf"))),
                          *({"price_eur": 500, "months": months} for months in (0, 61, 1.5, True, "6")),
                          {"price_eur": 500, "months": 6, "customer_id": "CUST00127"}):
            with self.subTest(arguments=arguments), self.assertRaises(worker.RequestError):
                self.tool("afford", arguments)

    def test_purchase_plan_preserves_default_afford_result_and_grounds_tips_in_own_records(self):
        args = {"price_eur": 1500, "months": 6, "protected_categories": [], "reserved_monthly_eur": 0}
        for cid in worker.DEMO_CUSTOMERS:
            result = self.request("purchase_plan", cid, args)
            original = self.tool("afford", {"price_eur": 1500, "months": 6}, cid)
            for key, value in original.items():
                if key != "limitation":
                    self.assertEqual(result[key], value, (cid, key))
            self.assertEqual(result["tips_month"], "2026-09")
            self.assertLessEqual(len(result["tips"]), 3)
            self.assertEqual(len({tip["category"] for tip in result["tips"]}), len(result["tips"]))
            rows = self.runtime.query("""select category, line, tx_amount_eur from transactions
                where customer_id = ? and tx_date >= '2026-09-01' and tx_date < '2026-10-01'
                and tx_amount_eur < 0""", [cid])
            for tip in result["tips"]:
                self.assertIn(tip["category"], worker.PURCHASE_CATEGORIES)
                amounts = [-Decimal(str(row["tx_amount_eur"])).quantize(Decimal("0.01"), rounding=worker.ROUND_HALF_UP) for row in rows
                           if row["category"] == tip["category"] and row["line"] == tip["line"]]
                self.assertTrue(amounts)
                expected = (sum(amounts) / len(amounts)).quantize(Decimal("0.01"), rounding=worker.ROUND_HALF_UP)
                self.assertEqual(Decimal(str(tip["amount_eur"])), expected)
                self.assertGreater(tip["amount_eur"], 0)
                self.assertIn("siirrät summan tavoitteeseen", tip["text"])
            self.assertNotRegex(json.dumps(result, allow_nan=False), r"CUST\d+")
            self.assertEqual(self.request("purchase_plan", cid, args), result)

    def test_purchase_plan_protection_changes_feasibility_and_never_proposes_protected_cuts_or_tips(self):
        args = {"price_eur": 1500, "months": 6, "protected_categories": [], "reserved_monthly_eur": 0}
        original = self.request("purchase_plan", "CUST00127", args)
        self.assertTrue(any(cut["line"] == "restaurants" for cut in original["cuts"]))
        protected = self.request("purchase_plan", "CUST00127", {**args, "protected_categories": ["Restaurants"]})
        self.assertTrue(all(cut["line"] not in worker.PURCHASE_CATEGORIES["Restaurants"] for cut in protected["cuts"]))
        self.assertTrue(all(tip["category"] != "Restaurants" for tip in protected["tips"]))
        self.assertLess(protected["set_aside_month"], original["set_aside_month"])
        self.assertGreater(protected["months_needed"], original["months_needed"])
        for category, lines in worker.PURCHASE_CATEGORIES.items():
            plan = self.request("purchase_plan", "CUST00127", {**args, "price_eur": 20000, "protected_categories": [category]})
            self.assertTrue(all(cut["line"] not in lines for cut in plan["cuts"]))
            self.assertTrue(all(tip["category"] != category for tip in plan["tips"]))

    def test_purchase_plan_reserves_other_projects_capacity_and_cannot_reuse_current_cash(self):
        args = {"price_eur": 1500, "months": 6, "protected_categories": [], "reserved_monthly_eur": 0}
        original = self.request("purchase_plan", "CUST00127", args)
        reserved = self.request("purchase_plan", "CUST00127", {**args, "reserved_monthly_eur": 50})
        self.assertEqual(reserved["reserved_monthly_eur"], 50)
        self.assertLessEqual(reserved["can_set_aside_month"], original["can_set_aside_month"])
        self.assertLess(reserved["set_aside_month"], original["set_aside_month"])
        self.assertGreater(reserved["months_needed"], original["months_needed"])
        self.assertEqual(self.request("purchase_plan", "CUST00207", args)["verdict"], "already_affordable")
        self.assertNotEqual(self.request("purchase_plan", "CUST00207", {**args, "reserved_monthly_eur": 1})["verdict"], "already_affordable")
        impossible = self.request("purchase_plan", "CUST00127", {**args, "reserved_monthly_eur": 3000000})
        self.assertEqual(impossible["verdict"], "not_now")
        self.assertEqual(impossible["tips"], [])
        self.assertEqual(self.request("purchase_plan", "CUST00127", args), original, "Reservations must not mutate the model snapshot")

    def test_purchase_plan_rejects_unbounded_preferences_reservations_and_identity_overrides(self):
        args = {"price_eur": 1500, "months": 6, "protected_categories": [], "reserved_monthly_eur": 0}
        invalid = [{}, {key: value for key, value in args.items() if key != "protected_categories"},
                   {**args, "customer_id": "CUST00127"},
                   *({**args, "protected_categories": value} for value in (None, "Restaurants", ["Housing"], ["Restaurants", "Restaurants"], [{}], ["Travel"] * 5)),
                   *({**args, "reserved_monthly_eur": value} for value in (-1, 3000001, "50", True, None, float("nan"), float("inf"))),
                   {**args, "price_eur": 0}, {**args, "months": 1.5}]
        for value in invalid:
            with self.subTest(args=value), self.assertRaises(worker.RequestError):
                self.request("purchase_plan", args=value)
        with self.assertRaises(worker.RequestError):
            self.request("purchase_plan", "CUST99999", args)
        self.assertNotIn("purchase_plan", {tool["name"] for tool in self.request("tools")})

    def test_interleaved_customers_and_cached_requests_never_cross(self):
        period = {"start_date": "2026-09-01", "end_date": "2026-10-01"}
        expected = {cid: self.tool("get_spending", period, cid)["total_eur"] for cid in worker.DEMO_CUSTOMERS}
        jobs = list(worker.DEMO_CUSTOMERS) * 15
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            actual = list(executor.map(lambda cid: self.tool("get_spending", period, cid)["total_eur"], jobs))
        self.assertEqual(actual, [expected[cid] for cid in jobs])
        self.assertEqual(len(set(expected.values())), 3)
        for cid in worker.DEMO_CUSTOMERS:
            before = self.request("context", cid)
            after = self.request("context", cid)
            self.assertEqual(before, after)

    def test_database_is_read_only_and_cache_version_is_content_hash(self):
        with self.assertRaises(duckdb_error()):
            self.runtime.connection.execute("create table should_not_exist(a integer)")
        self.assertRegex(self.runtime.version, r"^[0-9a-f]{64}$")

    def test_stdio_protocol_keeps_errors_safe_and_process_alive(self):
        requests = [
            {"id": "ready", "operation": "ready"},
            {"id": "bad", "operation": "context", "customer_id": "CUST99999"},
            {"id": "good", "operation": "context", "customer_id": "CUST00103"},
            {"id": "filter", "operation": "tool", "customer_id": "CUST00207", "args": {
                "name": "get_spending", "arguments": {"start_date": "2026-09-01", "end_date": "2026-10-01", "basket": "secret-untrusted-value"}}},
        ]
        proc = subprocess.run([sys.executable, str(HERE / "worker.py")], input="\n".join(map(json.dumps, requests)) + "\n",
                              text=True, encoding="utf-8", capture_output=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        responses = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual([row["id"] for row in responses], ["ready", "bad", "good", "filter"])
        self.assertEqual(responses[0]["result"]["coverage_from"], "2024-10-01")
        self.assertEqual(responses[0]["result"]["coverage_to"], "2026-09-30")
        self.assertEqual(responses[1]["error"]["code"], "invalid_request")
        self.assertNotIn("CUST99999", proc.stdout)
        self.assertIn("profile", responses[2]["result"])
        self.assertEqual(responses[3]["error"]["code"], "invalid_request")
        self.assertIn("Allowed fields: start_date, end_date, category, line", responses[3]["error"]["message"])
        self.assertNotIn("secret-untrusted-value", proc.stdout)


def duckdb_error():
    return worker.duckdb.Error


if __name__ == "__main__":
    unittest.main()
