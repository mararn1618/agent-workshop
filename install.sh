#!/usr/bin/env bash
set -euo pipefail

# Agentic Workshop installer
# Downloads and installs skill files for your agent harness.
# Usage: curl -fsSL https://raw.githubusercontent.com/mararn1618/agent-workshop/main/install.sh | bash -s -- <target>
# Targets: copilot, cursor, windsurf, codex

REPO="https://raw.githubusercontent.com/mararn1618/agent-workshop/main/agentic-workshop"
TARGET="${1:-}"

FILES=(
  "server.ts"
  "types.ts"
  "skills/workshop-prepare/SKILL.md"
  "skills/workshop-start/SKILL.md"
)

download() {
  local dest="$1"
  local file="$2"
  mkdir -p "$(dirname "$dest/$file")"
  curl -fsSL "$REPO/$file" -o "$dest/$file"
  echo "  $dest/$file"
}

download_all() {
  local dest="$1"
  echo "Downloading to $dest/ ..."
  for f in "${FILES[@]}"; do
    download "$dest" "$f"
  done
}

case "$TARGET" in
  copilot)
    DEST=".github/agentic-workshop"
    download_all "$DEST"
    echo ""
    echo "Add to .github/copilot-instructions.md:"
    echo "  @.github/agentic-workshop/skills/workshop-prepare/SKILL.md"
    echo "  @.github/agentic-workshop/skills/workshop-start/SKILL.md"
    ;;
  cursor)
    DEST=".cursor/agentic-workshop"
    download_all "$DEST"
    echo ""
    echo "Add to .cursor/rules/ or reference in your Cursor settings."
    ;;
  windsurf)
    DEST=".windsurf/agentic-workshop"
    download_all "$DEST"
    echo ""
    echo "Skills installed to $DEST/"
    ;;
  codex|opencode|gemini)
    DEST="agentic-workshop"
    download_all "$DEST"
    echo ""
    echo "Add to AGENTS.md:"
    echo "  @agentic-workshop/skills/workshop-prepare/SKILL.md"
    echo "  @agentic-workshop/skills/workshop-start/SKILL.md"
    ;;
  "")
    echo "Agentic Workshop installer"
    echo ""
    echo "Usage:"
    echo "  curl -fsSL $REPO/install.sh | bash -s -- <target>"
    echo ""
    echo "Targets:"
    echo "  copilot   - GitHub Copilot (.github/agentic-workshop/)"
    echo "  cursor    - Cursor (.cursor/agentic-workshop/)"
    echo "  windsurf  - Windsurf (.windsurf/agentic-workshop/)"
    echo "  codex     - Codex/OpenCode/Gemini (agentic-workshop/)"
    echo ""
    echo "For Claude Code:"
    echo "  /plugin marketplace add mararn1618/agent-workshop"
    echo "  /plugin install agentic-workshop@agent-workshop"
    exit 1
    ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Valid targets: copilot, cursor, windsurf, codex"
    exit 1
    ;;
esac

echo ""
echo "Done. Make sure Bun is installed: curl -fsSL https://bun.sh/install | bash"
