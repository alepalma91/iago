#!/bin/bash
set -euo pipefail

# iago — AI-powered PR review daemon installer

echo "Installing iago..."
echo ""

# Check dependencies
if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required but not installed."
  echo "Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh (GitHub CLI) is required but not installed."
  echo "Install it: brew install gh"
  exit 1
fi

# Directories
IAGO_HOME="${IAGO_HOME:-$HOME/.local/share/iago}"
IAGO_CONFIG="${IAGO_CONFIG:-$HOME/.config/iago}"
IAGO_BIN="${IAGO_BIN:-$HOME/bin}"
IAGO_SRC="$IAGO_HOME/src"

# Clone and build
if [ -d "$IAGO_SRC" ]; then
  echo "Updating existing installation..."
  cd "$IAGO_SRC"
  git pull --ff-only
else
  echo "Cloning iago..."
  mkdir -p "$IAGO_HOME"
  git clone https://github.com/theburrowhub/iago.git "$IAGO_SRC"
  cd "$IAGO_SRC"
fi

echo "Installing dependencies..."
bun install

echo "Building menu bar app..."
if command -v swiftc >/dev/null 2>&1; then
  make menubar-build || echo "  Warning: menu bar build failed (optional)"
else
  echo "  Skipping menu bar build (swiftc not found)"
fi

# Install binary
echo "Installing CLI..."
mkdir -p "$IAGO_BIN"
cat > "$IAGO_BIN/iago" <<EOF
#!/bin/bash
exec "$(which bun)" run "$IAGO_SRC/src/index.ts" "\$@"
EOF
chmod +x "$IAGO_BIN/iago"

# Install menu bar binary if built
if [ -f "$IAGO_SRC/extras/menubar/.build/IagoBar" ]; then
  cp "$IAGO_SRC/extras/menubar/.build/IagoBar" "$IAGO_BIN/iago-bar"
  echo "  Installed iago-bar to $IAGO_BIN/iago-bar"
fi

# Create default config
mkdir -p "$IAGO_CONFIG"
if [ ! -f "$IAGO_CONFIG/config.yaml" ]; then
  if [ -f "$IAGO_SRC/config.example.yaml" ]; then
    cp "$IAGO_SRC/config.example.yaml" "$IAGO_CONFIG/config.yaml"
  else
    cat > "$IAGO_CONFIG/config.yaml" <<'YAML'
# iago configuration
# See: https://github.com/theburrowhub/iago#configuration
YAML
  fi
  echo "  Default config created at $IAGO_CONFIG/config.yaml"
fi

echo ""
echo "iago installed successfully!"
echo ""
echo "  CLI:    $IAGO_BIN/iago"
echo "  Config: $IAGO_CONFIG/config.yaml"
echo "  Data:   $IAGO_HOME"
echo ""
echo "Make sure $IAGO_BIN is in your PATH, then run:"
echo "  iago start"
