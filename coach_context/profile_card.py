"""Customer profile card: a short, fixed-format summary of one customer for the chat model's context.

Built only from the BDA spending model's committed output CSVs (BDA/output/), so it works with any backend.
Put the rendered card in the prompt AFTER the shared, cached prefix (system prompt + tool definitions), so
overview questions need no tool calls and the shared prefix stays identical for every customer.

    from coach_context import build_profile_card, render_profile_card
    card = build_profile_card("CUST04971")      # dict, JSON-safe
    text = render_profile_card(card)            # ~600-900 tokens of plain text

CLI:  python -m coach_context CUST04971 [--json]
      python -m coach_context --sizes      (token-size statistics over all customers)

Stdlib only. Output is deterministic: the same data always gives byte-identical text (cache friendly).
"""
import argparse
import csv
import importlib.util
import json
import math
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = REPO / 'BDA' / 'output'
BDA_CONFIG = REPO / 'BDA' / 'engine' / 'config.py'

# Insight kinds already shown in their own card sections are not repeated in the insight list.
SKIP_INSIGHT_KINDS = {'safe_to_spend', 'baskets'}
MAX_INSIGHTS = 6
MIN_LINE_EUR = 5  # lines below this €/month are left out of the card
SAFE_LIMIT_TEXT = {
    'cash_until_payday': 'limited by the cash left until payday, so money is tight',
    'monthly_budget': 'limited by the usual monthly budget',
    'recent_budget': "limited by the last 12 months' actual budget",
}


def _load_bda_config():
    """BDA's config.py (stdlib only) is the single source of line labels and peer thresholds."""
    spec = importlib.util.spec_from_file_location('bda_config', BDA_CONFIG)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def nice(x):
    """Round € for people, same rule as BDA's insights: <100 -> 5, <1000 -> 10, else 50."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return 0
    return int(_step(x) * round(x / _step(x)))


def nice_down(x):
    """Like nice(), but always down: for amounts promised as safe (same as BDA's insights.nice_down)."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return 0
    return int(_step(x) * math.floor(x / _step(x) + 1e-9))


def _step(x):
    return 5 if abs(x) < 100 else 10 if abs(x) < 1000 else 50


def _f(row, key):
    v = row.get(key, '')
    return float(v) if v not in ('', None) else None


def _eur(x):
    return f"€{x:,.0f}" if x >= 0 else f"-€{-x:,.0f}"


class CardSource:
    """Loads BDA's output CSVs once. Reuse one instance; the data is a fixed snapshot."""

    def __init__(self, output_dir=DEFAULT_OUTPUT_DIR):
        self.output_dir = Path(output_dir)
        cfg = _load_bda_config()
        self.labels = {k: v[2] for k, v in cfg.LINES.items()}
        self.essential = {k for k, v in cfg.LINES.items() if v[1]}
        self.peer_min_ratio, self.peer_min_eur = cfg.PEER_MIN_RATIO, cfg.PEER_MIN_EUR
        self.summary = {r['customer_id']: r for r in self._read('customer_summary.csv')}
        self.spender = {r['customer_id']: r for r in self._read('spender_type.csv')}
        self.lines, self.insights = defaultdict(list), defaultdict(list)
        for r in self._read('customer_line.csv'):
            self.lines[r['customer_id']].append(r)
        for r in self._read('insights.csv'):
            self.insights[r['customer_id']].append(r)

    def _read(self, name):
        with open(self.output_dir / name, encoding='utf-8', newline='') as fh:
            return list(csv.DictReader(fh))


_default_source = None


def default_source():
    global _default_source
    if _default_source is None:
        _default_source = CardSource()
    return _default_source


def build_profile_card(customer_id, source=None):
    """Structured card for one customer. Raises KeyError for unknown customers."""
    src = source or default_source()
    s = src.summary[customer_id]
    income = _f(s, 'income_month')
    lines = []
    for r in sorted(src.lines[customer_id], key=lambda r: (-_f(r, 'expected_month'), r['line'])):
        if r['line'] == 'shock' or _f(r, 'expected_month') < MIN_LINE_EUR:
            continue
        you, peers = _f(r, 'expected_month'), _f(r, 'peer_median')
        ratio = _f(r, 'peer_ratio')
        lines.append({
            'line': r['line'], 'label': src.labels.get(r['line'], r['line']),
            'eur_month': nice(you), 'peers_eur_month': nice(peers),
            'essential': r['line'] in src.essential,
            'notably_above_peers': bool(ratio is not None and ratio >= src.peer_min_ratio
                                        and you - peers >= src.peer_min_eur),
        })
    insights = [{'kind': r['kind'], 'message': r['message'], 'action': r['action']}
                for r in sorted(src.insights[customer_id], key=lambda r: int(r['rank']))
                if r['kind'] not in SKIP_INSIGHT_KINDS][:MAX_INSIGHTS]
    sp = src.spender.get(customer_id, {})
    regular, shock, total = _f(s, 'regular_month'), _f(s, 'shock_month'), _f(s, 'total_spend_month')
    return {
        'as_of': s['as_of'][:10],
        'person': {'age': int(float(s['customer_age'])), 'area': s['area'], 'age_band': s['age_band']},
        'income': {'eur_month': nice(income), 'payday_day_of_month': int(float(s['payday_dom'])),
                   'next_payday': s['next_payday'][:10], 'days_to_payday': int(float(s['days_to_payday'])),
                   'peers_eur_month': nice(_f(s, 'peer_income_median')),
                   'late_payday_probability': round(_f(s, 'p_late_payday') or 0, 2)},
        'balance_eur': round(_f(s, 'balance')),
        'spending': {
            'eur_month': nice(total),
            'fixed_bills': {'eur_month': nice(regular), 'share': round(_f(s, 'basket1_share'), 2),
                            'housing_eur_month': nice(_f(s, 'housing_month')),
                            'utilities_eur_month': nice(_f(s, 'utilities_month'))},
            'surprises': {'eur_month': nice(shock), 'share': round(_f(s, 'basket2_share'), 2),
                          'per_year': round(_f(s, 'shocks_per_year'), 1),
                          'typical_eur': nice(_f(s, 'typical_shock_eur'))},
            'everyday': {'eur_month': nice(total - regular - shock), 'share': round(_f(s, 'basket3_share'), 2)},
        },
        'saving': {'eur_month': nice(_f(s, 'savings_month')), 'rate': round(_f(s, 'savings_rate'), 2)},
        'last_12_months': {'income_eur': nice(_f(s, 'income_12m') * 12), 'spent_eur': nice(_f(s, 'spend_12m') * 12),
                           'saved_eur': nice(_f(s, 'savings_12m') * 12), 'net_eur_month': nice(_f(s, 'net_12m'))},
        'safe_to_spend': {'eur_week': nice_down(_f(s, 'safe_to_spend_week')), 'limit': s['safe_binding']},
        'safe_to_save_eur_month': nice_down(_f(s, 'safe_to_save_month') or 0),
        'surprise_fund_target_eur': nice(_f(s, 'surprise_fund')),
        'surprise_fund_gap_eur': nice(_f(s, 'surprise_fund_gap') or 0),
        'spender_type': {'label': sp.get('label', ''), 'detail': sp.get('detail', '')},
        'lines': lines,
        'insights': insights,
    }


def render_profile_card(card):
    """Compact plain text for the prompt. Deterministic for a given card."""
    p, inc, sp = card['person'], card['income'], card['spending']
    fb, su, ev = sp['fixed_bills'], sp['surprises'], sp['everyday']
    l12 = card['last_12_months']
    net = l12['net_eur_month']
    out = [
        f"CUSTOMER PROFILE (as of {card['as_of']})",
        "Monthly figures are smoothed model estimates over the last 2 years; 'last 12 months' figures are actual "
        "totals. Use this for overview questions. For a specific period, line, transaction or calculation, call a tool.",
        "",
        f"Person: age {p['age']}, {p['area']} (peer group: age {p['age_band']}, {p['area']}).",
        f"Income: about {_eur(inc['eur_month'])}/month (peers {_eur(inc['peers_eur_month'])}), paid around day "
        f"{inc['payday_day_of_month']}. Next payday {inc['next_payday']} (in {inc['days_to_payday']} days)"
        + (f"; salary arrives late, at month end, in about {inc['late_payday_probability']:.0%} of months."
           if inc['late_payday_probability'] >= 0.05 else "."),
        f"Account balance now: {_eur(card['balance_eur'])}.",
        f"Spending: about {_eur(sp['eur_month'])}/month in three baskets:",
        f"- Mandatory & regular: {_eur(fb['eur_month'])} ({fb['share']:.0%}): rent/housing "
        f"{_eur(fb['housing_eur_month'])}, bills & utilities {_eur(fb['utilities_eur_month'])}.",
        f"- Mandatory & irregular (surprise costs): {_eur(su['eur_month'])}/month on average ({su['share']:.0%}); "
        + (f"about {su['per_year']:g} a year" if su['per_year'] >= 0.5 else "rare, less than once every two years")
        + f", typically {_eur(su['typical_eur'])} each.",
        f"- Everyday: {_eur(ev['eur_month'])} ({ev['share']:.0%}).",
        (f"Saving: about {_eur(card['saving']['eur_month'])}/month ({card['saving']['rate']:.0%} of income)."
         if card['saving']['eur_month'] > 0 else "Saving: no regular saving."),
        f"Last 12 months (actual): {_eur(l12['income_eur'])} in, {_eur(l12['spent_eur'])} spent, "
        f"{_eur(l12['saved_eur'])} saved; " + (f"spent about {_eur(-net)}/month more than came in."
                                               if net < 0 else f"about {_eur(net)}/month left over."),
        f"Safe to spend on extras this week: {_eur(card['safe_to_spend']['eur_week'])}, "
        f"{SAFE_LIMIT_TEXT.get(card['safe_to_spend']['limit'], card['safe_to_spend']['limit'])}.",
        (f"Safe to save: about {_eur(card['safe_to_save_eur_month'])}/month more on top of current saving"
         + (", into the surprise fund first." if card['surprise_fund_gap_eur'] > 0 else ".")
         if card['safe_to_save_eur_month'] > 0 else "Safe to save: nothing extra with current habits."),
        f"Surprise fund target: {_eur(card['surprise_fund_target_eur'])}; "
        + (f"the balance is about {_eur(card['surprise_fund_gap_eur'])} short of it."
           if card['surprise_fund_gap_eur'] > 0 else "the balance already covers it."),
        f"Spender type: {card['spender_type']['label']}. {card['spender_type']['detail']}",
        "",
        "Spending lines, €/month (you vs peer median; * = essential, do not nag; ! = notably above peers):",
    ]
    out += [f"- {l['label']}{'*' if l['essential'] else ''}{'!' if l['notably_above_peers'] else ''}: "
            f"{_eur(l['eur_month'])} vs {_eur(l['peers_eur_month'])}" for l in card['lines']]
    if card['insights']:
        out += ["", "Coach insights from the spending model (ranked; use these numbers, do not recompute):"]
        out += [f"{i}. {x['message']} Suggested action: {x['action']}" for i, x in enumerate(card['insights'], 1)]
    return '\n'.join(out)


def estimate_tokens(text):
    """Rough estimate (~4 characters per token). Use the API's count_tokens for exact numbers."""
    return math.ceil(len(text) / 4)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('customer_id', nargs='?')
    ap.add_argument('--json', action='store_true', help='print the structured card instead of the text')
    ap.add_argument('--sizes', action='store_true', help='token-size statistics over all customers')
    args = ap.parse_args(argv)
    if args.sizes:
        src = default_source()
        sizes = sorted(estimate_tokens(render_profile_card(build_profile_card(c, src))) for c in src.summary)
        q = lambda p: sizes[int(p * (len(sizes) - 1))]
        print(f'{len(sizes)} customers, estimated tokens: min {sizes[0]}, median {q(.5)}, p95 {q(.95)}, max {sizes[-1]}')
        return
    if not args.customer_id:
        ap.error('give a customer_id or --sizes')
    card = build_profile_card(args.customer_id)
    if args.json:
        print(json.dumps(card, indent=2, ensure_ascii=False))
    else:
        text = render_profile_card(card)
        print(text)
        print(f'\n[~{estimate_tokens(text)} tokens]')


if __name__ == '__main__':
    main()
