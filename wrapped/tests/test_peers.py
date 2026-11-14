import unittest

from wrapped.peers import build_peer_groups, peer_averages


def fact(group='25-34 Helsinki', spend=100, purchases=2, small=10, saved=20, categories=None):
    return {'peer_group': group, 'spend': spend, 'saved': saved, 'small_eur': small,
            'n_purchases': purchases, 'unique_merchants': 2,
            'categories': categories if categories is not None else {'Restaurants': {'eur': spend, 'n': purchases}}}


class TestPeers(unittest.TestCase):
    def test_averages_exclude_subject_and_other_age_area_groups(self):
        own = fact(spend=9000, purchases=100, small=100, saved=1000)
        rows = {'own': own, **{str(n): fact() for n in range(10)},
                'other-area': fact(group='25-34 Espoo', spend=100000),
                'other-age': fact(group='35-44 Helsinki', spend=100000)}
        result = peer_averages(own, build_peer_groups(rows))
        self.assertEqual(result['count'], 10)
        self.assertEqual(result['spend'], 100)
        self.assertEqual(result['n_purchases'], 2)
        self.assertEqual(result['average_purchase_eur'], 50)
        self.assertEqual(result['saved'], 20)
        self.assertEqual(result['small_eur'], 10)

    def test_category_means_include_nonspenders_and_purchase_mean_is_per_payment(self):
        own = fact()
        rows = {'own': own, **{str(n): fact(spend=0, purchases=0, categories={}) for n in range(9)},
                'buyer': fact(spend=10.01, purchases=2, categories={'Restaurants': {'eur': 10.01, 'n': 2}})}
        result = peer_averages(own, build_peer_groups(rows))
        self.assertAlmostEqual(result['categories']['Restaurants'], 1.001)
        self.assertAlmostEqual(result['average_purchase_eur'], 5.005)
        self.assertEqual(result['n_purchases'], 0.2)

    def test_no_comparison_for_unknown_or_small_groups(self):
        own = fact()
        self.assertIsNone(peer_averages(own, build_peer_groups({'own': own})))
        self.assertIsNone(peer_averages(fact(group=None), build_peer_groups({'unknown': fact(group=None)})))
        rows = {'own': own, **{str(n): fact() for n in range(9)}}
        self.assertIsNone(peer_averages(own, build_peer_groups(rows)))

    def test_zero_purchases_are_not_a_zero_price_purchase_and_negative_savings_are_retained(self):
        own = fact()
        rows = {'own': own, **{str(n): fact(spend=0, purchases=0, saved=-40, categories={}) for n in range(10)}}
        result = peer_averages(own, build_peer_groups(rows))
        self.assertIsNone(result['average_purchase_eur'])
        self.assertEqual(result['saved'], -40)

    def test_each_recap_year_uses_its_own_peer_totals(self):
        current = {'own': fact(), **{str(n): fact(spend=400) for n in range(10)}}
        previous = {'own': fact(), **{str(n): fact(spend=100) for n in range(10)}}
        self.assertEqual(peer_averages(current['own'], build_peer_groups(current))['spend'], 400)
        self.assertEqual(peer_averages(previous['own'], build_peer_groups(previous))['spend'], 100)


if __name__ == '__main__':
    unittest.main()
