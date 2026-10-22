---
name: message
description: >-
  Writes a short chat message and puts it on the user's macOS clipboard as rich
  text that pastes cleanly into both Microsoft Teams and Slack, with a preview
  page to copy it again. Use when the user asks for a Teams, Slack, or chat
  message, post, reply, announcement, status update, or anything to paste or
  send to someone; and whenever about to hand the user a message to send (a
  draft reply, a status update, a note to a teammate, a PR or ticket comment to
  post in chat), even if they didn't say "message", instead of printing it.
argument-hint: "<what the message is about>"
allowed-tools:
  - Bash(python3 -I ${CLAUDE_SKILL_DIR}/scripts/message.py:*)
---
# Message

Message request: `$ARGUMENTS`

This skill applies whenever you produce a message for the user to send, not only when they ask for it by name. The user pastes it into Teams or Slack; never ask which one or try to detect it, and never post anything yourself.

## 1. Write the message
If a caller (another skill, a script, or the user) supplied a prebuilt HTML fragment, skip to step 2 and send it through unchanged. Otherwise write an HTML fragment that renders the same in both apps:
- **Tags:** only `a`, `b`, `i`, `s`, `code`, `pre`, `br`, `ul`, `ol`, `li`, and no attributes except `href` on `a`. `<br>` is a line break and `<br><br>` a blank line. HTML-escape text: `&amp;`, `&lt;`, `&gt;`, and `&quot;` inside attributes.
- **Emoji:** real Unicode emoji (for example ✅), at most one, only when it adds meaning; none is fine. Never Slack `:shortcodes:`: Teams shows them as text.
- **No Slack-only syntax:** no `<@U123>` mentions, `<!channel>`, `<url|label>` links, or `*bold*` mrkdwn. Don't emit placeholders for mentions or channel pings; if the user asked for one, tell them in your reply to type it after pasting.

Write it for the reader:
- Short and decision-first: lead with the point or the ask, then only the context the reader needs. No walls of text.
- Link with `<a href>` and a natural label (the ticket summary, the PR title) instead of a bare URL.
- Never guess URLs, ticket keys, names, or titles. If one is missing, ask for it.
- Never include PHI or other sensitive personal data.
- No greeting or sign-off unless asked. Match the tone of the request.

## 2. Copy it
The preview path is `$HOME/.claude/messages/<slug>-message.html`, where `<slug>` is the ticket key if there is one, else a short kebab-case topic. The helper creates the directory.

Pipe the fragment into the helper through a quoted heredoc, so the shell expands nothing in the message:
```sh
python3 -I "${CLAUDE_SKILL_DIR}/scripts/message.py" "$HOME/.claude/messages/<slug>-message.html" <<'MSG'
<fragment>
MSG
```
If you run in a sandbox, run this command outside it (in Claude Code, with `dangerouslyDisableSandbox`): the sandbox can't reach the clipboard.

The helper rejects unsupported tags, attributes, and shortcodes, writes the preview page, removes its older preview pages in that directory, sets the clipboard to the HTML with a plain-text fallback, and prints the plain text. If it fails, show the user its error output and stop. Don't hand them a rebuilt message instead.

## 3. Reply
- Say the message is on the clipboard.
- Link the preview page as `[Copy message](file://<preview path>)`, with `$HOME` expanded to the absolute path and spaces written as `%20`.
- For a message you wrote, also show the plain text the helper printed.
