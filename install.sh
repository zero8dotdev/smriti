#!/bin/bash
# install.sh - Install Smriti, the unified memory layer for AI agents
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zero8dotdev/smriti/main/install.sh | bash
#
# Environment variables:
#   SMRITI_DIR       - Install directory (default: ~/.smriti)
#   SMRITI_BIN_DIR   - Binary directory (default: ~/.local/bin)
#   SMRITI_NO_HOOK   - Set to 1 to skip Claude Code hook setup

set -euo pipefail

# --- CI mode (used by GitHub Actions install-test.yml) -----------------------
# Pass --ci to run non-interactively with a temp HOME directory.
CI_MODE=0
for arg in "$@"; do
  [ "$arg" = "--ci" ] && CI_MODE=1
done

if [ "$CI_MODE" = "1" ]; then
  export HOME="$(mktemp -d /tmp/smriti-ci-XXXXX)"
  export SMRITI_NO_HOOK=1
  echo "CI mode: using temp HOME $HOME"
fi

# --- Configuration -----------------------------------------------------------

SMRITI_DIR="${SMRITI_DIR:-$HOME/.smriti}"
SMRITI_BIN_DIR="${SMRITI_BIN_DIR:-$HOME/.local/bin}"
REPO="https://github.com/zero8dotdev/smriti.git"

# --- Helpers ------------------------------------------------------------------

info()  { printf "\033[1;34m==>\033[0m \033[1m%s\033[0m\n" "$*"; }
ok()    { printf "\033[1;32m==>\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33mwarning:\033[0m %s\n" "$*"; }
err()   { printf "\033[1;31merror:\033[0m %s\n" "$*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# --- Preflight checks --------------------------------------------------------

info "Installing Smriti..."

# Check for git
if ! command_exists git; then
  err "git is required. Install it first: https://git-scm.com"
fi

# Check for jq (needed by the hook script)
if ! command_exists jq; then
  warn "jq is not installed. The Claude Code auto-save hook requires it."
  warn "Install it: brew install jq (macOS) or apt install jq (Linux)"
fi

# Check for Bun
if ! command_exists bun; then
  info "Bun not found. Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if ! command_exists bun; then
    err "Failed to install Bun. Install it manually: https://bun.sh"
  fi
  ok "Bun installed: $(bun --version)"
fi

# --- Clone / Update -----------------------------------------------------------

if [ -d "$SMRITI_DIR" ]; then
  info "Updating existing installation at $SMRITI_DIR..."
  cd "$SMRITI_DIR"
  git pull --ff-only origin main 2>/dev/null || {
    warn "Could not fast-forward. Reinstalling fresh..."
    cd /
    rm -rf "$SMRITI_DIR"
    git clone --depth 1 "$REPO" "$SMRITI_DIR"
    cd "$SMRITI_DIR"
  }
else
  info "Cloning Smriti to $SMRITI_DIR..."
  git clone --depth 1 "$REPO" "$SMRITI_DIR"
  cd "$SMRITI_DIR"
fi

# --- Install dependencies ----------------------------------------------------

info "Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install

# --- Create binary wrapper ----------------------------------------------------

info "Creating smriti binary..."
mkdir -p "$SMRITI_BIN_DIR"

cat > "$SMRITI_BIN_DIR/smriti" <<WRAPPER
#!/bin/bash
exec bun "$SMRITI_DIR/src/index.ts" "\$@"
WRAPPER
chmod +x "$SMRITI_BIN_DIR/smriti"

# Check if bin dir is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -q "^${SMRITI_BIN_DIR}$"; then
  warn "$SMRITI_BIN_DIR is not in your PATH."
  echo ""
  echo "  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo ""
  echo "    export PATH=\"$SMRITI_BIN_DIR:\$PATH\""
  echo ""
fi

# --- Claude Code hook setup --------------------------------------------------

if [ "${SMRITI_NO_HOOK:-0}" = "1" ]; then
  info "Skipping Claude Code hook setup (SMRITI_NO_HOOK=1)"
else
  CLAUDE_DIR="$HOME/.claude"
  HOOKS_DIR="$CLAUDE_DIR/hooks"
  HOOK_SCRIPT="$HOOKS_DIR/save-memory.sh"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"

  if [ -d "$CLAUDE_DIR" ]; then
    info "Setting up Claude Code auto-save hook..."

    mkdir -p "$HOOKS_DIR"

    # Install the hook script
    cat > "$HOOK_SCRIPT" <<'HOOKEOF'
#!/bin/bash
# save-memory.sh - Claude Code hook to save conversations to Smriti/QMD memory
#
# Fires on Stop event (after each Claude response).
# Reads new lines from the transcript JSONL and saves them.

set -euo pipefail

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$SESSION_ID" ] || [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

MEM_SESSION="${SESSION_ID:0:8}"

# Find smriti or fall back to QMD
if command -v smriti >/dev/null 2>&1; then
  SMRITI_BIN="smriti"
elif [ -f "$HOME/.smriti/src/index.ts" ]; then
  SMRITI_BIN="bun $HOME/.smriti/src/index.ts"
else
  exit 0
fi

STATE_DIR="$HOME/.cache/qmd/memory-hooks"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/${MEM_SESSION}.lines"

SAVED_LINES=0
if [ -f "$STATE_FILE" ]; then
  SAVED_LINES=$(cat "$STATE_FILE")
fi

TOTAL_LINES=$(wc -l < "$TRANSCRIPT_PATH")

if [ "$TOTAL_LINES" -le "$SAVED_LINES" ]; then
  exit 0
fi

tail -n +"$((SAVED_LINES + 1))" "$TRANSCRIPT_PATH" | while IFS= read -r line; do
  TYPE=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)

  if [ "$TYPE" = "user" ] || [ "$TYPE" = "assistant" ]; then
    MSG=$(echo "$line" | jq -r '
      .message.content
      | if type == "array" then
          [.[] | select(type == "object" and .type == "text") | .text] | join("\n")
        elif type == "string" then .
        else empty
        end
    ' 2>/dev/null)

    if [ -n "$MSG" ] && [ "$MSG" != "null" ] && [ ${#MSG} -gt 5 ]; then
      # Use smriti ingest or fall back to direct save
      # For now, use QMD's memory save through the smriti path
      QMD_BIN="$HOME/.bun/install/global/node_modules/qmd/src/qmd.ts"
      if [ -f "$QMD_BIN" ]; then
        bun "$QMD_BIN" memory save "$MEM_SESSION" "$TYPE" "$MSG" --title "claude-code" >/dev/null 2>&1 || true
      fi
    fi
  fi
done

echo "$TOTAL_LINES" > "$STATE_FILE"
exit 0
HOOKEOF
    chmod +x "$HOOK_SCRIPT"

    # Set up Claude settings if not already configured
    if [ ! -f "$SETTINGS_FILE" ]; then
      cat > "$SETTINGS_FILE" <<SETTINGSEOF
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_SCRIPT",
            "timeout": 30,
            "async": true
          }
        ]
      }
    ]
  }
}
SETTINGSEOF
      ok "Created Claude Code settings with auto-save hook"
    elif ! grep -q "save-memory.sh" "$SETTINGS_FILE" 2>/dev/null; then
      warn "Claude settings exist but don't include the save-memory hook."
      echo "  Add this hook manually to $SETTINGS_FILE:"
      echo ""
      echo "    {\"type\": \"command\", \"command\": \"$HOOK_SCRIPT\", \"timeout\": 30, \"async\": true}"
      echo ""
    else
      ok "Claude Code hook already configured"
    fi
  else
    info "Claude Code not detected (~/.claude not found). Skipping hook setup."
    echo "  Run the installer again after installing Claude Code to set up the hook."
  fi
fi

# --- Done ---------------------------------------------------------------------

echo ""
ok "Smriti installed successfully!"
echo ""
echo "  Install dir:  $SMRITI_DIR"
echo "  Binary:       $SMRITI_BIN_DIR/smriti"
echo ""
echo "  Get started:"
echo "    smriti help              Show all commands"
echo "    smriti ingest claude     Import Claude Code conversations"
echo "    smriti ingest copilot    Import GitHub Copilot (VS Code) conversations"
echo "    smriti status            Show memory statistics"
echo "    smriti search \"query\"    Search across all memory"
echo ""
echo "  To uninstall:"
echo "    curl -fsSL https://raw.githubusercontent.com/zero8dotdev/smriti/main/uninstall.sh | bash"
echo ""
