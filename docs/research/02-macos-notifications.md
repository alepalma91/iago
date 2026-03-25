# Research: macOS Native Notifications with Action Buttons

## Executive Summary

For a CLI-based PR review tool, we need macOS notifications that:
1. Display when a new PR needs review
2. Include an **"Accept Review"** action button
3. Detect when the user clicks that button and trigger the review workflow
4. Optionally show a badge/count of pending reviews

This document evaluates all viable approaches, from CLI tools to native Swift bridges and Node.js libraries.

---

## 1. macOS Notification System Overview

### Notification Frameworks (Apple)

| Framework | Status | macOS Version | Action Buttons |
|-----------|--------|---------------|----------------|
| `NSUserNotification` | **Deprecated** (macOS 11.0+) | 10.8 - 10.15 | Yes (limited) |
| `UNUserNotificationCenter` | **Current** | 10.14+ | Yes (full support) |

**Key constraint**: The `UNUserNotificationCenter` API requires a proper **app bundle** with a `CFBundleIdentifier`. Pure CLI tools cannot use it directly - they need a helper `.app` bundle or a wrapper tool.

### Notification Styles (controlled by user in System Settings)

- **Banner**: Auto-dismisses after ~5 seconds. **Not ideal** for action buttons (user may miss them).
- **Alert**: Persists on screen until the user interacts. **Required** for reliable action button workflows. Must be configured per-app in System Settings > Notifications.

### osascript `display notification`

```bash
osascript -e 'display notification "New PR from @user" with title "PR Review"'
```

**Limitations**: No custom action buttons. Only system-default Show/Close. Cannot detect which button was clicked. Not suitable for our use case.

---

## 2. CLI Tools for Actionable Notifications

### 2.1 Alerter (Recommended for CLI Integration)

**Repository**: [vjeantet/alerter](https://github.com/vjeantet/alerter)
**Version**: 26.5 (Feb 2026) - actively maintained, complete Swift rewrite
**License**: MIT
**Install**: `brew install vjeantet/tap/alerter`
**Requires**: macOS 13.0+

#### Key Features
- Action buttons with stdout-based callback detection
- Reply text input mode
- Persistent notifications (alert style)
- Custom icons via `--appIcon` or `--sender`
- Scheduled delivery (`--at`, `--delay`)
- Timeout with auto-close
- JSON output mode
- Notification grouping (`--group`)
- Ignore Do Not Disturb mode

#### Action Button Flow

```bash
# Send notification with Accept/Decline buttons
ANSWER=$(alerter \
  --title "PR Review Request" \
  --subtitle "repo-name #42" \
  --message "feat: add user authentication by @developer" \
  --actions "Accept Review,View on GitHub,Snooze" \
  --closeLabel "Dismiss" \
  --sound "Ping" \
  --timeout 300 \
  --group "pr-reviews" \
  --json)

# Parse the response
case $ANSWER in
  "@TIMEOUT")       echo "Notification timed out" ;;
  "@CLOSED")        echo "User dismissed" ;;
  "@CONTENTCLICKED") echo "User clicked the notification body" ;;
  "@ACTIONCLICKED")  echo "Default action triggered" ;;
  "Accept Review")   echo "START REVIEW WORKFLOW" ;;
  "View on GitHub")  echo "OPEN BROWSER" ;;
  "Snooze")          echo "SNOOZE 30 MIN" ;;
esac
```

#### JSON Output Mode

With `--json`, output looks like:
```json
{
  "activationType": "actionClicked",
  "activationValue": "Accept Review",
  "deliveredAt": "2026-03-25 10:30:00",
  "activationAt": "2026-03-25 10:30:05"
}
```

#### Node.js Integration Pattern

```javascript
const { execFile } = require('child_process');

function sendPRNotification(pr) {
  return new Promise((resolve, reject) => {
    const args = [
      '--title', 'PR Review Request',
      '--subtitle', `${pr.repo} #${pr.number}`,
      '--message', `${pr.title} by @${pr.author}`,
      '--actions', 'Accept Review,View on GitHub,Snooze',
      '--closeLabel', 'Dismiss',
      '--sound', 'Ping',
      '--timeout', '300',
      '--group', `pr-${pr.number}`,
      '--json'
    ];

    const child = execFile('alerter', args, (error, stdout) => {
      if (error) return reject(error);
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch {
        resolve({ activationValue: stdout.trim() });
      }
    });
  });
}

// Usage
const result = await sendPRNotification(pr);
if (result.activationValue === 'Accept Review') {
  startReviewWorkflow(pr);
}
```

#### Pros
- Actively maintained (v26.5, Feb 2026)
- Stdout-based callback is simple and reliable
- JSON output for structured parsing
- Homebrew installable
- Swift-based, native macOS feel
- Notification grouping for multiple PRs

#### Cons
- Blocks the calling process until user interacts (need to spawn in background)
- External binary dependency
- macOS 13.0+ required
- Each notification requires a separate process

---

### 2.2 NotifiCLI

**Repository**: [saihgupr/NotifiCLI](https://github.com/saihgupr/NotifiCLI)
**Install**: `brew tap saihgupr/notificli && brew install --cask notificli`
**Requires**: macOS Monterey+

#### Key Features
- Action buttons with stdout output (prints clicked button label)
- Reply text input
- Persistent notifications (`-persistent` flag)
- Custom icons from any `.app` bundle
- URL opening on click

#### Usage

```bash
RESPONSE=$(notificli -persistent \
  -title "PR Review" \
  -message "feat: auth by @dev" \
  -actions "Accept,Decline")

if [ "$RESPONSE" == "Accept" ]; then
  echo "Start review"
fi
```

#### Output Values
- Action clicked: prints the exact button label (e.g., `"Accept"`)
- Dismissed: prints `"dismissed"`
- Default click: prints `"default"`
- Reply: prints user's typed text

#### Pros
- Persistent notification support
- Simple stdout-based detection
- Custom icons

#### Cons
- Requires `.app` bundle in /Applications (not a simple binary)
- Less mature than alerter
- Requires manual notification permission setup
- Single-dash flag syntax (non-standard)

---

### 2.3 terminal-notifier

**Repository**: [julienXX/terminal-notifier](https://github.com/julienXX/terminal-notifier)
**Install**: `brew install terminal-notifier`

**NOT RECOMMENDED**: As of version 2.0.0, terminal-notifier **removed** action buttons, reply, and sticky notification features. It only supports basic banner/alert notifications with no custom actions.

Use alerter instead (it was forked from terminal-notifier specifically to add action support).

---

### 2.4 Jamf Notifier

**Repository**: [jamf/Notifier](https://github.com/jamf/Notifier)
**Requires**: macOS 10.15+

#### Key Features
- Alert and banner notification types
- `--messagebutton` with `--messagebuttonaction` for a single action button
- Action can launch URLs, apps, or run commands
- Uses `UNUserNotificationCenter` (modern framework)
- Rebranding support (custom icon)

#### Usage

```bash
/Applications/Utilities/Notifier.app/Contents/MacOS/Notifier \
  --type alert \
  --title "PR Review" \
  --message "New PR needs review" \
  --messagebutton "Accept Review" \
  --messagebuttonaction "/usr/bin/open https://github.com/org/repo/pull/42"
```

#### Limitations
- Only **one** custom action button
- Action triggers an external command (not stdout callback)
- Designed for enterprise/MDM deployment, not lightweight CLI
- Must be installed as `.app` bundle in `/Applications/Utilities/`

---

## 3. Node.js Libraries

### 3.1 node-notifier

**Package**: [node-notifier](https://www.npmjs.com/package/node-notifier) (v10.0.1)
**Weekly downloads**: ~2M
**Last publish**: ~4 years ago (still widely used)

#### macOS-Specific Options

```javascript
const notifier = require('node-notifier');

notifier.notify({
  title: 'PR Review Request',
  subtitle: 'repo-name #42',
  message: 'feat: add auth by @developer',
  icon: path.join(__dirname, 'icon.png'),
  contentImage: path.join(__dirname, 'pr-preview.png'),
  sound: 'Ping',
  wait: true,        // CRITICAL: keeps process alive for callbacks
  timeout: 300,
  actions: ['Accept Review', 'Snooze'],
  closeLabel: 'Dismiss',
  dropdownLabel: 'Actions',
  reply: false
}, (err, response, metadata) => {
  console.log('Response:', response);       // e.g., "activate"
  console.log('Metadata:', metadata);       // { activationValue: "Accept Review", ... }

  if (metadata.activationValue === 'Accept Review') {
    startReviewWorkflow();
  }
});

// Event-based API
notifier.on('click', (notifierObj, options, event) => {
  console.log('Notification clicked');
});

notifier.on('timeout', (notifierObj, options) => {
  console.log('Notification expired');
});
```

#### How It Works Internally
- Spawns `terminal-notifier` binary (bundled) as a child process
- Can use a custom binary path via `customPath` option (e.g., point to alerter)
- Parses stdout/stderr for event detection

#### Using node-notifier with alerter

```javascript
const NotificationCenter = require('node-notifier').NotificationCenter;

const notifier = new NotificationCenter({
  customPath: '/opt/homebrew/bin/alerter'  // Use alerter instead of terminal-notifier
});

notifier.notify({
  title: 'PR Review',
  message: 'New PR needs review',
  actions: ['Accept', 'Decline'],
  closeLabel: 'Later',
  timeout: 300,
  wait: true
}, (err, response, metadata) => {
  // metadata.activationValue contains the clicked action
});
```

#### Pros
- Cross-platform (macOS, Windows, Linux)
- npm installable, no external deps
- Event-based and callback APIs
- Bundled terminal-notifier binary
- Can swap in alerter via `customPath`

#### Cons
- Last published ~4 years ago
- Bundled terminal-notifier may be outdated
- macOS action support depends on the underlying binary
- `wait: true` blocks the notifier process

---

### 3.2 node-mac-notifier

**Package**: [node-mac-notifier](https://www.npmjs.com/package/node-mac-notifier) (v1.2.0)
**Last publish**: 7+ years ago

Native N-API addon that directly interfaces with `NSUserNotification`. Supports reply but **not custom action buttons**. Also uses the **deprecated** `NSUserNotification` API.

**NOT RECOMMENDED** for new projects.

---

## 4. Custom Swift Helper Binary (Advanced Approach)

For maximum control, build a small Swift CLI tool that uses `UNUserNotificationCenter`:

### Architecture

```
Node.js CLI (the-reviewer)
  |
  |-- spawns --> Swift helper binary (review-notifier)
  |                |
  |                |-- UNUserNotificationCenter
  |                |-- Registers action categories
  |                |-- Waits for user response
  |                |-- Outputs JSON to stdout
  |
  |-- reads stdout --> Parses action --> Triggers workflow
```

### Swift Implementation Sketch

```swift
import UserNotifications
import Foundation

// Must be an app bundle for UNUserNotificationCenter to work
let center = UNUserNotificationCenter.current()

// Define actions
let acceptAction = UNNotificationAction(
    identifier: "ACCEPT_REVIEW",
    title: "Accept Review",
    options: .foreground
)
let snoozeAction = UNNotificationAction(
    identifier: "SNOOZE",
    title: "Snooze",
    options: []
)

// Register category
let reviewCategory = UNNotificationCategory(
    identifier: "PR_REVIEW",
    actions: [acceptAction, snoozeAction],
    intentIdentifiers: []
)
center.setNotificationCategories([reviewCategory])

// Create and send notification
let content = UNMutableNotificationContent()
content.title = "PR Review Request"
content.body = "feat: add auth by @developer"
content.categoryIdentifier = "PR_REVIEW"
content.sound = .default

let request = UNNotificationRequest(
    identifier: UUID().uuidString,
    content: content,
    trigger: nil
)
center.add(request)

// Delegate handles responses
func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
) {
    let json = ["action": response.actionIdentifier]
    // Output JSON to stdout for Node.js to parse
    print(String(data: try! JSONSerialization.data(withJSONObject: json), encoding: .utf8)!)
    exit(0)
}
```

#### Pros
- Full control over notification behavior
- Uses modern `UNUserNotificationCenter` API
- Multiple action buttons with identifiers
- Can be distributed as part of the tool

#### Cons
- Requires Swift compilation (adds build complexity)
- Needs an `.app` bundle structure for `UNUserNotificationCenter`
- Significant development effort
- Must handle notification permissions programmatically

---

## 5. Dock Badge / Notification Count

### The Problem

macOS dock badges require a **running GUI application** with a dock icon. Pure CLI tools don't have dock presence. Options:

### Approach A: Menu Bar App (Recommended)

A lightweight macOS menu bar app (Swift/Electron) that:
- Shows pending review count as a badge icon in the menu bar
- Receives updates from the CLI daemon via IPC (Unix socket, file watch, or HTTP)
- Clicking the badge opens a dropdown of pending PRs

### Approach B: Terminal Tab Title / iTerm2 Badge

```javascript
// Set terminal tab title with count
process.stdout.write(`\x1b]0;[3 PRs] the-reviewer\x07`);

// iTerm2-specific badge
process.stdout.write(`\x1b]1337;SetBadgeFormat=${btoa('3 PRs')}\x07`);
```

### Approach C: Notification Grouping as Badge Proxy

Using alerter's `--group` flag, multiple notifications for the same group get stacked in Notification Center, showing a count. This provides a visual badge effect without a dock icon.

```bash
# Each PR creates a grouped notification
alerter --title "PR #42" --message "..." --group "pending-reviews"
alerter --title "PR #43" --message "..." --group "pending-reviews"
# macOS shows "2 Notifications" for the group
```

---

## 6. Recommendation

### Primary: alerter + Node.js child_process

**Why alerter?**
1. **Actively maintained** (v26.5, Feb 2026)
2. **Action buttons with stdout detection** - exactly what we need
3. **JSON output** for structured parsing
4. **Homebrew installable** - easy setup
5. **Notification grouping** for multiple pending PRs
6. **Timeout support** with configurable auto-dismiss
7. **No app bundle required** - works as a standalone binary

### Integration Architecture

```
┌──────────────────────────────────────────────────┐
│  the-reviewer CLI daemon (Node.js)               │
│                                                   │
│  ┌─────────────┐    ┌──────────────────────────┐ │
│  │ GitHub       │    │ Notification Manager     │ │
│  │ Poller       │───>│                          │ │
│  │              │    │ - Spawns alerter process  │ │
│  └─────────────┘    │ - Parses JSON stdout     │ │
│                      │ - Maps actions to         │ │
│                      │   review workflows        │ │
│                      │ - Groups by PR            │ │
│                      └──────────────────────────┘ │
│                                │                   │
│                      ┌─────────┴──────────┐       │
│                      │ Action Router       │       │
│                      │                     │       │
│                      │ "Accept Review" ──> │       │
│                      │   launch sandbox    │       │
│                      │ "View on GitHub" -> │       │
│                      │   open browser      │       │
│                      │ "Snooze" ────────> │       │
│                      │   reschedule        │       │
│                      └────────────────────┘       │
└──────────────────────────────────────────────────┘
```

### Fallback Chain

1. **alerter** (preferred) - full action button support
2. **node-notifier with customPath** - if alerter is available
3. **osascript display notification** - basic notification, no actions (graceful degradation)
4. **Terminal bell + stdout message** - last resort

### Setup Requirements

```bash
# User setup (one-time)
brew install vjeantet/tap/alerter

# System Settings > Notifications > alerter > set to "Alerts" (not Banners)
# This ensures notifications persist until the user interacts
```

### Notification Permission Detection

```javascript
const { execSync } = require('child_process');

function checkNotificationPermissions() {
  try {
    // Test with a silent notification
    execSync('alerter --message "test" --timeout 1 --group "test" --remove "test"');
    return true;
  } catch {
    return false;
  }
}
```

---

## 7. Edge Cases and Considerations

### Do Not Disturb / Focus Mode
- alerter supports `--ignoreDnd` (uses private API - may break in future macOS)
- Better approach: queue notifications and deliver when Focus Mode ends
- Use `macos-notification-state` npm package to detect DND status

### Multiple Simultaneous Notifications
- alerter blocks until user interacts - each notification needs its own child process
- Use `--group` to stack related notifications
- Consider batching: "You have 3 PRs pending review" with a single notification

### Notification Sounds
- Available system sounds: Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink
- Use sparingly to avoid notification fatigue

### Process Lifecycle
- alerter process persists until user acts or timeout
- If the CLI daemon restarts, orphaned alerter processes may remain
- Solution: track PIDs and clean up on daemon start/stop

### macOS Version Compatibility
- alerter v26.5: macOS 13.0+ (Ventura)
- For older macOS: fall back to node-notifier with bundled terminal-notifier (no action buttons)
