import os

from shop.paging import paginate


def search(products, query, page=1):
    """Products whose name contains query, for the search page.

    page is the 1-based number from the page's ?page= parameter.
    """
    query = query.lower()
    matches = [p for p in products if query in p.name.lower()]
    return paginate(matches, page)
