import re


def slugify(text):
    """Lowercase text and turn each run of non-alphanumerics into one hyphen."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def truncate(text, limit):
    """Cut text to at most limit characters, ending with an ellipsis if cut."""
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"
