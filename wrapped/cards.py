"""Turn Wrapped facts + the BDA model's outputs into Finnish story cards.

    from wrapped.cards import load_sources, build_cards
    src = load_sources()
    cards = build_cards('CUST04971', src)      # list of card dicts, ready for ui-demos/public/wrapped.js

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

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FACTS = HERE / 'output' / 'facts.json'
BDA_OUT = REPO / 'BDA' / 'output'

MAX_CARDS = 12
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
            'summary': read('customer_summary.csv'), 'spender': read('spender_type.csv')}


def card(id_, layout, kicker, title='', body='', count=None, suffix='', ask=None, items=None, note=None,
         priority=0):
    return {'id': id_, 'layout': layout, 'kicker': kicker, 'title': title, 'body': body,
            'count': None if count is None else round(count), 'suffix': suffix, 'ask': ask, 'items': items or [], 'note': note,
            '_priority': priority}


def build_cards(customer_id, src):
    f = src['facts'][customer_id]
    s = src['summary'][customer_id]
    sp = src['spender'].get(customer_id, {})
    cards = []

    # 1. Intro
    cards.append(card('intro', 'intro', 'Rahavuotesi', 'Lokakuu 2025 – syyskuu 2026',
                      'Yksi vuosi, yksi tarina. Katsotaan, millainen rahavuotesi oli.',
                      count=f['n_purchases'], suffix=' korttiostosta', priority=100))

    # 2. Year in numbers
    leftover = f['income'] - f['spend'] - max(f['saved'], 0)
    if leftover >= 50:
        year_body = (f'Kaikkien menojen ja säästöjen jälkeen tuloista jäi vielä {eur(leftover)}.' if f['saved'] > 0
                     else f'Kaikkien menojen jälkeen tuloista jäi vielä {eur(leftover)}.')
    elif leftover <= -50 and f['spend'] > f['income']:
        year_body = f'Menot ylittivät tulot {num(-leftover)} eurolla. Lopussa on vinkki, jolla tasapaino löytyy.'
    elif leftover <= -50:
        year_body = (f'Menot ja säästöt yhdessä ylittivät tulot {num(-leftover)} eurolla. '
                     'Lopussa on vinkki, jolla tasapaino löytyy.')
    else:
        year_body = 'Tulot ja menot menivät lähes tasan.'
    items = [{'label': 'Tulot', 'value': eur(f['income'])}, {'label': 'Menot', 'value': eur(f['spend'])}]
    if f['saved'] > 0:
        items.append({'label': 'Säästöön', 'value': eur(f['saved'])})
    cards.append(card('year', 'split', 'Vuotesi luvuissa', 'Tulot, menot ja säästöt', year_body, items=items,
                      ask='Mihin rahani menivät viimeisen vuoden aikana?', priority=95))

    # 3. Top 5 purchase categories
    cats = f['categories']
    total = sum(c['eur'] for c in cats.values()) or 1
    top5 = list(cats.items())[:5]
    cards.append(card('top5', 'list', 'Top 5', 'Mihin korttiostokset menivät',
                      f"Ykkösenä {CATEGORY_FI[top5[0][0]].lower()}. Korttiostoksia kertyi yhteensä {eur(total)}.",
                      items=[{'label': CATEGORY_FI[c], 'value': eur(v['eur']), 'share': round(v['eur'] / total, 3)}
                             for c, v in top5],
                      ask='Mihin rahani menivät viimeisen vuoden aikana?', priority=90))

    # 4. Favourite (non-essential) category
    fav = next(((c, v) for c, v in cats.items() if c not in ESSENTIAL_CATEGORIES and v['n'] >= 5), None)
    if fav:
        c, v = fav
        cards.append(card('favourite', 'hero', 'Vuoden suosikkisi', CATEGORY_FI[c],
                          f"Yhteensä {eur(v['eur'])} – keskimäärin {eur(v['eur'] / v['n'])} kerralla.",
                          count=v['n'], suffix=' kertaa',
                          ask=f'Kerro {CATEGORY_ASK[c]} viime vuonna. Miten voisin säästää niissä?', priority=85))

    # 5. Go-to place
    tm = f['top_merchant']
    if tm and tm['visits'] >= 10:
        place = f"{MCC_FI.get(tm['mcc'], 'Kauppa')} #{int(tm['id'][-4:])}"
        peer = (f" – enemmän kuin {f['unique_merchants_peer_pct']} % ikäisistäsi"
                if f['unique_merchants_peer_pct'] >= 75 else '')
        cards.append(card('place', 'hero', 'Kanta-asiakas', place,
                          f"Vuoden kantapaikkasi. Kaikkiaan asioit {f['unique_merchants']} eri paikassa{peer}.",
                          count=tm['visits'], suffix=' käyntiä', note='Kauppojen nimiä ei ole aineistossa.',
                          priority=60))

    # 6. Rhythm
    slot = f['top_slot']
    if slot:
        phrase = slot_phrase(slot['weekday'], slot['daypart'])
        h = f['top_hour']
        cards.append(card('rhythm', 'hero', 'Sinun aikasi', phrase[0].upper() + phrase[1:],
                          'Silloin teit enemmän ostoksia kuin minään muuna ajankohtana. '
                          f'Vilkkain tuntisi oli klo{NBSP}{h}⁠–⁠{h + 1}.',
                          count=slot['n'], suffix=' ostosta', priority=75))

    # 7. Small purchases add up (latte factor)
    if f['small_n'] >= 30:
        cards.append(card('small', 'hero', 'Pienistä puroista', f"{eur(f['small_eur'])} yhteensä",
                          'Alle 10 euron ostokset huomaa harvoin. Siksi ne kannattaa välillä laskea yhteen.',
                          count=f['small_n'], suffix=' pientä ostosta',
                          ask='Paljonko pienet ostokset maksavat minulle vuodessa?', priority=70))

    # 8. Biggest single purchase
    b = f['biggest']
    if b and b['eur'] >= 300:
        d = date.fromisoformat(b['date'])
        cards.append(card('biggest', 'hero', 'Vuoden isoin ostos', CATEGORY_FI.get(b['category'], b['category']),
                          f"{d.day}.{d.month}.{d.year} · {MCC_FI.get(b['mcc'], 'kauppa').lower()}",
                          count=b['eur'], suffix=' €', priority=62))

    # 9. Biggest and quietest month
    ms = f['month_spend']
    if ms:
        top_m = max(ms, key=ms.get)
        low_m = min(ms, key=ms.get)
        cards.append(card('month', 'hero', 'Vuoden kallein kuukausi', month_name(top_m).capitalize(),
                          f'Hiljaisin kuukausi oli {month_name(low_m)}: {eur(ms[low_m])}.',
                          count=ms[top_m], suffix=' €',
                          ask=f'Miksi menoni olivat {month_name(top_m)}ssa vuoden suurimmat?', priority=80))

    # 10. Days in the green (positive framing)
    days = f['green_days'] + f['negative_days']
    if f['negative_days'] == 0:
        cards.append(card('green', 'hero', 'Koko vuosi plussalla', 'Ei yhtään miinuspäivää',
                          'Tilisi ei käynyt kertaakaan miinuksella. Hieno saavutus!',
                          count=days, suffix=f' / {days} päivää', priority=88))
    elif f['green_days'] >= days / 2:
        back = ', ja palasit plussalle joka kerta' if f['ends_green'] else ''
        cards.append(card('green', 'hero', 'Päivät plussalla', f"Pisin plussaputki {f['best_green_streak']} päivää",
                          f"Tili kävi miinuksella {times(f['negative_episodes'])}{back}.",
                          count=f['green_days'], suffix=f' / {days} päivää',
                          ask='Miten saisin tilini pysymään plussalla palkkapäivään asti?', priority=78))
    else:
        cards.append(card('green', 'hero', 'Sinnikkyyttä', 'kertaa takaisin plussalle',
                          f"Pisin plussaputkesi kesti {f['best_green_streak']} päivää. Pieni puskuri auttaisi "
                          'pysymään plussalla palkkapäivään asti.',
                          count=f['recoveries'], suffix='',
                          ask='Miten saisin tilini pysymään plussalla palkkapäivään asti?', priority=78))

    # 11. Saving
    if f['saved'] > 0 and f['saving_months'] > 0:
        every = 'Joka ikinen kuukausi!' if f['saving_months'] >= 12 else \
            f"Säästit {f['saving_months']} kuukautena 12:sta."
        cards.append(card('saving', 'hero', 'Säästäjä', 'siirretty säästöön', every,
                          count=f['saved'], suffix=' €', priority=82))

    # 12. Compared with the year before (same 11 months)
    if f['cmp_prev_spend'] > 0:
        change = f['cmp_cur_spend'] / f['cmp_prev_spend'] - 1
        diff = abs(f['cmp_cur_spend'] - f['cmp_prev_spend'])
        if change <= -0.03:
            cards.append(card('vs_last_year', 'hero', 'Edellisvuoteen verrattuna', 'vähemmän menoja',
                              f'Marras–syyskuussa käytit {eur(diff)} vähemmän kuin vuotta aiemmin.',
                              count=round(-100 * change), suffix=' %', priority=65))
        elif change >= 0.03:
            cards.append(card('vs_last_year', 'hero', 'Edellisvuoteen verrattuna', 'enemmän menoja',
                              f'Marras–syyskuussa menot kasvoivat {eur(diff)} vuotta aiemmasta. Kasvu ei ole aina '
                              'huono asia – tärkeintä on, että se on tietoista.',
                              count=round(100 * change), suffix=' %',
                              ask='Miksi menoni kasvoivat edellisvuodesta?', priority=55))

    # 13. Spending personality (BDA spender type)
    label = sp.get('label', 'Balanced spender')
    saver = '(and a saver)' in label
    parts = [ARCHETYPE_FI.get(p.strip(), p.strip()) for p in label.replace('(and a saver)', '').split(' and ')]
    title = ' ja '.join([parts[0]] + [p[0].lower() + p[1:] for p in parts[1:]])
    lines = [LINE_FI[l] for l in sp.get('top_lines', '').split(',') if l in LINE_FI]
    group = f"{s['age_band']}-vuotiaat, {s['area']}"
    body = (f"Käytät ikäisiäsi enemmän: {', '.join(lines)}." if lines
            else 'Menosi ovat lähellä ikäistesi tasoa kaikilla alueilla.')
    cards.append(card('personality', 'hero', 'Kuluttajatyyppisi', title + (' · säästäjä' if saver else ''),
                      body, note=f'Verrokkiryhmä: {group}', ask='Millainen kuluttaja olen?', priority=92))

    # 14. Outro: one forward-looking tip from the spending model
    to_save = nice_down(float(s['safe_to_save_month'] or 0))
    net, extras = float(s['net_12m']), float(s['extras_12m'])
    gap = nice(float(s['surprise_fund_gap'] or 0))
    if to_save > 0:
        first = ' Aloita puskurirahastosta.' if gap > 0 else ''
        outro = card('outro', 'outro', 'Ensi vuoden tavoite', 'lisää säästöön',
                     f'Siirrä {eur(to_save)} kuussa säästöön heti palkkapäivänä. Syyskuussa 2027 sinulla on '
                     f'{eur(12 * to_save)} enemmän – nykyisillä tavoillasi.{first}',
                     count=12 * to_save, suffix=' €', ask='Miten pääsen ensi vuoden säästötavoitteeseeni?')
    elif net < -10 and extras > 0:
        trim = min(100, max(1, math.ceil(-net / extras * 100)))
        outro = card('outro', 'outro', 'Ensi vuoden tavoite', 'vähemmän ylimääräisiä menoja',
                     f'Kun arjen ylimääräiset menot pienenevät noin {trim} %, tulot ja menot ovat tasapainossa. '
                     'Pieni muutos riittää.',
                     count=trim, suffix=' %', ask='Miten saisin tuloni ja menoni tasapainoon?')
    elif gap > 0:
        outro = card('outro', 'outro', 'Ensi vuoden tavoite', 'puskuriin',
                     f'Yllättävät menot tulevat aina joskus. {eur(gap)}:n puskuri suojaa seuraavalta '
                     'pesukoneen hajoamiselta.',
                     count=gap, suffix=' €', ask='Miten kerään puskurirahaston?')
    else:
        outro = card('outro', 'outro', 'Ensi vuoden tavoite', 'Jatka samaan malliin',
                     'Taloutesi on hyvässä tasapainossa: tulot riittävät menoihin ja puskuri on kunnossa.',
                     ask='Miten voisin kehittää talouttani?')
    outro['_priority'] = 100
    cards.append(outro)

    # Keep the strongest cards (intro and outro always), in story order.
    while len(cards) > MAX_CARDS:
        cards.remove(min(cards[1:-1], key=lambda c: c['_priority']))
    for i, c in enumerate(cards):
        c['theme'] = THEMES[i % len(THEMES)]
        del c['_priority']
    return cards


def build_recap(customer_id, src):
    return {'customer_id': customer_id, 'period': src['period'], 'cards': build_cards(customer_id, src)}
