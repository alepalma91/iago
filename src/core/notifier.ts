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
    "Accept Review,View on GitHub,Snooze",
    "--closeLabel",
    "Dismiss",
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
    case "Accept Review":
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
