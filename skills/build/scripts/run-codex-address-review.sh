#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: run-codex-address-review.sh <spec-path> <claude-review-path> <reasoning-effort>

The Codex model is read from:
  <skill-dir>/config/codex-model.txt

Supported reasoning efforts: low, medium, high, xhigh, max

This script intentionally accepts no runtime model override flags or environment-variable overrides. Edit the skill file above to change the Codex model.
USAGE
}

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

SPEC_PATH="$1"
REVIEW_PATH="$2"
EFFORT="$3"
if [[ ! -f "$SPEC_PATH" ]]; then
  echo "Spec file not found: $SPEC_PATH" >&2
  exit 1
fi
if [[ ! -f "$REVIEW_PATH" ]]; then
  echo "Claude review file not found: $REVIEW_PATH" >&2
  exit 1
fi

case "$EFFORT" in
  low|medium|high|xhigh|max) ;;
  *)
    echo "Unsupported reasoning effort: $EFFORT" >&2
    usage
    exit 2
    ;;
esac

SPEC_DIR="$(cd "$(dirname "$SPEC_PATH")" && pwd -P)"
SPEC_PATH="$SPEC_DIR/$(basename "$SPEC_PATH")"
REVIEW_DIR="$(cd "$(dirname "$REVIEW_PATH")" && pwd -P)"
REVIEW_PATH="$REVIEW_DIR/$(basename "$REVIEW_PATH")"

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Run this script from inside the target Git repository." >&2
  exit 1
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"

# shared across every repo and session so specs and reviews never land in a repo
ARTIFACTS_ROOT="$HOME/.claude/build"
mkdir -p "$ARTIFACTS_ROOT/specs" "$ARTIFACTS_ROOT/reviews" "$ARTIFACTS_ROOT/codex-runs"
ARTIFACTS_ROOT="$(cd "$ARTIFACTS_ROOT" && pwd -P)"

case "$SPEC_PATH" in
  "$ARTIFACTS_ROOT"/specs/*.md) ;;
  *)
    echo "Spec must be a Markdown file under $ARTIFACTS_ROOT/specs/" >&2
    exit 1
    ;;
esac
case "$REVIEW_PATH" in
  "$ARTIFACTS_ROOT"/reviews/*.md) ;;
  *)
    echo "Review must be a Markdown file under $ARTIFACTS_ROOT/reviews/" >&2
    exit 1
    ;;
esac

REVIEW_EFFORT="$(awk -F'`' '/^- Review-fix effort: `(low|medium|high|xhigh|max)`$/ { print $2; exit }' "$REVIEW_PATH")"
if [[ -z "$REVIEW_EFFORT" ]]; then
  echo "Review is missing a valid Review-fix effort field: $REVIEW_PATH" >&2
  exit 1
fi
if [[ "$REVIEW_EFFORT" != "$EFFORT" ]]; then
  echo "Reasoning effort mismatch: review says $REVIEW_EFFORT but argument says $EFFORT" >&2
  exit 1
fi

if grep -Fq '<Replace this line' "$REVIEW_PATH" || grep -Fq '<file/path or area>' "$REVIEW_PATH"; then
  echo "Review still contains template placeholders: $REVIEW_PATH" >&2
  exit 1
fi

REVIEW_DISPOSITION="$(awk '
  $0 == "## Review comments for Codex" { in_section = 1; next }
  in_section && /^## / { in_section = 0 }
  in_section && $0 == "No actionable review comments." { sentinel++ }
  in_section && /^### / { headings++ }
  in_section && /^- / { actions++ }
  END {
    if (sentinel == 1 && actions == 0 && headings == 0) print "no-actionable"
    else if (sentinel == 0 && actions > 0) print "actionable"
    else print "invalid"
  }
' "$REVIEW_PATH")"
if [[ "$REVIEW_DISPOSITION" == "invalid" ]]; then
  echo "Review comments must contain either one or more actionable bullets or only the exact no-actionable sentinel." >&2
  exit 1
fi
if [[ "$REVIEW_DISPOSITION" == "no-actionable" && "$EFFORT" != "low" ]]; then
  echo "A review with no actionable comments must use low reasoning effort." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  cat >&2 <<'ERR'
Codex CLI was not found on PATH.
Install and authenticate Codex first, then rerun this skill:
  npm install -g @openai/codex   # or: brew install codex
  codex login
ERR
  exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
MODEL_FILE="$SKILL_DIR/config/codex-model.txt"
PROMPT_FILE="$SKILL_DIR/templates/codex-address-review-prompt.md"

if [[ ! -s "$MODEL_FILE" ]]; then
  echo "Codex model file is missing or empty: $MODEL_FILE" >&2
  exit 1
fi
if [[ ! -s "$PROMPT_FILE" ]]; then
  echo "Codex address-review prompt template is missing: $PROMPT_FILE" >&2
  exit 1
fi

MODEL="$(awk '/^[[:space:]]*(#|$)/ { next } { gsub(/[[:space:]]/, "", $0); print; exit }' "$MODEL_FILE")"
if [[ -z "$MODEL" ]]; then
  echo "No Codex model configured in $MODEL_FILE" >&2
  exit 1
fi

cd "$REPO_ROOT"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)-$$"
SPEC_BASENAME="$(basename "$SPEC_PATH" .md)"
OUTPUT_DIR="$ARTIFACTS_ROOT/codex-runs"
OUTPUT_PATH="$OUTPUT_DIR/${TIMESTAMP}-${SPEC_BASENAME}-address-review.md"
mkdir -p "$OUTPUT_DIR"

printf 'Running Codex model %s with %s reasoning effort.\n' "$MODEL" "$EFFORT"

{
  cat "$PROMPT_FILE"
  printf '\nReview disposition: %s\n\n' "$REVIEW_DISPOSITION"
  printf '%s\n' '--- ORIGINAL SPEC START ---'
  cat "$SPEC_PATH"
  printf '\n--- ORIGINAL SPEC END ---\n\n'
  printf '%s\n' '--- CLAUDE REVIEW COMMENTS START ---'
  cat "$REVIEW_PATH"
  printf '\n--- CLAUDE REVIEW COMMENTS END ---\n'
} | codex exec --model "$MODEL" --config "model_reasoning_effort=\"$EFFORT\"" --sandbox workspace-write --output-last-message "$OUTPUT_PATH" -

if [[ ! -s "$OUTPUT_PATH" ]]; then
  echo "Codex completed without writing a final message: $OUTPUT_PATH" >&2
  exit 1
fi

printf 'Codex review-fix final message saved to %s\n' "$OUTPUT_PATH"
