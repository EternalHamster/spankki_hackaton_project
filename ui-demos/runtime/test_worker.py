"""Integration checks against the immutable synthetic DuckDB snapshot; no model calls."""
import concurrent.futures
import importlib.util
import json
import subprocess
import sys
import unittest
from unittest.mock import patch
from decimal import Decimal
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
            for other in worker.DEMO_CUSTOMERS:
                if other != cid:
                    self.assertNotIn(other, json.dumps(actual))

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
                expected = sum((-Decimal(str(r["amount"])) for r in rows if r["category"] in worker.SPENDING_CATEGORIES and r["amount"] < 0), Decimal(0))
                self.assertEqual(Decimal(result["total_eur"]), expected, (profile["customer_id"], month))
                cash = self.tool("get_cash_flow", args, profile["customer_id"])
                self.assertEqual(Decimal(cash["spending_eur"]), expected)
                self.assertEqual(Decimal(cash["net_account_flow_eur"]), sum((Decimal(str(r["amount"])) for r in rows), Decimal(0)))

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
                expected = sum((Decimal(row["amount"]) for row in rows if row["line"] in self.runtime.resolve_line(line)), Decimal(0))
                actual = self.tool("get_spending", {**period, "line": line}, cid)
                self.assertEqual(Decimal(actual["total_eur"]), expected, (cid, line))
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
