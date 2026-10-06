#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: run-codex-build.sh <spec-path> <reasoning-effort>

The Codex model is read from:
  <skill-dir>/config/codex-model.txt

Supported reasoning efforts: low, medium, high, xhigh, max

This script intentionally accepts no runtime model override flags or environment-variable overrides. Edit the skill file above to change the Codex model.
USAGE
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

SPEC_PATH="$1"
EFFORT="$2"
if [[ ! -f "$SPEC_PATH" ]]; then
  echo "Spec file not found: $SPEC_PATH" >&2
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

SPEC_EFFORT="$(awk -F'`' '/^Reasoning effort: `(low|medium|high|xhigh|max)`$/ { print $2; exit }' "$SPEC_PATH")"
if [[ -z "$SPEC_EFFORT" ]]; then
  echo "Spec is missing a valid Reasoning effort field: $SPEC_PATH" >&2
  exit 1
fi
if [[ "$SPEC_EFFORT" != "$EFFORT" ]]; then
  echo "Reasoning effort mismatch: spec says $SPEC_EFFORT but argument says $EFFORT" >&2
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
PROMPT_FILE="$SKILL_DIR/templates/codex-build-prompt.md"

if [[ ! -s "$MODEL_FILE" ]]; then
  echo "Codex model file is missing or empty: $MODEL_FILE" >&2
  exit 1
fi
if [[ ! -s "$PROMPT_FILE" ]]; then
  echo "Codex build prompt template is missing: $PROMPT_FILE" >&2
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
OUTPUT_PATH="$OUTPUT_DIR/${TIMESTAMP}-${SPEC_BASENAME}-build.md"
mkdir -p "$OUTPUT_DIR"

printf 'Running Codex model %s with %s reasoning effort.\n' "$MODEL" "$EFFORT"

{
  cat "$PROMPT_FILE"
  cat "$SPEC_PATH"
  printf '\n--- SPEC END ---\n'
} | codex exec --model "$MODEL" --config "model_reasoning_effort=\"$EFFORT\"" --sandbox workspace-write --output-last-message "$OUTPUT_PATH" -

if [[ ! -s "$OUTPUT_PATH" ]]; then
  echo "Codex completed without writing a final message: $OUTPUT_PATH" >&2
  exit 1
fi

printf 'Codex build final message saved to %s\n' "$OUTPUT_PATH"
