"""Compute "Money Wrapped" facts for every customer from the raw transactions (one streaming pass, ~3 min).

The recap year is the last 12 months of data: 2025-10-01 .. 2026-09-30.
Writes wrapped/output/facts.json: {customer_id: {...facts...}}. Cards are built from it by wrapped/cards.py.

Usage (repo root):  python wrapped/build_facts.py
Stdlib only.
"""
import csv
import json
import time
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TX_CSV = REPO / 'Data' / 'tx_junction_transactions.csv'
BDA_SUMMARY = REPO / 'BDA' / 'output' / 'customer_summary.csv'
OUT = Path(__file__).resolve().parent / 'output' / 'facts.json'

YEAR_START, YEAR_END = date(2025, 10, 1), date(2026, 9, 30)
# "Vs last year" compares the same 11 complete months (Oct 2024 is partial for many accounts).
CMP_PREV = ('2024-11', '2025-09')
CMP_CUR = ('2025-11', '2026-09')
SMALL_EUR = 10.0
SPEND_TYPES = {'purchase', 'utilities_payment', 'housing_payment'}
DAYPARTS = [(5, 11, 'aamu'), (12, 17, 'iltapäivä'), (18, 23, 'ilta')]


def daypart(hour):
    return next((name for lo, hi, name in DAYPARTS if lo <= hour <= hi), 'yö')


class Acc:
    def __init__(self):
        self.income = self.spend = self.saved = 0.0
        self.month_spend = defaultdict(float)
        self.month_saved = defaultdict(float)
        self.cmp_prev = self.cmp_cur = 0.0
        self.cats = defaultdict(lambda: [0.0, 0])  # category -> [eur, count] (purchases)
        self.small_n, self.small_eur = 0, 0.0
        self.biggest = None  # (eur, date, category, mcc)
        self.merchants = Counter()
        self.merchant_mcc = {}
        self.slots = Counter()  # (weekday, daypart)
        self.hours = Counter()
        self.n_purchases = 0
        # daily balance, recap year only
        self.green = self.neg = 0
        self.streak = self.best_streak = 0
        self.episodes = self.recoveries = 0
        self.prev_neg = None
        self.cur_day = None
        self.cur_bal = None

    def close_day(self, day, bal):
        if not (YEAR_START <= day <= YEAR_END):
            return
        if bal >= 0:
            self.green += 1
            self.streak += 1
            self.best_streak = max(self.best_streak, self.streak)
            if self.prev_neg:
                self.recoveries += 1
        else:
            self.neg += 1
            self.streak = 0
            if not self.prev_neg:
                self.episodes += 1
        self.prev_neg = bal < 0

    def advance(self, until):
        d = self.cur_day
        while d < until:
            self.close_day(d, self.cur_bal)
            d += timedelta(days=1)


def main():
    t0 = time.time()
    acc = defaultdict(Acc)
    weekday_of = {}
    cur = None
    with open(TX_CSV, encoding='utf-8-sig', newline='') as fh:
        rd = csv.reader(fh)
        next(rd)
        for n, (cid, _acc, d, ts, cat, amt, bal, ttype, merch, mcc) in enumerate(rd, 1):
            a = acc[cid]
            amt, bal = float(amt), float(bal)
            day = weekday_of.get(d)
            if day is None:
                day = weekday_of[d] = date.fromisoformat(d)
            if cid != cur:
                if cur is not None:
                    acc[cur].advance(YEAR_END + timedelta(days=1))
                cur = cid
            elif day != a.cur_day:
                a.advance(day)
            a.cur_day, a.cur_bal = day, bal
            month = d[:7]
            spend = -amt if ttype in SPEND_TYPES else 0.0
            if CMP_PREV[0] <= month <= CMP_PREV[1]:
                a.cmp_prev += spend
            elif CMP_CUR[0] <= month <= CMP_CUR[1]:
                a.cmp_cur += spend
            if not (YEAR_START <= day <= YEAR_END):
                continue
            if ttype in ('salary', 'other_income'):
                a.income += amt
            elif ttype in ('salary_sweep', 'investment_deposit', 'investment_withdrawal'):
                a.saved -= amt
                a.month_saved[month] -= amt
            if spend:
                a.spend += spend
                a.month_spend[month] += spend
            if ttype == 'purchase':
                a.n_purchases += 1
                c = a.cats[cat]
                c[0] += spend
                c[1] += 1
                if spend < SMALL_EUR:
                    a.small_n += 1
                    a.small_eur += spend
                if a.biggest is None or spend > a.biggest[0]:
                    a.biggest = (spend, d, cat, mcc)
                if merch:
                    a.merchants[merch] += 1
                    a.merchant_mcc[merch] = mcc
                hour = int(ts[8:10])
                a.hours[hour] += 1
                a.slots[(day.weekday(), daypart(hour))] += 1
            if n % 1_000_000 == 0:
                print(f'{n:,} rows, {time.time() - t0:.0f}s', flush=True)
    acc[cur].advance(YEAR_END + timedelta(days=1))

    peer_group = {}
    with open(BDA_SUMMARY, encoding='utf-8', newline='') as fh:
        for r in csv.DictReader(fh):
            peer_group[r['customer_id']] = r['peer_group']

    facts = {}
    for cid, a in acc.items():
        top_merchant = a.merchants.most_common(1)[0] if a.merchants else None
        slot = a.slots.most_common(1)[0] if a.slots else None
        hour = a.hours.most_common(1)[0][0] if a.hours else None
        facts[cid] = {
            'peer_group': peer_group.get(cid),
            'income': round(a.income, 2), 'spend': round(a.spend, 2), 'saved': round(a.saved, 2),
            'month_spend': {m: round(v, 2) for m, v in sorted(a.month_spend.items())},
            'saving_months': sum(1 for v in a.month_saved.values() if v > 0.005),
            'cmp_prev_spend': round(a.cmp_prev, 2), 'cmp_cur_spend': round(a.cmp_cur, 2),
            'n_purchases': a.n_purchases,
            'categories': {c: {'eur': round(v[0], 2), 'n': v[1]} for c, v in sorted(a.cats.items(), key=lambda x: -x[1][0])},
            'small_n': a.small_n, 'small_eur': round(a.small_eur, 2),
            'biggest': None if a.biggest is None else
            {'eur': round(a.biggest[0], 2), 'date': a.biggest[1], 'category': a.biggest[2], 'mcc': a.biggest[3]},
            'top_merchant': None if top_merchant is None else
            {'id': top_merchant[0], 'visits': top_merchant[1], 'mcc': a.merchant_mcc[top_merchant[0]]},
            'unique_merchants': len(a.merchants),
            'top_slot': None if slot is None else {'weekday': slot[0][0], 'daypart': slot[0][1], 'n': slot[1]},
            'top_hour': hour,
            'green_days': a.green, 'negative_days': a.neg, 'best_green_streak': a.best_streak,
            'negative_episodes': a.episodes, 'recoveries': a.recoveries, 'ends_green': not a.prev_neg,
        }

    # Percentiles within the BDA peer group (same age band and area): share of peers at or below.
    groups = defaultdict(list)
    for cid, f in facts.items():
        groups[f['peer_group']].append(cid)
    for key in ('n_purchases', 'small_n', 'unique_merchants'):
        for members in groups.values():
            values = sorted(facts[c][key] for c in members)
            for c in members:
                v = facts[c][key]
                below = sum(1 for x in values if x <= v)
                facts[c][f'{key}_peer_pct'] = round(100 * below / len(values))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump({'period': {'from': str(YEAR_START), 'to': str(YEAR_END)}, 'customers': facts},
                  fh, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(facts)} customers in {time.time() - t0:.0f}s -> {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
