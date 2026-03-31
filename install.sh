#!/bin/bash
set -euo pipefail

# iago — AI-powered PR review daemon installer

REPO="alepalma91/iago"
IAGO_BIN="${IAGO_BIN:-$HOME/bin}"
IAGO_HOME="${IAGO_HOME:-$HOME/.local/share/iago}"

echo "Installing iago..."
echo ""

# ── Check prerequisites ───────────────────────────────────────

# Check for Homebrew (needed for dependencies)
HAS_BREW=false
if command -v brew >/dev/null 2>&1; then
  HAS_BREW=true
fi

# gh CLI — required
if ! command -v gh >/dev/null 2>&1; then
  if $HAS_BREW; then
    echo "Installing gh (GitHub CLI)..."
    brew install gh
  else
    echo "Error: gh (GitHub CLI) is required but not installed."
    echo "Install it: brew install gh"
    exit 1
  fi
fi

# Check gh auth
if ! gh auth status >/dev/null 2>&1; then
  echo ""
  echo "GitHub CLI is not authenticated. Running gh auth login..."
  gh auth login
fi

# claude CLI — required
if ! command -v claude >/dev/null 2>&1; then
  echo ""
  echo "Warning: Claude Code CLI (claude) not found in PATH."
  echo "iago uses Claude Code to review PRs. Install it from:"
  echo "  https://docs.anthropic.com/en/docs/claude-code"
  echo ""
fi

# alerter — optional but recommended for rich notifications
if ! command -v alerter >/dev/null 2>&1; then
  if $HAS_BREW; then
    echo "Installing alerter (for rich notifications)..."
    brew install alerter
  else
    echo "Note: alerter not found. Notifications will use basic macOS alerts."
    echo "For rich notifications with action buttons: brew install alerter"
  fi
fi

mkdir -p "$IAGO_BIN" "$IAGO_HOME"

# ── Try prebuilt binary from GitHub Releases ───────────────────

install_prebuilt() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64)        arch="x86_64" ;;
    *)
      echo "  Unsupported architecture: $arch"
      return 1
      ;;
  esac

  # Get latest release tag
  local tag
  tag="$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null)" || return 1

  if [ -z "$tag" ]; then
    return 1
  fi

  local version="${tag#v}"
  local tarball="iago-${version}-darwin-${arch}.tar.gz"

  echo "  Downloading $tarball..."
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap "rm -rf '$tmpdir'" EXIT

  if gh release download "$tag" --repo "$REPO" --pattern "$tarball" --dir "$tmpdir" 2>/dev/null; then
    tar -xzf "$tmpdir/$tarball" -C "$tmpdir"
    cp "$tmpdir/iago" "$IAGO_BIN/iago"
    chmod +x "$IAGO_BIN/iago"
    if [ -f "$tmpdir/iago-bar" ]; then
      cp "$tmpdir/iago-bar" "$IAGO_BIN/iago-bar"
      chmod +x "$IAGO_BIN/iago-bar"
      echo "  Installed iago-bar to $IAGO_BIN/iago-bar"
    fi
    echo "  Installed iago $version (prebuilt, $arch)"
    return 0
  fi

  return 1
}

install_from_source() {
  # Ensure bun is in PATH (common install locations)
  for p in "$HOME/.bun/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
    [ -x "$p/bun" ] && export PATH="$p:$PATH"
  done

  if ! command -v bun >/dev/null 2>&1; then
    echo "  bun not found. Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi

  local IAGO_SRC="$IAGO_HOME/src"

  if [ -d "$IAGO_SRC" ]; then
    echo "  Updating existing source installation..."
    cd "$IAGO_SRC"
    git pull --ff-only
  else
    echo "  Cloning iago..."
    gh repo clone "$REPO" "$IAGO_SRC"
    cd "$IAGO_SRC"
  fi

  echo "  Installing dependencies..."
  bun install

  # Try to compile a standalone binary
  if bun build --compile --minify src/index.ts --outfile "$IAGO_BIN/iago" 2>/dev/null; then
    echo "  Compiled standalone binary to $IAGO_BIN/iago"
  else
    # Fall back to wrapper script
    cat > "$IAGO_BIN/iago" <<EOF
#!/bin/bash
exec "$(which bun)" run "$IAGO_SRC/src/index.ts" "\$@"
EOF
    chmod +x "$IAGO_BIN/iago"
    echo "  Installed wrapper script to $IAGO_BIN/iago"
  fi

  # Build menu bar app if Xcode tools are available
  if command -v swiftc >/dev/null 2>&1; then
    echo "  Building menu bar app..."
    (cd "$IAGO_SRC" && make menubar-install 2>/dev/null) && {
      echo "  Installed iago-bar to $IAGO_BIN/iago-bar"
    } || echo "  Warning: menu bar build failed (optional)"
  else
    echo ""
    echo "  Note: Xcode Command Line Tools not found. Skipping menu bar app."
    echo "  To install later: xcode-select --install && iago update"
  fi
}

# ── Install ────────────────────────────────────────────────────

echo "Checking for prebuilt release..."
if ! install_prebuilt; then
  echo "  No prebuilt binary available. Building from source..."
  install_from_source
fi

# ── Set up default prompts if missing ──────────────────────────

IAGO_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/iago"
mkdir -p "$IAGO_CONFIG_DIR/prompts"

if [ ! -f "$IAGO_CONFIG_DIR/prompts/system.md" ]; then
  cat > "$IAGO_CONFIG_DIR/prompts/system.md" <<'PROMPT'
You are an expert code reviewer operating with a team of specialized agents. Analyze the repository and dynamically assign agents as needed to cover all relevant technologies, edge cases, and architectural concerns.

Adopt a strict "0 BS" policy:

Ignore cosmetic issues (formatting, trivial comments, style preferences).
Focus only on issues that impact correctness, reliability, security, performance, or maintainability in a meaningful way.

Your goal is to identify problems that:

Can cause bugs or incorrect behavior
Introduce security risks
Degrade performance or scalability
Break API contracts or expected behavior
Lack proper error handling or resilience
Affect future development (testability, extensibility, feature evolution)
PROMPT
  echo "  Created default system prompt"
fi

if [ ! -f "$IAGO_CONFIG_DIR/prompts/instructions.md" ]; then
  cat > "$IAGO_CONFIG_DIR/prompts/instructions.md" <<'PROMPT'
Review the provided pull request diff. For each issue found, produce a review comment with:

Severity: CRITICAL, WARNING, or SUGGESTION
Location: File path + exact line(s)
Issue: Clear, concise explanation of the problem
Fix: Concrete, actionable solution (code or approach)

Write comments as if they are posted directly on the PR that can be resolved by the developers:

Keep them concise and resolvable
Expand only when necessary for clarity
One issue per comment

Focus Areas (Priority Order)
Bugs and logic errors
Security vulnerabilities
Performance regressions
API contract violations
Missing or weak error handling

Additional Guidelines
Be pragmatic, not theoretical
Avoid noise and redundancy
Prefer actionable fixes over vague advice
Highlight risks and impact when relevant
If something is fine, don't comment just to feel useful

IF there are changes needed, make sure to use the github commands to request those changes. Do not approve it unless is ready for production and all change requests have been solved - or marked as resolved.
PROMPT
  echo "  Created default instructions"
fi

# Wire prompts into config if not already set
if [ -f "$IAGO_CONFIG_DIR/config.yaml" ]; then
  if ! grep -q "system_prompt:" "$IAGO_CONFIG_DIR/config.yaml" 2>/dev/null; then
    cat >> "$IAGO_CONFIG_DIR/config.yaml" <<YAML
prompts:
  system_prompt: ~/.config/iago/prompts/system.md
  instructions: ~/.config/iago/prompts/instructions.md
YAML
    echo "  Added prompt paths to config"
  fi
fi

# ── PATH setup ─────────────────────────────────────────────────

echo ""
echo "iago installed successfully!"
echo ""
echo "  CLI:       $IAGO_BIN/iago"
echo "  Config:    $IAGO_CONFIG_DIR/config.yaml"
echo "  Prompts:   $IAGO_CONFIG_DIR/prompts/"
echo "  Data:      $IAGO_HOME"
echo ""

case ":$PATH:" in
  *":$IAGO_BIN:"*) ;;
  *)
    # Detect shell profile
    SHELL_NAME="$(basename "$SHELL")"
    case "$SHELL_NAME" in
      zsh)  PROFILE="$HOME/.zshrc" ;;
      bash) PROFILE="$HOME/.bashrc" ;;
      fish) PROFILE="$HOME/.config/fish/config.fish" ;;
      *)    PROFILE="$HOME/.profile" ;;
    esac

    EXPORT_LINE="export PATH=\"$IAGO_BIN:\$PATH\""
    if [ -f "$PROFILE" ] && grep -qF "$IAGO_BIN" "$PROFILE" 2>/dev/null; then
      echo "  PATH already configured in $PROFILE"
    else
      echo "" >> "$PROFILE"
      echo "# iago" >> "$PROFILE"
      echo "$EXPORT_LINE" >> "$PROFILE"
      echo "  Added $IAGO_BIN to PATH in $PROFILE"
      echo "  Run: source $PROFILE (or open a new terminal)"
    fi
    export PATH="$IAGO_BIN:$PATH"
    ;;
esac

# ── Post-install ───────────────────────────────────────────────

echo ""
echo "Prerequisites:"
command -v gh      >/dev/null 2>&1 && echo "  [ok] gh (GitHub CLI)" || echo "  [!!] gh — install with: brew install gh"
command -v claude  >/dev/null 2>&1 && echo "  [ok] claude (Claude Code)" || echo "  [!!] claude — install from: https://docs.anthropic.com/en/docs/claude-code"
command -v alerter >/dev/null 2>&1 && echo "  [ok] alerter (rich notifications)" || echo "  [--] alerter — optional: brew install alerter"
[ -f "$IAGO_BIN/iago-bar" ]       && echo "  [ok] iago-bar (menu bar app)" || echo "  [--] iago-bar — needs Xcode tools: xcode-select --install"
echo ""

# Run setup only on first install (no config file yet)
if [ -t 0 ] && [ ! -f "$IAGO_CONFIG_DIR/config.yaml" ]; then
  echo "Running setup wizard..."
  echo ""
  "$IAGO_BIN/iago" setup || true
else
  echo "To get started: iago start"
  echo "To reconfigure:  iago setup"
fi
