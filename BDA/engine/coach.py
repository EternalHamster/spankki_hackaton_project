"""Coach API: the functions the chat's LLM calls as tools.

Every function returns a plain JSON-ready dict with round numbers. The LLM explains these; it must
not compute or invent numbers itself.

Wiring it to an LLM (any provider with tool calling):

    from engine import coach
    tools = coach.TOOLS                      # [{"name", "description", "input_schema"}, ...]
    system = coach.SYSTEM_PROMPT
    ...
    # when the model asks for a tool:
    result = coach.call(customer_id, tool_name, tool_arguments)     # always returns a dict
    # send json.dumps(result) back as the tool result; flag it as an error if "error" in result

The customer id comes from the logged-in session, never from the model: it is not part of any tool's
input, so a user cannot ask about someone else's money.

Direct use:
    coach.overview("CUST00042")
    coach.safe_to_spend("CUST00042")
    coach.what_if("CUST00042", "dining_out", cut_pct=20)
    coach.afford("CUST00042", price_eur=500, months=6)
    coach.spending("CUST00042", line="taxi", month="2026-08")

Requires BDA/output/coach.duckdb (run `python -m engine` from the BDA folder once).
"""
import json
import math
from functools import lru_cache

import duckdb
import pandas as pd

from . import config as C
from .insights import nice, nice_down, LABEL

# Everyday words for sets of spending lines. Accepted wherever a `line` is accepted.
GROUPS = {
    "dining_out": ("eating out (restaurants, cafés, fast food, bars)", ["restaurants", "fast_food", "bars"]),
    "transport": ("getting around (public transport, fuel, taxis, parking)",
                  ["public_transport", "fuel", "taxi", "parking", "transport_other"]),
    "food": ("food (groceries and eating out)", ["groceries", "restaurants", "fast_food", "bars"]),
    "extras": ("extras (everything that is not a bill or an essential)", list(C.DISCRETIONARY)),
    "essentials": ("everyday essentials (groceries, health, getting to work)", list(C.ESSENTIAL_EVERYDAY)),
    "fixed_bills": ("fixed bills (housing and utilities)", list(C.REGULAR_LINES)),
}
MONEY_FLOWS = {"income": ("income", ["income"]), "savings": ("money moved to savings and investments", ["savings_transfer"])}
LINE_NAMES = list(C.LINES) + list(GROUPS)

SYSTEM_PROMPT = """You are a personal money coach inside a Finnish bank's mobile app. You talk with one \
customer about their own account.

Everything you know about their money comes from the tools. The tools already return rounded, checked \
numbers, so quote them as they are and do not add, subtract or estimate amounts yourself; if you need a \
number you don't have, call a tool. If a tool returns an error, say you can't answer that yet rather than \
guessing.

The customer is not a finance person and reads this on a phone. Answer in two or three short sentences, \
with one number and one concrete next step. The numbers come from a statistical model, but ranges, \
probabilities and confidence levels would only confuse, so leave them out. Explain any money term you \
use in everyday words.

Spending falls into three baskets, and helping people see them is the point of the app: fixed bills \
(rent, utilities), surprises (repairs, medical bills) and everyday spending (the part they control). \
Groceries, health costs and getting to work are essentials: never suggest cutting them. Be encouraging \
and never judge how someone spends."""


class CoachError(ValueError):
    """A request the coach cannot answer (unknown customer, line or period). The message is safe to show."""


@lru_cache(maxsize=1)
def _con():
    return duckdb.connect(str(C.DB_PATH), read_only=True)


def _q(sql, params=None):
    return _con().cursor().execute(sql, params or []).df()


def _in(values):
    return "(" + ",".join(f"'{v}'" for v in values) + ")"


def _summary(cid):
    df = _q("select * from customer_summary where customer_id = ?", [cid])
    if df.empty:
        raise CoachError(f"unknown customer {cid}")
    return df.iloc[0]


def _resolve(line, extra=None):
    """Line or group name -> (label, [lines])."""
    names = {**{k: (v[2], [k]) for k, v in C.LINES.items()}, **GROUPS, **(extra or {})}
    key = str(line).strip().lower().replace(" ", "_").replace("-", "_")
    if key not in names:
        raise CoachError(f"unknown line '{line}'. Valid names: {', '.join(names)}")
    return names[key]


def _lines(cid, lines):
    df = _q(f"select * from customer_line where customer_id = ? and line in {_in(lines)}", [cid])
    if df.empty:
        _summary(cid)              # raises for an unknown customer
        raise CoachError("no data for this line")
    return df.set_index("line").reindex([l for l in lines if l in set(df["line"])])


def _date(value, what):
    try:
        return pd.Timestamp(str(value))
    except (ValueError, TypeError):
        raise CoachError(f"{what} must be a date like 2026-08-31, got '{value}'") from None


def _period(cid, month=None, start=None, end=None):
    """(start, end) dates. month='YYYY-MM', or start/end='YYYY-MM-DD'. Default: last complete month."""
    as_of = pd.Timestamp(_summary(cid)["as_of"])
    if month:
        try:
            a = pd.Timestamp(str(month)[:7] + "-01")
        except (ValueError, TypeError):
            raise CoachError(f"month must look like 2026-08, got '{month}'") from None
        b = a + pd.offsets.MonthEnd(0)
    elif start or end:
        a = _date(start, "start") if start else as_of - pd.Timedelta(days=29)
        b = _date(end, "end") if end else as_of
    else:
        b = as_of if as_of.is_month_end else as_of.replace(day=1) - pd.Timedelta(days=1)
        a = b.replace(day=1)
    if a > b:
        raise CoachError("the start date is after the end date")
    return a, min(b, as_of) if a <= as_of else b


def _money(x):
    return round(float(x), 2)


SPEND_FILTER = "spend > 0 and line not in ('income', 'savings_transfer')"


# ------------------------------------------------------------------ tools
def lines():
    """Names the other tools accept as `line`."""
    out = [{"line": k, "label": v[2], "basket": v[0], "essential": v[1]} for k, v in C.LINES.items()]
    out += [{"line": k, "label": v[0], "group_of": v[1]} for k, v in GROUPS.items()]
    return out


def overview(cid, n=5):
    s = _summary(cid)
    ins = _q("select kind, line, message, action, numbers from insights where customer_id = ? order by rank limit ?",
             [cid, int(n)])
    b = baskets(cid)
    return {"customer_id": cid, "age": int(s["customer_age"]), "area": s["area"],
            "as_of": str(pd.Timestamp(s["as_of"]).date()),
            "spender_type": spender_type(cid)["label"],
            "safe_to_spend_week": nice_down(s["safe_to_spend_week"]),
            "baskets_month": {"fixed_bills": b["fixed_bills"]["total"], "surprises": b["surprises"]["total"],
                              "everyday": b["everyday"]["total"]},
            "insights": [dict(r, line=r["line"] if isinstance(r["line"], str) else None,
                              numbers=json.loads(r["numbers"])) for r in ins.to_dict("records")]}


LIMITED_BY = {
    "cash_until_payday": "the money on the account until the next salary arrives",
    "monthly_budget": "the monthly budget: income minus bills, essentials, surprises and savings",
    "recent_budget": "the monthly budget over the last 12 months: income minus bills, essentials, surprises and savings",
}


def safe_to_spend(cid):
    s = _summary(cid)
    return {"safe_to_spend_week": nice_down(s["safe_to_spend_week"]),
            "usual_extras_week": nice(s["extras_12m"] * 7 / 30.44),
            "next_payday": str(pd.Timestamp(s["next_payday"]).date()),
            "days_to_payday": int(s["days_to_payday"]),
            "money_is_tight": bool(s["safe_binding"] == "cash_until_payday" or s["safe_to_spend_week"] <= 0),
            "limited_by": LIMITED_BY[s["safe_binding"]],
            "explanation": "The amount per week for extras (eating out, shopping, fun) that still leaves enough for "
                           "rent and bills due before payday, usual groceries, transport and health costs, a "
                           "possible surprise cost and a small cushion, even if the salary arrives late. "
                           "It is never more than the monthly budget allows."}


def safe_to_save(cid):
    s = _summary(cid)
    save = nice_down(s["safe_to_save_month"])
    short = nice(s["surprise_fund_gap"])
    return {"safe_to_save_month": save, "safe_to_save_year": 12 * save,
            "already_saving_month": nice(s["savings_month"]),
            "left_over_month": nice(s["surplus_month"]),
            "surprise_fund_target": nice(s["surprise_fund"]), "surprise_fund_short": short,
            "save_first_into": "surprise fund" if short > 0 else "long-term savings",
            "explanation": "The extra amount that can go to savings every month with today's habits, on top of "
                           "what is already saved. It is a cautious share of what was left over each month in "
                           "the last 12 months, so an expensive month does not break it."}


def compare_to_peers(cid, line=None):
    s = _summary(cid)
    if line:
        rows = _lines(cid, _resolve(line)[1])
    else:
        rows = _q("select * from customer_line where customer_id = ? order by expected_month desc", [cid]).set_index("line")
    out = []
    for name, r in rows.iterrows():
        nat, ratio = r["national_eur"], r["peer_ratio"]
        has_freq = pd.notna(r.get("lam")) and pd.notna(r.get("peer_lam_median"))
        out.append({"line": name, "label": LABEL[name],
                    "you_month": nice(r["expected_month"]), "peers_month": nice(r["peer_median"]),
                    "peer_group": f"age {s['age_band']}, {s['area']}",
                    "you_vs_peers": ("about the same" if pd.isna(ratio) else
                                     "much more" if ratio >= C.PEER_MIN_RATIO else
                                     "more" if ratio >= 1.15 else
                                     "less" if ratio <= 0.85 else "about the same"),
                    "more_than_pct_of_peers": int(round(100 * r["peer_pct"])),
                    "payments_per_month": round(float(r["lam"]), 1) if has_freq else None,
                    "peers_payments_per_month": round(float(r["peer_lam_median"]), 1) if has_freq else None,
                    "eur_per_payment": nice(r["size_eur"]) if has_freq else None,
                    "peers_eur_per_payment": nice(r["peer_size_median"]) if has_freq else None,
                    "finland_average_month": (nice(nat) if pd.notna(nat) and nat >= 5 else None)})
    return out[0] if line and len(out) == 1 else out


def what_if(cid, line, cut_pct=20):
    """Cut a spending line (or group) by cut_pct percent: what does it save?"""
    try:
        cut_pct = float(cut_pct)
    except (TypeError, ValueError):
        raise CoachError("cut_pct must be a number between 1 and 100") from None
    if not 0 < cut_pct <= 100:
        raise CoachError("cut_pct must be a number between 1 and 100")
    label, names = _resolve(line)
    s = _summary(cid)
    now = nice(_lines(cid, names)["expected_month"].sum())
    saves = nice(now * cut_pct / 100)
    left = nice(s["net_12m"])
    out = {"line": line, "label": label, "cut_pct": cut_pct if cut_pct % 1 else int(cut_pct),
           "now_month": now, "after_month": now - saves, "saves_month": saves, "saves_year": 12 * saves,
           "left_over_month_now": left, "left_over_month_after": left + saves}
    gap = float(s["surprise_fund_gap"])
    if gap > 0 and saves > 0:
        out["months_to_fill_surprise_fund"] = math.ceil(gap / saves)
    if all(C.LINES[l][1] for l in names):
        out["note"] = "This is an essential cost. Cutting it is usually hard; look at extras first."
    return out


def _up5(x):
    return int(5 * math.ceil(float(x) / 5 - 1e-9))


AFFORD_MAX_CUT = 0.5          # never suggest cutting an extra by more than half
AFFORD_MAX_MONTHS = 60


def afford(cid, price_eur, months=6):
    """Forecast: can the customer put aside price_eur within `months` months, and if not, what has to change?

    Uses the model's cautious monthly surplus (safe-to-save), made a little smaller when the months ahead
    are more expensive than an average month (season factors). A missing amount is covered first from
    what the customer already moves to savings each month, then by cutting extras, starting where they
    spend most above their peers. Essentials are never cut.
    """
    return _afford(cid, price_eur, months, query=_q)


def _afford(cid, price_eur, months=6, *, query):
    """Use the caller's snapshot connection without changing the process-wide BDA database."""
    try:
        price, months = float(price_eur), int(months)
    except (TypeError, ValueError):
        raise CoachError("price_eur must be an amount in euros and months a whole number") from None
    if not 0 < price <= 1_000_000:
        raise CoachError("price_eur must be between 1 and 1,000,000")
    if not 1 <= months <= AFFORD_MAX_MONTHS:
        raise CoachError(f"months must be between 1 and {AFFORD_MAX_MONTHS}")
    summary = query("select * from customer_summary where customer_id = ?", [cid])
    if summary.empty:
        raise CoachError(f"unknown customer {cid}")
    s = summary.iloc[0]
    cl = query("select * from customer_line where customer_id = ?", [cid]).set_index("line")

    # the months ahead compared with an average month (e.g. a window with December costs more)
    first = pd.Timestamp(s["as_of"]).replace(day=1) + pd.offsets.MonthBegin(1)
    moy = [(first + pd.DateOffset(months=i)).month for i in range(months)]
    season = query("select line, month_of_year, factor from model_season").pivot(
        index="line", columns="month_of_year", values="factor")
    season_extra = 0.0
    for line in cl.index:
        if line in C.LINES and line in season.index:
            mean_factor = sum(float(season.loc[line].get(m, 1.0)) for m in moy) / len(moy)
            season_extra += float(cl.loc[line, "expected_month"]) * (mean_factor - 1)
    season_extra = max(0.0, season_extra)

    need = _up5(price / months)
    room = nice_down(max(0.0, float(s["safe_to_save_month"]) - season_extra))
    saving = nice_down(max(0.0, float(s["savings_12m"])))           # already moved to savings each month
    # income - spending - saving below zero: that much has to be found before anything can be set aside
    shortfall = _up5(max(0.0, -float(s["surplus_month"])))
    spare_now = nice_down(max(0.0, float(s["balance"]) - float(s["surprise_fund"]) - C.SAFE_CUSHION_EUR
                              - float(s["regular_month"])))

    out = {"price_eur": _money(price), "months": months, "needed_month": need, "can_set_aside_month": room,
           "months_without_changes": math.ceil(price / room) if room > 0 else None,
           "already_saving_month": saving, "from_current_saving_month": 0, "surprise_fund_short": nice(s["surprise_fund_gap"])}
    if season_extra >= 5:
        out["months_ahead_cost_more_month"] = nice(season_extra)
    if shortfall > 0:
        out["budget_short_month"] = shortfall

    cuts = []
    if spare_now >= price:
        verdict, set_aside, final_months = "already_affordable", 0, 0
        out["spare_money_on_account"] = spare_now
    elif room >= need:
        verdict, set_aside, final_months = "yes", need, months
    else:
        missing = need - room + shortfall
        out["from_current_saving_month"] = redirect = min(missing, saving)
        missing -= redirect
        out["missing_month"] = missing
        cand = cl.loc[[l for l in C.DISCRETIONARY if l in cl.index]].copy()
        cand["excess"] = (cand["expected_month"] - cand["peer_median"]).fillna(0.0)
        cand = cand.sort_values(["excess", "expected_month"], ascending=False, kind="stable")
        left = missing
        for line, r in cand.iterrows():
            if left <= 0 or len(cuts) == 3:
                break
            cut = min(left, int(5 * math.floor(AFFORD_MAX_CUT * float(r["expected_month"]) / 5 + 1e-9)))
            if cut < 5:
                continue
            now = max(nice(r["expected_month"]), 2 * cut)
            item = {"line": line, "label": LABEL[line], "now_month": now, "cut_month": cut, "after_month": now - cut,
                    "more_than_peers": bool(pd.notna(r["peer_ratio"]) and r["peer_ratio"] >= 1.15)}
            size, lam = r.get("size_eur"), r.get("lam")
            if pd.notna(size) and pd.notna(lam) and size > 0:
                fewer = max(1, round(cut / float(size)))
                if fewer <= lam:
                    item["fewer_payments_month"] = int(fewer)
            cuts.append(item)
            left -= cut
        freed = sum(c["cut_month"] for c in cuts)
        possible = room + redirect + freed - shortfall
        if missing <= 0:
            verdict, set_aside, final_months = "yes", need, months
        elif left <= 0:
            verdict, set_aside, final_months = "yes_with_changes", need, months
        elif possible > 0 and math.ceil(price / possible) <= AFFORD_MAX_MONTHS:
            verdict, set_aside, final_months = "takes_longer", possible, math.ceil(price / possible)
        else:
            verdict, set_aside, final_months = "not_now", 0, None
    out.update(verdict=verdict, set_aside_month=set_aside, months_needed=final_months, cuts=cuts,
               cuts_total_month=sum(c["cut_month"] for c in cuts))
    out["summary"] = {
        "already_affordable": "There is already enough spare money on the account for this, beyond next month's "
                              "bills and the surprise fund.",
        "yes": f"Reachable with today's habits: set aside €{set_aside} a month for {months} months."
               + (f" €{out['from_current_saving_month']} a month of that comes out of what already goes to savings."
                  if out["from_current_saving_month"] else ""),
        "yes_with_changes": f"Reachable in {months} months by setting aside €{set_aside} a month, if the listed "
                            f"extras are cut by €{out['cuts_total_month']} a month in total."
                            + (f" This also uses €{out['from_current_saving_month']} a month of what already goes "
                               f"to savings." if out["from_current_saving_month"] else ""),
        "takes_longer": f"Not reachable in {months} months. With the listed cuts, €{set_aside} a month can be set "
                        f"aside, which takes {final_months} months.",
        "not_now": "Not reachable right now: there is no room in the monthly budget even after cutting extras. "
                   "Getting the monthly budget into balance comes first.",
    }[verdict]
    if out["surprise_fund_short"] > 0 and verdict != "not_now":
        out["note"] = "The surprise fund is not full yet. Filling it first is the safer order."
    return out


def spending(cid, line=None, category=None, month=None, start=None, end=None):
    """Facts from the transactions: total, number of payments, biggest payment in a period."""
    a, b = _period(cid, month, start, end)
    where, params = ["customer_id = ?", "tx_date between ? and ?", "spend > 0"], [cid, a.date(), b.date()]
    label, usual = None, None
    if line:
        label, names = _resolve(line)
        where.append(f"line in {_in(names)}")
        usual = float(_q(f"""select coalesce(sum(amount), 0) / greatest(count(distinct month), 1) x from (
                               select month, amount from customer_month_line
                               where customer_id = ? and line in {_in(names)} order by month desc limit ?)""",
                         [cid, 12 * len(names)])["x"].iloc[0])
    elif category:
        where.append("lower(category) = lower(?)")
        params.append(category)
    else:
        where.append("line not in ('income', 'savings_transfer')")       # moving money to savings is not spending
    r = _q(f"select count(*) n, coalesce(sum(spend), 0) eur, coalesce(max(spend), 0) biggest "
           f"from transactions where {' and '.join(where)}", params).iloc[0]
    out = {"line": line, "label": label, "category": category, "from": str(a.date()), "to": str(b.date()),
           "total_eur": _money(r["eur"]), "payments": int(r["n"]), "biggest_payment_eur": _money(r["biggest"])}
    if usual is not None:
        out["usual_month_eur"] = nice(usual)          # average of the last 12 months, for "is that a lot?"
    return out


def breakdown(cid, month=None, start=None, end=None, by="line"):
    """Where the money went in a period: income, spending split by line / basket / category, savings."""
    if by not in ("line", "basket", "category"):
        raise CoachError("by must be one of: line, basket, category")
    a, b = _period(cid, month, start, end)
    p = [cid, a.date(), b.date()]
    tot = _q("""select coalesce(sum(tx_amount_eur) filter (where line = 'income'), 0) income,
                       coalesce(sum(spend) filter (where line = 'savings_transfer'), 0) saved,
                       coalesce(sum(spend) filter (where line not in ('income', 'savings_transfer')), 0) spent
                from transactions where customer_id = ? and tx_date between ? and ?""", p).iloc[0]
    rows = _q(f"""select {by} k, sum(spend) eur, count(*) n from transactions
                  where customer_id = ? and tx_date between ? and ? and {SPEND_FILTER}
                  group by 1 order by eur desc""", p)
    basket_name = {1: "fixed bills", 2: "surprises", 3: "everyday spending", 0: "unusual large payments"}

    def name(k):
        if by == "basket":
            return basket_name.get(int(k), str(k))
        if by == "line":
            return LABEL.get(k, "unusual large payments" if k == "anomaly" else k)
        return k
    spent = float(tot["spent"])
    return {"from": str(a.date()), "to": str(b.date()), "income_eur": _money(tot["income"]),
            "spent_eur": _money(spent), "moved_to_savings_eur": _money(tot["saved"]),
            "left_over_eur": _money(tot["income"] - spent - tot["saved"]),
            "by": by,
            "parts": [{"name": name(r["k"]), "eur": _money(r["eur"]), "payments": int(r["n"]),
                       "share_pct": round(100 * r["eur"] / spent) if spent > 0 else 0} for _, r in rows.iterrows()]}


def history(cid, line=None, months=12):
    """Month-by-month totals (for a chart or "how has X developed"). line=None: all spending."""
    try:
        months = max(1, min(int(months), 36))
    except (TypeError, ValueError):
        raise CoachError("months must be a number") from None
    _summary(cid)
    if line:
        label, names = _resolve(line, extra=MONEY_FLOWS)
    else:
        label, names = "all spending", [l for l in C.LINES] + ["anomaly"]
    df = _q(f"""select month, sum(amount) eur from customer_month_line
                where customer_id = ? and line in {_in(names)} group by 1 order by 1 desc limit ?""", [cid, months])
    df = df.iloc[::-1]
    series = [{"month": pd.Timestamp(m).strftime("%Y-%m"), "eur": _money(e)} for m, e in zip(df["month"], df["eur"])]
    top = max(series, key=lambda x: x["eur"]) if series else None
    return {"line": line, "label": label, "months": series,
            "average_month_eur": nice(df["eur"].mean()) if len(df) else 0,
            "highest_month": top["month"] if top else None, "highest_month_eur": top["eur"] if top else 0}


def biggest_payments(cid, n=5, line=None, month=None, start=None, end=None):
    """The largest single payments in a period."""
    try:
        n = max(1, min(int(n), 20))
    except (TypeError, ValueError):
        raise CoachError("n must be a number") from None
    a, b = _period(cid, month, start, end)
    where, params = f"customer_id = ? and tx_date between ? and ? and {SPEND_FILTER}", [cid, a.date(), b.date()]
    if line:
        where += f" and line in {_in(_resolve(line)[1])}"
    df = _q(f"select tx_date, line, category, spend from transactions where {where} "
            f"order by spend desc, ts limit ?", params + [n])
    return {"from": str(a.date()), "to": str(b.date()),
            "payments": [{"date": str(pd.Timestamp(r["tx_date"]).date()),
                          "what": LABEL.get(r["line"], r["category"].lower()), "eur": _money(r["spend"])}
                         for _, r in df.iterrows()]}


def baskets(cid):
    s = _summary(cid)
    cl = _q("select line, expected_month from customer_line where customer_id = ?", [cid]).set_index("line")["expected_month"]
    b3 = {l: nice(cl[l]) for l in C.EVERYDAY_LINES + ["big_purchase"] if nice(cl[l]) > 0}
    everyday = {LABEL[k]: v for k, v in sorted(b3.items(), key=lambda kv: -kv[1])}
    if nice(s["unusual_month"]) > 0:
        everyday["unusual large payments"] = nice(s["unusual_month"])
    tot = float(s["total_spend_month"])
    pct = lambda x: round(100 * float(x) / tot) if tot > 0 else 0
    b3_month = tot - s["regular_month"] - s["shock_month"]
    r1, r2, r3 = nice(s["regular_month"]), nice(s["shock_month"]), nice(b3_month)
    return {"total_spending_month": r1 + r2 + r3,           # the three rounded baskets add up exactly
            "fixed_bills": {"total": r1, "share_pct": pct(s["regular_month"]),
                            "rent / housing": nice(s["housing_month"]), "bills & utilities": nice(s["utilities_month"])},
            "surprises": {"total": r2, "share_pct": pct(s["shock_month"]),
                          "per_year": round(float(s["shocks_per_year"]), 1),
                          "typical_eur": nice(s["typical_shock_eur"]), "surprise_fund_target": nice(s["surprise_fund"])},
            "everyday": {"total": r3, "share_pct": pct(b3_month), **everyday},
            "income_month": nice(s["income_month"]), "saving_month": nice(s["savings_month"])}


def spender_type(cid):
    df = _q("select label, detail, top_lines, everyday_share_pct from spender_type where customer_id = ?", [cid])
    if df.empty:
        raise CoachError(f"unknown customer {cid}")
    r = df.iloc[0]
    return {"label": r["label"], "detail": r["detail"], "top_lines": [l for l in r["top_lines"].split(",") if l],
            "everyday_share_pct": int(r["everyday_share_pct"])}


# ------------------------------------------------------------------ tool definitions for the LLM
_LINE = {"type": "string", "enum": LINE_NAMES,
         "description": "Spending line or group. Groups: dining_out (restaurants + fast_food + bars), transport, "
                        "food (groceries + dining out), extras, essentials, fixed_bills."}
_PERIOD = {
    "month": {"type": "string", "description": "A calendar month as YYYY-MM, e.g. 2026-08. Leave out for the last complete month."},
    "start": {"type": "string", "description": "First day of a custom period, YYYY-MM-DD. Use with end instead of month."},
    "end": {"type": "string", "description": "Last day of a custom period, YYYY-MM-DD."},
}


def _tool(name, description, properties=None, required=()):
    return {"name": name, "description": description,
            "input_schema": {"type": "object", "properties": properties or {}, "required": list(required),
                             "additionalProperties": False}}


TOOLS = [
    _tool("overview",
          "Start here when the customer opens the chat or asks an open question like 'how am I doing?'. Returns "
          "the most important insights for them (each with a ready message, one action and its numbers), their "
          "spender type, safe-to-spend and the three baskets.",
          {"n": {"type": "integer", "description": "How many insights to return (default 5)."}}),
    _tool("safe_to_spend",
          "How much the customer can safely spend per week on extras until their next salary. Use for 'what can "
          "I spend this week?', 'can I afford X?' or 'is money tight?'."),
    _tool("safe_to_save",
          "How much more the customer can safely move to savings every month, and whether it should go to their "
          "surprise fund first. Use for 'how much can I save?' or 'should I save more?'."),
    _tool("spending",
          "Exact facts from the transactions: total, number of payments and biggest payment for a spending line, "
          "group or raw bank category in a month or date range. Use for 'how much did I spend on taxis last "
          "month?'. Leave out line and category for all spending. Also returns the usual monthly amount for "
          "comparison.",
          {"line": _LINE,
           "category": {"type": "string", "description": "Raw bank category instead of a line, e.g. Groceries, "
                        "Restaurants, Transportation, Entertainment, Health, Home & Tech, Lifestyle, Travel, Housing, Utilities."},
           **_PERIOD}),
    _tool("breakdown",
          "Where the money went in a month or date range: income, total spending split by spending line, by the "
          "three baskets or by bank category, money moved to savings, and what was left over. Use for 'where "
          "does my money go?' or 'show me August'.",
          {"by": {"type": "string", "enum": ["line", "basket", "category"], "description": "How to split spending (default line)."},
           **_PERIOD}),
    _tool("history",
          "Month-by-month totals for a spending line or group, for income, for savings, or for all spending. Use "
          "for 'how has my eating out changed?' or to show a chart.",
          {"line": {"type": "string", "enum": LINE_NAMES + list(MONEY_FLOWS),
                    "description": "Spending line or group, or 'income' / 'savings'. Leave out for all spending."},
           "months": {"type": "integer", "description": "How many months back (default 12)."}}),
    _tool("biggest_payments",
          "The largest single payments in a month or date range, optionally within one line or group. Use for "
          "'what were my biggest purchases?'.",
          {"n": {"type": "integer", "description": "How many payments (default 5)."}, "line": _LINE, **_PERIOD}),
    _tool("compare_to_peers",
          "The customer's usual monthly spending on a line compared with people of the same age in the same city, "
          "and with the Finnish average from Statistics Finland. Says whether the difference comes from paying "
          "more often or paying more each time. Leave out line for all lines.",
          {"line": _LINE}),
    _tool("what_if",
          "What the customer would save per month and per year by cutting a spending line or group by a "
          "percentage, and what that does to their monthly balance. Use for 'what if I cut dining out by 20 %?'.",
          {"line": _LINE, "cut_pct": {"type": "number", "description": "Percent to cut, 1-100 (default 20)."}},
          required=["line"]),
    _tool("afford",
          "Forecast for a purchase or savings goal: can the customer put aside a given amount within a number of "
          "months, and if not, what has to change? Returns a verdict (already_affordable, yes, yes_with_changes, "
          "takes_longer, not_now), the amount to set aside each month, which extras to cut and by how much, and "
          "how many months it realistically takes. Use for 'I want to buy a €500 TV in 6 months, what should I "
          "do?' or 'can I save €2,000 for a trip by summer?'.",
          {"price_eur": {"type": "number", "description": "Price of the purchase or size of the goal, in euros."},
           "months": {"type": "integer", "description": "Months until the money is needed, 1-60 (default 6)."}},
          required=["price_eur"]),
    _tool("baskets",
          "The customer's usual month split into the three baskets: fixed bills, surprises and everyday spending, "
          "with the lines inside each. Use to explain where the money goes and what they can control."),
    _tool("spender_type",
          "What kind of spender the customer is, from the extras where they spend more than most people their age."),
]
TOOLS_DOC = {t["name"]: t["description"] for t in TOOLS}       # kept for older callers
_FUNCS = {"overview": overview, "safe_to_spend": safe_to_spend, "safe_to_save": safe_to_save, "spending": spending,
          "breakdown": breakdown, "history": history, "biggest_payments": biggest_payments,
          "compare_to_peers": compare_to_peers, "what_if": what_if, "afford": afford, "baskets": baskets, "spender_type": spender_type}


def call(cid, name, arguments=None):
    """Run a tool for a customer. Never raises: problems come back as {"error": "..."}."""
    if name not in _FUNCS:
        return {"error": f"unknown tool '{name}'. Available: {', '.join(_FUNCS)}"}
    args = dict(arguments or {})
    allowed = next(t for t in TOOLS if t["name"] == name)["input_schema"]["properties"]
    unknown = [k for k in args if k not in allowed]
    if unknown:
        return {"error": f"{name} does not take: {', '.join(unknown)}. It takes: {', '.join(allowed) or 'nothing'}"}
    try:
        return _FUNCS[name](cid, **{k: v for k, v in args.items() if v is not None})
    except CoachError as e:
        return {"error": str(e)}
    except TypeError as e:               # a required argument is missing
        return {"error": f"{name}: {e}"}


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    cid = sys.argv[1] if len(sys.argv) > 1 else "CUST00042"
    demo = [("overview", {}), ("safe_to_spend", {}), ("safe_to_save", {}),
            ("spending", {"line": "taxi"}), ("what_if", {"line": "dining_out", "cut_pct": 20}),
            ("afford", {"price_eur": 500, "months": 6}), ("compare_to_peers", {"line": "restaurants"}), ("breakdown", {"by": "basket"}),
            ("history", {"line": "dining_out", "months": 6}), ("biggest_payments", {"n": 3}),
            ("baskets", {}), ("spender_type", {})]
    for name, args in demo:
        print(f"\n## {name} {args or ''}\n{json.dumps(call(cid, name, args), indent=2, ensure_ascii=False)}")
