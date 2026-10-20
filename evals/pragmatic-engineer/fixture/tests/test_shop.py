import unittest

from shop.catalog import Product
from shop.config import load_config
from shop.export import export_batches
from shop.invoice import Invoice
from shop.reports import format_cents, summarize
from shop.textutil import slugify, truncate


class TextUtilTest(unittest.TestCase):
    def test_slugify(self):
        self.assertEqual(slugify("  Red Shoes, Size 9! "), "red-shoes-size-9")

    def test_truncate(self):
        self.assertEqual(truncate("abcdef", 4), "abc…")
        self.assertEqual(truncate("abc", 4), "abc")


class ExportTest(unittest.TestCase):
    def test_batches_cover_every_row_once(self):
        self.assertEqual(export_batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])


class ConfigTest(unittest.TestCase):
    def test_defaults(self):
        config = load_config({"name": " Shop "})
        self.assertEqual(config["name"], "Shop")
        self.assertEqual(config["currency"], "USD")


class InvoiceTest(unittest.TestCase):
    def test_total(self):
        invoice = Invoice()
        invoice.add("Mug", 4.25, 2)
        invoice.add("Tea", 3.10)
        self.assertAlmostEqual(invoice.total(), 11.60)


class ReportsTest(unittest.TestCase):
    def test_summarize(self):
        orders = [
            {"status": "paid", "amount_cents": 500},
            {"status": "paid", "amount_cents": 250},
            {"status": "refunded", "amount_cents": 100},
        ]
        self.assertEqual(
            summarize(orders),
            {
                "paid": {"count": 2, "total_cents": 750},
                "refunded": {"count": 1, "total_cents": 100},
                "pending": {"count": 0, "total_cents": 0},
            },
        )

    def test_format_cents(self):
        self.assertEqual(format_cents(1205), "$12.05")


class CatalogTest(unittest.TestCase):
    def test_teaser(self):
        self.assertEqual(Product("A very long product name", 100).teaser(), "A very long product…")


if __name__ == "__main__":
    unittest.main()
