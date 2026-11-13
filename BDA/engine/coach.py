"""Coach API: the functions an LLM calls as tools. Every function returns plain JSON-ready dicts with
round numbers. The LLM explains these; it must not compute or invent numbers itself.

    from engine import coach
    coach.overview("CUST00042")
    coach.safe_to_spend("CUST00042")
    coach.compare_to_peers("CUST00042", "taxi")
    coach.what_if("CUST00042", "restaurants", cut_pct=20)
    coach.spending("CUST00042", line="taxi", month="2026-08")
    coach.spender_type("CUST00042")

Requires BDA/output/coach.duckdb (run `python -m engine` from the BDA folder once).
"""
import json
from functools import lru_cache

import duckdb
import pandas as pd

from . import config as C
from .insights import nice, LABEL, fmt_date

TOOLS_DOC = {
    "overview": "Top insights for the customer: safe-to-spend, biggest savings opportunities, trends, surprise fund, the three baskets.",
    "safe_to_spend": "How much the customer can safely spend per week on extras until next payday.",
    "compare_to_peers": "Customer's monthly spending on a line vs people their age in their area and the Finnish average (Statistics Finland).",
    "what_if": "Money saved per month and per year if the customer cuts a spending line by cut_pct percent.",
    "spending": "Facts: how much and how many payments on a line / category in a month or date range.",
    "baskets": "Split of monthly spending into fixed bills, surprises and everyday spending, per line.",
    "spender_type": "What kind of spender the customer is, compared with people their age.",
    "lines": "List of spending lines the other tools accept.",
}


@lru_cache(maxsize=1)
def _con():
    return duckdb.connect(str(C.DB_PATH), read_only=True)


def _q(sql, params=None):
    return _con().execute(sql, params or []).df()


def _summary(cid):
    df = _q("select * from customer_summary where customer_id = ?", [cid])
    if df.empty:
        raise KeyError(f"unknown customer {cid}")
    return df.iloc[0]


def _line(cid, line):
    df = _q("select * from customer_line where customer_id = ? and line = ?", [cid, line])
    if df.empty:
        raise KeyError(f"unknown line {line}; see lines()")
    return df.iloc[0]


def lines():
    return [{"line": k, "label": v[2], "basket": v[0], "essential": v[1]} for k, v in C.LINES.items()]


def overview(cid, n=5):
    s = _summary(cid)
    ins = _q("select kind, line, message, action, numbers from insights where customer_id = ? order by rank limit ?", [cid, n])
    st = spender_type(cid)
    return {"customer_id": cid, "age": int(s["customer_age"]), "area": s["area"], "spender_type": st["label"],
            "as_of": str(pd.Timestamp(s["as_of"]).date()),
            "insights": [dict(r, line=r["line"] if isinstance(r["line"], str) else None,
                              numbers=json.loads(r["numbers"])) for r in ins.to_dict("records")]}


def safe_to_spend(cid):
    s = _summary(cid)
    return {"safe_to_spend_week": nice(s["safe_to_spend_week"]),
            "next_payday": str(pd.Timestamp(s["next_payday"]).date()),
            "days_to_payday": int(s["days_to_payday"]),
            "money_is_tight": bool(s["safe_binding"] == "cash_until_payday"),
            "explanation": "Balance now, minus rent and bills due before payday, minus usual groceries, transport and "
                           "health costs, minus a cushion for surprises, spread over the weeks until payday "
                           "(and never more than the monthly budget allows)."}


def compare_to_peers(cid, line=None):
    s = _summary(cid)
    rows = [_line(cid, line)] if line else [r for _, r in _q(
        "select * from customer_line where customer_id = ? order by expected_month desc", [cid]).iterrows()]
    out = []
    for r in rows:
        nat = r["national_eur"]
        out.append({"line": r["line"], "label": LABEL[r["line"]],
                    "you_month": nice(r["expected_month"]), "peers_month": nice(r["peer_median"]),
                    "peer_group": f"age {s['age_band']}, {s['area']}",
                    "you_vs_peers": ("much more" if r["peer_ratio"] >= C.PEER_MIN_RATIO else
                                     "more" if r["peer_ratio"] >= 1.15 else
                                     "less" if r["peer_ratio"] <= 0.85 else "about the same"),
                    "more_than_pct_of_peers": int(round(100 * r["peer_pct"])),
                    "payments_per_month": round(float(r["lam"]), 1), "peers_payments_per_month": round(float(r["peer_lam_median"]), 1),
                    "eur_per_payment": nice(r["size_eur"]), "peers_eur_per_payment": nice(r["peer_size_median"]),
                    "finland_average_month": (nice(nat) if pd.notna(nat) and nat >= 5 else None)})
    return out[0] if line else out


def what_if(cid, line, cut_pct=20):
    r, s = _line(cid, line), _summary(cid)
    save = r["expected_month"] * cut_pct / 100
    return {"line": line, "label": LABEL[line], "cut_pct": cut_pct,
            "now_month": nice(r["expected_month"]), "after_month": nice(r["expected_month"] - save),
            "saves_month": nice(save), "saves_year": nice(12 * save),
            "safe_to_spend_week_after": nice(s["safe_to_spend_week"] + save * 7 / 30.44)}


def spending(cid, line=None, category=None, month=None, start=None, end=None):
    """Facts from raw transactions. month='YYYY-MM' or start/end='YYYY-MM-DD'. Default: last full month."""
    if month:
        start = pd.Timestamp(month + "-01")
        end = start + pd.offsets.MonthEnd(0)
    elif not start:
        as_of = pd.Timestamp(_summary(cid)["as_of"])
        start = (as_of - pd.offsets.MonthBegin(1)) if as_of.day != 1 else as_of
        start = pd.Timestamp(start.year, start.month, 1)
        end = start + pd.offsets.MonthEnd(0)
    where, params = ["customer_id = ?", "tx_date between ? and ?", "spend > 0"], [cid, pd.Timestamp(start).date(), pd.Timestamp(end).date()]
    if line:
        where.append("line = ?"); params.append(line)
    if category:
        where.append("lower(category) = lower(?)"); params.append(category)
    df = _q(f"select count(*) n, coalesce(sum(spend),0) eur, coalesce(max(spend),0) biggest "
            f"from transactions where {' and '.join(where)}", params)
    r = df.iloc[0]
    return {"line": line, "category": category, "from": str(pd.Timestamp(start).date()), "to": str(pd.Timestamp(end).date()),
            "total_eur": round(float(r["eur"]), 2), "payments": int(r["n"]),
            "biggest_payment_eur": round(float(r["biggest"]), 2)}


def baskets(cid):
    s = _summary(cid)
    cl = _q("select line, expected_month from customer_line where customer_id = ?", [cid]).set_index("line")["expected_month"]
    b3 = {l: nice(cl[l]) for l in C.EVERYDAY_LINES + ["big_purchase"] if nice(cl[l]) > 0}
    return {"fixed_bills": {"total": nice(s["regular_month"]), "rent / housing": nice(s["housing_month"]),
                            "bills & utilities": nice(s["utilities_month"])},
            "surprises": {"total": nice(s["shock_month"]), "per_year": round(float(s["shocks_per_year"]), 1),
                          "typical_eur": nice(s["typical_shock_eur"]), "surprise_fund_target": nice(s["surprise_fund"])},
            "everyday": {"total": nice(s["total_spend_month"] - s["regular_month"] - s["shock_month"]),
                         **{LABEL[k]: v for k, v in sorted(b3.items(), key=lambda kv: -kv[1])}},
            "income_month": nice(s["income_month"]), "saving_month": nice(s["savings_month"])}


def spender_type(cid):
    r = _q("select label, detail, top_lines, everyday_share_pct from spender_type where customer_id = ?", [cid]).iloc[0]
    return {"label": r["label"], "detail": r["detail"], "top_lines": [l for l in r["top_lines"].split(",") if l],
            "everyday_share_pct": int(r["everyday_share_pct"])}


if __name__ == "__main__":
    import sys
    cid = sys.argv[1] if len(sys.argv) > 1 else "CUST00042"
    for name, res in [("overview", overview(cid)), ("safe_to_spend", safe_to_spend(cid)),
                      ("compare_to_peers taxi", compare_to_peers(cid, "taxi")),
                      ("what_if restaurants -20%", what_if(cid, "restaurants", 20)),
                      ("spending taxi last month", spending(cid, line="taxi")),
                      ("baskets", baskets(cid)), ("spender_type", spender_type(cid))]:
        print(f"\n## {name}\n{json.dumps(res, indent=2, ensure_ascii=False)}")
