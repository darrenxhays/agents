# Eval results

## How to run

```sh
# pragmatic-engineer: six tasks in a small Python fixture repo, each run by `claude -p`
python3 evals/pragmatic-engineer/run.py --checkout <checkout> --label <name> [--runs 3] [--model opus]
python3 evals/pragmatic-engineer/run.py --report <name> [<name>...]

# build: static checks only (script tests with a fake codex, and every path the skill names exists)
bash evals/build/check.sh
```

To evaluate an older version, export it first, for example
`mkdir /tmp/old && git archive main skills hooks .claude-plugin | tar -x -C /tmp/old`.

`claude plugin eval` is available, but its graders can't run a test command or read a diff
on their own, so the pragmatic-engineer suite uses `run.py` instead. Each run loads only the
plugin under test (its SessionStart hook included, with `HOME` pointed at a throwaway
directory so it never touches the real `~/.codex`): no user settings, other plugins,
`CLAUDE.md`, or MCP servers.

Columns: **Score** is one point per run each for tests passing (existing plus hidden),
asking exactly when expected (only task d), touching nothing unrelated, and, on b and c,
reusing the existing helper or the standard library. **Src lines changed** is added plus
deleted lines outside `tests/`. **Asked** means the source was left unchanged and the final
message asks a question. **Unrelated touched** covers files outside the task's allowed set
and the task's bait lines (for example an unused import next to the bug).

Tasks: a) bug in a shared helper with two callers, one depending on current behavior;
b) feature an existing helper covers; c) standard library suffices; d) ambiguous request;
e) refactor with existing tests; f) one-line change.

## Baseline (before the rewrite)

pragmatic-engineer, Opus, 3 runs per task:

| Task | Score | Tests pass | Src lines changed | Reused | Asked | Unrelated touched | Skill loads | Turns |
|---|---|---|---|---|---|---|---|---|
| a-shared-helper-bug | 9/9 | y/y/y | 2/2/3 | -/-/- | n/n/n | n/n/n | 1/1/1 | 11/13/11 |
| b-existing-helper | 12/12 | y/y/y | 5/5/5 | y/y/y | n/n/n | n/n/n | 1/1/1 | 12/12/12 |
| c-stdlib | 11/12 | y/y/y | 4/12/4 | y/n/y | n/n/n | n/n/n | 1/1/1 | 12/9/13 |
| d-ambiguous | 8/9 | y/y/y | 9/0/0 | -/-/- | n/y/y | n/n/n | 1/1/1 | 8/5/6 |
| e-refactor | 9/9 | y/y/y | 25/25/25 | -/-/- | n/n/n | n/n/n | 1/1/1 | 11/10/6 |
| f-one-line | 9/9 | y/y/y | 2/2/2 | -/-/- | n/n/n | n/n/n | 1/1/1 | 9/8/9 |

Total 58/60; cost $2.61; mean 26s per run. Misses: on c, one run added a regex format check
next to `date.fromisoformat`; on d, one run picked a reading, stated it, and built it.

build: `run-codex.test.sh` passes; every path SKILL.md names exists.

## Part 1: pragmatic-engineer rewrite (old delivery)

Same suite, Opus, 3 runs per task. First draft of the new SKILL.md:

| Task | Score | Src lines changed | Asked |
|---|---|---|---|
| a-shared-helper-bug | 9/9 | 2/2/2 | n/n/n |
| b-existing-helper | 12/12 | 5/5/5 | n/n/n |
| c-stdlib | 12/12 | 8/14/11 | n/n/n |
| d-ambiguous | 6/9 | 8/9/9 | n/n/n |
| e-refactor | 9/9 | 25/25/25 | n/n/n |
| f-one-line | 9/9 | 2/2/2 | n/n/n |

Total 57/60. It lost on d: "otherwise state the assumption in one line and proceed" led it to
build one reading and flag the choice afterward in every run. Restoring the old rule's substance
("present the readings and ask before writing code; don't pick one silently") fixed it:
d 9/9 (0/0/0 lines, asked 3/3) and f still 9/9 without asking. On c the new text used
`strptime` or `fromisoformat` plus a format check in every run (standard library, no hand-rolled
date rules), so diffs were longer than the baseline's but all three scored.

## Part 2: new delivery (body injected by the SessionStart hook)

| Task | Score | Tests pass | Src lines changed | Reused | Asked | Unrelated touched | Skill loads | Turns |
|---|---|---|---|---|---|---|---|---|
| a-shared-helper-bug | 9/9 | y/y/y | 2/2/2 | -/-/- | n/n/n | n/n/n | 0/0/0 | 9/8/7 |
| b-existing-helper | 12/12 | y/y/y | 5/5/5 | y/y/y | n/n/n | n/n/n | 0/0/0 | 10/11/10 |
| c-stdlib | 12/12 | y/y/y | 11/8/8 | y/y/y | n/n/n | n/n/n | 0/0/0 | 12/11/10 |
| d-ambiguous | 9/9 | y/y/y | 0/0/0 | -/-/- | y/y/y | n/n/n | 0/0/0 | 3/8/3 |
| e-refactor | 9/9 | y/y/y | 25/25/25 | -/-/- | n/n/n | n/n/n | 0/0/0 | 6/6/6 |
| f-one-line | 9/9 | y/y/y | 2/2/2 | -/-/- | n/n/n | n/n/n | 0/0/0 | 7/7/7 |

Total 60/60; cost $2.33; mean 21s per run. No run loaded the skill (the old delivery loaded it in
every run), and runs took fewer turns.
