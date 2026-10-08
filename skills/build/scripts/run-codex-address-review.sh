#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: run-codex-address-review.sh <claude-review-path> <spec-path>...

Pass every spec of the build: one, or one per subtask.

The Codex model and effort are read from the review's Review-fix model and
Review-fix effort fields; the model must be in the Codex catalog (`codex debug models`).
USAGE
}

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

REVIEW_PATH="$1"
shift
if [[ ! -f "$REVIEW_PATH" ]]; then
  echo "Claude review file not found: $REVIEW_PATH" >&2
  exit 1
fi

REVIEW_DIR="$(cd "$(dirname "$REVIEW_PATH")" && pwd -P)"
REVIEW_PATH="$REVIEW_DIR/$(basename "$REVIEW_PATH")"

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Run this script from inside the target Git repository." >&2
  exit 1
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"

# zz/ is git-ignored through .git/info/exclude, so plans, specs, reviews and runs stay local
ARTIFACTS_ROOT="$REPO_ROOT/zz"
mkdir -p "$ARTIFACTS_ROOT/specs" "$ARTIFACTS_ROOT/reviews" "$ARTIFACTS_ROOT/runs"
ARTIFACTS_ROOT="$(cd "$ARTIFACTS_ROOT" && pwd -P)"

SPEC_PATHS=()
for spec in "$@"; do
  if [[ ! -f "$spec" ]]; then
    echo "Spec file not found: $spec" >&2
    exit 1
  fi
  spec="$(cd "$(dirname "$spec")" && pwd -P)/$(basename "$spec")"
  case "$spec" in
    "$ARTIFACTS_ROOT"/specs/*.md) SPEC_PATHS+=("$spec") ;;
    *)
      echo "Spec must be a Markdown file under $ARTIFACTS_ROOT/specs/" >&2
      exit 1
      ;;
  esac
done
case "$REVIEW_PATH" in
  "$ARTIFACTS_ROOT"/reviews/*.md) ;;
  *)
    echo "Review must be a Markdown file under $ARTIFACTS_ROOT/reviews/" >&2
    exit 1
    ;;
esac

MODEL="$(awk -F'`' 'index($0, "- Review-fix model: `") == 1 { print $2; exit }' "$REVIEW_PATH")"
EFFORT="$(awk -F'`' 'index($0, "- Review-fix effort: `") == 1 { print $2; exit }' "$REVIEW_PATH")"
if [[ -z "$MODEL" || "$MODEL" == *"<"* || -z "$EFFORT" || "$EFFORT" == *"<"* ]]; then
  echo "Review needs a filled-in Review-fix model and Review-fix effort: $REVIEW_PATH" >&2
  exit 1
fi

if grep -Fq '<Replace this line' "$REVIEW_PATH" || grep -Fq '<file/path or area>' "$REVIEW_PATH"; then
  echo "Review still contains template placeholders: $REVIEW_PATH" >&2
  exit 1
fi

REVIEW_DISPOSITION="$(awk '
  $0 == "## Review comments" { in_section = 1; next }
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

if ! codex debug models 2>/dev/null | grep -qF "\"slug\":\"$MODEL\""; then
  echo "Model $MODEL is not in the Codex catalog. Choose one from: codex debug models" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PROMPT_FILE="$SKILL_DIR/templates/address-review-prompt.md"

if [[ ! -s "$PROMPT_FILE" ]]; then
  echo "Codex address-review prompt template is missing: $PROMPT_FILE" >&2
  exit 1
fi

cd "$REPO_ROOT"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)-$$"
REVIEW_BASENAME="$(basename "$REVIEW_PATH" .md)"
OUTPUT_DIR="$ARTIFACTS_ROOT/runs"
OUTPUT_PATH="$OUTPUT_DIR/${TIMESTAMP}-${REVIEW_BASENAME}-address-review.md"
mkdir -p "$OUTPUT_DIR"

printf 'Running Codex model %s with %s reasoning effort.\n' "$MODEL" "$EFFORT"

{
  cat "$PROMPT_FILE"
  printf '\nReview disposition: %s\n\n' "$REVIEW_DISPOSITION"
  for spec in "${SPEC_PATHS[@]}"; do
    printf '%s\n' '--- ORIGINAL SPEC START ---'
    cat "$spec"
    printf '\n--- ORIGINAL SPEC END ---\n\n'
  done
  printf '%s\n' '--- CLAUDE REVIEW COMMENTS START ---'
  cat "$REVIEW_PATH"
  printf '\n--- CLAUDE REVIEW COMMENTS END ---\n'
} | codex exec --model "$MODEL" --config "model_reasoning_effort=\"$EFFORT\"" --sandbox workspace-write --output-last-message "$OUTPUT_PATH" -

if [[ ! -s "$OUTPUT_PATH" ]]; then
  echo "Codex completed without writing a final message: $OUTPUT_PATH" >&2
  exit 1
fi

printf 'Codex review-fix final message saved to %s\n' "$OUTPUT_PATH"
