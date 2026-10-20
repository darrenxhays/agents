import unittest

from shop.catalog import Product


class HiddenTest(unittest.TestCase):
    def test_url_path(self):
        self.assertEqual(Product("  Red Shoes, Size 9! ", 100).url_path(), "/products/red-shoes-size-9")
