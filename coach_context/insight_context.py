"""Insight context: everything the model may know when it writes the 3 key insights for ONE customer.

It is the profile card plus the detail needed to explain *why*:
  - per spending line: how often and how much per payment, the same for peers, the Finnish average,
    where the customer stands among peers, last month against their usual month
  - how safe-to-spend was limited, the late-salary chance, the three weekly limits
  - the peer group's model parameters (hierarchical priors): typical frequency and size per line,
    how bursty months are, how much Statistics Finland weighs in

Privacy: the context holds the customer's own rows and GROUP-LEVEL numbers only (medians and model
parameters of a peer group of dozens to hundreds of people). No other customer's row is ever read
into it, and the customer ID is not included. tests/test_insight_context.py checks both.

    from coach_context.insight_context import InsightSource, build_insight_context, render_insight_context
    src = InsightSource()                              # once, at startup
    ctx = build_insight_context('CUST04971', src)      # dict, JSON-safe
    text = render_insight_context(ctx)                 # plain text for the prompt (~1,500 tokens)

CLI:  python -m coach_context.insight_context CUST04971 [--json]

Stdlib only. Deterministic: the same data always gives byte-identical text.
"""
import argparse
import json
from collections import defaultdict

from .profile_card import (CardSource, SAFE_LIMIT_TEXT, _eur, _f, build_profile_card, estimate_tokens,
                           nice, nice_down, render_profile_card)

MIN_LINE_EUR = 5          # lines below this €/month (customer and peers) are left out
MIN_GROUP_SIZE = 10       # a peer group smaller than this is not described (too close to individuals)

HOW_IT_WORKS = [
    "Monthly amounts are model estimates of the customer's usual month (about 2 years of history), not one "
    "calendar month. A line's usual month = payments per month x euros per payment.",
    "Peers = people in the same age band and city. 'Peer median' is the middle person of that group.",
    "Safe-to-spend is the lowest of three weekly limits: cash on the account until the salary arrives "
    "(after bills due, usual essentials, a possible surprise cost and a 100 euro cushion, and allowing for a "
    "late salary), the usual monthly budget, and the budget of the last 12 months.",
    "Safe-to-save is a cautious share of what was left over each month in the last 12 months.",
    "The surprise fund target covers a bad year of unexpected costs (9 years out of 10).",
    "Burstiness says how uneven months are (1 = steady; 5 = some months several times the usual, others "
    "nothing). For bursty lines one expensive month says little about the usual level.",
]


class InsightSource(CardSource):
    """CardSource plus the peer-group model parameters (model_hyper.csv)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.hyper = defaultdict(dict)
        for r in self._read('model_hyper.csv'):
            self.hyper[r['peer_group']][r['line']] = r


_default_source = None


def default_source():
    global _default_source
    if _default_source is None:
        _default_source = InsightSource()
    return _default_source


def _round1(x):
    return None if x is None else round(x, 1)


def _line_detail(r, src):
    """One spending line of THIS customer, next to the peer group's median values for the same line."""
    you, peers = _f(r, 'expected_month'), _f(r, 'peer_median')
    lam, size = _f(r, 'lam'), _f(r, 'size_eur')
    out = {
        'line': r['line'], 'label': src.labels.get(r['line'], r['line']),
        'essential': r['line'] in src.essential,
        'eur_month': nice(you), 'peers_eur_month': nice(peers),
        'more_than_pct_of_peers': round(100 * _f(r, 'peer_pct')),
        # no national figure for housing: the Finnish average includes owners without rent or a loan
        'finland_eur_month': (nice(_f(r, 'national_eur'))
                              if (_f(r, 'national_eur') or 0) >= 5 and r['line'] != 'housing' else None),
    }
    if lam is not None and size is not None:       # frequency x size lines (not rent / utilities)
        out.update(payments_per_month=_round1(lam), eur_per_payment=nice(size),
                   peers_payments_per_month=_round1(_f(r, 'peer_lam_median')),
                   peers_eur_per_payment=nice(_f(r, 'peer_size_median')),
                   burstiness=_round1(_f(r, 'phi')))
        # State the reason for a gap to peers in words (same 1.3x rule as the engine's own insights),
        # so the model does not have to infer it from four numbers. It gets this wrong otherwise.
        ratio = _f(r, 'peer_ratio')
        if ratio is not None and ratio >= src.peer_min_ratio and you - peers >= src.peer_min_eur:
            often = lam / max(_f(r, 'peer_lam_median') or 0, 1e-6) >= 1.3
            bigger = size / max(_f(r, 'peer_size_median') or 0, 1e-6) >= 1.3
            out['why_above_peers'] = ('pays more often AND more each time' if often and bigger else
                                      'pays more often, about the same each time' if often else
                                      'pays about as often, but more each time' if bigger else
                                      'a bit more often and a bit more each time')
    last, usual = _f(r, 'last_month_eur'), _f(r, 'usual_month_eur')
    if last is not None and usual is not None:
        out.update(last_month_eur=nice(last), usual_month_eur=nice(usual),
                   last_month_was_highest_ever=str(r.get('last_month_is_record', '')).lower() == 'true')
    p_up, p_down = _f(r, 'p_up') or 0, _f(r, 'p_down') or 0
    if max(p_up, p_down) >= 0.95:                  # only real, model-confirmed changes of level
        out['level_change'] = {'direction': 'up' if p_up >= p_down else 'down',
                               'before_eur_month': nice(_f(r, 'base_month')),
                               'last_6_months_eur_month': nice(_f(r, 'recent_month'))}
    return out


def _peer_group(name, src):
    """Group-level model parameters only: nothing here identifies or describes a single person."""
    rows = src.hyper.get(name, {})
    size = max((int(float(r['n_cust'])) for r in rows.values()), default=0)
    if size < MIN_GROUP_SIZE:
        return {'name': name, 'people': size, 'lines': []}
    lines = []
    for line, r in sorted(rows.items()):
        a, b, m = _f(r, 'a'), _f(r, 'b'), _f(r, 'M')
        if not a or not b or m is None or (a / b) * m < MIN_LINE_EUR:
            continue
        lines.append({
            'line': line, 'label': src.labels.get(line, line),
            'typical_payments_per_month': _round1(a / b), 'typical_eur_per_payment': nice(m),
            'burstiness': _round1(_f(r, 'phi_g')),
            # how different people in the group are from each other (0.3 = alike, 1+ = very different)
            'spread_between_people': _round1(a ** -0.5),
            'statistics_finland_weight_pct': round(100 * (_f(r, 'statfin_weight') or 0), 1),
        })
    return {'name': name, 'people': size, 'lines': lines}


def build_insight_context(customer_id, source=None):
    """Context for one customer. Raises KeyError for unknown customers."""
    src = source or default_source()
    s = src.summary[customer_id]
    card = build_profile_card(customer_id, src)
    rows = sorted(src.lines[customer_id], key=lambda r: (-_f(r, 'expected_month'), r['line']))
    lines = [_line_detail(r, src) for r in rows
             if max(_f(r, 'expected_month'), _f(r, 'peer_median')) >= MIN_LINE_EUR]
    limits = {'cash_until_payday': _f(s, 'safe_week_cash'), 'monthly_budget': _f(s, 'safe_week_budget'),
              'recent_budget': _f(s, 'safe_week_budget_12m')}
    return {
        'profile': card,
        'safe_to_spend_detail': {
            'eur_week': card['safe_to_spend']['eur_week'],
            'limited_by': card['safe_to_spend']['limit'],
            'weekly_limits_eur': {k: nice_down(max(v, 0)) for k, v in limits.items()},
            'usual_extras_eur_week': nice(_f(s, 'extras_12m') * 7 / 30.44),
            'late_salary_chance_pct': round(100 * (_f(s, 'p_late_payday') or 0)),
        },
        'money_left_over_eur_month': nice(_f(s, 'surplus_month') or 0),
        'lines': lines,
        'peer_group': _peer_group(s['peer_group'], src),
        'how_it_works': HOW_IT_WORKS,
    }


def render_insight_context(ctx):
    """Plain text for the prompt. Deterministic for a given context."""
    d, g = ctx['safe_to_spend_detail'], ctx['peer_group']
    w = d['weekly_limits_eur']
    out = [render_profile_card(ctx['profile']), "",
           "SAFE-TO-SPEND DETAIL",
           f"{_eur(d['eur_week'])}/week, {SAFE_LIMIT_TEXT.get(d['limited_by'], d['limited_by'])}. "
           f"The three weekly limits: cash until the salary arrives {_eur(w['cash_until_payday'])}, usual monthly "
           f"budget {_eur(w['monthly_budget'])}, budget of the last 12 months {_eur(w['recent_budget'])}. "
           f"The LOWEST of the three applies"
           + (", so cash until the salary is what holds it back. " if d['limited_by'] == 'cash_until_payday'
              else ", so the budget holds it back, not the cash on the account. ")
           +
           f"Usual spending on extras: {_eur(d['usual_extras_eur_week'])}/week. "
           f"Chance the next salary arrives late: {d['late_salary_chance_pct']} %.",
           f"Left over in a usual month after all spending and current saving: "
           f"{_eur(ctx['money_left_over_eur_month'])}.",
           "",
           "SPENDING LINES IN DETAIL (you | peer median)"]
    for l in ctx['lines']:
        parts = [f"{_eur(l['eur_month'])} | {_eur(l['peers_eur_month'])} a month",
                 f"more than {l['more_than_pct_of_peers']} % of peers"]
        if 'payments_per_month' in l:
            parts.append(f"{l['payments_per_month']:g} payments a month of {_eur(l['eur_per_payment'])} | "
                         f"{l['peers_payments_per_month']:g} of {_eur(l['peers_eur_per_payment'])}")
            parts.append(f"burstiness {l['burstiness']:g}")
        if 'why_above_peers' in l:
            parts.append(f"REASON for the gap to peers: {l['why_above_peers']}")
        if l['finland_eur_month'] is not None:
            parts.append(f"Finland average {_eur(l['finland_eur_month'])}")
        if 'last_month_eur' in l:
            parts.append(f"last month {_eur(l['last_month_eur'])} vs usual {_eur(l['usual_month_eur'])}"
                         + (" (highest month on record)" if l['last_month_was_highest_ever'] else ""))
        if 'level_change' in l:
            c = l['level_change']
            parts.append(f"level really went {c['direction']}: {_eur(c['before_eur_month'])} before, "
                         f"{_eur(c['last_6_months_eur_month'])} in the last 6 months")
        out.append(f"- {l['label']}{'*' if l['essential'] else ''}: " + "; ".join(parts))
    out += ["", f"PEER GROUP MODEL: {g['name']} ({g['people']} people). Group-level numbers, no individuals."]
    out += [f"- {l['label']}: typically {l['typical_payments_per_month']:g} payments a month of "
            f"{_eur(l['typical_eur_per_payment'])}; burstiness {l['burstiness']:g}; spread between people "
            f"{l['spread_between_people']:g}; Statistics Finland weight {l['statistics_finland_weight_pct']:g} %"
            for l in g['lines']]
    out += ["", "HOW THE NUMBERS ARE MADE"] + [f"- {x}" for x in ctx['how_it_works']]
    return '\n'.join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('customer_id')
    ap.add_argument('--json', action='store_true', help='print the structured context instead of the text')
    args = ap.parse_args(argv)
    ctx = build_insight_context(args.customer_id)
    if args.json:
        print(json.dumps(ctx, indent=2, ensure_ascii=False))
    else:
        text = render_insight_context(ctx)
        print(text)
        print(f'\n[~{estimate_tokens(text)} tokens]')


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    main()
