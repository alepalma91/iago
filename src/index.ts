#!/usr/bin/env bun

import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { reviewCommand } from "./commands/review.js";
import { configCommand } from "./commands/config.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { mcpCommand } from "./commands/mcp.js";
import { setupCommand } from "./commands/setup.js";

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
    case "mcp":
      await mcpCommand();
      break;
    case "setup":
      await setupCommand(args.slice(1));
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
  console.log(`iago — AI-powered PR review daemon

Usage:
  iago start     Start the daemon (poll for PR reviews)
  iago stop      Stop the running daemon
  iago status    Show active PR reviews
  iago review    Manually review a PR by URL
  iago config    Manage configuration (init, validate, show)
  iago dashboard Start the dashboard server
  iago mcp       Start the MCP server (stdio transport)
  iago setup     Interactive first-time setup wizard
  iago help      Show this help message`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
