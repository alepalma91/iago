#!/bin/bash

# iago SwiftBar plugin
# Shows PR review status in the macOS menu bar
# Refresh interval: 30s (from filename)

DB="$HOME/.local/share/iago/iago.db"
SQLITE=/usr/bin/sqlite3
DASHBOARD_URL="http://localhost:1460"
BUN="$HOME/.bun/bin/bun"
CLI_DIR="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)"

# Resolve CLI_DIR: try known locations
if [[ ! -f "$CLI_DIR/src/index.ts" ]]; then
  for d in "$HOME/Documents/AI/the-reviwer" "$HOME/iago" "$HOME/src/iago"; do
    if [[ -f "$d/src/index.ts" ]]; then
      CLI_DIR="$d"
      break
    fi
  done
fi

# 18x18 parrot icon — templateImage adapts to dark/light mode automatically
ICON="iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAQAAAD8x0bcAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAAqo0jMgAAAAlwSFlzAAAOwwAADsMBx2+oZAAAAAd0SU1FB+oDGhMkIaDus74AAAEgSURBVCjPjdI7i1NREADg7969jVsJxgdsI4lItNOAnaBVShst3EbSpNpGwUJE/AdW/oHYSQqxia2FQYIRRDCEBLYRH2S30SJqoo5FNF65ATNTzeGDc2bmsEYk4Igraua6Hiq7hZ8SM6+0TRawbiJ8F8LAaXfFMt+rwxlTn1x1XNl1YVfJsxz77Cwd4bxLhvpqGsIN2zkUOokfnmoaGToonNM30nBfIpA5qpJJfXRMqqWi6YB9h3xw24aQeuOLi4Sxw54L4YGyb16o+iqEmeqitxDuKbnmspLHQm+JnvyZ1OJxXTfdMRC/0Ux45+S/KJ89p+x55MTfmRfRS5u28mvJVi5rapov0xVkXDwqXnfhf2hup0gyrVz1VtvrdX7YivgFhOeMB4CCXskAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDMtMjZUMTY6MzM6MDQrMDA6MDDh5oRCAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTAzLTI2VDE2OjMyOjM2KzAwOjAwZmlBCgAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wMy0yNlQxOTozNjozMyswMDowME3fOj0AAAAZdEVYdFNvZnR3YXJlAHd3dy5pbmtzY2FwZS5vcmeb7jwaAAAAAElFTkSuQmCC"

# --- status helpers ---
sfimage_for_status() {
  case "$1" in
    reviewing) echo "eye.fill" ;;
    cloning)   echo "arrow.down.circle" ;;
    accepted)  echo "hand.thumbsup.fill" ;;
    notified)  echo "bell.fill" ;;
    done)      echo "checkmark.circle.fill" ;;
    error)     echo "xmark.circle.fill" ;;
    dismissed) echo "minus.circle" ;;
    detected)  echo "magnifyingglass" ;;
    *)         echo "questionmark.circle" ;;
  esac
}

sfcolor_for_status() {
  case "$1" in
    reviewing|cloning|accepted|notified) echo "#f0a500" ;;
    done)                                 echo "#34c759" ;;
    error)                                echo "#ff3b30" ;;
    *)                                    echo "#8e8e93" ;;
  esac
}

# --- action: trigger review ---
trigger_review() {
  local url="$1"
  if [[ -f "$CLI_DIR/src/index.ts" && -x "$BUN" ]]; then
    nohup "$BUN" run "$CLI_DIR/src/index.ts" review "$url" --force >/dev/null 2>&1 &
  else
    open "$DASHBOARD_URL"
  fi
}

# --- action: dismiss PR ---
dismiss_pr() {
  local repo="$1" pr_number="$2"
  $SQLITE "$DB" "UPDATE pr_reviews SET status='dismissed', updated_at=datetime('now') WHERE repo='$repo' AND pr_number=$pr_number;"
}

# Handle actions passed via $1
case "$1" in
  review)  trigger_review "$2"; exit 0 ;;
  dismiss) dismiss_pr "$2" "$3"; exit 0 ;;
esac

# --- check DB exists ---
if [[ ! -f "$DB" ]]; then
  echo "| templateImage=$ICON"
  echo "---"
  echo "No database found | sfimage=exclamationmark.triangle sfcolor=#ff3b30"
  echo "Run make dev to start | color=#8e8e93 size=12"
  exit 0
fi

# --- queries (also fetch id for actions) ---
ACTIVE=$($SQLITE "$DB" "SELECT id, repo, pr_number, title, status, url FROM pr_reviews WHERE status NOT IN ('done','error','dismissed') ORDER BY created_at DESC LIMIT 10;" 2>/dev/null)
RECENT=$($SQLITE "$DB" "SELECT id, repo, pr_number, title, status, url FROM pr_reviews WHERE status IN ('done','error','dismissed') AND updated_at >= datetime('now', '-24 hours') ORDER BY updated_at DESC LIMIT 10;" 2>/dev/null)

ACTIVE_COUNT=0
if [[ -n "$ACTIVE" ]]; then
  ACTIVE_COUNT=$(echo "$ACTIVE" | wc -l | tr -d ' ')
fi

# --- header: parrot icon + optional count ---
if [[ "$ACTIVE_COUNT" -gt 0 ]]; then
  echo "$ACTIVE_COUNT | templateImage=$ICON"
else
  echo "| templateImage=$ICON"
fi
echo "---"

SELF="$0"

# --- render PR item with submenu ---
render_pr() {
  local id="$1" repo="$2" pr_number="$3" title="$4" status="$5" url="$6"

  local short_title=$(echo "$title" | cut -c 1-40)
  local sf=$(sfimage_for_status "$status")
  local sfc=$(sfcolor_for_status "$status")
  local short_repo=$(echo "$repo" | sed 's|.*/||')

  # Parent item (shows PR info)
  echo "${short_repo}#${pr_number}  ${short_title} | sfimage=$sf sfcolor=$sfc size=13"

  # Submenu: Open in GitHub (always available)
  echo "--Open in GitHub | sfimage=safari href=$url"

  # Submenu: status-dependent actions
  case "$status" in
    detected|notified|dismissed)
      # Not yet reviewed — offer "Review"
      echo "--Review | sfimage=play.fill sfcolor=#34c759 bash=$SELF param1=review param2=$url terminal=false refresh=true"
      ;;
    done)
      # Already reviewed — offer "Review Again"
      echo "--Review Again | sfimage=arrow.counterclockwise sfcolor=#f0a500 bash=$SELF param1=review param2=$url terminal=false refresh=true"
      ;;
    error)
      # Failed — offer "Retry"
      echo "--Retry | sfimage=arrow.counterclockwise sfcolor=#ff3b30 bash=$SELF param1=review param2=$url terminal=false refresh=true"
      ;;
    reviewing|cloning|accepted)
      # In progress — no review action
      echo "--In progress… | color=#8e8e93"
      ;;
  esac

  # Submenu: Dismiss/Ignore (available unless already dismissed or in-progress)
  case "$status" in
    reviewing|cloning|accepted|dismissed)
      # Don't offer dismiss for in-progress or already dismissed
      ;;
    *)
      echo "--Ignore | sfimage=xmark.circle sfcolor=#8e8e93 bash=$SELF param1=dismiss param2=$repo param3=$pr_number terminal=false refresh=true"
      ;;
  esac
}

# --- active section ---
if [[ -n "$ACTIVE" ]]; then
  echo "Active | size=11 color=#8e8e93"
  while IFS='|' read -r id repo pr_number title status url; do
    render_pr "$id" "$repo" "$pr_number" "$title" "$status" "$url"
  done <<< "$ACTIVE"
  echo "---"
fi

# --- recent section ---
if [[ -n "$RECENT" ]]; then
  echo "Recent | size=11 color=#8e8e93"
  while IFS='|' read -r id repo pr_number title status url; do
    render_pr "$id" "$repo" "$pr_number" "$title" "$status" "$url"
  done <<< "$RECENT"
  echo "---"
fi

# --- empty state ---
if [[ -z "$ACTIVE" && -z "$RECENT" ]]; then
  echo "No reviews yet | color=#8e8e93"
  echo "---"
fi

# --- footer ---
echo "Dashboard | sfimage=globe href=$DASHBOARD_URL"
echo "Refresh | sfimage=arrow.clockwise refresh=true"
