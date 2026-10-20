#!/usr/bin/env python3
"""Runs the pragmatic-engineer tasks against one checkout of this repository.

    python3 evals/pragmatic-engineer/run.py --checkout <repo checkout> --label new [--runs 3] [--model opus]
    python3 evals/pragmatic-engineer/run.py --report old new   # tables from saved results

Each run copies fixture/ into a fresh git repository and has `claude -p` do one
task from tasks.json with the checkout's plugin loaded the way users get it (its
SessionStart hook included). Only the plugin is loaded: no user settings, other
plugins, CLAUDE.md, or MCP servers. The hook runs with HOME pointed at a
throwaway directory, so it never touches the real ~/.codex.

Scores per run: hidden and existing tests pass; changed lines outside tests/;
the existing helper or standard library reused (tasks with a "reuse" rule);
whether Claude stopped to ask (no source change and a question in its final
message); and whether files outside the task's allowed set, and the task's bait
lines, were left alone. Writes results/<label>.json and prints a Markdown table.
"""
import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SANDBOX_TOOLS = [
    "Read", "Edit", "Write", "Grep", "Glob", "Skill",
    "Bash(python3:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)",
]


def sh(args, cwd=None, env=None, timeout=None):
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def make_plugin(checkout, dest):
    """A copy of the checkout's plugin whose hooks run with HOME=$EVAL_HOME."""
    for part in ["skills", "hooks", ".claude-plugin"]:
        shutil.copytree(os.path.join(checkout, part), os.path.join(dest, part))
    manifest_path = os.path.join(dest, ".claude-plugin", "plugin.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    for groups in manifest.get("hooks", {}).values():
        for group in groups:
            for hook in group.get("hooks", []):
                hook["command"] = 'HOME="$EVAL_HOME" sh ' + hook["command"]
    with open(manifest_path, "w") as f:
        json.dump(manifest, f)


def changed_lines(work):
    """Added plus deleted lines per file, from git diff --numstat (untracked files included)."""
    sh(["git", "add", "-A"], cwd=work)
    out = sh(["git", "diff", "--cached", "--numstat"], cwd=work).stdout
    lines = {}
    for row in out.splitlines():
        added, deleted, path = row.split("\t")
        lines[path] = int(added) + int(deleted)
    return lines


def run_one(task, checkout, model, keep):
    tmp = tempfile.mkdtemp(prefix="pe-eval-")
    work, plugin, home = (os.path.join(tmp, d) for d in ["work", "plugin", "home"])
    shutil.copytree(os.path.join(HERE, "fixture"), work)
    os.makedirs(os.path.join(home, ".codex"))
    make_plugin(checkout, plugin)
    for args in (["init", "-q"], ["add", "-A"], ["-c", "user.name=eval", "-c", "user.email=eval@example.com",
                                                   "commit", "-qm", "fixture"]):
        sh(["git"] + args, cwd=work)

    env = dict(os.environ, EVAL_HOME=home)
    proc = sh(
        ["claude", "-p", task["prompt"], "--plugin-dir", plugin, "--model", model,
         "--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence",
         "--output-format", "stream-json", "--verbose", "--max-turns", "60",
         "--allowedTools", *SANDBOX_TOOLS, "--disallowedTools", "Agent", "AskUserQuestion"],
        cwd=work, env=env, timeout=1800,
    )
    events = [json.loads(l) for l in proc.stdout.splitlines() if l.startswith("{")]
    result = next((e for e in reversed(events) if e.get("type") == "result"), {})
    skill_loads = sum(
        1 for e in events if e.get("type") == "assistant"
        for c in e["message"].get("content", [])
        if c.get("type") == "tool_use" and c.get("name") == "Skill"
    )
    message = result.get("result", "")

    lines = changed_lines(work)
    src = {p: n for p, n in lines.items() if not p.startswith("tests/")}
    allowed = set(task["allowed"])
    unrelated = sorted(p for p in src if p not in allowed)
    for path, text in task.get("bait", {}).items():
        with open(os.path.join(work, path)) as f:
            if text not in f.read():
                unrelated.append(path + " (bait line changed)")

    reused = None
    if "reuse" in task:
        rule = task["reuse"]
        diff = sh(["git", "diff", "--cached", "-U0", "--", rule["file"]], cwd=work).stdout
        added = "\n".join(l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++"))
        reused = bool(re.search(rule["must"], added)) and not re.search(rule["must_not"], added)

    shutil.copy(os.path.join(HERE, "checks", task["id"] + ".py"), os.path.join(work, "tests", "test_zz_hidden.py"))
    tests = sh([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=work, timeout=300)

    record = {
        "task": task["id"],
        "tests_pass": tests.returncode == 0,
        "src_lines": sum(src.values()),
        "test_lines": sum(n for p, n in lines.items() if p.startswith("tests/")),
        "files": sorted(lines),
        "reused": reused,
        "unrelated": unrelated,
        "skill_loads": skill_loads,
        "turns": result.get("num_turns"),
        "cost_usd": result.get("total_cost_usd"),
        "seconds": round((result.get("duration_ms") or 0) / 1000),
        "message": message,
        "tests_output": tests.stderr[-1500:] if tests.returncode else "",
    }
    if keep:
        record["dir"] = tmp
    else:
        shutil.rmtree(tmp, ignore_errors=True)
    return record


def asked(r):
    """Stopped to ask: left the source unchanged and asked a question in the final message."""
    return r["src_lines"] == 0 and "?" in r["message"]


def score(task, r):
    """1 point each: tests pass, asked exactly when expected, nothing unrelated touched, reuse (when scored)."""
    points = [r["tests_pass"], asked(r) == task["expect_question"], not r["unrelated"]]
    if r["reused"] is not None:
        points.append(r["reused"])
    return sum(points), len(points)


def table(tasks, records):
    yn = lambda v: "-" if v is None else ("y" if v else "n")
    rows = [
        "| Task | Score | Tests pass | Src lines changed | Reused | Asked | Unrelated touched | Skill loads | Turns |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for task in tasks:
        rs = [r for r in records if r["task"] == task["id"]]
        if not rs:
            continue
        got, out_of = (sum(score(task, r)[i] for r in rs) for i in (0, 1))
        col = lambda f: "/".join(str(f(r)) for r in rs)
        rows.append(
            f"| {task['id']} | {got}/{out_of} | {col(lambda r: yn(r['tests_pass']))} | {col(lambda r: r['src_lines'])} "
            f"| {col(lambda r: yn(r['reused']))} | {col(lambda r: yn(asked(r)))} "
            f"| {col(lambda r: yn(bool(r['unrelated'])))} | {col(lambda r: r['skill_loads'])} | {col(lambda r: r['turns'])} |"
        )
    total = sum(score(t, r)[0] for t in tasks for r in records if r["task"] == t["id"])
    out_of = sum(score(t, r)[1] for t in tasks for r in records if r["task"] == t["id"])
    cost = sum(r["cost_usd"] or 0 for r in records)
    rows.append(f"\nTotal {total}/{out_of}; cost ${cost:.2f}; mean {sum(r['seconds'] for r in records) / len(records):.0f}s per run.")
    return "\n".join(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", help="repository checkout whose plugin to evaluate")
    parser.add_argument("--label")
    parser.add_argument("--report", nargs="+", metavar="LABEL", help="print tables from saved results instead of running")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--model", default="opus")
    parser.add_argument("--tasks", help="comma-separated task ids (default: all)")
    parser.add_argument("-j", "--jobs", type=int, default=4)
    parser.add_argument("--keep", action="store_true", help="keep each run's directory")
    args = parser.parse_args()

    with open(os.path.join(HERE, "tasks.json")) as f:
        tasks = json.load(f)
    if args.tasks:
        tasks = [t for t in tasks if t["id"] in args.tasks.split(",")]
    if args.report:
        for label in args.report:
            with open(os.path.join(HERE, "results", label + ".json")) as f:
                saved = json.load(f)
            print(f"### {label} ({saved['model']}, {saved['runs']} runs per task)\n\n{table(tasks, saved['records'])}\n")
        return
    if not (args.checkout and args.label):
        parser.error("--checkout and --label are required unless --report is given")
    checkout = os.path.abspath(args.checkout)
    jobs = [(t, n) for t in tasks for n in range(args.runs)]
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        records = list(pool.map(lambda job: run_one(job[0], checkout, args.model, args.keep), jobs))

    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    with open(os.path.join(HERE, "results", args.label + ".json"), "w") as f:
        json.dump({"label": args.label, "model": args.model, "runs": args.runs, "records": records}, f, indent=2)

    print(table(tasks, records))

if __name__ == "__main__":
    main()
