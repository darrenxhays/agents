import unittest

from shop import config
from shop.paging import paginate


class HiddenTest(unittest.TestCase):
    def test_default_page_size(self):
        self.assertEqual(config.PAGE_SIZE, 20)
        self.assertEqual(config.load_config({"name": "x"})["page_size"], 20)
        self.assertEqual(len(paginate(list(range(50)), 0)), 20)
