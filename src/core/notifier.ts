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
    "--actions",
    "Launch Review,View on GitHub,Snooze",
    "--close-label",
    "Dismiss",
    "--sender",
    "com.apple.ScriptEditor2",
    "--ignore-dnd",
    "--sound",
    "Ping",
    "--timeout",
    "300",
    "--group",
    "pr-reviews",
    "--json",
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
  const args = buildAlerterArgs(pr);

  const proc = Bun.spawn(["alerter", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  try {
    const response = JSON.parse(stdout) as AlerterResponse;
    return handleNotificationAction(response);
  } catch {
    return "dismiss";
  }
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

export async function sendReviewCompleteNotification(pr: PRNotificationInfo): Promise<void> {
  await sendSimpleNotification(
    "Review Complete",
    `${pr.repo} #${pr.pr_number}`,
    `${pr.title} — review finished`,
    "Glass",
  );
}

export async function sendReviewErrorNotification(pr: PRNotificationInfo, error: string): Promise<void> {
  const shortError = error.length > 80 ? error.slice(0, 77) + "..." : error;
  await sendSimpleNotification(
    "Review Failed",
    `${pr.repo} #${pr.pr_number}`,
    `${pr.title} — ${shortError}`,
    "Basso",
  );
}
