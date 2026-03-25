#!/usr/bin/env bun

import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { reviewCommand } from "./commands/review.js";
import { configCommand } from "./commands/config.js";
import { dashboardCommand } from "./commands/dashboard.js";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "start":
      await startCommand(args.slice(1));
      break;
    case "stop":
      await stopCommand();
      break;
    case "status":
      await statusCommand();
      break;
    case "review":
      await reviewCommand(args.slice(1));
      break;
    case "config":
      await configCommand(args.slice(1));
      break;
    case "dashboard":
      await dashboardCommand(args.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
      }
      printHelp();
      process.exit(command ? 1 : 0);
  }
}

function printHelp() {
  console.log(`the-reviewer — AI-powered PR review daemon

Usage:
  the-reviewer start     Start the daemon (poll for PR reviews)
  the-reviewer stop      Stop the running daemon
  the-reviewer status    Show active PR reviews
  the-reviewer review    Manually review a PR by URL
  the-reviewer config    Manage configuration (init, validate, show)
  the-reviewer dashboard Start the dashboard server
  the-reviewer help      Show this help message`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
