from shop.config import PAGE_SIZE


def paginate(items, page, size=PAGE_SIZE):
    """Return the items on a page. Pages are numbered from 0."""
    start = page * size
    return items[start : start + size]
