import { describe, expect, it } from "bun:test";
import { buildAlerterArgs, handleNotificationAction } from "../../src/core/notifier.js";
import type { AlerterResponse } from "../../src/types/index.js";

const samplePR = {
  repo: "owner/repo",
  pr_number: 42,
  title: "feat: add auth",
  author: "developer",
  url: "https://github.com/owner/repo/pull/42",
};

describe("buildAlerterArgs", () => {
  it("should build correct args array", () => {
    const args = buildAlerterArgs(samplePR);
    expect(args).toContain("--title");
    expect(args).toContain("PR Review Request");
    expect(args).toContain("--json");
  });

  it("should format subtitle as repo #number", () => {
    const args = buildAlerterArgs(samplePR);
    const subtitleIdx = args.indexOf("--subtitle");
    expect(args[subtitleIdx + 1]).toBe("owner/repo #42");
  });

  it("should format message as title — @author", () => {
    const args = buildAlerterArgs(samplePR);
    const msgIdx = args.indexOf("--message");
    expect(args[msgIdx + 1]).toBe("feat: add auth — @developer");
  });

  it("should include all action buttons", () => {
    const args = buildAlerterArgs(samplePR);
    const actionsIdx = args.indexOf("--actions");
    expect(args[actionsIdx + 1]).toBe("Accept Review,View on GitHub,Snooze");
  });
});

describe("handleNotificationAction", () => {
  it("should map Accept Review to accept", () => {
    const response: AlerterResponse = {
      activationType: "actionClicked",
      activationValue: "Accept Review",
      deliveredAt: "2025-03-20T10:00:00Z",
    };
    expect(handleNotificationAction(response)).toBe("accept");
  });

  it("should map View on GitHub to view", () => {
    const response: AlerterResponse = {
      activationType: "actionClicked",
      activationValue: "View on GitHub",
      deliveredAt: "2025-03-20T10:00:00Z",
    };
    expect(handleNotificationAction(response)).toBe("view");
  });

  it("should map Snooze to snooze", () => {
    const response: AlerterResponse = {
      activationType: "actionClicked",
      activationValue: "Snooze",
      deliveredAt: "2025-03-20T10:00:00Z",
    };
    expect(handleNotificationAction(response)).toBe("snooze");
  });

  it("should map closed activationType to dismiss", () => {
    const response: AlerterResponse = {
      activationType: "closed",
      deliveredAt: "2025-03-20T10:00:00Z",
    };
    expect(handleNotificationAction(response)).toBe("dismiss");
  });

  it("should map timeout activationType to timeout", () => {
    const response: AlerterResponse = {
      activationType: "timeout",
      deliveredAt: "2025-03-20T10:00:00Z",
    };
    expect(handleNotificationAction(response)).toBe("timeout");
  });
});
