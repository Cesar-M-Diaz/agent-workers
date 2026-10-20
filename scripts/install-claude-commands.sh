#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEST="${CLAUDE_COMMANDS_DIR:-$HOME/.claude/commands}"

mkdir -p "$DEST"
cp "$ROOT"/claude/commands/*.md "$DEST"/

printf 'Installed DSH slash commands in %s\n' "$DEST"
printf '%s\n' 'Restart Claude Code or start a new session to pick them up.'
