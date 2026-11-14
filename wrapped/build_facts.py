"""Compute "Money Wrapped" facts for every customer from the raw transactions (one streaming pass, ~3 min).

The recap year is the last 12 months of data: 2025-10-01 .. 2026-09-30. The same facts are computed for the
year before it (2024-10-01 .. 2025-09-30), for the previous-year story and the "what changed" card.
Writes wrapped/output/facts.json: {period, customers: {customer_id: {...facts...}}, previous: {period, customers}}.
Cards are built from it by wrapped/cards.py.

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
# The data starts in Oct 2024: 97 % of accounts have their first transaction by 4 Oct 2024, all by 23 Oct.
PREV_START, PREV_END = date(2024, 10, 1), date(2025, 9, 30)
SMALL_EUR = 10.0
SPEND_TYPES = {'purchase', 'utilities_payment', 'housing_payment'}
DAYPARTS = [(5, 11, 'aamu'), (12, 17, 'iltapäivä'), (18, 23, 'ilta')]


def daypart(hour):
    return next((name for lo, hi, name in DAYPARTS if lo <= hour <= hi), 'yö')


class Acc:
    """One customer's totals for one period."""

    def __init__(self, start, end):
        self.start, self.end = start, end
        self.income = self.spend = self.saved = 0.0
        self.month_spend = defaultdict(float)
        self.month_saved = defaultdict(float)
        self.cats = defaultdict(lambda: [0.0, 0])  # category -> [eur, count] (purchases)
        self.small_n, self.small_eur = 0, 0.0
        self.biggest = None  # (eur, date, category, mcc)
        self.merchants = Counter()
        self.merchant_mcc = {}
        self.slots = Counter()  # (weekday, daypart)
        self.hours = Counter()
        self.n_purchases = 0
        # daily balance, this period only
        self.green = self.neg = 0
        self.streak = self.best_streak = 0
        self.episodes = self.recoveries = 0
        self.prev_neg = None
        self.cur_day = None
        self.cur_bal = None

    def close_day(self, day, bal):
        if not (self.start <= day <= self.end):
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

    def facts(self, peer_group):
        top_merchant = self.merchants.most_common(1)[0] if self.merchants else None
        slot = self.slots.most_common(1)[0] if self.slots else None
        hour = self.hours.most_common(1)[0][0] if self.hours else None
        return {
            'peer_group': peer_group,
            'income': round(self.income, 2), 'spend': round(self.spend, 2), 'saved': round(self.saved, 2),
            'month_spend': {m: round(v, 2) for m, v in sorted(self.month_spend.items())},
            'saving_months': sum(1 for v in self.month_saved.values() if v > 0.005),
            'n_purchases': self.n_purchases,
            'categories': {c: {'eur': round(v[0], 2), 'n': v[1]}
                           for c, v in sorted(self.cats.items(), key=lambda x: -x[1][0])},
            'small_n': self.small_n, 'small_eur': round(self.small_eur, 2),
            'biggest': None if self.biggest is None else
            {'eur': round(self.biggest[0], 2), 'date': self.biggest[1], 'category': self.biggest[2],
             'mcc': self.biggest[3]},
            'top_merchant': None if top_merchant is None else
            {'id': top_merchant[0], 'visits': top_merchant[1], 'mcc': self.merchant_mcc[top_merchant[0]]},
            'unique_merchants': len(self.merchants),
            'top_slot': None if slot is None else {'weekday': slot[0][0], 'daypart': slot[0][1], 'n': slot[1]},
            'top_hour': hour,
            'green_days': self.green, 'negative_days': self.neg, 'best_green_streak': self.best_streak,
            'negative_episodes': self.episodes, 'recoveries': self.recoveries, 'ends_green': not self.prev_neg,
        }


def add_peer_percentiles(facts):
    """Percentiles within the BDA peer group (same age band and area): share of peers at or below."""
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


def main():
    t0 = time.time()
    acc = defaultdict(lambda: (Acc(PREV_START, PREV_END), Acc(YEAR_START, YEAR_END)))  # (previous, current)
    weekday_of = {}
    cur = None
    end = YEAR_END + timedelta(days=1)
    with open(TX_CSV, encoding='utf-8-sig', newline='') as fh:
        rd = csv.reader(fh)
        next(rd)
        for n, (cid, _acc, d, ts, cat, amt, bal, ttype, merch, mcc) in enumerate(rd, 1):
            pair = acc[cid]
            amt, bal = float(amt), float(bal)
            day = weekday_of.get(d)
            if day is None:
                day = weekday_of[d] = date.fromisoformat(d)
            if cid != cur:
                if cur is not None:
                    for a in acc[cur]:
                        a.advance(end)
                cur = cid
            elif day != pair[0].cur_day:
                for a in pair:
                    a.advance(day)
            for a in pair:
                a.cur_day, a.cur_bal = day, bal
            if n % 1_000_000 == 0:
                print(f'{n:,} rows, {time.time() - t0:.0f}s', flush=True)
            a = pair[0] if day <= PREV_END else pair[1]
            if not (a.start <= day <= a.end):
                continue
            month = d[:7]
            spend = -amt if ttype in SPEND_TYPES else 0.0
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
    for a in acc[cur]:
        a.advance(end)

    peer_group = {}
    with open(BDA_SUMMARY, encoding='utf-8', newline='') as fh:
        for r in csv.DictReader(fh):
            peer_group[r['customer_id']] = r['peer_group']

    previous = {cid: pair[0].facts(peer_group.get(cid)) for cid, pair in acc.items()}
    facts = {cid: pair[1].facts(peer_group.get(cid)) for cid, pair in acc.items()}
    add_peer_percentiles(previous)
    add_peer_percentiles(facts)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump({'period': {'from': str(YEAR_START), 'to': str(YEAR_END)}, 'customers': facts,
                   'previous': {'period': {'from': str(PREV_START), 'to': str(PREV_END)}, 'customers': previous}},
                  fh, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(facts)} customers in {time.time() - t0:.0f}s -> {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
