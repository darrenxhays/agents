#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  run-codex.sh build --model M --effort E --plan PATH --subtask S1
  run-codex.sh fix   --model M --effort E --plan PATH --review PATH

build implements one subtask of the approved plan; fix addresses a review.
The model must be in the Codex catalog (`codex debug models`). The plan must be
<output-dir>/plans/<run-id>-<slug>.md and the review a Markdown file under
<output-dir>/reviews/; Codex's final message is saved to
<output-dir>/runs/<run-id>-<subtask>-build.md or <run-id>-fix.md.

BUILD_OUTPUT_DIR sets the output directory (default: zz). Relative paths are
resolved from the repository root; absolute paths are used as given.
BUILD_CODEX_NETWORK=true lets Codex's sandbox reach the network, including
local services such as a database or container runtime (off by default).
USAGE
}

[[ $# -ge 1 ]] || { usage; exit 2; }
ACTION="$1"
shift
case "$ACTION" in
  build|fix) ;;
  *) usage; exit 2 ;;
esac
MODEL="" EFFORT="" PLAN_PATH="" SUBTASK="" REVIEW_PATH=""
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || { usage; exit 2; }
  case "$1" in
    --model) MODEL="$2" ;;
    --effort) EFFORT="$2" ;;
    --plan) PLAN_PATH="$2" ;;
    --subtask) SUBTASK="$2" ;;
    --review) REVIEW_PATH="$2" ;;
    *) usage; exit 2 ;;
  esac
  shift 2
done
if [[ -z "$MODEL" || -z "$EFFORT" || -z "$PLAN_PATH" ]] \
  || [[ "$ACTION" == build && ( -z "$SUBTASK" || -n "$REVIEW_PATH" ) ]] \
  || [[ "$ACTION" == fix && ( -z "$REVIEW_PATH" || -n "$SUBTASK" ) ]]; then
  usage
  exit 2
fi
if [[ "$EFFORT" == ultra ]]; then
  echo "Don't use ultra effort: it has Codex split the work itself." >&2
  exit 2
fi
if [[ "$ACTION" == build && ! "$SUBTASK" =~ ^S[0-9]+$ ]]; then
  echo "Subtask id must look like S1, S2, ...: $SUBTASK" >&2
  exit 2
fi

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Run this script from inside the target Git repository." >&2
  exit 1
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"

# prepare.sh created this directory and excluded it from Git when inside the repo.
ARTIFACTS_ROOT="${BUILD_OUTPUT_DIR:-zz}"
case "$ARTIFACTS_ROOT" in
  /*) ;;
  *) ARTIFACTS_ROOT="$REPO_ROOT/$ARTIFACTS_ROOT" ;;
esac
if [[ ! -d "$ARTIFACTS_ROOT" ]]; then
  echo "Output directory not found (run prepare.sh first): $ARTIFACTS_ROOT" >&2
  exit 1
fi
ARTIFACTS_ROOT="$(cd "$ARTIFACTS_ROOT" && pwd -P)"
mkdir -p "$ARTIFACTS_ROOT/runs"

# Prints the absolute path of a file that must be a Markdown file in $2.
resolve_in() {
  local path="$1" dir="$2" what="$3"
  if [[ ! -f "$path" ]]; then
    echo "$what file not found: $path" >&2
    return 1
  fi
  path="$(cd "$(dirname "$path")" && pwd -P)/$(basename "$path")"
  case "$path" in
    "$ARTIFACTS_ROOT/$dir"/*.md) printf '%s\n' "$path" ;;
    *)
      echo "$what must be a Markdown file under $ARTIFACTS_ROOT/$dir/" >&2
      return 1
      ;;
  esac
}
PLAN_PATH="$(resolve_in "$PLAN_PATH" plans Plan)"
RUN_ID="$(basename "$PLAN_PATH" | grep -oE '^[0-9]{8}-[0-9]{6}' || true)"
if [[ -z "$RUN_ID" ]]; then
  echo "Plan file name must start with the run id (YYYYMMDD-HHMMSS-): $PLAN_PATH" >&2
  exit 1
fi
if [[ "$ACTION" == build ]] && ! grep -q "^### $SUBTASK:" "$PLAN_PATH"; then
  echo "Plan has no subtask section '### $SUBTASK:': $PLAN_PATH" >&2
  exit 1
fi
if [[ "$ACTION" == fix ]]; then
  REVIEW_PATH="$(resolve_in "$REVIEW_PATH" reviews Review)"
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

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "$ACTION" == build ]]; then
  PROMPT_FILE="$SKILL_DIR/templates/implement-prompt.md"
  OUTPUT_PATH="$ARTIFACTS_ROOT/runs/$RUN_ID-$SUBTASK-build.md"
else
  PROMPT_FILE="$SKILL_DIR/templates/fix-prompt.md"
  OUTPUT_PATH="$ARTIFACTS_ROOT/runs/$RUN_ID-fix.md"
fi
if [[ ! -s "$PROMPT_FILE" ]]; then
  echo "Codex prompt template is missing: $PROMPT_FILE" >&2
  exit 1
fi

SANDBOX=(--sandbox workspace-write)
if [[ "${BUILD_CODEX_NETWORK:-}" == true ]]; then
  SANDBOX+=(--config sandbox_workspace_write.network_access=true)
fi

cd "$REPO_ROOT"
rm -f "$OUTPUT_PATH"
printf 'Running Codex %s with model %s at %s reasoning effort.\n' "${SUBTASK:-fix}" "$MODEL" "$EFFORT"

{
  cat "$PROMPT_FILE"
  printf '\n--- PLAN START ---\n'
  cat "$PLAN_PATH"
  printf '\n--- PLAN END ---\n'
  if [[ "$ACTION" == build ]]; then
    printf '\nYour subtask: %s\n' "$SUBTASK"
  else
    printf '\n--- REVIEW START ---\n'
    cat "$REVIEW_PATH"
    printf '\n--- REVIEW END ---\n'
  fi
} | codex exec --model "$MODEL" --config "model_reasoning_effort=\"$EFFORT\"" "${SANDBOX[@]}" --output-last-message "$OUTPUT_PATH" -

if [[ ! -s "$OUTPUT_PATH" ]]; then
  echo "Codex completed without writing a final message: $OUTPUT_PATH" >&2
  exit 1
fi

printf 'Codex final message saved to %s\n' "$OUTPUT_PATH"
