"""Same-period peer aggregates for Wrapped; only group averages reach the UI."""
from collections import defaultdict
from decimal import Decimal

MIN_PEERS = 10
MONEY_KEYS = ('spend', 'saved', 'small_eur')
COUNT_KEYS = ('n_purchases', 'unique_merchants')


def cents(value):
    return int(Decimal(str(value)) * 100)


def build_peer_groups(facts):
    groups = {}
    for row in facts.values():
        key = row.get('peer_group')
        if not key:
            continue
        group = groups.setdefault(key, {'count': 0, 'categories': defaultdict(int),
                                       **{name: 0 for name in MONEY_KEYS + COUNT_KEYS}})
        group['count'] += 1
        for name in MONEY_KEYS:
            group[name] += cents(row[name])
        for name in COUNT_KEYS:
            group[name] += row[name]
        for category, values in row['categories'].items():
            group['categories'][category] += cents(values['eur'])
    return groups


def peer_averages(row, groups):
    """Exclude the subject, include category non-spenders, and never mix recap years."""
    group = groups.get(row.get('peer_group'))
    if not group or group['count'] - 1 < MIN_PEERS:
        return None
    count = group['count'] - 1
    categories = {name: (total - cents(row['categories'].get(name, {}).get('eur', 0))) / 100 / count
                  for name, total in group['categories'].items()}
    purchase_count = group['n_purchases'] - row['n_purchases']
    purchase_cents = sum(group['categories'].values()) - sum(cents(value['eur']) for value in row['categories'].values())
    return {'count': count, 'categories': categories,
            **{name: (group[name] - cents(row[name])) / 100 / count for name in MONEY_KEYS},
            **{name: (group[name] - row[name]) / count for name in COUNT_KEYS},
            'average_purchase_eur': purchase_cents / 100 / purchase_count if purchase_count else None}
