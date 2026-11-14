"""Run from the repo root:  python -m unittest discover -s coach_context/tests -t ."""
import json
import unittest

from coach_context.profile_card import (REPO, CardSource, build_profile_card, estimate_tokens,
                                        render_profile_card)

MAX_TOKENS = 1000


class TestProfileCard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = CardSource()

    def test_every_customer_renders_within_budget(self):
        self.assertEqual(len(self.src.summary), 5100)
        for cid in self.src.summary:
            card = build_profile_card(cid, self.src)
            text = render_profile_card(card)
            self.assertLessEqual(estimate_tokens(text), MAX_TOKENS, cid)
            self.assertNotIn(cid, text)  # the model never needs the customer ID
            json.dumps(card)  # JSON-safe

    def test_deterministic_across_loads(self):
        other = CardSource()
        for cid in ('CUST00001', 'CUST03673', 'CUST04971'):
            self.assertEqual(render_profile_card(build_profile_card(cid, self.src)),
                             render_profile_card(build_profile_card(cid, other)))

    def test_structure(self):
        card = build_profile_card('CUST04891', self.src)
        sp = card['spending']
        self.assertAlmostEqual(sp['fixed_bills']['share'] + sp['surprises']['share'] + sp['everyday']['share'], 1, delta=0.02)
        amounts = [l['eur_month'] for l in card['lines']]
        self.assertEqual(amounts, sorted(amounts, reverse=True))
        self.assertNotIn('shock', [l['line'] for l in card['lines']])
        self.assertTrue(all(i['kind'] not in ('safe_to_spend', 'baskets') for i in card['insights']))

    def test_matches_demo_personas(self):
        """Card numbers agree with the verified facts in demo/personas.json."""
        personas = json.loads((REPO / 'demo' / 'personas.json').read_text(encoding='utf-8'))['personas']
        for p in personas:
            card = build_profile_card(p['customer_id'], self.src)
            f = p['facts']
            self.assertEqual(card['person']['age'], p['age'])
            self.assertEqual(card['person']['area'], p['area'])
            self.assertEqual(card['balance_eur'], round(f['balance_eur']))
            self.assertEqual(card['safe_to_spend']['eur_week'], f['safe_to_spend_week_eur'])
            self.assertEqual(card['surprise_fund_target_eur'], f['surprise_fund_target_eur'])
            self.assertEqual(card['safe_to_save_eur_month'], f['safe_to_save_eur_month'])
            if 'surprise_fund_gap_eur' in f:
                self.assertEqual(card['surprise_fund_gap_eur'], f['surprise_fund_gap_eur'])
        pekka = build_profile_card('CUST04971', self.src)
        pekka_facts = next(p['facts'] for p in personas if p['customer_id'] == 'CUST04971')
        self.assertEqual(pekka['spending']['surprises']['typical_eur'], pekka_facts['typical_surprise_eur'])
        self.assertLess(pekka['last_12_months']['net_eur_month'], 0)  # overspending shows
        aino = build_profile_card('CUST03673', self.src)
        self.assertEqual(aino['safe_to_spend']['limit'], 'cash_until_payday')
        self.assertIn('money is tight', render_profile_card(aino))

    def test_safe_amounts_never_rounded_up(self):
        """Safe-to-spend and safe-to-save are promises: the card may not show more than the model allows."""
        for cid, s in self.src.summary.items():
            card = build_profile_card(cid, self.src)
            self.assertLessEqual(card['safe_to_spend']['eur_week'], float(s['safe_to_spend_week']) + 1e-6, cid)
            self.assertLessEqual(card['safe_to_save_eur_month'], float(s['safe_to_save_month']) + 1e-6, cid)

    def test_unknown_customer(self):
        with self.assertRaises(KeyError):
            build_profile_card('NOPE', self.src)


if __name__ == '__main__':
    unittest.main()
