"""Shortlist demo persona candidates from Features/ and BDA/output/.

Usage: python scripts/select_personas.py   (prints the top candidates per persona type)
Stdlib only. The final picks and their stories are recorded in demo/personas.json.
"""
import csv
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(*path):
    with open(os.path.join(ROOT, *path), encoding='utf-8-sig', newline='') as fh:
        return list(csv.DictReader(fh))


def num(row, key):
    v = row.get(key, '')
    return float(v) if v not in ('', None) else None


features = {r['customer_id']: r for r in load('Features', 'customer_features.csv')}
summary = {r['customer_id']: r for r in load('BDA', 'output', 'customer_summary.csv')}
spender = {r['customer_id']: r for r in load('BDA', 'output', 'spender_type.csv')}
monthly = defaultdict(list)
for r in load('Features', 'customer_monthly.csv'):
    monthly[r['customer_id']].append(r)


def clean(cid):
    """Complete, believable history: salary every full month, no extreme balances."""
    f = features[cid]
    full = [m for m in monthly[cid] if m['month'] >= '2024-11']
    return (all(float(m['salary']) > 0 for m in full) and num(f, 'balance_max') < 60000
            and num(f, 'income_monthly_mean') < 9000)


def shock(cid):
    """Biggest single month in 2026 where one large purchase pushed the balance below zero."""
    best = None
    for m in monthly[cid]:
        if m['month'] < '2026-01':
            continue
        big = float(m['max_purchase'])
        unplanned = max(float(m['health']), float(m['home_tech']))  # the big one must be health or home & tech
        if big >= 1200 and unplanned >= big and float(m['balance_min']) < 0 and (best is None or big > best[1]):
            best = (m['month'], big, float(m['balance_min']))
    return best


def neg_months_before(cid, month):
    return sum(1 for m in monthly[cid] if '2024-11' <= m['month'] < month and int(m['days_negative']) > 0)


TYPES = {
    'tight_young_adult': dict(
        test=lambda f, s: 20 <= num(f, 'age') <= 27 and num(f, 'spend_to_income') >= 0.95
        and 0.10 <= num(f, 'share_days_negative') <= 0.6 and num(f, 'savings_rate') < 0.05,
        score=lambda f, s: num(f, 'share_days_negative') + num(f, 'share_restaurants') + num(f, 'share_entertainment')),
    'payday_splurger': dict(
        test=lambda f, s: 26 <= num(f, 'age') <= 45 and num(f, 'payday_spend_ratio') >= 1.8
        and 0.7 <= num(f, 'spend_to_income') <= 1.0 and num(f, 'share_days_negative') <= 0.15,
        score=lambda f, s: num(f, 'payday_spend_ratio')),
    # Approved mortgage applicants save 90%+ of income in this data, which is not believable on stage,
    # so the home-buyer story uses a realistic young saver plus the bank's affordability rule.
    'saver_home_buyer': dict(
        test=lambda f, s: 26 <= num(f, 'age') <= 35 and 0.15 <= num(f, 'savings_rate') <= 0.4
        and 0.5 <= num(f, 'spend_to_income') <= 0.85 and num(f, 'share_days_negative') == 0
        and num(f, 'balance_change_total') > 0,
        score=lambda f, s: num(f, 'savings_rate') - abs(num(f, 'spend_trend_last6_vs_first6') - 1) / 4),
    'surprise_cost': dict(
        test=lambda f, s: 35 <= num(f, 'age') <= 60 and num(f, 'spend_to_income') <= 0.95
        and 2300 <= num(f, 'income_monthly_mean') <= 4800
        and shock(f['customer_id']) is not None
        and neg_months_before(f['customer_id'], shock(f['customer_id'])[0]) <= 1,
        score=lambda f, s: shock(f['customer_id'])[1]),
}

SHOW = ['age', 'postal_area', 'income_monthly_mean', 'spend_to_income', 'savings_rate', 'share_days_negative',
        'payday_spend_ratio', 'share_restaurants', 'pre_app_savings_rate', 'final_decision']

if __name__ == '__main__':
    for name, t in TYPES.items():
        hits = [(t['score'](f, summary[cid]), cid) for cid, f in features.items()
                if clean(cid) and t['test'](f, summary[cid])]
        hits.sort(reverse=True)
        print(f'\n=== {name}: {len(hits)} candidates')
        for sc, cid in hits[:6]:
            f, s = features[cid], summary[cid]
            info = ' '.join(f'{k}={f[k]}' for k in SHOW if f.get(k) not in ('', None))
            print(f'  {cid} score={sc:.2f} {info} | type="{spender[cid]["label"]}" '
                  f'safe_week={s["safe_to_spend_week"]} binding={s["safe_binding"]} shock={shock(cid)}')
