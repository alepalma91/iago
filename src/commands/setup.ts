import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { getConfigDir, getDataDir, DEFAULT_CONFIG } from "../core/config.js";
import { stringify as stringifyYAML } from "yaml";

const LAUNCH_DIR = join(homedir(), "Library", "LaunchAgents");
const DAEMON_LABEL = "com.iago.daemon";
const MENUBAR_LABEL = "com.iago.menubar";

interface SetupAnswers {
  configDir: string;
  pollInterval: string;
  watchedRepos: string[];
  autoReview: boolean;
  dashboardPort: number;
  installLaunchd: boolean;
  installMenubar: boolean;
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function ghAuthOk(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["gh", "auth", "status"], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

export async function setupCommand(_args: string[]): Promise<void> {
  console.log("\n  iago setup\n");

  // ── Dependency checks ──────────────────────────────────────
  console.log("  Checking dependencies...");

  const hasGh = await commandExists("gh");
  const hasClaude = await commandExists("claude");
  const hasGhAuth = hasGh ? await ghAuthOk() : false;

  console.log(`    ${hasGh ? "+" : "x"} gh (GitHub CLI)`);
  console.log(`    ${hasClaude ? "+" : "x"} claude (Claude Code)`);
  if (hasGh) {
    console.log(`    ${hasGhAuth ? "+" : "x"} gh auth`);
  }

  if (!hasGh) {
    console.error("\n  gh is required. Install it: brew install gh");
    process.exit(1);
  }
  if (!hasGhAuth) {
    console.error("\n  gh is not authenticated. Run: gh auth login");
    process.exit(1);
  }
  if (!hasClaude) {
    console.error("\n  claude is required. Install Claude Code: https://docs.anthropic.com/en/docs/claude-code");
    process.exit(1);
  }

  console.log("");

  // ── Gather answers (interactive or defaults) ───────────────
  let answers: SetupAnswers;

  if (isInteractive()) {
    answers = await interactivePrompt();
  } else {
    console.log("  Non-interactive mode: using defaults.\n");
    answers = defaultAnswers();
  }

  // ── Write config ───────────────────────────────────────────
  const configDir = answers.configDir;
  const configPath = join(configDir, "config.yaml");
  const promptsDir = join(configDir, "prompts");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(promptsDir, { recursive: true });

  if (existsSync(configPath)) {
    console.log(`  Config already exists at ${configPath} — skipping.`);
  } else {
    const config = buildConfigYaml(answers);
    writeFileSync(configPath, config, "utf-8");
    console.log(`  Writing config... done`);
  }

  // Write default prompt files
  writeIfNotExists(
    join(promptsDir, "default-system.md"),
    "You are an expert code reviewer. You review pull requests for correctness, security, performance, and maintainability. You provide actionable feedback with specific line references. You are concise and prioritize the most impactful issues."
  );
  writeIfNotExists(
    join(promptsDir, "default-instructions.md"),
    `Review the following pull request diff. For each issue found:
1. State the severity: CRITICAL, WARNING, or SUGGESTION
2. Reference the specific file and line(s)
3. Explain the issue clearly
4. Suggest a concrete fix

Focus on:
- Bugs and logic errors
- Security vulnerabilities
- Performance regressions
- API contract violations
- Missing error handling`
  );

  // ── Data directory ─────────────────────────────────────────
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });

  // ── LaunchAgent plists ─────────────────────────────────────
  if (answers.installLaunchd) {
    installLaunchdPlists(answers.installMenubar);
    console.log("  Installing LaunchAgents... done");
  }

  console.log(`
  Setup complete!

  Config:    ${configPath}
  Data:      ${dataDir}
  Dashboard: http://localhost:${answers.dashboardPort}

  Run 'iago start' or reboot to begin.
`);
}

async function interactivePrompt(): Promise<SetupAnswers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const defaultConfigDir = getConfigDir();
    const configDirInput = await prompt(rl, `  Config path [${defaultConfigDir}]: `);
    const configDir = configDirInput.trim() || defaultConfigDir;

    const pollInput = await prompt(rl, "  Poll interval [60s]: ");
    const pollInterval = pollInput.trim() || "60s";

    const reposInput = await prompt(rl, "  Watched repos (comma-sep, empty=all): ");
    const watchedRepos = reposInput.trim()
      ? reposInput.split(",").map((r) => r.trim()).filter(Boolean)
      : [];

    const autoInput = await prompt(rl, "  Auto-review all repos? [y/N]: ");
    const autoReview = autoInput.trim().toLowerCase() === "y";

    const portInput = await prompt(rl, "  Dashboard port [1460]: ");
    const dashboardPort = parseInt(portInput.trim(), 10) || 1460;

    const launchdInput = await prompt(rl, "  Start on login (launchd)? [Y/n]: ");
    const installLaunchd = launchdInput.trim().toLowerCase() !== "n";

    let installMenubar = false;
    if (installLaunchd) {
      const menubarBin = join(homedir(), "bin", "iago-bar");
      if (existsSync(menubarBin)) {
        const menubarInput = await prompt(rl, "  Start menu bar on login? [Y/n]: ");
        installMenubar = menubarInput.trim().toLowerCase() !== "n";
      }
    }

    console.log("");
    return { configDir, pollInterval, watchedRepos, autoReview, dashboardPort, installLaunchd, installMenubar };
  } finally {
    rl.close();
  }
}

function defaultAnswers(): SetupAnswers {
  return {
    configDir: getConfigDir(),
    pollInterval: "60s",
    watchedRepos: [],
    autoReview: false,
    dashboardPort: 1460,
    installLaunchd: false,
    installMenubar: false,
  };
}

function buildConfigYaml(answers: SetupAnswers): string {
  const config: Record<string, any> = {
    github: {
      poll_interval: answers.pollInterval,
      watched_repos: answers.watchedRepos,
      ignored_repos: [],
    },
    launchers: {
      max_parallel: 3,
      default_tools: ["claude"],
    },
    notifications: {
      native: true,
    },
    dashboard: {
      enabled: true,
      port: answers.dashboardPort,
    },
  };

  if (answers.autoReview) {
    config.repos = { "*": { auto_review: true } };
  }

  return `# iago configuration\n# See: https://github.com/alepalma91/iago\n\n${stringifyYAML(config)}`;
}

function writeIfNotExists(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content, "utf-8");
  }
}

function installLaunchdPlists(includeMenubar: boolean): void {
  mkdirSync(LAUNCH_DIR, { recursive: true });

  // Resolve paths for the daemon plist
  const iagoBin = resolveIagoBin();
  const home = homedir();
  const dataDir = getDataDir();

  mkdirSync(dataDir, { recursive: true });

  // Build daemon plist — for compiled binary, point directly at it
  const daemonPlist = buildDaemonPlist(iagoBin, home);
  writeFileSync(join(LAUNCH_DIR, `${DAEMON_LABEL}.plist`), daemonPlist, "utf-8");

  if (includeMenubar) {
    const menubarBin = join(home, "bin", "iago-bar");
    const menubarPlist = buildMenubarPlist(menubarBin, home);
    writeFileSync(join(LAUNCH_DIR, `${MENUBAR_LABEL}.plist`), menubarPlist, "utf-8");
  }
}

function resolveIagoBin(): string {
  // If we're running from a compiled binary, use our own executable path
  // process.execPath points to the binary itself for bun-compiled apps
  const execPath = process.execPath;
  // If running via bun, execPath is the bun binary — check argv[1]
  if (execPath.endsWith("/bun") || execPath.endsWith("/bun.exe")) {
    // Running from source: bun run src/index.ts
    return execPath; // Will need bun + source path
  }
  // Compiled binary: use the exec path directly
  return execPath;
}

function resolveIagoArgs(): string[] {
  const execPath = process.execPath;
  if (execPath.endsWith("/bun") || execPath.endsWith("/bun.exe")) {
    // Running from source
    const srcEntry = process.argv[1];
    return ["run", srcEntry!, "start"];
  }
  return ["start"];
}

function buildPath(): string {
  const dirs = new Set<string>();
  // Add common binary locations
  for (const cmd of ["gh", "claude", "bun"]) {
    try {
      const proc = Bun.spawnSync(["which", cmd], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode === 0) {
        const cmdPath = proc.stdout.toString().trim();
        if (cmdPath) {
          const dir = cmdPath.substring(0, cmdPath.lastIndexOf("/"));
          if (dir) dirs.add(dir);
        }
      }
    } catch {}
  }
  dirs.add("/usr/local/bin");
  dirs.add("/usr/bin");
  dirs.add("/bin");
  return Array.from(dirs).join(":");
}

function buildDaemonPlist(iagoBin: string, home: string): string {
  const args = resolveIagoArgs();
  const agentPath = buildPath();
  const workDir = iagoBin.endsWith("/bun") ? process.cwd() : join(home, ".local", "share", "iago");

  const programArgs = [iagoBin, ...args]
    .map((a) => `    <string>${a}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>

  <key>WorkingDirectory</key>
  <string>${workDir}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
    <key>PATH</key>
    <string>${agentPath}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>ProcessType</key>
  <string>Background</string>

  <key>StandardOutPath</key>
  <string>${home}/.local/share/iago/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/.local/share/iago/daemon.log</string>
</dict>
</plist>
`;
}

function buildMenubarPlist(menubarBin: string, home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MENUBAR_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${menubarBin}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}
