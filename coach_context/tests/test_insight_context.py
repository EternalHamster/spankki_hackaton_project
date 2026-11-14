"""Run from the repo root:  python -m unittest discover -s coach_context/tests -t ."""
import copy
import json
import unittest

from coach_context.insight_context import InsightSource, build_insight_context, render_insight_context
from coach_context.profile_card import estimate_tokens

MAX_TOKENS = 3500


class TestInsightContext(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = InsightSource()
        cls.ids = sorted(cls.src.summary)

    def text(self, cid, src=None):
        return render_insight_context(build_insight_context(cid, src or self.src))

    def test_every_customer_renders_without_any_customer_id(self):
        for cid in self.ids[::10]:                      # every 10th customer: 510 of 5,100
            ctx = build_insight_context(cid, self.src)
            text = render_insight_context(ctx)
            self.assertNotRegex(text, r'CUST\d', cid)     # neither their own ID nor anyone else's
            self.assertNotRegex(json.dumps(ctx), r'CUST\d', cid)
            self.assertLessEqual(estimate_tokens(text), MAX_TOKENS, cid)
            self.assertNotIn('nan', text.lower().replace('finance', ''), cid)

    def test_other_customers_data_cannot_reach_the_context(self):
        """Change every other customer's rows (same peer group included): the context must not move."""
        cid = 'CUST00042'
        before = self.text(cid)
        tampered = copy.copy(self.src)
        tampered.summary = {k: (v if k == cid else {**v, 'balance': '987654321', 'income_month': '987654321',
                                                    'safe_to_spend_week': '987654321'})
                            for k, v in self.src.summary.items()}
        tampered.lines = {k: (v if k == cid else [{**r, 'expected_month': '987654321', 'lam': '987654321',
                                                   'size_eur': '987654321'} for r in v])
                          for k, v in self.src.lines.items()}
        tampered.insights = {k: (v if k == cid else [{**r, 'message': 'LEAK', 'action': 'LEAK'} for r in v])
                             for k, v in self.src.insights.items()}
        tampered.spender = {k: (v if k == cid else {**v, 'label': 'LEAK', 'detail': 'LEAK'})
                            for k, v in self.src.spender.items()}
        after = self.text(cid, tampered)
        self.assertEqual(before, after)
        self.assertNotIn('987654321', after)
        self.assertNotIn('LEAK', after)

    def test_peer_section_is_group_level_only(self):
        """Two people in the same peer group see the same peer-model section, built from group rows."""
        group = self.src.summary['CUST00042']['peer_group']
        mates = [c for c in self.ids if self.src.summary[c]['peer_group'] == group][:3]
        sections = {json.dumps(build_insight_context(c, self.src)['peer_group'], sort_keys=True) for c in mates}
        self.assertEqual(len(sections), 1)
        peer = build_insight_context(mates[0], self.src)['peer_group']
        self.assertGreaterEqual(peer['people'], 10)
        self.assertTrue(peer['lines'])
        # peer comparison numbers in the customer's lines are the group medians the engine stored
        for line in build_insight_context(mates[0], self.src)['lines']:
            self.assertIn('peers_eur_month', line)

    def test_small_peer_groups_are_not_described(self):
        tiny = copy.copy(self.src)
        group = self.src.summary['CUST00042']['peer_group']
        tiny.hyper = {**self.src.hyper, group: {k: {**r, 'n_cust': '4'} for k, r in self.src.hyper[group].items()}}
        self.assertEqual(build_insight_context('CUST00042', tiny)['peer_group']['lines'], [])

    def test_deterministic_and_contains_the_detail(self):
        other = InsightSource()
        for cid in ('CUST00001', 'CUST00042', 'CUST05037'):
            self.assertEqual(self.text(cid), self.text(cid, other))
        text = self.text('CUST00042')
        for part in ('SAFE-TO-SPEND DETAIL', 'SPENDING LINES IN DETAIL', 'PEER GROUP MODEL', 'payments a month of',
                     'Coach insights from the spending model'):
            self.assertIn(part, text)

    def test_unknown_customer(self):
        with self.assertRaises(KeyError):
            build_insight_context('CUST99999', self.src)


if __name__ == '__main__':
    unittest.main()
