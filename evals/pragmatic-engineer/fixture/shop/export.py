from shop.paging import paginate


def export_batches(rows, size):
    """Split rows into batches of size for the nightly export."""
    batches = []
    page = 0
    while True:
        batch = paginate(rows, page, size)
        if not batch:
            return batches
        batches.append(batch)
        page += 1
