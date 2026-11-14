import json
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .repository import FinanceRepository


class NoArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Period(NoArgs):
    start_date: date
    end_date: date = Field(description="Exclusive upper bound; October ends at November 1")
    category: str | None = Field(default=None, min_length=1, max_length=120)

    @model_validator(mode="after")
    def valid_range(self):
        if not 0 < (self.end_date - self.start_date).days <= 366:
            raise ValueError("Period must be positive and no longer than 366 days")
        return self


class Savings(Period):
    reduction_percent: int = Field(ge=0, le=100, strict=True)
    category: str = Field(min_length=1, max_length=120)


SCHEMAS = {
    "get_data_context": (NoArgs, "Get this customer's available categories, historical date coverage and capabilities. Use before financial lookups. Missing coverage is not zero spending. Dates are historical, never live."),
    "get_spending": (Period, "Get gross outgoing spending and category totals for a date range. The end date is exclusive. Transfers and refunds are excluded; amounts are EUR decimal strings. No raw transactions or customer identifiers are returned."),
    "get_three_baskets": (Period, "Group historical expenditure into three illustrative pedagogical baskets. Categories use operator-defined rules, not facts about a customer's needs. Unclassified spending remains explicit. End date is exclusive."),
    "simulate_savings": (Savings, "Calculate savings from reducing one category by an integer percentage. This is a historical scenario for the requested period, not a forecast or transfer. Python calculates money exactly. End date is exclusive."),
    "calculate_safe_to_spend": (NoArgs, "Check whether a safe-to-spend estimate is available. This baseline has no trusted live balances, confirmed bills or reserves. It returns missing inputs and no amount; never infer affordability from historical income or spending."),
}


def definitions():
    return [{"name": name, "description": description, "input_schema": schema.model_json_schema()}
            for name, (schema, description) in SCHEMAS.items()]


class FinanceTools:
    def __init__(self, repository: FinanceRepository, customer_id: str):
        self.repository, self.customer_id = repository, customer_id

    def execute(self, name: str, arguments: dict) -> dict:
        if name not in SCHEMAS:
            return {"error": "unknown_tool"}
        try:
            args = SCHEMAS[name][0].model_validate(arguments)
        except ValidationError:
            # Do not echo attacker-controlled values, IDs or validation internals.
            return {"error": "invalid_arguments", "detail": "Use the declared schema and a date range of 1-366 days."}
        if name == "calculate_safe_to_spend":
            return {"status": "insufficient_data", "safe_to_spend_eur": None,
                    "missing_inputs": ["latest balance per account with timestamps", "confirmed upcoming bills",
                                       "confirmed incoming money", "essential reserves", "safety buffer", "planning horizon"],
                    "detail": "Do not interpret historical remaining income as available cash."}
        context = self.repository.describe(self.customer_id)
        if name == "get_data_context":
            return context
        if not context["coverage_from"]:
            return {"status": "no_customer_data", "data_version": context["data_version"]}
        result = self.repository.spending(self.customer_id, args.start_date, args.end_date, args.category)
        result["data_version"] = context["data_version"]
        result["coverage"] = {"from": context["coverage_from"], "to": context["coverage_to"]}
        result["coverage_note"] = "Coverage endpoints are observed transaction dates, not a guarantee of complete reporting."
        result["outside_observed_range"] = (args.start_date < date.fromisoformat(context["coverage_from"])
            or args.end_date.toordinal() - 1 > date.fromisoformat(context["coverage_to"]).toordinal())
        if args.category and args.category.casefold() not in {c.casefold() for c in context["categories"]}:
            result["category_status"] = "not_found_in_customer_spending"
        if name == "get_three_baskets":
            totals = {k: Decimal("0.00") for k in ("regular_needs", "irregular_needs", "everyday_choices", "unclassified")}
            for row in result.pop("categories"):
                totals[row["basket"]] += Decimal(row["total_eur"])
            result["baskets"] = {k: str(v) for k, v in totals.items()}
            result["assumption"] = "Illustrative category rules; individual needs may differ."
        elif name == "simulate_savings":
            savings = (Decimal(result["total_eur"]) * args.reduction_percent / 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            result.update(savings_eur=str(savings), reduction_percent=args.reduction_percent,
                          scenario="Historical period only; not an annual forecast.")
        return result

    def tool_result(self, tool_id: str, name: str, arguments: dict) -> dict:
        result = self.execute(name, arguments)
        return {"type": "tool_result", "tool_use_id": tool_id,
                "content": json.dumps(result, ensure_ascii=False), "is_error": "error" in result}
