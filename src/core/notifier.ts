import type { NotificationAction, AlerterResponse } from "../types/index.js";

export interface PRNotificationInfo {
  repo: string;
  pr_number: number;
  title: string;
  author: string;
  url: string;
}

export function buildAlerterArgs(pr: PRNotificationInfo): string[] {
  return [
    "--title",
    "PR Review Request",
    "--subtitle",
    `${pr.repo} #${pr.pr_number}`,
    "--message",
    `${pr.title} — @${pr.author}`,
    "--sender",
    "com.apple.ScriptEditor2",
    "--sound",
    "Ping",
    "--group",
    `pr-review-${pr.repo}-${pr.pr_number}`,
    "--actions",
    "Launch Review,View on GitHub,Ignore",
  ];
}

export function handleNotificationAction(response: AlerterResponse): NotificationAction {
  if (response.activationType === "timeout") {
    return "timeout";
  }

  if (response.activationType === "closed") {
    return "dismiss";
  }

  // activationType === "actionClicked" or "contentsClicked"
  switch (response.activationValue) {
    case "Launch Review":
      return "accept";
    case "View on GitHub":
      return "view";
    case "Snooze":
      return "snooze";
    default:
      return "dismiss";
  }
}

export async function sendPRNotification(pr: PRNotificationInfo): Promise<NotificationAction> {
  const hasAlerter = await checkAlerterAvailable();

  if (hasAlerter) {
    // Fire-and-forget: notification stays in Notification Center
    const args = buildAlerterArgs(pr);
    Bun.spawn(["alerter", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } else {
    // Fallback: osascript
    const msg = `${pr.title} — @${pr.author}`;
    const script = `display notification "${escapeAppleScript(msg)}" with title "PR Review Request" subtitle "${escapeAppleScript(`${pr.repo} #${pr.pr_number}`)}" sound name "Ping"`;
    Bun.spawn(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  // Non-blocking: always return "notified" — user acts via menu bar
  return "notified";
}

export async function checkAlerterAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "alerter"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

export async function openInBrowser(url: string): Promise<void> {
  const proc = Bun.spawn(["open", url], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

export async function sendSimpleNotification(
  title: string,
  subtitle: string,
  message: string,
  sound: string = "Glass",
): Promise<void> {
  const hasAlerter = await checkAlerterAvailable();

  if (hasAlerter) {
    const proc = Bun.spawn(
      [
        "alerter",
        "--title", title,
        "--subtitle", subtitle,
        "--message", message,
        "--sender", "com.apple.ScriptEditor2",
        "--sound", sound,
        "--timeout", "15",
        "--group", "pr-reviews",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
  } else {
    // Fallback: osascript (always available on macOS)
    const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" subtitle "${escapeAppleScript(subtitle)}" sound name "${sound}"`;
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  }
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function sendReviewCompleteNotification(pr: PRNotificationInfo, summary?: string): Promise<void> {
  const message = summary
    ? `${pr.title} — ${summary}`
    : `${pr.title} — review finished`;

  const hasAlerter = await checkAlerterAvailable();

  if (hasAlerter) {
    const proc = Bun.spawn(
      [
        "alerter",
        "--title", "Review Complete",
        "--subtitle", `${pr.repo} #${pr.pr_number}`,
        "--message", message,
        "--sender", "com.apple.ScriptEditor2",
        "--sound", "Glass",
        "--group", `pr-review-${pr.repo}-${pr.pr_number}`,
        "--actions", "View Output,Open in GitHub",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  } else {
    const script = `display notification "${escapeAppleScript(message)}" with title "Review Complete" subtitle "${escapeAppleScript(`${pr.repo} #${pr.pr_number}`)}" sound name "Glass"`;
    Bun.spawn(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}

export async function sendReviewErrorNotification(pr: PRNotificationInfo, error: string): Promise<void> {
  const shortError = error.length > 80 ? error.slice(0, 77) + "..." : error;
  const message = `${pr.title} — ${shortError}`;

  const hasAlerter = await checkAlerterAvailable();

  if (hasAlerter) {
    const proc = Bun.spawn(
      [
        "alerter",
        "--title", "Review Failed",
        "--subtitle", `${pr.repo} #${pr.pr_number}`,
        "--message", message,
        "--sender", "com.apple.ScriptEditor2",
        "--sound", "Basso",
        "--group", `pr-review-${pr.repo}-${pr.pr_number}`,
        "--actions", "Retry,View Details",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  } else {
    const script = `display notification "${escapeAppleScript(message)}" with title "Review Failed" subtitle "${escapeAppleScript(`${pr.repo} #${pr.pr_number}`)}" sound name "Basso"`;
    Bun.spawn(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}
