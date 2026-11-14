"""Turn Wrapped facts + the BDA model's outputs into Finnish story cards.

    from wrapped.cards import load_sources, build_cards
    src = load_sources()
    cards = build_cards('CUST04971', src)      # list of card dicts, ready for ui-demos/public/wrapped.js
    older = build_cards('CUST04971', src, year='previous')   # the story of the year before

The latest year's story carries a "what changed" card with the drastic differences between the two years.

Every number comes from wrapped/output/facts.json (raw transactions) or BDA/output (spending model).
Tone rules: never shame. Problems are shown as progress ("you got back to green 15 times"), every recap
has positive cards, essential spending (groceries, health) is never presented as a "favourite".
"""
import csv
import json
import math
from datetime import date
from pathlib import Path

from coach_context.profile_card import nice, nice_down
from wrapped.peers import build_peer_groups, peer_averages

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FACTS = HERE / 'output' / 'facts.json'
BDA_OUT = REPO / 'BDA' / 'output'

MAX_CARDS = 13
MONTHS = ['tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu', 'heinäkuu', 'elokuu',
          'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu']
WEEKDAYS = ['maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai', 'lauantai', 'sunnuntai']
DAYPART_ADVERB = {'aamu': 'aamuisin', 'iltapäivä': 'iltapäivisin', 'ilta': 'iltaisin', 'yö': 'öisin'}
CATEGORY_FI = {'Groceries': 'Ruokaostokset', 'Restaurants': 'Ravintolat', 'Transportation': 'Liikkuminen',
               'Entertainment': 'Vapaa-aika', 'Health': 'Terveys', 'Home & Tech': 'Koti ja tekniikka',
               'Lifestyle': 'Ostokset', 'Travel': 'Matkailu'}
CATEGORY_ASK = {'Restaurants': 'ravintolamenoistani', 'Transportation': 'liikkumisen menoistani',
                'Entertainment': 'vapaa-ajan menoistani', 'Lifestyle': 'ostoksistani',
                'Travel': 'matkailumenoistani', 'Home & Tech': 'koti- ja tekniikkamenoistani'}
ESSENTIAL_CATEGORIES = {'Groceries', 'Health'}
MCC_FI = {
    '5411': 'Ruokakauppa', '5499': 'Lähikauppa', '5422': 'Lihakauppa', '5451': 'Maitotuotemyymälä',
    '5812': 'Ravintola', '5814': 'Pikaruokapaikka', '5813': 'Baari', '5541': 'Huoltoasema',
    '5542': 'Polttoaineautomaatti', '4111': 'Joukkoliikenne', '4121': 'Taksi', '7523': 'Pysäköinti',
    '5912': 'Apteekki', '8011': 'Lääkäri', '8021': 'Hammaslääkäri', '8099': 'Terveyspalvelu',
    '7922': 'Teatteri ja liput', '7999': 'Vapaa-ajan palvelu', '7832': 'Elokuvateatteri', '7991': 'Nähtävyys',
    '7996': 'Huvipuisto', '5200': 'Kodin tarvikkeet', '5732': 'Elektroniikkaliike', '5251': 'Rautakauppa',
    '5712': 'Huonekaluliike', '5734': 'Ohjelmistokauppa', '5941': 'Urheiluliike', '5651': 'Vaateliike',
    '5999': 'Erikoisliike', '5691': 'Vaateliike', '5942': 'Kirjakauppa', '5945': 'Lelu- ja harrastekauppa',
    '4722': 'Matkatoimisto', '4511': 'Lentoyhtiö', '7011': 'Hotelli', '7512': 'Autovuokraamo',
}
ARCHETYPE_FI = {
    'Balanced spender': 'Tasapainoinen kuluttaja', 'On-the-go': 'Aina menossa', 'Shopper': 'Shoppailija',
    'Home & gadget investor': 'Koti- ja teknofani', 'Traveller': 'Maailmanmatkaaja',
    'Experience seeker': 'Elämysten etsijä', 'Big-ticket buyer': 'Isojen hankintojen tekijä',
    'Driver': 'Autoilija', 'Social butterfly': 'Seurapiiriperhonen', 'Takeaway lover': 'Noutoruoan ystävä',
    'Foodie': 'Ravintolagurmee',
}
LINE_FI = {
    'restaurants': 'ravintolat ja kahvilat', 'fast_food': 'pika- ja noutoruoka', 'bars': 'baarit',
    'taxi': 'taksit', 'parking': 'pysäköinti', 'transport_other': 'muu liikkuminen',
    'entertainment': 'vapaa-aika', 'lifestyle': 'ostokset ja hyvinvointi', 'travel': 'matkailu',
    'home_tech': 'koti ja tekniikka', 'big_purchase': 'isot kertaostokset',
}
THEMES = ['forest', 'lime', 'berry', 'green', 'sunset', 'ocean', 'mint', 'night']
NBSP = ' '


def eur(x):
    """Finnish money: 1 234 € (whole euros)."""
    return f'{round(x):,}'.replace(',', NBSP) + NBSP + '€'


def num(x):
    return f'{round(x):,}'.replace(',', NBSP)


def times(n):
    return 'kerran' if n == 1 else f'{n} kertaa'


def month_name(m):
    return MONTHS[int(m[5:7]) - 1]


def slot_phrase(weekday, daypart):
    """'perjantai' + 'iltaisin' -> 'perjantai-iltaisin' (hyphen when the vowels meet)."""
    first, second = WEEKDAYS[weekday], DAYPART_ADVERB[daypart]
    return first + ('-' if first[-1] == second[0] else '') + second


def load_sources():
    def read(name):
        with open(BDA_OUT / name, encoding='utf-8', newline='') as fh:
            return {r['customer_id']: r for r in csv.DictReader(fh)}
    facts = json.loads(FACTS.read_text(encoding='utf-8'))
    return {'period': facts['period'], 'facts': facts['customers'],
            'previous_period': facts['previous']['period'], 'previous': facts['previous']['customers'],
            'peer_groups': build_peer_groups(facts['customers']),
            'previous_peer_groups': build_peer_groups(facts['previous']['customers']),
            'summary': read('customer_summary.csv'), 'spender': read('spender_type.csv')}


def card(id_, layout, kicker, title='', body='', count=None, suffix='', ask=None, items=None, note=None,
         priority=0):
    return {'id': id_, 'layout': layout, 'kicker': kicker, 'title': title, 'body': body,
            'count': None if count is None else round(count), 'suffix': suffix, 'ask': ask, 'items': items or [], 'note': note,
            '_priority': priority}


def period_title(period):
    """{'from': '2025-10-01', 'to': '2026-09-30'} -> 'Lokakuu 2025 – syyskuu 2026'."""
    start, end = period['from'], period['to']
    return f'{month_name(start).capitalize()} {start[:4]} – {month_name(end)} {end[:4]}'


def signed(x, unit=''):
    """+1 234 € / −12 % (a real minus sign, so it lines up with the plus)."""
    x = round(x)
    return ('+' if x >= 0 else '−') + num(abs(x)) + (NBSP + unit if unit else '')


# A change makes the "what changed" card only when it is big both relatively and in euros:
# totals by 20 % and 300 €, a purchase category by 50 % and 500 €, days in the green up by 10 points.
BIG_PCT, BIG_EUR, BIG_CATEGORY_PCT, BIG_CATEGORY_EUR, BIG_GREEN_POINTS, MAX_CHANGES = 0.20, 300, 0.50, 500, 10, 4


def changes_card(prev, cur):
    """The drastic changes from the previous recap year to the latest one, biggest first. Facts only, no
    judgement. Small shifts (a few per cent) are left out; returns None when nothing changed much."""
    found = []  # (size in euros for sorting, item)

    def money(label, a, b, min_eur=BIG_EUR, min_pct=BIG_PCT):
        diff = b - a
        if abs(diff) < min_eur or (a >= 1 and abs(diff) / a < min_pct):
            return
        found.append((abs(diff), {'label': label, 'value': signed(diff, '€'), 'detail': f'{eur(a)} → {eur(b)}'}))

    money('Tulot', prev['income'], cur['income'])
    money('Menot', prev['spend'], cur['spend'])
    money('Säästöön', max(prev['saved'], 0), max(cur['saved'], 0))
    for c in sorted({*prev['categories'], *cur['categories']}):
        a, b = (y['categories'].get(c, {'eur': 0})['eur'] for y in (prev, cur))
        money(CATEGORY_FI.get(c, c), a, b, BIG_CATEGORY_EUR, BIG_CATEGORY_PCT)
    found.sort(key=lambda x: -x[0])
    items = [item for _, item in found]

    n0, n1 = prev['n_purchases'], cur['n_purchases']
    if n0 and abs(n1 - n0) / n0 >= BIG_PCT and abs(n1 - n0) >= 30:
        items.append({'label': 'Korttiostoksia', 'value': signed(100 * (n1 / n0 - 1), '%'),
                      'detail': f'{num(n0)} → {num(n1)} kpl'})
    share = [round(100 * y['green_days'] / max(1, y['green_days'] + y['negative_days'])) for y in (prev, cur)]
    if share[1] - share[0] >= BIG_GREEN_POINTS:  # only as progress: a drop is never listed (tone rules)
        items.append({'label': 'Päivät plussalla', 'value': signed(share[1] - share[0], '%'),
                      'detail': ''})
    if not items:
        return None
    return card('changes', 'changes', 'Mikä muuttui', 'Edellisvuodesta tähän vuoteen',
                items=items[:MAX_CHANGES], ask='Mikä taloudessani muuttui edellisvuodesta?', priority=86)


def build_cards(customer_id, src, year='current'):
    """year='current': the latest recap year. year='previous': the story of the year before it."""
    previous = year == 'previous'
    prev_f = src.get('previous', {}).get(customer_id)
    f = prev_f if previous else src['facts'][customer_id]
    if f is None:
        return []
    s = src['summary'][customer_id]
    sp = src['spender'].get(customer_id, {})
    peers = peer_averages(f, src.get('previous_peer_groups' if previous else 'peer_groups', {}))
    group = f"{s['age_band']}-vuotiaat, {s['area']}"
    cards = []

    # 1. Intro
    cards.append(card('intro', 'intro', 'Edellinen rahavuotesi' if previous else 'Rahavuotesi',
                      period_title(src['previous_period'] if previous else src['period']),
                      'Vuotesi tärkeimmät luvut.',
                      count=f['n_purchases'], suffix=' korttiostosta', priority=100))

    # 2. Year in numbers
    leftover = f['income'] - f['spend'] - max(f['saved'], 0)
    if leftover >= 50:
        year_body = (f'Menojen ja säästöjen jälkeen jäi {eur(leftover)}.' if f['saved'] > 0
                     else f'Menojen jälkeen jäi {eur(leftover)}.')
    elif leftover <= -50 and f['spend'] > f['income']:
        year_body = f'Menot ylittivät tulot {eur(-leftover)}.'
    elif leftover <= -50:
        year_body = f'Menot ja säästöt ylittivät tulot {eur(-leftover)}.'
    else:
        year_body = 'Tulot ja menot menivät lähes tasan.'
    items = [{'label': 'Tulot', 'value': eur(f['income'])}, {'label': 'Menot', 'value': eur(f['spend'])}]
    if f['saved'] > 0:
        items.append({'label': 'Säästöön', 'value': eur(f['saved'])})
    cards.append(card('year', 'split', 'Vuotesi luvuissa', 'Tulot, menot ja säästöt', year_body, items=items,
                      ask='Mihin rahani menivät viimeisen vuoden aikana?', priority=95))

    if peers:
        comparisons = [
            {'label': 'Menot vuodessa', 'own': eur(f['spend']), 'peer': eur(peers['spend'])},
            {'label': 'Korttiostoksia', 'own': num(f['n_purchases']), 'peer': num(peers['n_purchases'])},
        ]
        if f['n_purchases'] and peers['average_purchase_eur'] is not None:
            comparisons.append({'label': 'Ostos keskimäärin',
                                'own': eur(sum(value['eur'] for value in f['categories'].values()) / f['n_purchases']),
                                'peer': eur(peers['average_purchase_eur'])})
        peer_card = card('peers', 'comparison', 'Vertailu omaan ryhmään', 'Sinä ja verrokkiryhmäsi',
                         'Sama ikä, alue ja vuosi. Keskiarvo ei ole tavoite.',
                         items=comparisons, note=f'{group} · {num(peers["count"])} muuta asiakasta',
                         ask=f'Vertaa rahavuoteni {period_title(src["period"]).lower()} menoja saman ikäryhmän ja alueen ryhmäkeskiarvoihin.',
                         priority=94)
        cards.append(peer_card)

    # 3. Top 5 purchase categories
    cats = f['categories']
    total = sum(c['eur'] for c in cats.values()) or 1
    top5 = list(cats.items())[:5]
    if top5:
        cards.append(card('top5', 'list', 'Top 5', 'Mihin korttiostokset menivät',
                          f'Korttiostokset yhteensä {eur(total)}.',
                          items=[{'label': CATEGORY_FI[c], 'value': eur(v['eur']), 'share': round(v['eur'] / total, 3)}
                                 for c, v in top5],
                          ask='Mihin rahani menivät viimeisen vuoden aikana?', priority=90))

    # 4. Favourite (non-essential) category
    fav = next(((c, v) for c, v in cats.items() if c not in ESSENTIAL_CATEGORIES and v['n'] >= 5), None)
    if fav:
        c, v = fav
        cards.append(card('favourite', 'hero', 'Vuoden suosikkisi', CATEGORY_FI[c],
                          f"{eur(v['eur'])} yhteensä · keskimäärin {eur(v['eur'] / v['n'])}/ostos",
                          count=v['n'], suffix=' kertaa',
                          ask=f'Kerro {CATEGORY_ASK[c]} viime vuonna. Miten voisin säästää niissä?',
                          note=(f'Ikäisesi lähialueella käyttävät tähän keskimäärin {eur(peers["categories"].get(c, 0))} vuodessa.' if peers else None),
                          priority=85))

    # 5. Go-to place
    tm = f['top_merchant']
    if tm and tm['visits'] >= 10:
        place = f"{MCC_FI.get(tm['mcc'], 'Kauppa')} #{int(tm['id'][-4:])}"
        cards.append(card('place', 'hero', 'Kanta-asiakas', place,
                          f"Asioit vuoden aikana {f['unique_merchants']} eri paikassa.",
                          count=tm['visits'], suffix=' käyntiä', note='Kauppojen nimiä ei ole aineistossa.',
                          priority=60))

    # 6. Rhythm
    slot = f['top_slot']
    if slot:
        phrase = slot_phrase(slot['weekday'], slot['daypart'])
        h = f['top_hour']
        cards.append(card('rhythm', 'hero', 'Sinun aikasi', phrase[0].upper() + phrase[1:],
                          f'Vilkkain tuntisi: klo{NBSP}{h}⁠–⁠{h + 1}.',
                          count=slot['n'], suffix=' ostosta', priority=75))

    # 7. Small purchases add up (latte factor)
    if f['small_n'] >= 30:
        cards.append(card('small', 'hero', 'Pienistä puroista', f"{eur(f['small_eur'])} yhteensä",
                          'Alle 10 euron ostoksistakin kertyy.',
                          count=f['small_n'], suffix=' pientä ostosta',
                          ask='Paljonko pienet ostokset maksavat minulle vuodessa?',
                          note=(f'Sama ikä ja alue: keskimäärin {eur(peers["small_eur"])}/vuosi.' if peers else None),
                          priority=70))

    # 8. Biggest single purchase
    b = f['biggest']
    if b and b['eur'] >= 300:
        d = date.fromisoformat(b['date'])
        cards.append(card('biggest', 'hero', 'Vuoden isoin ostos', CATEGORY_FI.get(b['category'], b['category']),
                          f"{d.day}.{d.month}.{d.year}",
                          count=b['eur'], suffix=' €', priority=62))

    # 9. Biggest and quietest month
    ms = f['month_spend']
    if ms:
        top_m = max(ms, key=ms.get)
        low_m = min(ms, key=ms.get)
        cards.append(card('month', 'hero', 'Vuoden kallein kuukausi', month_name(top_m).capitalize(),
                          f'Hiljaisin: {month_name(low_m)}, {eur(ms[low_m])}.',
                          count=ms[top_m], suffix=' €',
                          ask=f'Miksi menoni olivat {month_name(top_m)}ssa vuoden suurimmat?', priority=80))

    # 10. Days in the green (positive framing)
    days = f['green_days'] + f['negative_days']
    if f['negative_days'] == 0:
        cards.append(card('green', 'hero', 'Koko vuosi plussalla', 'Ei yhtään miinuspäivää',
                          'Tilisi pysyi plussalla koko vuoden.',
                          count=days, suffix=f' / {days} päivää', priority=88))
    elif f['green_days'] >= days / 2:
        back = ', ja palasit plussalle joka kerta' if f['ends_green'] else ''
        cards.append(card('green', 'hero', 'Päivät plussalla', f"Pisin plussaputki {f['best_green_streak']} päivää",
                          f"Tili kävi miinuksella {times(f['negative_episodes'])}{back}.",
                          count=f['green_days'], suffix=f' / {days} päivää',
                          ask='Miten saisin tilini pysymään plussalla palkkapäivään asti?', priority=78))
    else:
        cards.append(card('green', 'hero', 'Sinnikkyyttä', 'kertaa takaisin plussalle',
                          f"Pisin plussaputkesi: {f['best_green_streak']} päivää.",
                          count=f['recoveries'], suffix='',
                          ask='Miten saisin tilini pysymään plussalla palkkapäivään asti?', priority=78))

    # 11. Saving
    if f['saved'] > 0 and f['saving_months'] > 0:
        every = 'Joka ikinen kuukausi!' if f['saving_months'] >= 12 else \
            f"Säästit {f['saving_months']} kuukautena 12:sta."
        cards.append(card('saving', 'hero', 'Säästäjä', 'siirretty säästöön', every,
                          count=f['saved'], suffix=' €',
                          note=(f'Sama ikä ja alue: nettosäästö keskimäärin {eur(peers["saved"])}/vuosi.' if peers else None),
                          priority=82))

    # 12. What changed drastically since the previous year
    # Only in the latest year's story, and only when something changed drastically.
    changes = None if previous or not prev_f else changes_card(prev_f, f)
    if changes:
        cards.append(changes)

    if previous:
        # The spender type and the savings tip describe the customer today, so the older story skips them
        # and hands over to the latest year instead.
        outro = card('outro', 'outro', 'Tarina jatkuu', 'Entä sen jälkeen?',
                     f"Seuraavaksi: {period_title(src['period']).lower()}.",
                     ask='Mikä taloudessani muuttui edellisvuodesta?')
        for c in cards:  # the coach's ready-made questions are about the latest year
            c['ask'] = None
        return finish(cards, outro)

    # 13. Spending personality (BDA spender type)
    label = sp.get('label', 'Balanced spender')
    saver = '(and a saver)' in label
    parts = [ARCHETYPE_FI.get(p.strip(), p.strip()) for p in label.replace('(and a saver)', '').split(' and ')]
    title = ' ja '.join([parts[0]] + [p[0].lower() + p[1:] for p in parts[1:]])
    lines = [LINE_FI[l] for l in sp.get('top_lines', '').split(',') if l in LINE_FI]
    body = (f"Ryhmääsi enemmän: {', '.join(lines)}." if lines
            else 'Menosi ovat lähellä ryhmäsi keskiarvoja.')
    cards.append(card('personality', 'hero', 'Kuluttajatyyppisi', title + (' · säästäjä' if saver else ''),
                      body, note=f'Verrokkiryhmä: {group}', ask='Millainen kuluttaja olen?', priority=92))

    # 14. Outro: one forward-looking tip from the spending model
    to_save = nice_down(float(s['safe_to_save_month'] or 0))
    net, extras = float(s['net_12m']), float(s['extras_12m'])
    gap = nice(float(s['surprise_fund_gap'] or 0))
    if to_save > 0:
        first = ' Aloita puskurirahastosta.' if gap > 0 else ''
        outro = card('outro', 'outro', 'Ensi vuoden tavoite', 'lisää säästöön',
                     f'Säästä {eur(to_save)}/kk palkkapäivänä.{first}',
                     count=12 * to_save, suffix=' €', ask='Miten pääsen ensi vuoden säästötavoitteeseeni?')
    elif net < -10 and extras > 0:
        trim = min(100, max(1, math.ceil(-net / extras * 100)))
        outro = card('outro', 'outro', 'Ensi vuoden tavoite', 'vähemmän ylimääräisiä menoja',
                     'Tällä vähennyksellä tulot ja menot tasapainottuisivat.',
                     count=trim, suffix=' %', ask='Miten saisin tuloni ja menoni tasapainoon?')
    elif gap > 0:
        outro = card('outro', 'outro', 'Ensi vuoden tavoite', 'puskuriin',
                     'Kokoa puskuri yllättäviin menoihin.',
                     count=gap, suffix=' €', ask='Miten kerään puskurirahaston?')
    else:
        outro = card('outro', 'outro', 'Ensi vuoden tavoite', 'Jatka samaan malliin',
                     'Tulot kattavat menot ja puskuri on kunnossa.',
                     ask='Miten voisin kehittää talouttani?')
    return finish(cards, outro)


def finish(cards, outro):
    """Add the closing card, keep the strongest cards (intro and outro always) in story order, add themes."""
    outro['_priority'] = 100
    cards.append(outro)
    while len(cards) > MAX_CARDS:
        cards.remove(min(cards[1:-1], key=lambda c: c['_priority']))
    for i, c in enumerate(cards):
        c['theme'] = THEMES[i % len(THEMES)]
        del c['_priority']
    return cards


def build_recap(customer_id, src, year='current'):
    period = src['previous_period'] if year == 'previous' else src['period']
    return {'customer_id': customer_id, 'period': period, 'cards': build_cards(customer_id, src, year)}
