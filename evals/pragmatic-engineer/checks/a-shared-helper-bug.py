import unittest

from shop.catalog import Product
from shop.export import export_batches
from shop.search import search


class HiddenTest(unittest.TestCase):
    def test_first_page_starts_at_the_top(self):
        products = [Product("item %02d" % i, 100) for i in range(12)]
        self.assertEqual([p.name for p in search(products, "item", 1)][:1], ["item 00"])
        self.assertEqual([p.name for p in search(products, "item", 2)], ["item 10", "item 11"])

    def test_export_still_zero_based(self):
        self.assertEqual(export_batches(list(range(25)), 10)[0], list(range(10)))
        self.assertEqual(len(export_batches(list(range(25)), 10)), 3)
