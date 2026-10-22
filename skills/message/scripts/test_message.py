"""Tests for message.py (the clipboard call needs a real clipboard and isn't tested).

Run: python3 skills/message/scripts/test_message.py
"""
import tempfile
import unittest
from pathlib import Path

import message


class PlainTextTest(unittest.TestCase):
    def test_link_with_label(self):
        self.assertEqual(
            message.plain_text('See <a href="https://example.com/pr/1">Fix login</a>.'),
            "See Fix login (https://example.com/pr/1).",
        )

    def test_link_whose_text_is_the_url(self):
        self.assertEqual(
            message.plain_text('<a href="https://example.com">https://example.com</a>'),
            "https://example.com",
        )

    def test_list_items_become_bullets(self):
        fragment = "Done:\n<ul>\n  <li>one</li>\n  <li><b>two</b></li>\n</ul>\nNext up"
        self.assertEqual(message.plain_text(fragment), "Done:\n• one\n• two\nNext up")

    def test_nested_list_is_indented(self):
        fragment = "<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>"
        self.assertEqual(message.plain_text(fragment), "• a\n  • b\n• c")

    def test_br_becomes_newline(self):
        self.assertEqual(message.plain_text("one<br>two<br><br>three"), "one\ntwo\n\nthree")

    def test_source_whitespace_collapses_outside_pre(self):
        self.assertEqual(
            message.plain_text("a\n   b<pre>x\n  y</pre>c"), "a b\nx\n  y\nc"
        )


class ValidateTest(unittest.TestCase):
    def test_accepts_supported_markup(self):
        message.validate(
            '<b>Shipped</b> ✅ at 10:30 (10:30:45 UTC)<br>'
            '<a href="https://example.com/a:b:c">https://example.com/:id:</a>'
            "<ul><li><i>x</i> <s>y</s> <code>z</code></li></ul><pre>p</pre>"
        )

    def test_rejects_shortcode(self):
        with self.assertRaisesRegex(ValueError, ":white_check_mark:"):
            message.validate("Done :white_check_mark:")

    def test_rejects_shortcode_after_url_in_text(self):
        with self.assertRaisesRegex(ValueError, ":tada:"):
            message.validate("https://example.com :tada:")

    def test_allows_shortcode_text_inside_code(self):
        message.validate("<code>emoji: :tada:</code>")

    def test_rejects_unsupported_tag(self):
        with self.assertRaisesRegex(ValueError, "unsupported tag <div>"):
            message.validate("<div>hi</div>")

    def test_rejects_unsupported_attribute(self):
        with self.assertRaisesRegex(ValueError, "unsupported attribute style on <b>"):
            message.validate('<b style="color:red">hi</b>')


class CleanupTest(unittest.TestCase):
    def test_removes_only_its_own_older_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            old = tmp / "old-topic-message.html"
            old.write_text("<html><head><title>Message</title></head></html>")
            unrelated = tmp / "team-message.html"
            unrelated.write_text("<html><head><title>Team message</title></head></html>")
            other = tmp / "notes.html"
            other.write_text("<title>Message</title>")
            out = tmp / "new-topic-message.html"

            message.write_preview(out, "<b>hi</b>")
            message.remove_old_previews(out)

            self.assertFalse(old.exists())
            self.assertTrue(unrelated.exists())
            self.assertTrue(other.exists())
            self.assertIn("<b>hi</b>", out.read_text())
            self.assertIn(message.MARKER, out.read_text())


if __name__ == "__main__":
    unittest.main()
