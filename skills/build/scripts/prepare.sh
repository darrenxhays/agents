#!/usr/bin/env bash
# Preflight for a build: prints one JSON object describing the repository, the
# output directory, the working tree, the mode, and the names this run uses.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: prepare.sh [--output-dir DIR] [--ticket ID] [--slug SLUG]

Run from inside the target Git repository.

--output-dir  Where plans, reviews, and run reports go. Default: BUILD_OUTPUT_DIR,
              else zz. Relative paths resolve from the repository root.
--ticket      Ticket id, used in the suggested branch name.
--slug        Short slug of the request, used in the branch and file names.

Creates the output directory's plans/, reviews/, and runs/ subdirectories,
excludes the directory from Git through info/exclude when it is inside the
repository, and writes a snapshot of the working tree to runs/.
USAGE
}

output_dir="${BUILD_OUTPUT_DIR:-}"
ticket=""
slug=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) [[ $# -ge 2 ]] || { usage; exit 2; }; output_dir="$2"; shift 2 ;;
    --ticket) [[ $# -ge 2 ]] || { usage; exit 2; }; ticket="$2"; shift 2 ;;
    --slug) [[ $# -ge 2 ]] || { usage; exit 2; }; slug="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
[[ -n "$output_dir" ]] || output_dir="zz"
if [[ -n "$slug" && ! "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Slug must be lowercase letters, digits, and single hyphens: $slug" >&2
  exit 2
fi

fail() { echo "$1" >&2; exit 1; }

if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  fail "Run this script from inside the target Git repository."
fi
repo_root="$(cd "$repo_root" && pwd -P)"
cd "$repo_root"
git_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
worktree_git_dir="$(cd "$(git rev-parse --absolute-git-dir)" && pwd -P)"

json_str() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/\\t}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}
  printf '"%s"' "$s"
}
# One JSON array from stdin lines.
json_lines() {
  local line sep="" out="["
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    out+="$sep$(json_str "$line")"; sep=","
  done
  printf '%s]' "$out"
}
# The value, or null when empty.
json_or_null() { if [[ -n "$1" ]]; then json_str "$1"; else printf null; fi; }
# Runs a command for at most $1 seconds (network calls to a PR host can hang).
with_timeout() { local secs=$1; shift; perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }

# --- Output directory -------------------------------------------------------

case "$output_dir" in
  /*) ;;
  *) output_dir="$repo_root/$output_dir" ;;
esac
# Resolve symlinks in the part that exists; the rest is created below.
existing="$output_dir"
rest=""
while [[ ! -d "$existing" ]]; do
  rest="/$(basename "$existing")$rest"
  existing="$(dirname "$existing")"
done
case "$rest/" in
  */./*|*/../*) fail "Output directory can't contain . or .. after its existing part: $output_dir" ;;
esac
output_dir="$(cd "$existing" && pwd -P)$rest"
output_dir="${output_dir%/}"

case "$output_dir/" in
  "$repo_root/") fail "Output directory can't be the repository root: $output_dir" ;;
  "$git_dir/"*|"$worktree_git_dir/"*) fail "Output directory can't be inside Git metadata: $output_dir" ;;
esac
case "$repo_root/" in
  "$output_dir/"*) fail "Output directory can't contain the repository: $output_dir" ;;
esac
inside_repo=""
case "$output_dir/" in
  "$repo_root/"*) inside_repo=1; output_rel="${output_dir#"$repo_root/"}" ;;
esac
if [[ -n "$inside_repo" && -n "$(git ls-files -- "$output_rel" | head -n 1)" ]]; then
  fail "Output directory has tracked files; choose a dedicated directory: $output_dir"
fi
mkdir -p "$output_dir/plans" "$output_dir/reviews" "$output_dir/runs"

if [[ -z "$inside_repo" ]]; then
  exclude_status="outside the repository"
elif git check-ignore -q -- "$output_rel/x"; then
  exclude_status="already ignored"
else
  # Root-anchored, with ignore-pattern metacharacters and trailing spaces escaped.
  entry="/$(printf '%s' "$output_rel" | sed -e 's/[][\\*?]/\\&/g' -e 's/ *$//')"
  trailing="${output_rel##*[! ]}"
  entry+="${trailing// /\\ }/"
  exclude_file="$(git rev-parse --git-path info/exclude)"
  mkdir -p "$(dirname "$exclude_file")"
  if [[ -s "$exclude_file" && -n "$(tail -c1 "$exclude_file")" ]]; then echo >> "$exclude_file"; fi
  printf '%s\n' "$entry" >> "$exclude_file"
  exclude_status="added $entry to $(cd "$(dirname "$exclude_file")" && pwd -P)/$(basename "$exclude_file")"
fi

# --- Working tree -------------------------------------------------------------

run_id="$(date +%Y%m%d-%H%M%S)"
staged="$(git diff --cached --name-only)"
unstaged="$(git diff --name-only)"
untracked="$(git ls-files --others --exclude-standard)"
worktree_file="$output_dir/runs/$run_id-worktree.txt"
{
  echo "Branch: $(git branch --show-current)"
  printf '\nStaged:\n%s\n' "${staged:-none}"
  printf '\nUnstaged:\n%s\n' "${unstaged:-none}"
  printf '\nUntracked:\n%s\n' "${untracked:-none}"
} > "$worktree_file"

# --- Branches -------------------------------------------------------------------

current_branch="$(git branch --show-current)"
remote="$(git remote | grep -x origin || git remote | head -n 1 || true)"
default_branch=""
if [[ -n "$remote" ]]; then
  default_branch="$(git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null || true)"
  default_branch="${default_branch#"$remote/"}"
fi
if [[ -z "$default_branch" ]]; then
  for name in main master trunk; do
    if git show-ref --verify --quiet "refs/heads/$name"; then default_branch="$name"; break; fi
  done
fi

# Head and base branches of recently merged PRs, as "head base" lines.
remote_url="$( [[ -n "$remote" ]] && git remote get-url "$remote" 2>/dev/null || true)"
pr_branches=""
pr_source=""
case "$remote_url" in
  *github.com[:/]*)
    if command -v gh >/dev/null 2>&1; then
      pr_branches="$(GH_PROMPT_DISABLED=1 with_timeout 20 gh pr list --state merged --limit 30 \
        --json headRefName,baseRefName --jq '.[] | .headRefName + " " + .baseRefName' 2>/dev/null || true)"
      pr_source="merged GitHub PRs"
    fi
    ;;
  *dev.azure.com*|*visualstudio.com*)
    if command -v az >/dev/null 2>&1; then
      pr_branches="$(with_timeout 30 az repos pr list --status completed --top 30 --detect true \
        --query '[].[sourceRefName, targetRefName]' -o tsv 2>/dev/null \
        | sed -e 's#refs/heads/##g' | tr '\t' ' ' || true)"
      pr_source="completed Azure DevOps PRs"
    fi
    ;;
esac

evidence=()
base_branch=""
flow_feature="$(git config --get gitflow.prefix.feature || true)"
flow_develop="$(git config --get gitflow.branch.develop || true)"
if [[ -n "$pr_branches" ]]; then
  read -r count base_branch < <(awk '{ print $2 }' <<<"$pr_branches" | sort | uniq -c | sort -rn | head -n 1) || true
  evidence+=("$count of $(wc -l <<<"$pr_branches" | tr -d ' ') recent $pr_source targeted $base_branch")
elif [[ -n "$flow_develop" ]]; then
  base_branch="$flow_develop"
  evidence+=("git-flow config: gitflow.branch.develop=$flow_develop")
else
  base_branch="$default_branch"
fi

# Branch names to learn the convention from: recent PR heads, else remote branches.
names="$(awk '{ print $1 }' <<<"$pr_branches")"
names_source="$pr_source"
if [[ -z "$names" && -n "$remote" ]]; then
  names="$(git for-each-ref --format='%(refname)' "refs/remotes/$remote" | sed -e "s#^refs/remotes/$remote/##")"
  names_source="branches on $remote"
fi
names="$(grep -vxF -e HEAD -e "$default_branch" -e "$base_branch" -e main -e master -e develop <<<"$names" || true)"

prefix=""
ticket_upper=""
if [[ -n "$flow_feature" ]]; then
  prefix="$flow_feature"
  evidence+=("git-flow config: gitflow.prefix.feature=$flow_feature")
fi
total="$(grep -c . <<<"$names" || true)"
if [[ "$total" -gt 0 ]]; then
  counts="$(awk '{ n = index($0, "/"); print (n ? substr($0, 1, n) : "(no prefix)") }' <<<"$names" | sort | uniq -c | sort -rn)"
  evidence+=("prefixes of $total $names_source: $(awk '{ printf "%s%s %s", sep, $2, $1; sep = ", " }' <<<"$counts")")
  read -r top_count top_prefix <<<"$(head -n 1 <<<"$counts")"
  if [[ -z "$prefix" && "$total" -ge 3 && "$top_prefix" != "(no prefix)" && $((top_count * 2)) -ge "$total" ]]; then
    prefix="$top_prefix"
  fi
  # Ticket ids after the prefix: KEY-123 keeps its case when most names do.
  upper="$(sed -e 's#^[^/]*/##' <<<"$names" | grep -cE '^[A-Z][A-Z0-9]*-[0-9]+' || true)"
  lower="$(sed -e 's#^[^/]*/##' <<<"$names" | grep -cE '^[a-z][a-z0-9]*-[0-9]+' || true)"
  if [[ "$upper" -gt "$lower" ]]; then
    ticket_upper=1
    evidence+=("$upper of $total names start with an uppercase ticket id")
  fi
fi

ticket_part="$ticket"
[[ -n "$ticket_upper" ]] || ticket_part="$(tr '[:upper:]' '[:lower:]' <<<"$ticket")"
suggested="$prefix${ticket_part:+$ticket_part-}$slug"
suggested="${suggested%-}"
if [[ -z "$prefix" ]]; then
  convention="none found; default <ticket-id>-<slug>"
else
  convention="$prefix<ticket-id>-<slug>"
fi

# --- Mode and models -------------------------------------------------------

mode="claude"
codex_json="null"
if command -v codex >/dev/null 2>&1; then
  mode="codex"
  login_ok=true
  login="$(codex login status 2>&1)" || login_ok=false
  models="null"
  models_error=""
  if ! command -v python3 >/dev/null 2>&1; then
    models_error="python3 is needed to read the Codex model catalog"
  elif ! catalog="$(codex debug models 2>/dev/null)"; then
    models_error="codex debug models failed; run it to see why"
  elif ! models="$(python3 -c '
import json, re, sys
# Listed, current models only, at the highest version of each family.
best = {}
for m in json.load(sys.stdin)["models"]:
    if m.get("visibility") != "list":
        continue
    if re.search(r"previous[- ]generation|\bolder\b|\blegacy\b", m.get("description") or "", re.I):
        continue
    version = re.search(r"\d+(?:\.\d+)*", m["slug"])
    family = m["slug"][: version.start()] + m["slug"][version.end() :] if version else m["slug"]
    key = tuple(int(n) for n in version.group().split(".")) if version else ()
    if family not in best or key > best[family][0]:
        efforts = [l["effort"] if isinstance(l, dict) else l for l in m.get("supported_reasoning_levels", [])]
        best[family] = (key, {"slug": m["slug"], "description": m.get("description", ""),
                              "efforts": [e for e in efforts if e != "ultra"]})
print(json.dumps([entry for _, entry in best.values()]))
' <<<"$catalog" 2>&1)"; then
    models_error="could not read the Codex model catalog: $models"
    models="null"
  fi
  codex_json="{\"login_ok\":$login_ok,\"login\":$(json_str "$login"),\"models\":$models,\"models_error\":$(json_or_null "$models_error")}"
fi

# --- Output -------------------------------------------------------------------

plan_path=""
review_path=""
if [[ -n "$slug" ]]; then
  plan_path="$output_dir/plans/$run_id-$slug.md"
  review_path="$output_dir/reviews/$run_id-$slug.md"
fi

printf '{'
printf '"repo_root":%s,' "$(json_str "$repo_root")"
printf '"current_branch":%s,' "$(json_or_null "$current_branch")"
printf '"default_branch":%s,' "$(json_or_null "$default_branch")"
printf '"base_branch":%s,' "$(json_or_null "$base_branch")"
printf '"branch":{"suggested":%s,"convention":%s,"evidence":%s},' \
  "$(json_or_null "$suggested")" "$(json_str "$convention")" "$(printf '%s\n' ${evidence[@]+"${evidence[@]}"} | json_lines)"
printf '"output_dir":%s,' "$(json_str "$output_dir")"
printf '"exclude":%s,' "$(json_str "$exclude_status")"
printf '"run_id":"%s",' "$run_id"
printf '"plan_path":%s,"review_path":%s,' "$(json_or_null "$plan_path")" "$(json_or_null "$review_path")"
printf '"worktree":{"file":%s,"staged":%s,"unstaged":%s,"untracked":%s},' "$(json_str "$worktree_file")" \
  "$(json_lines <<<"$staged")" "$(json_lines <<<"$unstaged")" "$(json_lines <<<"$untracked")"
printf '"mode":"%s","codex":%s' "$mode" "$codex_json"
printf '}\n'
