#!/usr/bin/env bash
# Self-check for the run-codex scripts with a fake codex on PATH: bash scripts/run-codex.test.sh
set -euo pipefail
scripts="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
export HOME="$tmp/home"
mkdir -p "$HOME/.claude/build/specs" "$HOME/.claude/build/reviews" "$tmp/bin" "$tmp/repo"
git -C "$tmp/repo" init -q
fail() { echo "FAIL: $1"; exit 1; }

# Fake codex: a one-model catalog, and exec records its args and prompt.
cat > "$tmp/bin/codex" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == debug ]]; then echo '{"models":[{"slug":"model-a","visibility":"list"}]}'; exit; fi
echo "\$@" > "$tmp/args"; cat > "$tmp/prompt"
while [[ \$# -gt 0 ]]; do [[ "\$1" == --output-last-message ]] && echo done > "\$2"; shift; done
EOF
chmod +x "$tmp/bin/codex"
export PATH="$tmp/bin:$PATH"
cd "$tmp/repo"

spec="$HOME/.claude/build/specs/repo-1-x.md"
cat > "$spec" <<'EOF'
## Implementation subtasks
### S1: first
- Model: `model-a`
- Effort: `low`
### S10: tenth
- Model: `model-a`
- Effort: `high`
### S2: unfilled
- Model: `<latest-version model for the current mode>`
- Effort: `<effort the model supports>`
### S3: unknown model
- Model: `model-z`
- Effort: `low`
## Build instructions
EOF

bash "$scripts/run-codex-build.sh" "$spec" S10 >/dev/null
grep -q -- '--model model-a --config model_reasoning_effort="high"' "$tmp/args" || fail "S10 model/effort"
grep -qx 'Your subtask: S10' "$tmp/prompt" || fail "subtask line in prompt"
bash "$scripts/run-codex-build.sh" "$spec" S1 >/dev/null
grep -q 'model_reasoning_effort="low"' "$tmp/args" || fail "S1 picked up S10's fields"
ls "$HOME/.claude/build/runs/"*-S1-build.md >/dev/null || fail "S1 output saved"
! bash "$scripts/run-codex-build.sh" "$spec" S2 2>/dev/null || fail "accepted placeholder model"
! bash "$scripts/run-codex-build.sh" "$spec" S3 2>/dev/null || fail "accepted model not in catalog"
! bash "$scripts/run-codex-build.sh" "$spec" S9 2>/dev/null || fail "accepted missing subtask"

review="$HOME/.claude/build/reviews/repo-1-x.md"
write_review() {
  printf -- '- Review-fix model: `model-a`\n- Review-fix effort: `%s`\n\n## Review comments\n%s\n\n## Validation notes\n' "$1" "$2" > "$review"
}
write_review medium '- a.ts: bug — fix it'
bash "$scripts/run-codex-address-review.sh" "$spec" "$review" >/dev/null
grep -q 'model_reasoning_effort="medium"' "$tmp/args" || fail "review-fix effort"
grep -qx 'Review disposition: actionable' "$tmp/prompt" || fail "actionable disposition"
write_review medium 'No actionable review comments.'
! bash "$scripts/run-codex-address-review.sh" "$spec" "$review" 2>/dev/null || fail "clean review allowed above low effort"
write_review low 'No actionable review comments.'
bash "$scripts/run-codex-address-review.sh" "$spec" "$review" >/dev/null
grep -qx 'Review disposition: no-actionable' "$tmp/prompt" || fail "no-actionable disposition"

echo ok
