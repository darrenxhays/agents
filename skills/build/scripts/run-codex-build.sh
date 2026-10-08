#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: run-codex-build.sh <spec-path> <subtask-id>

Builds one subtask (for example S1) of the spec with Codex. The subtask's Model and
Effort are read from its section in the spec; the model must be in the Codex catalog
(`codex debug models`). Run several at once for subtasks in the same wave.
USAGE
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

SPEC_PATH="$1"
SUBTASK="$2"
if [[ ! -f "$SPEC_PATH" ]]; then
  echo "Spec file not found: $SPEC_PATH" >&2
  exit 1
fi
if [[ ! "$SUBTASK" =~ ^S[0-9]+$ ]]; then
  echo "Subtask id must look like S1, S2, ...: $SUBTASK" >&2
  usage
  exit 2
fi

SPEC_DIR="$(cd "$(dirname "$SPEC_PATH")" && pwd -P)"
SPEC_PATH="$SPEC_DIR/$(basename "$SPEC_PATH")"

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Run this script from inside the target Git repository." >&2
  exit 1
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"

# zz/ is git-ignored through .git/info/exclude, so plans, specs, reviews and runs stay local
ARTIFACTS_ROOT="$REPO_ROOT/zz"
mkdir -p "$ARTIFACTS_ROOT/specs" "$ARTIFACTS_ROOT/reviews" "$ARTIFACTS_ROOT/runs"
ARTIFACTS_ROOT="$(cd "$ARTIFACTS_ROOT" && pwd -P)"

case "$SPEC_PATH" in
  "$ARTIFACTS_ROOT"/specs/*.md) ;;
  *)
    echo "Spec must be a Markdown file under $ARTIFACTS_ROOT/specs/" >&2
    exit 1
    ;;
esac

# Reads "- <field>: `value`" from the subtask's "### <id>: ..." section.
subtask_field() {
  awk -F'`' -v heading="### $SUBTASK:" -v prefix="- $1: \`" '
    index($0, heading) == 1 { in_section = 1; next }
    in_section && /^##/ { exit }
    in_section && index($0, prefix) == 1 { print $2; exit }
  ' "$SPEC_PATH"
}

if ! grep -q "^### $SUBTASK:" "$SPEC_PATH"; then
  echo "Spec has no subtask section '### $SUBTASK:': $SPEC_PATH" >&2
  exit 1
fi
MODEL="$(subtask_field Model)"
EFFORT="$(subtask_field Effort)"
if [[ -z "$MODEL" || "$MODEL" == *"<"* || -z "$EFFORT" || "$EFFORT" == *"<"* ]]; then
  echo "Subtask $SUBTASK needs a filled-in Model and Effort in the spec: $SPEC_PATH" >&2
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
PROMPT_FILE="$SKILL_DIR/templates/build-prompt.md"
if [[ ! -s "$PROMPT_FILE" ]]; then
  echo "Codex build prompt template is missing: $PROMPT_FILE" >&2
  exit 1
fi

cd "$REPO_ROOT"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)-$$"
SPEC_BASENAME="$(basename "$SPEC_PATH" .md)"
OUTPUT_PATH="$ARTIFACTS_ROOT/runs/${TIMESTAMP}-${SPEC_BASENAME}-${SUBTASK}-build.md"

printf 'Running %s with Codex model %s at %s reasoning effort.\n' "$SUBTASK" "$MODEL" "$EFFORT"

{
  cat "$PROMPT_FILE"
  cat "$SPEC_PATH"
  printf '\n--- SPEC END ---\n\nYour subtask: %s\n' "$SUBTASK"
} | codex exec --model "$MODEL" --config "model_reasoning_effort=\"$EFFORT\"" --sandbox workspace-write --output-last-message "$OUTPUT_PATH" -

if [[ ! -s "$OUTPUT_PATH" ]]; then
  echo "Codex completed without writing a final message: $OUTPUT_PATH" >&2
  exit 1
fi

printf 'Codex %s final message saved to %s\n' "$SUBTASK" "$OUTPUT_PATH"
