"""Build deterministic customer metrics from the Junction transaction data.

Outputs (in Features/):
  customer_monthly.csv   one row per customer per month
  customer_features.csv  one row per customer

Stdlib only. One streaming pass over the 343 MB transaction file (~3-5 min).
Usage: python scripts/build_features.py [data_dir] [out_dir]
"""
import csv
import os
import statistics
import sys
import time
from array import array
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'Data')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'Features')

DATA_END = date(2026, 9, 30)
FULL_MONTHS_FROM = '2024-11'  # Oct 2024 is partial for some accounts
LARGE_PURCHASE = 1000.0
PAYDAY_WINDOW_DAYS = 3  # salary day + 2 following days

PURCHASE_CATS = {
    'Groceries': 'groceries', 'Restaurants': 'restaurants', 'Transportation': 'transportation',
    'Entertainment': 'entertainment', 'Health': 'health', 'Home & Tech': 'home_tech',
    'Lifestyle': 'lifestyle', 'Travel': 'travel',
}
MONTHLY_COLS = [
    'customer_id', 'month', 'days_observed', 'n_tx', 'n_purchases',
    'income_total', 'salary', 'other_income', 'investment_withdrawal',
    'spend_total', 'purchases_total', *PURCHASE_CATS.values(), 'utilities', 'housing',
    'investment_deposit', 'salary_sweep', 'net_flow',
    'balance_start', 'balance_end', 'balance_min', 'balance_max', 'balance_mean_daily',
    'days_negative', 'n_large_purchases', 'max_purchase', 'weekend_purchases_total',
]
SUM_COLS = MONTHLY_COLS[3:MONTHLY_COLS.index('balance_start')] + ['n_large_purchases', 'weekend_purchases_total']


def load(name):
    with open(os.path.join(DATA, name), encoding='utf-8-sig', newline='') as fh:
        return list(csv.DictReader(fh))


def sas_ts(s):
    return datetime.strptime(s, '%d%b%y:%H:%M:%S')


def r2(x):
    return '' if x is None else round(x, 2)


def r4(x):
    return '' if x is None else round(x, 4)


def div(a, b):
    return a / b if b else None


def mean(xs):
    return statistics.mean(xs) if xs else None


def median(xs):
    return statistics.median(xs) if xs else None


def sd(xs):
    return statistics.stdev(xs) if len(xs) > 1 else None


def month_of(d):
    return d.isoformat()[:7]


# ---------- reference data ----------
customers = {r['customer_id']: r for r in load('tx_customers_junction.csv')}
link = {r['customer_id']: r for r in load('mtg_tx_customer_link_and_final_mtg_infio.csv')}
mid_to_cid = {r['mortgage_customer_id']: cid for cid, r in link.items()}
app_date, decision_date = {}, {}
for r in load('mtg_negotiation_history.csv'):
    cid = mid_to_cid[r['mortgage_customer_id']]
    if r['event_type'] == 'application_created':
        app_date[cid] = sas_ts(r['timestamp']).date()
    elif r['event_type'] == 'loan_decision':
        decision_date[cid] = sas_ts(r['timestamp']).date()

# ---------- accumulators ----------
monthly = {}  # (cid, month) -> dict


def mrow(cid, m):
    key = (cid, m)
    row = monthly.get(key)
    if row is None:
        row = dict.fromkeys(SUM_COLS, 0.0)
        row.update(days_observed=0, balance_start=None, balance_end=None, balance_min=None,
                   balance_max=None, bal_sum=0.0, days_negative=0, max_purchase=0.0)
        monthly[key] = row
    return row


class Cust:
    __slots__ = ('purchases', 'merchants', 'no_merchant', 'hours', 'weekday_n', 'payday_spend',
                 'last_salary', 'salary_days', 'bal_n', 'bal_sum', 'bal_sq', 'bal_min', 'bal_max',
                 'neg_days', 'neg_streak', 'neg_longest', 'neg_episodes', 'opening', 'closing',
                 'first_date', 'bal_at_app')

    def __init__(self):
        self.purchases = array('d'); self.merchants = Counter(); self.no_merchant = 0
        self.hours = Counter(); self.weekday_n = Counter(); self.payday_spend = 0.0
        self.last_salary = None; self.salary_days = Counter()
        self.bal_n = 0; self.bal_sum = 0.0; self.bal_sq = 0.0
        self.bal_min = float('inf'); self.bal_max = float('-inf')
        self.neg_days = 0; self.neg_streak = 0; self.neg_longest = 0; self.neg_episodes = 0
        self.opening = None; self.closing = None; self.first_date = None; self.bal_at_app = None


cust = defaultdict(Cust)


def close_day(cid, c, day, bal):
    """Record the end-of-day balance for one calendar day."""
    row = mrow(cid, month_of(day))
    if row['balance_start'] is None:
        row['balance_start'] = prev_month_end.get(cid, c.opening)
    row['days_observed'] += 1
    row['bal_sum'] += bal
    row['balance_end'] = bal
    row['balance_min'] = bal if row['balance_min'] is None else min(row['balance_min'], bal)
    row['balance_max'] = bal if row['balance_max'] is None else max(row['balance_max'], bal)
    c.bal_n += 1; c.bal_sum += bal; c.bal_sq += bal * bal
    c.bal_min = min(c.bal_min, bal); c.bal_max = max(c.bal_max, bal)
    if bal < 0:
        row['days_negative'] += 1; c.neg_days += 1
        if c.neg_streak == 0:
            c.neg_episodes += 1
        c.neg_streak += 1; c.neg_longest = max(c.neg_longest, c.neg_streak)
    else:
        c.neg_streak = 0
    if cid in app_date and day == app_date[cid] - timedelta(days=1):
        c.bal_at_app = bal
    if (day + timedelta(days=1)).month != day.month:
        prev_month_end[cid] = bal


prev_month_end = {}


def advance(cid, c, cur_day, cur_bal, until):
    """Close cur_day and carry the balance through every day before `until`."""
    d = cur_day
    while d < until:
        close_day(cid, c, d, cur_bal)
        d += timedelta(days=1)


# ---------- stream transactions ----------
t0 = time.time()
cur_cid = cur_day = cur_bal = None
with open(os.path.join(DATA, 'tx_junction_transactions.csv'), encoding='utf-8-sig', newline='') as fh:
    rd = csv.reader(fh)
    next(rd)
    for n, (cid, _acc, d, ts, cat, amt, bal, ttype, merch, _mcc) in enumerate(rd, 1):
        amt = float(amt); bal = float(bal)
        day = date.fromisoformat(d)
        c = cust[cid]
        if cid != cur_cid:
            if cur_cid is not None:
                advance(cur_cid, cust[cur_cid], cur_day, cur_bal, DATA_END + timedelta(days=1))
                cust[cur_cid].closing = cur_bal
            cur_cid = cid; c.opening = bal - amt; c.first_date = day
        elif day != cur_day:
            advance(cid, c, cur_day, cur_bal, day)
        cur_day, cur_bal = day, bal

        row = mrow(cid, d[:7])
        if row['balance_start'] is None:
            row['balance_start'] = prev_month_end.get(cid, c.opening)
        row['balance_min'] = bal if row['balance_min'] is None else min(row['balance_min'], bal)
        row['balance_max'] = bal if row['balance_max'] is None else max(row['balance_max'], bal)
        row['n_tx'] += 1
        row['net_flow'] += amt
        spend = -amt
        if ttype == 'purchase':
            col = PURCHASE_CATS[cat]
            row[col] += spend; row['purchases_total'] += spend; row['spend_total'] += spend
            row['n_purchases'] += 1
            row['max_purchase'] = max(row['max_purchase'], spend)
            if spend >= LARGE_PURCHASE:
                row['n_large_purchases'] += 1
            t = sas_ts(ts)
            if t.weekday() >= 5:
                row['weekend_purchases_total'] += spend
            c.purchases.append(spend)
            c.hours[t.hour] += 1
            c.weekday_n[t.weekday()] += 1
            if merch:
                c.merchants[merch] += 1
            else:
                c.no_merchant += 1
            if c.last_salary and 0 <= (day - c.last_salary).days < PAYDAY_WINDOW_DAYS:
                c.payday_spend += spend
        elif ttype == 'utilities_payment':
            row['utilities'] += spend; row['spend_total'] += spend
        elif ttype == 'housing_payment':
            row['housing'] += spend; row['spend_total'] += spend
        elif ttype == 'investment_deposit':
            row['investment_deposit'] += spend
        elif ttype == 'salary_sweep':
            row['salary_sweep'] += spend
        elif ttype == 'salary':
            row['salary'] += amt; row['income_total'] += amt
            c.last_salary = day; c.salary_days[day.day] += 1
        elif ttype == 'other_income':
            row['other_income'] += amt; row['income_total'] += amt
        elif ttype == 'investment_withdrawal':
            row['investment_withdrawal'] += amt; row['income_total'] += amt
        if n % 500000 == 0:
            print(f'{n:,} rows, {time.time() - t0:.0f}s', flush=True)
    advance(cur_cid, cust[cur_cid], cur_day, cur_bal, DATA_END + timedelta(days=1))
    cust[cur_cid].closing = cur_bal
print(f'streamed in {time.time() - t0:.0f}s', flush=True)

# ---------- write monthly ----------
os.makedirs(OUT, exist_ok=True)
by_cust = defaultdict(list)
with open(os.path.join(OUT, 'customer_monthly.csv'), 'w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    w.writerow(MONTHLY_COLS)
    for (cid, m) in sorted(monthly):
        row = monthly[(cid, m)]
        row['balance_mean_daily'] = div(row['bal_sum'], row['days_observed'])
        by_cust[cid].append((m, row))
        out = []
        for col in MONTHLY_COLS:
            if col == 'customer_id': out.append(cid)
            elif col == 'month': out.append(m)
            elif col in ('days_observed', 'n_tx', 'n_purchases', 'days_negative', 'n_large_purchases'):
                out.append(int(row[col]))
            else: out.append(r2(row[col]))
        w.writerow(out)

# ---------- customer features ----------
FEATURE_COLS = [
    'customer_id', 'age', 'postal_code', 'postal_area',
    'first_tx_date', 'n_full_months', 'n_tx', 'tx_per_month',
    'income_monthly_mean', 'income_monthly_median', 'income_monthly_sd',
    'salary_monthly_mean', 'salary_cv', 'salary_payday', 'other_income_months_share',
    'spend_monthly_mean', 'spend_monthly_median', 'spend_monthly_sd', 'spend_monthly_cv',
    'purchases_monthly_mean', 'purchases_monthly_median',
    *[f'share_{v}' for v in PURCHASE_CATS.values()],
    'utilities_monthly_mean', 'housing_monthly_mean', 'housing_share_of_income',
    'purchase_amount_mean', 'purchase_amount_median', 'purchase_amount_p90', 'purchase_amount_max',
    'n_large_purchases', 'purchases_per_month',
    'share_purchases_morning', 'share_purchases_afternoon', 'share_purchases_evening',
    'purchase_hour_mean', 'share_purchases_weekend', 'share_spend_weekend',
    'payday_spend_share', 'payday_spend_ratio',
    'n_unique_merchants', 'top_merchant_share', 'share_purchases_no_merchant',
    'spend_to_income', 'savings_rate', 'investment_deposit_monthly_mean', 'salary_sweep_monthly_mean',
    'net_flow_monthly_mean', 'spend_trend_last6_vs_first6',
    'balance_opening', 'balance_closing', 'balance_daily_mean', 'balance_daily_sd',
    'balance_min', 'balance_max', 'balance_change_total',
    'days_negative', 'share_days_negative', 'n_overdraft_episodes', 'longest_negative_streak_days',
    'months_with_negative_balance',
    'has_mortgage_application', 'mortgage_customer_id', 'application_date', 'decision_date',
    'final_decision', 'rejection_reason', 'final_property_price_eur', 'final_requested_loan_eur',
    'final_equity_amount_eur', 'final_collateral_value_eur', 'required_monthly_income_eur',
    'loan_to_value',
    'pre_app_window_months', 'pre_app_income_monthly_mean', 'pre_app_spend_monthly_mean',
    'pre_app_purchases_monthly_mean', 'pre_app_spend_to_income', 'pre_app_savings_rate',
    'pre_app_balance_at_application', 'pre_app_balance_min', 'pre_app_share_days_negative',
    'pre_app_n_large_purchases', 'pre_app_income_to_required',
]


def window_stats(rows):
    inc = sum(r['income_total'] for r in rows)
    spend = sum(r['spend_total'] for r in rows)
    saved = sum(r['investment_deposit'] + r['salary_sweep'] - r['investment_withdrawal'] for r in rows)
    return inc, spend, saved


with open(os.path.join(OUT, 'customer_features.csv'), 'w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    w.writerow(FEATURE_COLS)
    for cid in sorted(customers):
        c = cust[cid]; info = customers[cid]
        full = [r for m, r in by_cust[cid] if m >= FULL_MONTHS_FROM]
        nm = len(full)
        inc = [r['income_total'] for r in full]
        sal = [r['salary'] for r in full if r['salary'] > 0]
        spend = [r['spend_total'] for r in full]
        purch = [r['purchases_total'] for r in full]
        tot_inc, tot_spend, tot_saved = window_stats(full)
        tot_purch = sum(purch)
        p = sorted(c.purchases)
        n_p = len(p)
        n_hours = sum(c.hours.values())
        weekend_spend = sum(r['weekend_purchases_total'] for r in full)
        n_salaries = sum(c.salary_days.values())
        expected_payday_share = div(PAYDAY_WINDOW_DAYS * n_salaries, c.bal_n)
        payday_share = div(c.payday_spend, sum(p))
        bal_mean = div(c.bal_sum, c.bal_n)
        bal_sd = (c.bal_sq / c.bal_n - bal_mean ** 2) ** 0.5 if c.bal_n else None
        first6, last6 = purch[:6], purch[-6:]
        f = {
            'customer_id': cid, 'age': info['customer_age'], 'postal_code': info['customer_postal_code'],
            'postal_area': info['customer_postal_code'][:3],
            'first_tx_date': c.first_date.isoformat(), 'n_full_months': nm,
            'n_tx': sum(int(r['n_tx']) for _, r in by_cust[cid]),
            'tx_per_month': r2(div(sum(r['n_tx'] for r in full), nm)),
            'income_monthly_mean': r2(mean(inc)), 'income_monthly_median': r2(median(inc)),
            'income_monthly_sd': r2(sd(inc)),
            'salary_monthly_mean': r2(mean(sal)), 'salary_cv': r4(div(sd(sal), mean(sal))),
            'salary_payday': c.salary_days.most_common(1)[0][0] if c.salary_days else '',
            'other_income_months_share': r4(div(sum(1 for r in full if r['other_income'] > 0), nm)),
            'spend_monthly_mean': r2(mean(spend)), 'spend_monthly_median': r2(median(spend)),
            'spend_monthly_sd': r2(sd(spend)), 'spend_monthly_cv': r4(div(sd(spend), mean(spend))),
            'purchases_monthly_mean': r2(mean(purch)), 'purchases_monthly_median': r2(median(purch)),
            'utilities_monthly_mean': r2(mean([r['utilities'] for r in full])),
            'housing_monthly_mean': r2(mean([r['housing'] for r in full])),
            'housing_share_of_income': r4(div(sum(r['housing'] for r in full), tot_inc)),
            'purchase_amount_mean': r2(div(sum(p), n_p)), 'purchase_amount_median': r2(median(p)),
            'purchase_amount_p90': r2(p[int(0.9 * (n_p - 1))] if p else None),
            'purchase_amount_max': r2(p[-1] if p else None),
            'n_large_purchases': sum(int(r['n_large_purchases']) for _, r in by_cust[cid]),
            'purchases_per_month': r2(div(sum(r['n_purchases'] for r in full), nm)),
            'share_purchases_morning': r4(div(sum(v for h, v in c.hours.items() if h < 12), n_hours)),
            'share_purchases_afternoon': r4(div(sum(v for h, v in c.hours.items() if 12 <= h < 18), n_hours)),
            'share_purchases_evening': r4(div(sum(v for h, v in c.hours.items() if h >= 18), n_hours)),
            'purchase_hour_mean': r2(div(sum(h * v for h, v in c.hours.items()), n_hours)),
            'share_purchases_weekend': r4(div(c.weekday_n[5] + c.weekday_n[6], n_hours)),
            'share_spend_weekend': r4(div(weekend_spend, tot_purch)),
            'payday_spend_share': r4(payday_share),
            'payday_spend_ratio': r4(div(payday_share, expected_payday_share)) if payday_share is not None else '',
            'n_unique_merchants': len(c.merchants),
            'top_merchant_share': r4(div(c.merchants.most_common(1)[0][1], n_p)) if c.merchants else '',
            'share_purchases_no_merchant': r4(div(c.no_merchant, n_p)),
            'spend_to_income': r4(div(tot_spend, tot_inc)), 'savings_rate': r4(div(tot_saved, tot_inc)),
            'investment_deposit_monthly_mean': r2(mean([r['investment_deposit'] for r in full])),
            'salary_sweep_monthly_mean': r2(mean([r['salary_sweep'] for r in full])),
            'net_flow_monthly_mean': r2(mean([r['net_flow'] for r in full])),
            'spend_trend_last6_vs_first6': r4(div(sum(last6), sum(first6))),
            'balance_opening': r2(c.opening), 'balance_closing': r2(c.closing),
            'balance_daily_mean': r2(bal_mean), 'balance_daily_sd': r2(bal_sd),
            'balance_min': r2(c.bal_min), 'balance_max': r2(c.bal_max),
            'balance_change_total': r2(c.closing - c.opening),
            'days_negative': c.neg_days, 'share_days_negative': r4(div(c.neg_days, c.bal_n)),
            'n_overdraft_episodes': c.neg_episodes, 'longest_negative_streak_days': c.neg_longest,
            'months_with_negative_balance': sum(1 for _, r in by_cust[cid] if r['days_negative'] > 0),
        }
        f.update({f'share_{col}': r4(div(sum(r[col] for r in full), tot_purch)) for col in PURCHASE_CATS.values()})
        f['has_mortgage_application'] = int(cid in link)
        if cid in link:
            L = link[cid]
            f.update({
                'mortgage_customer_id': L['mortgage_customer_id'],
                'application_date': app_date[cid].isoformat(), 'decision_date': decision_date[cid].isoformat(),
                'final_decision': L['final_decision'], 'rejection_reason': L['rejection_reason'],
                'final_property_price_eur': L['final_property_price_eur'],
                'final_requested_loan_eur': L['final_requested_loan_eur'],
                'final_equity_amount_eur': L['final_equity_amount_eur'],
                'final_collateral_value_eur': L['final_collateral_value_eur'],
                'required_monthly_income_eur': r2(float(L['required_monthly_income_eur'])),
                'loan_to_value': r4(float(L['lfinal_loan_to_value'])),
            })
            app_m = month_of(app_date[cid])
            pre = [r for m, r in by_cust[cid] if FULL_MONTHS_FROM <= m < app_m]
            pre_all = [r for m, r in by_cust[cid] if m < app_m]
            p_inc, p_spend, p_saved = window_stats(pre)
            p_days = sum(r['days_observed'] for r in pre_all)
            f.update({
                'pre_app_window_months': len(pre),
                'pre_app_income_monthly_mean': r2(div(p_inc, len(pre))),
                'pre_app_spend_monthly_mean': r2(div(p_spend, len(pre))),
                'pre_app_purchases_monthly_mean': r2(mean([r['purchases_total'] for r in pre])),
                'pre_app_spend_to_income': r4(div(p_spend, p_inc)),
                'pre_app_savings_rate': r4(div(p_saved, p_inc)),
                'pre_app_balance_at_application': r2(c.bal_at_app),
                'pre_app_balance_min': r2(min(r['balance_min'] for r in pre_all)),
                'pre_app_share_days_negative': r4(div(sum(r['days_negative'] for r in pre_all), p_days)),
                'pre_app_n_large_purchases': sum(int(r['n_large_purchases']) for r in pre_all),
                'pre_app_income_to_required': r4(div(div(p_inc, len(pre)), float(L['required_monthly_income_eur']))),
            })
        w.writerow([f.get(col, '') for col in FEATURE_COLS])

print(f'done in {time.time() - t0:.0f}s -> {OUT}')
