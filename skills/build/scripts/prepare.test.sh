#!/usr/bin/env bash
# Self-check for prepare.sh against throwaway repositories: bash scripts/prepare.test.sh
set -euo pipefail
scripts="$(cd "$(dirname "$0")" && pwd)"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
unset BUILD_OUTPUT_DIR
fail() { echo "FAIL: $1"; exit 1; }
# Reads a value from prepare's JSON: field 'a.b' or a Python expression on j.
field() { python3 -c 'import json,sys; j=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }

# Claude mode: no codex anywhere on PATH.
no_codex_path=""
IFS=: read -ra dirs <<<"$PATH"
for d in "${dirs[@]}"; do [[ -x "$d/codex" ]] || no_codex_path+="${no_codex_path:+:}$d"; done
prepare() { PATH="$no_codex_path" bash "$scripts/prepare.sh" "$@"; }

new_repo() {
  git init -q "$1"
  git -C "$1" config user.email test@example.com
  git -C "$1" config user.name test
  mkdir -p "$1/src"; echo one > "$1/src/a.txt"
  git -C "$1" add -A; git -C "$1" commit -qm init
}

# Default output dir: created, excluded once, and kept out of the snapshot.
repo="$tmp/repo"; new_repo "$repo"; cd "$repo"
echo two >> src/a.txt; echo new > src/b.txt; echo staged > src/c.txt; git add src/c.txt
out="$(prepare --slug add-thing)"
[ "$(field 'j["output_dir"]' <<<"$out")" = "$repo/zz" ] || fail "default output dir"
for d in plans reviews runs; do [ -d "$repo/zz/$d" ] || fail "zz/$d created"; done
grep -qx '/zz/' .git/info/exclude || fail "zz excluded"
[ "$(field 'j["mode"]' <<<"$out")" = claude ] || fail "claude mode without codex"
[ "$(field 'j["worktree"]["staged"]' <<<"$out")" = "['src/c.txt']" ] || fail "staged snapshot"
[ "$(field 'j["worktree"]["unstaged"]' <<<"$out")" = "['src/a.txt']" ] || fail "unstaged snapshot"
[ "$(field 'j["worktree"]["untracked"]' <<<"$out")" = "['src/b.txt']" ] || fail "untracked snapshot excludes zz"
grep -qx 'src/b.txt' "$(field 'j["worktree"]["file"]' <<<"$out")" || fail "snapshot file"
run_id="$(field 'j["run_id"]' <<<"$out")"
[[ "$run_id" =~ ^[0-9]{8}-[0-9]{6}$ ]] || fail "run id format"
[ "$(field 'j["plan_path"]' <<<"$out")" = "$repo/zz/plans/$run_id-add-thing.md" ] || fail "plan path"
[ "$(field 'j["branch"]["suggested"]' <<<"$out")" = add-thing ] || fail "branch without ticket or convention"
out="$(prepare)"
[ "$(field 'j["exclude"]' <<<"$out")" = "already ignored" ] || fail "rerun sees the exclude"
[ "$(grep -c zz .git/info/exclude)" = 1 ] || fail "exclude entry duplicated"
BUILD_OUTPUT_DIR= prepare >/dev/null; [ -d "$repo/zz" ] || fail "empty BUILD_OUTPUT_DIR keeps zz"

# BUILD_OUTPUT_DIR, from a subdirectory, with ignore metacharacters and a trailing space.
cd "$repo/src"
out="$(BUILD_OUTPUT_DIR='out [x]*?/nested ' prepare)"
[ "$(field 'j["output_dir"]' <<<"$out")" = "$repo/out [x]*?/nested " ] || fail "relative to repo root"
grep -qxF '/out \[x\]\*\?/nested\ /' "$repo/.git/info/exclude" || fail "escaped exclude entry"
touch "$repo/out [x]*?/nested /f"
[ -z "$(git -C "$repo" status --porcelain -- 'out*')" ] || fail "escaped entry ignores the dir"
mkdir -p "$repo/outx/nested "; touch "$repo/outx/nested /f"
[ -n "$(git -C "$repo" status --porcelain -- outx)" ] || fail "escaped entry matched too much"
rm -rf "$repo/outx"

# --output-dir beats BUILD_OUTPUT_DIR; absolute paths outside the repo need no exclude.
out="$(BUILD_OUTPUT_DIR=ignored prepare --output-dir "$tmp/elsewhere")"
[ "$(field 'j["output_dir"]' <<<"$out")" = "$tmp/elsewhere" ] || fail "absolute output dir"
[ "$(field 'j["exclude"]' <<<"$out")" = "outside the repository" ] || fail "outside needs no exclude"
[ ! -e "$repo/ignored" ] || fail "--output-dir overrides BUILD_OUTPUT_DIR"

# Refusals create nothing.
cd "$repo"
for bad in . .git .git/new src .. "$repo" ./src/../zz/.. new/../x; do
  if prepare --output-dir "$bad" >/dev/null 2>&1; then fail "accepted output dir $bad"; fi
done
[ ! -e .git/new ] && [ ! -e new ] || fail "refusal created a directory"
! prepare --slug 'Bad Slug' >/dev/null 2>&1 || fail "accepted a bad slug"

# Branch convention from the remote's branches.
remote="$tmp/remote.git"; git init -q --bare "$remote"
new_repo "$tmp/seed"; git -C "$tmp/seed" branch -M main
for b in feature/PROJ-1-a feature/PROJ-2-b bugfix/PROJ-3-c; do git -C "$tmp/seed" branch "$b"; done
git -C "$tmp/seed" push -q "$remote" --all
git -C "$remote" symbolic-ref HEAD refs/heads/main
git clone -q "$remote" "$tmp/clone"; cd "$tmp/clone"
out="$(prepare --ticket PROJ-9 --slug add-thing)"
[ "$(field 'j["branch"]["suggested"]' <<<"$out")" = feature/PROJ-9-add-thing ] || fail "prefix convention: $out"
[ "$(field 'j["default_branch"]' <<<"$out")" = main ] && [ "$(field 'j["base_branch"]' <<<"$out")" = main ] || fail "default and base"
field 'j["branch"]["evidence"]' <<<"$out" | grep -q 'feature/ 2, bugfix/ 1' || fail "prefix evidence"

# git-flow config wins.
git config gitflow.prefix.feature feat/; git config gitflow.branch.develop dev
out="$(prepare --ticket PROJ-9 --slug add-thing)"
[ "$(field 'j["branch"]["suggested"]' <<<"$out")" = feat/PROJ-9-add-thing ] || fail "git-flow prefix"
[ "$(field 'j["base_branch"]' <<<"$out")" = dev ] || fail "git-flow develop"

# No convention: the default <ticket-id>-<slug>, lowercased.
remote2="$tmp/remote2.git"; git init -q --bare "$remote2"
for b in x-y z; do git -C "$tmp/seed" branch "$b"; done
git -C "$tmp/seed" push -q "$remote2" main x-y z
git -C "$remote2" symbolic-ref HEAD refs/heads/main
git clone -q "$remote2" "$tmp/clone2"; cd "$tmp/clone2"
out="$(prepare --ticket PROJ-9 --slug add-thing)"
[ "$(field 'j["branch"]["suggested"]' <<<"$out")" = proj-9-add-thing ] || fail "default branch format: $out"

# Codex mode: login status, and the catalog filtered to current listed models.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/codex" <<'EOF'
#!/usr/bin/env bash
if [[ "$1 $2" == "login status" ]]; then echo "Logged in"; exit 0; fi
[[ "$1 $2" == "debug models" ]] || exit 1
lv() { printf '[%s]' "$(printf '{"effort":"%s"},' "$@" | sed 's/,$//')"; }
cat <<JSON
{"models":[
 {"slug":"m-2.1-work","visibility":"list","description":"Latest workhorse model.","supported_reasoning_levels":$(lv low medium high ultra)},
 {"slug":"m-2-work","visibility":"list","description":"Previous generation workhorse model.","supported_reasoning_levels":$(lv low)},
 {"slug":"m-3-frontier","visibility":"list","description":"Frontier model for the hardest work.","supported_reasoning_levels":$(lv low max)},
 {"slug":"m-2-quick","visibility":"list","description":"Fast model.","supported_reasoning_levels":$(lv low)},
 {"slug":"m-10-quick","visibility":"list","description":"Fast and affordable.","supported_reasoning_levels":$(lv low medium)},
 {"slug":"m-1-old","visibility":"list","description":"Older balanced model.","supported_reasoning_levels":$(lv low)},
 {"slug":"m-1-classic","visibility":"list","description":"Legacy model.","supported_reasoning_levels":$(lv low)},
 {"slug":"m-4-hidden","visibility":"hide","description":"Internal.","supported_reasoning_levels":$(lv low)}
]}
JSON
EOF
chmod +x "$tmp/bin/codex"
cd "$repo"
out="$(PATH="$tmp/bin:$no_codex_path" bash "$scripts/prepare.sh")"
[ "$(field 'j["mode"]' <<<"$out")" = codex ] || fail "codex mode"
[ "$(field 'j["codex"]["login_ok"]' <<<"$out")" = True ] || fail "login status"
[ "$(field 'sorted(m["slug"] for m in j["codex"]["models"])' <<<"$out")" = "['m-10-quick', 'm-2.1-work', 'm-3-frontier']" ] || fail "catalog filter: $out"
[ "$(field '[m["efforts"] for m in j["codex"]["models"] if m["slug"]=="m-2.1-work"][0]' <<<"$out")" = "['low', 'medium', 'high']" ] || fail "ultra removed"

echo ok
