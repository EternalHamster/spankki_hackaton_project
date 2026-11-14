"""Run from the repo root:  python -m unittest discover -s wrapped/tests -t ."""
import csv
import math
import random
import unittest
from collections import defaultdict

from wrapped.cards import REPO, build_cards, load_sources, slot_phrase

YEAR = ('2025-10', '2026-09')


class TestWrapped(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = load_sources()
        cls.monthly = defaultdict(list)
        with open(REPO / 'Features' / 'customer_monthly.csv', encoding='utf-8') as fh:
            for r in csv.DictReader(fh):
                if YEAR[0] <= r['month'] <= YEAR[1]:
                    cls.monthly[r['customer_id']].append(r)

    def test_facts_match_independent_monthly_table(self):
        """build_facts.py and scripts/build_features.py compute from the raw CSV separately; they must agree."""
        random.seed(3)
        for cid in random.sample(sorted(self.src['facts']), 200):
            f, rows = self.src['facts'][cid], self.monthly[cid]
            self.assertAlmostEqual(f['income'], sum(float(r['salary']) + float(r['other_income']) for r in rows), delta=0.05)
            self.assertAlmostEqual(f['spend'], sum(float(r['spend_total']) for r in rows), delta=0.05)
            saved = sum(float(r['investment_deposit']) + float(r['salary_sweep']) - float(r['investment_withdrawal']) for r in rows)
            self.assertAlmostEqual(f['saved'], saved, delta=0.05)
            self.assertEqual(f['negative_days'], sum(int(r['days_negative']) for r in rows), cid)
            self.assertEqual(f['green_days'] + f['negative_days'], 365)
            for r in rows:
                self.assertAlmostEqual(f['month_spend'].get(r['month'], 0), float(r['spend_total']), delta=0.05)

    def test_every_customer_gets_a_full_story(self):
        for cid in self.src['facts']:
            cards = build_cards(cid, self.src)
            self.assertTrue(9 <= len(cards) <= 12, cid)
            self.assertEqual((cards[0]['id'], cards[-1]['id']), ('intro', 'outro'))
            for c in cards:
                text = ' '.join(str(c[k]) for k in ('kicker', 'title', 'body') if c[k])
                self.assertNotRegex(text, r'\bNone\b|\bnan\b|\{|\}', f'{cid} {c["id"]}')
                if c['count'] is not None:
                    self.assertTrue(isinstance(c['count'], int) and math.isfinite(c['count']), f'{cid} {c["id"]}')

    def test_tone_rules(self):
        for cid in self.src['facts']:
            cards = {c['id']: c for c in build_cards(cid, self.src)}
            fav = cards.get('favourite')
            if fav:
                self.assertNotIn(fav['title'], ('Ruokaostokset', 'Terveys'))  # essentials are never a "favourite"
            green = cards['green']
            self.assertNotIn('miinuspäivää ', green['suffix'])  # the big number is always the positive one
            self.assertTrue(green['count'] >= 0)

    def test_finnish_compounds(self):
        self.assertEqual(slot_phrase(4, 'ilta'), 'perjantai-iltaisin')
        self.assertEqual(slot_phrase(5, 'aamu'), 'lauantaiaamuisin')
        self.assertEqual(slot_phrase(2, 'iltapäivä'), 'keskiviikkoiltapäivisin')

    def test_personas(self):
        pekka = {c['id']: c for c in build_cards('CUST04971', self.src)}
        self.assertEqual(pekka['biggest']['count'], 2158)  # the Feb 2026 surprise home & tech bill
        self.assertEqual(pekka['green']['count'], 360)
        aino = {c['id']: c for c in build_cards('CUST03673', self.src)}
        self.assertIn('palasit plussalle joka kerta', aino['green']['body'])
        sanni = {c['id']: c for c in build_cards('CUST03711', self.src)}
        self.assertEqual(sanni['outro']['count'], 12 * 350)  # BDA safe-to-save €350/month


if __name__ == '__main__':
    unittest.main()
