PAGE_SIZE = 10
CURRENCY = "USD"


def load_config(raw):
    """Build the shop's settings from a parsed config file (a dict of strings)."""
    return {
        "name": raw["name"].strip(),
        "currency": raw.get("currency", CURRENCY).upper(),
        "page_size": int(raw.get("page_size", PAGE_SIZE)),
        "sale_ends": raw.get("sale_ends"),
    }
