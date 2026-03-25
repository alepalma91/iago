import { loadConfig } from "../core/config.js";
import type { AppConfig } from "../types/index.js";

export async function startCommand(_args: string[]): Promise<void> {
  const config = loadConfig();

  console.log("the-reviewer: starting daemon...");
  console.log(`  Poll interval: ${config.github.poll_interval}`);
  console.log(`  Tools: ${config.launchers.default_tools.join(", ")}`);
  console.log(`  Max parallel: ${config.launchers.max_parallel}`);
  console.log("");
  console.log("Polling for PR review requests... (Ctrl+C to stop)");

  // The actual pipeline is wired in commit 13
}
