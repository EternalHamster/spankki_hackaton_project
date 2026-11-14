"""Private, persistent JSON-lines bridge from Node to the read-only coach snapshot.

Protocol: {id, operation, customer_id?, args?} -> {id, result} or {id, error}.
Only Node supplies customer_id, resolved from its signed session. This process never listens on a port.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import threading
from collections import OrderedDict
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from types import SimpleNamespace

import duckdb

CODE_ROOT = Path(os.getenv("COACH_CODE_ROOT", Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(CODE_ROOT))
from coach_context.profile_card import _load_bda_config, build_profile_card, render_profile_card, nice, nice_down
from coach_context.insight_context import build_insight_context, render_insight_context
from BDA.engine.coach import _afford

DEMO_CUSTOMERS = ("CUST00207", "CUST00127", "CUST00103")
SPENDING_CATEGORIES = ("Housing", "Utilities", "Groceries", "Health", "Home & Tech", "Transportation",
                       "Restaurants", "Lifestyle", "Entertainment", "Travel")
GROUPS = {
    "dining_out": ("restaurants", "fast_food", "bars"),
    "transport": ("public_transport", "fuel", "taxi", "parking", "transport_other"),
    "food": ("groceries", "restaurants", "fast_food", "bars"),
    "fixed_bills": ("housing", "utilities"),
}
MODEL_CONFIG = _load_bda_config()
# Large optional purchases share a model line across these three bank categories.
# Protecting any of them therefore excludes that pooled line conservatively.
PURCHASE_CATEGORIES = {
    "Restaurants": ("restaurants", "fast_food", "bars"),
    "Lifestyle": ("lifestyle", "big_purchase"),
    "Entertainment": ("entertainment", "big_purchase"),
    "Travel": ("travel", "big_purchase"),
}
PURCHASE_TIP_LABELS = {
    "Restaurants": ("Ravintolat ja kahvilat", "ravintolaostoksen"),
    "Lifestyle": ("Ostokset", "harkinnanvaraisen ostoksen"),
    "Entertainment": ("Vapaa-aika", "vapaa-ajan ostoksen"),
    "Travel": ("Matkailu", "matkailuun liittyvän ostoksen"),
}
DATE_PROPERTIES = {
    "start_date": {"type": "string", "description": "First included day, YYYY-MM-DD, from the historical snapshot."},
    "end_date": {"type": "string", "description": "Exclusive upper bound, YYYY-MM-DD: September ends at October 1."},
}
LINE_PROPERTY = {"type": "string", "enum": list(MODEL_CONFIG.LINES) + list(GROUPS) + ["extras", "essentials"],
                 "description": "Optional specific model line or group. For total consumer spending (Finnish 'arjen menot'), omit line and category. There is no everyday or basket filter."}


def definition(name, description, properties=None, required=()):
    return {"name": name, "description": description, "input_schema": {
        "type": "object", "properties": properties or {}, "required": list(required), "additionalProperties": False}}


TOOLS = [
    definition("get_spending", "Exact historical consumer spending total, payment count, largest payment and category totals. With no filter, includes all ten consumer categories (Finnish 'arjen menot'), excluding investment flows. Omit category and line for that total; no basket argument exists. For both income and spending, use one get_cash_flow call.",
               {**DATE_PROPERTIES, "category": {"type": "string", "description": "Optional bank category, e.g. Restaurants, Groceries or Home & Tech. Do not combine with line."}, "line": LINE_PROPERTY}, DATE_PROPERTIES),
    definition("get_cash_flow", "Exact historical income, spending, investment movements, net cash flow and latest recorded account balance before the period's end. spending_eur is total consumer spending (Finnish 'arjen menot') across all ten consumer categories, excluding investment flows. One call answers both income and spending. Separates remaining income from account balance.", DATE_PROPERTIES, DATE_PROPERTIES),
    definition("get_transactions", "Up to 20 of this customer's original transactions in a period, newest first. Use only when individual purchases are needed. Paginate with offset; never infer totals from a page.",
               {**DATE_PROPERTIES, "category": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}, "offset": {"type": "integer", "minimum": 0, "maximum": 2000}}, DATE_PROPERTIES),
    definition("safe_to_spend", "Dated BDA model estimate of weekly room for extras, its limiting factors, next payday, safe saving and surprise-fund target. Optional purchase amount is compared by code with the modeled weekly budget; this is not a live-bank affordability guarantee.",
               {"purchase_eur": {"type": "number", "exclusiveMinimum": 0, "maximum": 1000000}}),
    definition("afford", "Plan a purchase costing price_eur over months (1–60). Use for 'can I afford X in Y months?' and purchase goals, not the weekly safe_to_spend check. Returns a verdict, required monthly saving, money redirected from existing savings, specific optional spending cuts, and an alternative timeline. Ask for a missing price or timeframe before calling. This is a scenario based on the dated snapshot, not a live balance or a guarantee.",
               {"price_eur": {"type": "number", "exclusiveMinimum": 0, "maximum": 1000000},
                "months": {"type": "integer", "minimum": 1, "maximum": 60}}, ("price_eur", "months")),
    definition("what_if", "Model-based savings scenario for reducing a spending line or group. Backend calculates monthly/yearly effects; figures are estimates, not forecasts or transfers.",
               {"line": LINE_PROPERTY, "cut_percent": {"type": "number", "exclusiveMinimum": 0, "maximum": 100}}, ("line", "cut_percent")),
    definition("compare_to_peers", "Own modeled spending versus group medians and national aggregates. Explains frequency versus payment size. No individual peer data.", {"line": LINE_PROPERTY}, ("line",)),
    definition("get_model_detail", "Retrieve this customer's dated model assumptions or ranked insight evidence. For exact period totals use get_spending or get_cash_flow.",
               {"topic": {"type": "string", "enum": ["income", "saving", "spending", "insights", "spender_type"]}}, ("topic",)),
]
TOOL_SCHEMAS = {tool["name"]: tool["input_schema"] for tool in TOOLS}


class RequestError(ValueError):
    pass


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def money(value):
    return str(Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def validate_arguments(name, arguments):
    schema = TOOL_SCHEMAS.get(name)
    if schema is None or not isinstance(arguments, dict):
        raise RequestError("Unknown tool or invalid arguments")
    properties = schema["properties"]
    if set(arguments) - properties.keys() or set(schema["required"]) - arguments.keys():
        raise RequestError("Allowed fields: " + ", ".join(properties) + ". Required fields: " + ", ".join(schema["required"]) + ". Never provide customer identifiers.")
    for key, value in arguments.items():
        spec = properties[key]
        if spec["type"] == "string":
            if not isinstance(value, str) or not value.strip() or len(value) > 120:
                raise RequestError("Invalid text argument")
        elif spec["type"] == "integer":
            if type(value) is not int:
                raise RequestError("Expected an integer")
        elif spec["type"] == "number":
            if type(value) not in (int, float) or not math.isfinite(value):
                raise RequestError("Expected a finite number")
        if "enum" in spec and value not in spec["enum"]:
            raise RequestError("Use a declared value for " + key + ": " + ", ".join(spec["enum"]))
        if "minimum" in spec and value < spec["minimum"] or "maximum" in spec and value > spec["maximum"]:
            raise RequestError("Argument outside allowed bounds")
        if "exclusiveMinimum" in spec and value <= spec["exclusiveMinimum"]:
            raise RequestError("Argument must be positive")


class CustomerRuntime:
    def __init__(self, database=None):
        self.path = Path(database or os.getenv("COACH_DB_PATH", CODE_ROOT / "BDA/output/coach.duckdb")).resolve()
        self.connection = duckdb.connect(str(self.path), read_only=True, config={"threads": 2, "memory_limit": "256MB"})
        self.lock = threading.RLock()
        self.cfg = MODEL_CONFIG
        self.groups = {**GROUPS, "extras": tuple(self.cfg.DISCRETIONARY), "essentials": tuple(self.cfg.ESSENTIAL_EVERYDAY)}
        self.version = os.getenv("COACH_SNAPSHOT_VERSION") or self._file_digest()
        metadata = self.query("select first_month, as_of from meta")[0]
        self.as_of = metadata["as_of"][:10]
        # Coverage is a property of the snapshot, not the last day this customer made a payment.
        self.coverage = {"first": metadata["first_month"][:10], "last": self.as_of}
        self._observed_transactions = {}
        self._summary = None
        self._sources = {}
        self._contexts = {}
        self._bootstraps = {}
        self._tool_cache = OrderedDict()
        # Fail startup rather than silently serving the wrong/missing database schema.
        for table in ("customers", "transactions", "customer_summary", "customer_line", "insights", "spender_type", "model_hyper", "model_season"):
            self.connection.execute(f"select * from {table} limit 0")

    def _file_digest(self):
        digest = hashlib.sha256()
        with self.path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    def close(self):
        self.connection.close()

    def query(self, sql, parameters=()):
        cursor = self.connection.cursor()
        try:
            cursor.execute(sql, parameters)
            names = [item[0] for item in cursor.description]
            return [clean(dict(zip(names, row))) for row in cursor.fetchall()]
        finally:
            cursor.close()

    def query_frame(self, sql, parameters=()):
        """BDA calculations use this runtime's read-only snapshot and customer-bound query parameters."""
        cursor = self.connection.cursor()
        try:
            return cursor.execute(sql, parameters).df()
        finally:
            cursor.close()

    @staticmethod
    def customer(customer_id):
        if customer_id not in DEMO_CUSTOMERS:
            raise RequestError("Unknown demo customer")
        return customer_id

    def source(self, customer_id):
        cid = self.customer(customer_id)
        if cid not in self._sources:
            summary = self.query("select * from customer_summary where customer_id = ?", [cid])
            if len(summary) != 1:
                raise RequestError("Customer snapshot unavailable")
            # All dictionaries contain exactly this customer's rows. No process-wide all-customer CSV data.
            s = summary[0]
            peers = self.query("select * from model_hyper where peer_group = ? and n_cust >= 10", [s["peer_group"]])
            self._sources[cid] = SimpleNamespace(
                labels={key: value[2] for key, value in self.cfg.LINES.items()},
                essential={key for key, value in self.cfg.LINES.items() if value[1]},
                peer_min_ratio=self.cfg.PEER_MIN_RATIO, peer_min_eur=self.cfg.PEER_MIN_EUR,
                summary={cid: s}, lines={cid: self.query("select * from customer_line where customer_id = ? order by line", [cid])},
                insights={cid: self.query("select * from insights where customer_id = ? order by rank", [cid])},
                spender={cid: self.query("select * from spender_type where customer_id = ?", [cid])[0]},
                hyper={s["peer_group"]: {row["line"]: row for row in peers}})
        return self._sources[cid]

    def context(self, customer_id):
        cid = self.customer(customer_id)
        if cid not in self._contexts:
            source = self.source(cid)
            profile = render_profile_card(build_profile_card(cid, source))
            details = render_insight_context(build_insight_context(cid, source))
            # Avoid wording that could be mistaken for a live-bank balance in this dated demo.
            profile = profile.replace("Account balance now:", "Recorded account balance at snapshot date:")
            profile = (f"Snapshot data coverage: {self.coverage['first']} through {self.coverage['last']} inclusive. "
                       "A day without transactions inside this period is not missing coverage.\n" + profile)
            details = details.replace("Account balance now:", "Recorded account balance at snapshot date:")
            if re.search(r"CUST\d+", profile + details):
                raise RequestError("Unexpected identifier in model context")
            self._contexts[cid] = {"profile": profile, "insight_context": details, "as_of": self.as_of, "version": self.version,
                                   "coverage_from": self.coverage["first"], "coverage_to": self.coverage["last"]}
        return self._contexts[cid]

    def bootstrap(self, customer_id):
        cid = self.customer(customer_id)
        if cid not in self._bootstraps:
            if self._summary is None:
                self._summary = self.query("select count(*) count, min(tx_date) as \"from\", max(tx_date) as \"to\" from transactions")[0]
                self._summary["customerCount"] = self.query("select count(*) n from customers")[0]["n"]
                self._summary["categories"] = {row["category"]: row["n"] for row in self.query("select category, count(*) n from transactions group by category")}
                self._summary["types"] = {row["transaction_type"]: row["n"] for row in self.query("select transaction_type, count(*) n from transactions group by transaction_type")}
            rows = self.query("select customer_id, customer_postal_code, customer_age from customers where customer_id = ?", [cid])
            if len(rows) != 1:
                raise RequestError("Customer snapshot unavailable")
            profile = rows[0]
            profile["customer_age"] = str(profile["customer_age"])
            profile["transactions"] = self.query("""select cast(tx_date as varchar) as date,
                strftime(ts, '%H:%M:%S') as time, category, tx_amount_eur as amount, balance_after_eur as balance,
                transaction_type as type, coalesce(merchant_id,'') as merchant, coalesce(mcc_code,'') as mcc, bank_account_id as account
                from transactions where customer_id = ? order by tx_date, ts""", [cid])
            # Browser calculations expect numeric amounts, while tool results use exact decimal strings.
            for row in profile["transactions"]:
                row["amount"], row["balance"] = float(row["amount"]), float(row["balance"])
            weekly = build_insight_context(cid, self.source(cid))["safe_to_spend_detail"]
            self._bootstraps[cid] = {"summary": self._summary, "profiles": [profile], "as_of": self.as_of, "version": self.version,
                                     "weekly_spending": {key: weekly[key] for key in ("eur_week", "usual_extras_eur_week")}}
        return self._bootstraps[cid]

    def period(self, arguments):
        try:
            values = [arguments[key] for key in ("start_date", "end_date")]
            if any(not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) for value in values):
                raise ValueError()
            start, end = map(date.fromisoformat, values)
            if not 0 < (end - start).days <= 1096:
                raise ValueError()
            return start, end
        except (ValueError, KeyError, TypeError):
            raise RequestError("Use a valid date range of 1 to 1096 days, with an exclusive end date") from None

    def resolve_line(self, line):
        if line in self.cfg.LINES:
            return [line]
        if line in self.groups:
            return list(self.groups[line])
        raise RequestError("Unknown spending line")

    def _where(self, cid, arguments, spending=False):
        start, end = self.period(arguments)
        parts, params = ["customer_id = ?", "tx_date >= ?", "tx_date < ?"], [cid, start, end]
        if spending:
            parts += ["tx_amount_eur < 0", "category in (" + ",".join("?" for _ in SPENDING_CATEGORIES) + ")"]
            params += list(SPENDING_CATEGORIES)
        if arguments.get("category") and arguments.get("line"):
            raise RequestError("Select category or line, not both")
        if arguments.get("category"):
            parts.append("lower(category) = lower(?)")
            params.append(arguments["category"])
        if arguments.get("line"):
            lines = self.resolve_line(arguments["line"])
            parts.append("line in (" + ",".join("?" for _ in lines) + ")")
            params += lines
        return " and ".join(parts), params, start, end

    def execute(self, cid, name, args):
        self.customer(cid)
        validate_arguments(name, args)
        key = (self.version, cid, name, json.dumps(args, sort_keys=True))
        if key in self._tool_cache:
            self._tool_cache.move_to_end(key)
            return self._tool_cache[key]
        result = self._execute(cid, name, args)
        result.update(as_of=self.as_of, data_version=self.version, historical_snapshot=True)
        if re.search(r"CUST\d+", json.dumps(result)):
            raise RequestError("Unexpected identifier in tool result")
        self._tool_cache[key] = result
        if len(self._tool_cache) > 256:
            self._tool_cache.popitem(last=False)
        return result

    def purchase_plan(self, cid, args):
        """Internal project proposal: a constrained plan plus dated optional-purchase examples."""
        required = {"price_eur", "months", "protected_categories", "reserved_monthly_eur"}
        if set(args) != required:
            raise RequestError("Purchase plan requires price_eur, months, protected_categories and reserved_monthly_eur only")
        validate_arguments("afford", {key: args[key] for key in ("price_eur", "months")})
        protected = args["protected_categories"]
        reserved = args["reserved_monthly_eur"]
        if not isinstance(protected, list) or len(protected) > len(PURCHASE_CATEGORIES) or any(
                not isinstance(category, str) or category not in PURCHASE_CATEGORIES for category in protected) or len(set(protected)) != len(protected):
            raise RequestError("Use each supported optional category at most once")
        if type(reserved) not in (int, float) or not math.isfinite(reserved) or not 0 <= reserved <= 3_000_000:
            raise RequestError("reserved_monthly_eur must be a nonnegative finite amount up to 3000000")
        protected_lines = {line for category in protected for line in PURCHASE_CATEGORIES[category]}
        if not protected_lines.issubset(self.cfg.DISCRETIONARY):
            raise RequestError("Purchase category mapping is unavailable")
        result = _afford(cid, args["price_eur"], args["months"], query=self.query_frame,
                         protected_lines=protected_lines, reserved_monthly_eur=reserved)
        snapshot = date.fromisoformat(self.as_of)
        end = snapshot + timedelta(days=1) if (snapshot + timedelta(days=1)).day == 1 else snapshot.replace(day=1)
        start = (end - timedelta(days=1)).replace(day=1)
        tips = []
        if result["verdict"] != "not_now" and start >= date.fromisoformat(self.coverage["first"]):
            rows = self.query("""select category, line, count(*) payments,
                sum(cast(-tx_amount_eur as decimal(18,2))) total_eur
                from transactions where customer_id = ? and tx_date >= ? and tx_date < ? and tx_amount_eur < 0
                and category in ('Restaurants', 'Lifestyle', 'Entertainment', 'Travel')
                group by category, line order by total_eur desc, category, line""", [cid, start, end])
            seen = set(protected)
            for row in rows:
                category = row["category"]
                if category in seen or row["line"] not in self.cfg.DISCRETIONARY or row["payments"] <= 0:
                    continue
                amount = Decimal(row["total_eur"]) / Decimal(row["payments"])
                amount = amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                if amount <= 0:
                    continue
                label, purchase = PURCHASE_TIP_LABELS[category]
                tips.append({"category": category, "line": row["line"], "label": label,
                             "amount_eur": float(amount),
                             "text": f"Jos jätät yhden {purchase} väliin ja siirrät summan tavoitteeseen, etenet nopeammin."})
                seen.add(category)
                if len(tips) == 3:
                    break
        result.update(tips=tips, tips_month=start.strftime("%Y-%m"), protected_categories=list(protected),
                      reserved_monthly_eur=float(reserved), model_estimate=True, historical_snapshot=True,
                      as_of=self.as_of, data_version=self.version,
                      limitation="Scenario based on the historical snapshot, with protected spending and other projects' monthly reservations. No money has been saved or transferred automatically.")
        if re.search(r"CUST\d+", json.dumps(result, allow_nan=False)):
            raise RequestError("Unexpected identifier in purchase plan")
        return result

    def _execute(self, cid, name, args):
        if name == "afford":
            return {**_afford(cid, **args, query=self.query_frame), "model_estimate": True,
                    "limitation": "Scenario starting at the historical snapshot, not today's available money. Income, bills and other purchases may have changed."}
        if name in ("get_spending", "get_transactions", "get_cash_flow"):
            where, params, start, end = self._where(cid, args, spending=name == "get_spending")
            if cid not in self._observed_transactions:
                self._observed_transactions[cid] = self.query("select min(tx_date) first, max(tx_date) last from transactions where customer_id = ?", [cid])[0]
            outside = start.isoformat() < self.coverage["first"] or (end - timedelta(days=1)).isoformat() > self.coverage["last"]
            result = {"from": start.isoformat(), "to_exclusive": end.isoformat(), "coverage": self.coverage,
                      "observed_transactions": self._observed_transactions[cid],
                      "outside_snapshot_range": outside,
                      # Retain the original protocol field as an alias, now correctly based on snapshot coverage.
                      "outside_observed_range": outside,
                      "coverage_note": "Coverage comes from the dataset snapshot metadata. Days without transactions inside this coverage have no recorded activity; they are not missing data. Observed transaction endpoints are not coverage limits."
                      + (" The requested range extends outside the snapshot; absent data outside its coverage is not evidence of zero spending." if outside else "")}
            if name == "get_spending":
                result.update(self.query(f"""select count(*) payments,
                    coalesce(sum(cast(-tx_amount_eur as decimal(18,2))),0) total_eur,
                    coalesce(max(cast(-tx_amount_eur as decimal(18,2))),0) biggest_payment_eur
                    from transactions where {where}""", params)[0])
                result["categories"] = self.query(f"""select category, count(*) payments,
                    sum(cast(-tx_amount_eur as decimal(18,2))) total_eur
                    from transactions where {where} group by category order by total_eur desc""", params)
                result["months"] = self.query(f"""select strftime(tx_date,'%Y-%m') as "month", count(*) payments,
                    sum(cast(-tx_amount_eur as decimal(18,2))) total_eur
                    from transactions where {where} group by 1 order by 1""", params)
            elif name == "get_transactions":
                limit, offset = args.get("limit", 10), args.get("offset", 0)
                result["total_matches"] = self.query(f"select count(*) n from transactions where {where}", params)[0]["n"]
                result["transactions"] = self.query(f"""select cast(tx_date as varchar) date, strftime(ts,'%H:%M:%S') time,
                    category, cast(tx_amount_eur as decimal(18,2)) amount_eur,
                    cast(balance_after_eur as decimal(18,2)) balance_after_eur, merchant_id merchant_code
                    from transactions where {where} order by ts desc, category, tx_amount_eur limit ? offset ?""", params + [limit, offset])
                result["next_offset"] = offset + limit if offset + limit < result["total_matches"] else None
            else:
                cats = ",".join("?" for _ in SPENDING_CATEGORIES)
                result.update(self.query(f"""select
                    coalesce(sum(cast(tx_amount_eur as decimal(18,2))) filter (where category in ('Salary','Other Income') and tx_amount_eur >= 0),0) income_eur,
                    coalesce(sum(cast(-tx_amount_eur as decimal(18,2))) filter (where category in ({cats}) and tx_amount_eur < 0),0) spending_eur,
                    coalesce(sum(cast(-tx_amount_eur as decimal(18,2))) filter (where category in ('Invest Deposit','Salary Sweep')),0) investment_out_eur,
                    coalesce(sum(cast(tx_amount_eur as decimal(18,2))) filter (where category='Invest Withdraw'),0) investment_in_eur,
                    coalesce(sum(cast(tx_amount_eur as decimal(18,2))),0) net_account_flow_eur
                    from transactions where {where}""", list(SPENDING_CATEGORIES) + params)[0])
                result["remaining_income_eur"] = money(Decimal(result["income_eur"]) - Decimal(result["spending_eur"]))
                balance = self.query("""select sum(cast(balance_after_eur as decimal(18,2))) recorded_balance_eur,
                    max(tx_date) latest_balance_date from (
                      select balance_after_eur, tx_date, row_number() over (partition by bank_account_id order by ts desc) rn
                      from transactions where customer_id = ? and tx_date < ?
                    ) where rn = 1""", [cid, end])[0]
                result.update(balance)
            return result

        source = self.source(cid)
        card = build_profile_card(cid, source)
        if name == "get_model_detail":
            return {"model_estimate": True, "topic": args["topic"], "detail": card[args["topic"]]}
        if name == "safe_to_spend":
            detail = build_insight_context(cid, source)["safe_to_spend_detail"]
            result = {"model_estimate": True, **detail,
                      "next_payday": card["income"]["next_payday"], "recorded_balance_eur": card["balance_eur"],
                      "safe_to_save_eur_month": card["safe_to_save_eur_month"],
                      "surprise_fund_target_eur": card["surprise_fund_target_eur"],
                      "limitation": "Historical model estimate, not a live-bank affordability guarantee. Other purchases and bills since the snapshot are unknown."}
            if "purchase_eur" in args:
                purchase = Decimal(str(args["purchase_eur"]))
                result.update(purchase_eur=money(purchase), fits_modeled_weekly_budget=purchase <= detail["eur_week"],
                              modeled_weekly_room_after_purchase_eur=money(Decimal(detail["eur_week"]) - purchase))
            return result
        lines = self.resolve_line(args["line"])
        if name == "compare_to_peers":
            context = build_insight_context(cid, source)
            if context["peer_group"]["people"] < 10:
                return {"status": "insufficient_group_size"}
            return {"model_estimate": True, "group_size": context["peer_group"]["people"],
                    "group": context["peer_group"]["name"], "lines": [row for row in context["lines"] if row["line"] in lines]}
        if name == "what_if":
            before = nice(sum(float(row["expected_month"]) for row in source.lines[cid] if row["line"] in lines))
            saves = nice(before * args["cut_percent"] / 100)
            left = nice(float(source.summary[cid]["net_12m"]))
            return {"model_estimate": True, "line": args["line"], "cut_percent": args["cut_percent"],
                    "current_month_eur": before, "after_month_eur": before - saves,
                    "saves_month_eur": saves, "saves_year_eur": saves * 12,
                    "remaining_month_before_eur": left, "remaining_month_after_eur": left + saves,
                    "essential": all(line in source.essential for line in lines),
                    "limitation": "Scenario at modeled usual spending levels; not a forecast or transfer. Do not suggest cutting essentials."}
        raise RequestError("Unknown tool")

    def dispatch(self, request):
        if not isinstance(request, dict) or set(request) - {"id", "operation", "customer_id", "args"}:
            raise RequestError("Invalid request")
        operation, args = request.get("operation"), request.get("args", {})
        if not isinstance(args, dict):
            raise RequestError("Invalid arguments")
        with self.lock:
            if operation == "ready":
                if args:
                    raise RequestError("Unexpected arguments")
                return {"status": "ready", "as_of": self.as_of, "version": self.version, "customers": list(DEMO_CUSTOMERS),
                        "coverage_from": self.coverage["first"], "coverage_to": self.coverage["last"]}
            if operation == "tools":
                if args:
                    raise RequestError("Unexpected arguments")
                return TOOLS
            cid = self.customer(request.get("customer_id"))
            if operation in ("context", "bootstrap"):
                if args:
                    raise RequestError("Unexpected arguments")
                return getattr(self, operation)(cid)
            if operation == "tool" and set(args) == {"name", "arguments"}:
                return self.execute(cid, args["name"], args["arguments"])
            if operation == "purchase_plan":
                return self.purchase_plan(cid, args)
            raise RequestError("Unknown operation")


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    runtime = CustomerRuntime()
    for line in sys.stdin:
        request_id = None
        try:
            if len(line.encode("utf-8")) > 32768:
                raise RequestError("Request is too large")
            request = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid number")))
            request_id = request.get("id") if isinstance(request, dict) else None
            if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
                raise RequestError("A request id is required")
            result = runtime.dispatch(request)
            response = {"id": request_id, "result": result}
        except RequestError as error:
            # RequestError messages are controlled validation text, never raw request values or SQL errors.
            response = {"id": request_id, "error": {"code": "invalid_request", "message": str(error)}}
        except (ValueError, TypeError):
            response = {"id": request_id, "error": {"code": "invalid_request", "message": "Use the declared operation and arguments for the selected demo customer."}}
        except Exception:
            response = {"id": request_id, "error": {"code": "unavailable", "message": "Customer data is temporarily unavailable."}}
        print(json.dumps(clean(response), ensure_ascii=False, separators=(",", ":"), allow_nan=False), flush=True)
    runtime.close()


if __name__ == "__main__":
    main()
