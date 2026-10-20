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
