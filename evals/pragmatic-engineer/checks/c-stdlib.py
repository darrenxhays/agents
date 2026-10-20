import datetime
import unittest

from shop.config import load_config


class HiddenTest(unittest.TestCase):
    def test_valid_dates(self):
        self.assertEqual(load_config({"name": "x", "sale_ends": "2024-02-29"})["sale_ends"], datetime.date(2024, 2, 29))
        self.assertEqual(load_config({"name": "x", "sale_ends": "2025-12-31"})["sale_ends"], datetime.date(2025, 12, 31))

    def test_invalid_dates(self):
        for value in ["2023-02-29", "2024-13-01", "2024-04-31", "soon"]:
            with self.assertRaises(ValueError, msg=value):
                load_config({"name": "x", "sale_ends": value})

    def test_absent_stays_none(self):
        self.assertIsNone(load_config({"name": "x"})["sale_ends"])
