#!/usr/bin/env bash
# Self-check for run-codex.sh with a fake codex on PATH: bash scripts/run-codex.test.sh
set -euo pipefail
scripts="$(cd "$(dirname "$0")" && pwd)"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
unset BUILD_OUTPUT_DIR BUILD_CODEX_NETWORK
mkdir -p "$tmp/bin" "$tmp/repo/zz/plans" "$tmp/repo/zz/reviews"
git init -q "$tmp/repo"
fail() { echo "FAIL: $1"; exit 1; }

# Fake codex: a one-model catalog, and exec records its args and prompt.
cat > "$tmp/bin/codex" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == debug ]]; then echo '{"models":[{"slug":"model-a","visibility":"list"}]}'; exit; fi
echo "\$@" > "$tmp/args"; cat > "$tmp/prompt"
[[ -n "\${FAKE_NO_MESSAGE:-}" ]] && exit 0
while [[ \$# -gt 0 ]]; do [[ "\$1" == --output-last-message ]] && echo done > "\$2"; shift; done
EOF
chmod +x "$tmp/bin/codex"
export PATH="$tmp/bin:$PATH"
cd "$tmp/repo"
run() { bash "$scripts/run-codex.sh" "$@"; }

plan="$tmp/repo/zz/plans/20260101-120000-add-thing.md"
cat > "$plan" <<'EOF'
# Plan: add thing
## Subtasks
### S1: first
### S10: tenth
EOF
review="$tmp/repo/zz/reviews/20260101-120000-add-thing.md"
echo '### Should fix' > "$review"

run build --model model-a --effort high --plan "$plan" --subtask S10 >/dev/null
grep -q -- '--model model-a --config model_reasoning_effort="high" --sandbox workspace-write --output-last-message' "$tmp/args" || fail "build args"
grep -qx 'Your subtask: S10' "$tmp/prompt" || fail "subtask line in prompt"
grep -qx '### S10: tenth' "$tmp/prompt" && grep -qx -- '--- PLAN END ---' "$tmp/prompt" || fail "plan in prompt"
head -n 1 "$tmp/prompt" | grep -q 'implementation agent' || fail "implement prompt first"
[ -s zz/runs/20260101-120000-S10-build.md ] || fail "build output named from the run id"
! grep -q 'network_access' "$tmp/args" || fail "network on by default"

run fix --model model-a --effort low --plan "$plan" --review "$review" >/dev/null
grep -q 'model_reasoning_effort="low"' "$tmp/args" || fail "fix effort"
grep -qx '### Should fix' "$tmp/prompt" && grep -qx -- '--- REVIEW END ---' "$tmp/prompt" || fail "review in fix prompt"
grep -q 'after a review' "$tmp/prompt" || fail "fix prompt template"
[ -s zz/runs/20260101-120000-fix.md ] || fail "fix output named from the run id"

BUILD_CODEX_NETWORK=true run build --model model-a --effort low --plan "$plan" --subtask S1 >/dev/null
grep -q -- '--config sandbox_workspace_write.network_access=true' "$tmp/args" || fail "network opt-in"

# Rejections.
expect_fail() { if run "$@" >/dev/null 2>&1; then fail "accepted: $*"; fi; }
expect_fail build --model model-z --effort low --plan "$plan" --subtask S1   # not in catalog
expect_fail build --model model-a --effort ultra --plan "$plan" --subtask S1
expect_fail build --model model-a --effort low --plan "$plan" --subtask S9   # no such subtask
expect_fail build --model model-a --effort low --plan "$plan" --subtask x1
expect_fail build --model model-a --effort low --plan "$plan"                # no subtask
expect_fail build --model model-a --effort low --plan "$plan" --subtask S1 --review "$review"
expect_fail fix --model model-a --effort low --plan "$plan"                  # no review
expect_fail fix --model model-a --effort low --plan "$plan" --review "$plan" # review outside reviews/
touch "$tmp/outside.md"; expect_fail build --model model-a --effort low --plan "$tmp/outside.md" --subtask S1
cp "$plan" zz/plans/no-run-id.md; expect_fail build --model model-a --effort low --plan zz/plans/no-run-id.md --subtask S1
FAKE_NO_MESSAGE=1 expect_fail build --model model-a --effort low --plan "$plan" --subtask S1

# An empty setting keeps the default; overrides work from a subdirectory, relative or absolute.
BUILD_OUTPUT_DIR= run build --model model-a --effort low --plan "$plan" --subtask S1 >/dev/null
mkdir -p "$tmp/repo/src"; cd "$tmp/repo/src"
check_output_directory() {
  local setting="$1" expected="$2"
  mkdir -p "$expected/plans" "$expected/reviews"
  cp "$plan" "$expected/plans/20260202-090000-custom.md"
  cp "$review" "$expected/reviews/custom.md"
  BUILD_OUTPUT_DIR="$setting" run build --model model-a --effort low --plan "$expected/plans/20260202-090000-custom.md" --subtask S1 >/dev/null
  [ -s "$expected/runs/20260202-090000-S1-build.md" ] || fail "build output missing from $expected"
  BUILD_OUTPUT_DIR="$setting" run fix --model model-a --effort low --plan "$expected/plans/20260202-090000-custom.md" --review "$expected/reviews/custom.md" >/dev/null
  [ -s "$expected/runs/20260202-090000-fix.md" ] || fail "fix output missing from $expected"
  if BUILD_OUTPUT_DIR="$setting" run build --model model-a --effort low --plan "$plan" --subtask S1 >/dev/null 2>&1; then
    fail "accepted a plan outside $expected"
  fi
  if BUILD_OUTPUT_DIR="$setting" run fix --model model-a --effort low --plan "$expected/plans/20260202-090000-custom.md" --review "$review" >/dev/null 2>&1; then
    fail "accepted a review outside $expected"
  fi
}
check_output_directory 'local output/nested/' "$tmp/repo/local output/nested"
check_output_directory "$tmp/absolute output/" "$tmp/absolute output"

echo ok
