#!/bin/bash
set -euo pipefail

# iago — AI-powered PR review daemon installer

REPO="theburrowhub/iago"
IAGO_BIN="${IAGO_BIN:-$HOME/bin}"
IAGO_HOME="${IAGO_HOME:-$HOME/.local/share/iago}"

echo "Installing iago..."
echo ""

# Check required dependencies
if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh (GitHub CLI) is required but not installed."
  echo "Install it: brew install gh"
  exit 1
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
  local url="https://github.com/${REPO}/releases/download/${tag}/${tarball}"

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
  if ! command -v bun >/dev/null 2>&1; then
    echo "Error: bun is required for source install."
    echo "Install it: curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi

  local IAGO_SRC="$IAGO_HOME/src"

  if [ -d "$IAGO_SRC" ]; then
    echo "  Updating existing source installation..."
    cd "$IAGO_SRC"
    git pull --ff-only
  else
    echo "  Cloning iago..."
    git clone "https://github.com/${REPO}.git" "$IAGO_SRC"
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

  # Build menu bar app if possible
  echo "  Building menu bar app..."
  if command -v swiftc >/dev/null 2>&1; then
    (cd "$IAGO_SRC" && make menubar-build 2>/dev/null) && {
      cp "$IAGO_SRC/extras/menubar/.build/IagoBar" "$IAGO_BIN/iago-bar"
      echo "  Installed iago-bar to $IAGO_BIN/iago-bar"
    } || echo "  Warning: menu bar build failed (optional)"
  else
    echo "  Skipping menu bar build (swiftc not found)"
  fi
}

# Try prebuilt first, fall back to source
echo "Checking for prebuilt release..."
if ! install_prebuilt; then
  echo "  No prebuilt binary available. Building from source..."
  install_from_source
fi

echo ""
echo "iago installed successfully!"
echo ""
echo "  CLI:  $IAGO_BIN/iago"
echo "  Data: $IAGO_HOME"
echo ""

# Ensure bin is in PATH
case ":$PATH:" in
  *":$IAGO_BIN:"*) ;;
  *)
    echo "Add to your shell profile:"
    echo "  export PATH=\"$IAGO_BIN:\$PATH\""
    echo ""
    ;;
esac

# Run setup if interactive
if [ -t 0 ]; then
  echo "Running setup wizard..."
  echo ""
  "$IAGO_BIN/iago" setup || true
fi
