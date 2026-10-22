"""Put a chat message on the macOS clipboard as rich text for Teams and Slack.

Usage: python3 -I message.py <out.html> < fragment.html

Reads an HTML fragment from stdin, checks that it uses only markup both apps
render the same way, writes a preview page with a Copy button to <out.html>
(removing older preview pages in that directory), puts the HTML and a
plain-text fallback on the clipboard, and prints the plain text.
"""
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

ALLOWED_TAGS = {"a", "b", "i", "s", "code", "pre", "br", "ul", "ol", "li"}
# Not after a letter or digit, so times like 10:30:45 and ratios like 1:2:3 pass.
SHORTCODE = re.compile(r"(?<!\w):[a-z0-9_+-]+:")
URL = re.compile(r"\S+://\S+")
MARKER = "<title>Message</title>"

PAGE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Message</title>
<style>
  body { font: 15px/1.5 -apple-system, sans-serif; margin: 2rem; max-width: 46rem; }
  #message { border: 1px solid #ccc; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<div id="message">
{fragment}
</div>
<button id="copy" type="button">Copy</button>
<script>
document.getElementById("copy").addEventListener("click", function () {
  var range = document.createRange();
  range.selectNodeContents(document.getElementById("message"));
  var selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand("copy");
  this.textContent = "Copied!";
});
</script>
</body>
</html>
"""


class Validator(HTMLParser):
    """Collects unsupported tags and attributes, and Slack shortcodes in text."""

    def __init__(self):
        super().__init__()
        self.problems = []
        self.in_code = 0

    def handle_starttag(self, tag, attrs):
        if tag not in ALLOWED_TAGS:
            self.problems.append(f"unsupported tag <{tag}>")
            return
        for name, _ in attrs:
            if not (tag == "a" and name == "href"):
                self.problems.append(f"unsupported attribute {name} on <{tag}>")
        if tag in ("code", "pre"):
            self.in_code += 1

    def handle_endtag(self, tag):
        if tag not in ALLOWED_TAGS:
            self.problems.append(f"unsupported tag </{tag}>")
        elif tag in ("code", "pre") and self.in_code:
            self.in_code -= 1

    def handle_data(self, data):
        # Code shows literally in both apps, so a shortcode there is meant as text.
        if self.in_code:
            return
        for match in SHORTCODE.finditer(URL.sub(" ", data)):
            self.problems.append(
                f"emoji shortcode {match.group()} (use a Unicode emoji; Teams shows shortcodes as text)"
            )


class PlainText(HTMLParser):
    """Renders the fragment as plain text: links as 'text (url)', list items as bullets."""

    def __init__(self):
        super().__init__()
        self.parts = []
        self.line_start = True
        self.lists = 0
        self.pre = 0
        self.link = None  # (href, index in parts where the link text starts)

    def emit(self, text):
        if text:
            self.parts.append(text)
            self.line_start = text.endswith("\n")

    def new_line(self):
        if not self.line_start:
            self.emit("\n")

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.emit("\n")
        elif tag == "li":
            self.new_line()
            self.parts.append("  " * (self.lists - 1) + "• ")
            self.line_start = True
        elif tag in ("ul", "ol"):
            self.lists += 1
        elif tag == "pre":
            self.new_line()
            self.pre += 1
        elif tag == "a":
            self.link = (dict(attrs).get("href") or "", len(self.parts))

    def handle_endtag(self, tag):
        if tag in ("ul", "ol"):
            self.lists = max(self.lists - 1, 0)
            self.new_line()
        elif tag == "pre":
            self.pre = max(self.pre - 1, 0)
            self.new_line()
        elif tag == "a" and self.link:
            href, start = self.link
            self.link = None
            text = "".join(self.parts[start:]).strip()
            del self.parts[start:]
            if not href or text == href:
                self.emit(text or href)
            elif not text:
                self.emit(href)
            else:
                self.emit(f"{text} ({href})")

    def handle_data(self, data):
        # Outside <pre>, source line breaks and indentation render as one space.
        if not self.pre:
            data = re.sub(r"\s+", " ", data)
            if self.line_start:
                data = data.lstrip()
        self.emit(data)

    def text(self):
        lines = [line.rstrip() for line in "".join(self.parts).split("\n")]
        return "\n".join(lines).strip("\n")


def validate(fragment):
    """Raises ValueError listing every problem that would render differently in Teams and Slack."""
    parser = Validator()
    parser.feed(fragment)
    parser.close()
    if parser.problems:
        allowed = ", ".join(sorted(ALLOWED_TAGS))
        raise ValueError("; ".join(parser.problems) + f". Allowed tags: {allowed}.")


def plain_text(fragment):
    parser = PlainText()
    parser.feed(fragment)
    parser.close()
    return parser.text()


def write_preview(out, fragment):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(PAGE.replace("{fragment}", fragment), encoding="utf-8")


def remove_old_previews(out):
    """Deletes other *-message.html pages next to out, only if this script wrote them."""
    for page in out.parent.glob("*-message.html"):
        if page.resolve() == out.resolve() or not page.is_file():
            continue
        if MARKER in page.read_text(encoding="utf-8", errors="replace"):
            page.unlink()


def set_clipboard(text, fragment):
    # The charset meta keeps emoji intact in apps that would otherwise guess the encoding.
    html_hex = ('<meta charset="utf-8">' + fragment).encode("utf-8").hex().upper()
    subprocess.run(
        [
            "osascript",
            "-e", "on run argv",
            "-e", f"set the clipboard to {{text:(item 1 of argv), «class HTML»:«data HTML{html_hex}»}}",
            "-e", "end run",
            # Ends osascript's options, so text starting with "-" is still an argument.
            "--", text,
        ],
        check=True,
    )


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python3 -I message.py <out.html> < fragment.html")
    out = Path(sys.argv[1])
    fragment = sys.stdin.read().strip()
    if not fragment:
        sys.exit("message.py: no HTML fragment on stdin")
    try:
        validate(fragment)
    except ValueError as err:
        sys.exit(f"message.py: {err}")
    text = plain_text(fragment)
    write_preview(out, fragment)
    remove_old_previews(out)
    try:
        set_clipboard(text, fragment)
    except (OSError, subprocess.CalledProcessError) as err:
        sys.exit(f"message.py: could not set the clipboard ({err}); the preview page is at {out}")
    print(text)


if __name__ == "__main__":
    main()
