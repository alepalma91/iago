import { existsSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export async function uninstallCommand(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const keepData = args.includes("--keep-data");
  const force = args.includes("--force") || args.includes("-f");

  const home = homedir();
  const binDir = process.env.IAGO_BIN ?? join(home, "bin");
  const dataDir = process.env.IAGO_DATA ?? join(home, ".local/share/iago");
  const configDir = join(home, ".config/iago");

  const targets = [
    { path: join(binDir, "iago"), label: "CLI binary", always: true },
    { path: join(binDir, "iago-bar"), label: "Menu bar binary", always: true },
    { path: configDir, label: "Config directory", always: !keepData },
    { path: dataDir, label: "Data directory (DB, worktrees)", always: !keepData },
    { path: join(dataDir, "src"), label: "Source checkout", always: true },
  ];

  // Check for running daemon
  try {
    const pidFile = join(dataDir, "iago.pid");
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (pid && isProcessRunning(pid)) {
        if (!force) {
          console.error("iago daemon is still running (PID %d). Stop it first:", pid);
          console.error("  iago stop");
          console.error("  # or: iago uninstall --force");
          process.exit(1);
        }
        console.log(`Stopping daemon (PID ${pid})...`);
        process.kill(pid, "SIGTERM");
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch {}

  // Check for launchd menubar
  const plistPath = join(home, "Library/LaunchAgents/com.iago.menubar.plist");
  if (existsSync(plistPath)) {
    targets.push({ path: plistPath, label: "LaunchAgent plist", always: true });
  }

  console.log(dryRun ? "Dry run — would remove:" : "Uninstalling iago...");
  console.log("");

  for (const t of targets) {
    if (!t.always) continue;
    if (!existsSync(t.path)) {
      console.log(`  [skip] ${t.label} — not found (${t.path})`);
      continue;
    }
    if (dryRun) {
      console.log(`  [remove] ${t.label} — ${t.path}`);
    } else {
      try {
        rmSync(t.path, { recursive: true, force: true });
        console.log(`  [removed] ${t.label} — ${t.path}`);
      } catch (err: any) {
        console.error(`  [error] ${t.label} — ${err.message}`);
      }
    }
  }

  if (keepData) {
    console.log("");
    console.log(`  Kept: ${configDir}`);
    console.log(`  Kept: ${dataDir}`);
  }

  // Unload launchd agent if present
  if (existsSync(plistPath) || !dryRun) {
    try {
      Bun.spawnSync(["launchctl", "unload", plistPath], { stdout: "ignore", stderr: "ignore" });
    } catch {}
  }

  // Clean PATH from shell profile
  const shellName = process.env.SHELL?.split("/").pop() ?? "zsh";
  const profile = shellName === "bash" ? join(home, ".bashrc")
    : shellName === "fish" ? join(home, ".config/fish/config.fish")
    : join(home, ".zshrc");

  if (existsSync(profile)) {
    try {
      const content = readFileSync(profile, "utf-8");
      const lines = content.split("\n");
      const filtered = lines.filter(l => !l.includes("# iago") && !l.includes(binDir + ":"));
      if (filtered.length !== lines.length) {
        if (dryRun) {
          console.log(`\n  [clean] Would remove PATH entry from ${profile}`);
        } else {
          writeFileSync(profile, filtered.join("\n"));
          console.log(`\n  [cleaned] Removed PATH entry from ${profile}`);
        }
      }
    } catch {}
  }

  if (!dryRun) {
    console.log("\niago uninstalled.");
    if (!keepData) {
      console.log("All data and config removed.");
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
