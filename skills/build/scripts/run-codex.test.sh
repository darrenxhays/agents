#!/usr/bin/env bash
# Self-check for the run-codex scripts with a fake codex on PATH: bash scripts/run-codex.test.sh
set -euo pipefail
scripts="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
mkdir -p "$tmp/bin" "$tmp/repo/zz/specs" "$tmp/repo/zz/reviews"
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

spec="$tmp/repo/zz/specs/1-x.md"
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
ls "$tmp/repo/zz/runs/"*-S1-build.md >/dev/null || fail "S1 output saved"
! bash "$scripts/run-codex-build.sh" "$spec" S2 2>/dev/null || fail "accepted placeholder model"
! bash "$scripts/run-codex-build.sh" "$spec" S3 2>/dev/null || fail "accepted model not in catalog"
! bash "$scripts/run-codex-build.sh" "$spec" S9 2>/dev/null || fail "accepted missing subtask"

review="$tmp/repo/zz/reviews/1-x.md"
write_review() {
  printf -- '- Review-fix model: `model-a`\n- Review-fix effort: `%s`\n\n## Review comments\n%s\n\n## Validation notes\n' "$1" "$2" > "$review"
}
write_review medium '- a.ts: bug — fix it'
spec2="$tmp/repo/zz/specs/1-x-S2.md"; echo '### S2: second' > "$spec2"
bash "$scripts/run-codex-address-review.sh" "$review" "$spec" "$spec2" >/dev/null
[ "$(grep -cx -- '--- ORIGINAL SPEC START ---' "$tmp/prompt")" = 2 ] && grep -qx '### S2: second' "$tmp/prompt" || fail "every spec in fix prompt"
touch "$tmp/outside.md"; ! bash "$scripts/run-codex-address-review.sh" "$review" "$tmp/outside.md" 2>/dev/null || fail "accepted spec outside zz/specs"
grep -q 'model_reasoning_effort="medium"' "$tmp/args" || fail "review-fix effort"
grep -qx 'Review disposition: actionable' "$tmp/prompt" || fail "actionable disposition"
write_review medium 'No actionable review comments.'
! bash "$scripts/run-codex-address-review.sh" "$review" "$spec" 2>/dev/null || fail "clean review allowed above low effort"
write_review low 'No actionable review comments.'
bash "$scripts/run-codex-address-review.sh" "$review" "$spec" >/dev/null
grep -qx 'Review disposition: no-actionable' "$tmp/prompt" || fail "no-actionable disposition"

echo ok
