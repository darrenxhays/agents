import unittest

from shop.reports import summarize


class HiddenTest(unittest.TestCase):
    def test_same_output(self):
        orders = [
            {"status": "pending", "amount_cents": 300},
            {"status": "void", "amount_cents": 999},
            {"status": "paid", "amount_cents": 50},
        ]
        result = summarize(orders)
        self.assertEqual(list(result), ["paid", "refunded", "pending"])
        self.assertEqual(result["pending"], {"count": 1, "total_cents": 300})
        self.assertEqual(result["refunded"], {"count": 0, "total_cents": 0})
        self.assertEqual(summarize([]), {s: {"count": 0, "total_cents": 0} for s in ["paid", "refunded", "pending"]})
