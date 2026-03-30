import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig, resolveHome } from "../core/config.js";
import { stringify as stringifyYAML } from "yaml";

const CONFIG_DIR = join(homedir(), ".config", "iago");
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");
const PROMPTS_DIR = join(CONFIG_DIR, "prompts");

const DEFAULT_CONFIG_YAML = `# iago configuration
# See: https://github.com/alepalma91/iago

github:
  # poll_interval: "60s"
  # trigger_reasons:
  #   - review_requested
  # watched_repos: []      # empty = all repos
  # ignored_repos: []

sandbox:
  # strategy: worktree
  # base_dir: ~/.local/share/iago
  # ttl: "24h"

launchers:
  # max_parallel: 3
  default_tools:
    - claude
  # tools:
  #   claude:
  #     display_name: "Claude Code"
  #     command: claude
  #     args: ["-p", "{{prompt}}", "--output-format", "text"]
  #     stdin_mode: none
  #     output_mode: stdout
  #     timeout: "5m"
  #     enabled: true

prompts:
  # system_prompt: ~/.config/iago/prompts/system.md
  # instructions: ~/.config/iago/prompts/instructions.md
  # default_techniques: []
  # techniques:
  #   security:
  #     description: "Security-focused review"
  #     prompt_file: ~/.config/iago/prompts/security.md

notifications:
  native: true
  # on_new_pr: true
  # on_review_complete: true
  # sound: default

dashboard:
  # enabled: true
  # port: 3847
`;

const DEFAULT_SYSTEM_PROMPT = `You are an expert code reviewer. You review pull requests for correctness, security, performance, and maintainability. You provide actionable feedback with specific line references. You are concise and prioritize the most impactful issues.`;

const DEFAULT_INSTRUCTIONS = `Review the following pull request diff. For each issue found:
1. State the severity: CRITICAL, WARNING, or SUGGESTION
2. Reference the specific file and line(s)
3. Explain the issue clearly
4. Suggest a concrete fix

Focus on:
- Bugs and logic errors
- Security vulnerabilities
- Performance regressions
- API contract violations
- Missing error handling`;

export async function configCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "init":
      await configInit();
      break;
    case "validate":
      await configValidate();
      break;
    case "show":
      await configShow();
      break;
    default:
      if (subcommand) {
        console.error(`Unknown config subcommand: ${subcommand}`);
      }
      console.log(`Usage:
  iago config init       Create default config files
  iago config validate   Check config for errors
  iago config show       Print resolved config`);
      if (subcommand) process.exit(1);
      break;
  }
}

async function configInit(): Promise<void> {
  console.log("Initializing config...\n");

  // Create directories
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(PROMPTS_DIR, { recursive: true });

  // Write config.yaml
  writeIfNotExists(CONFIG_PATH, DEFAULT_CONFIG_YAML, "config.yaml");

  // Write default prompts
  writeIfNotExists(
    join(PROMPTS_DIR, "default-system.md"),
    DEFAULT_SYSTEM_PROMPT,
    "prompts/default-system.md"
  );
  writeIfNotExists(
    join(PROMPTS_DIR, "default-instructions.md"),
    DEFAULT_INSTRUCTIONS,
    "prompts/default-instructions.md"
  );

  console.log(`\nDone! Edit ${CONFIG_PATH} to customize.`);
}

function writeIfNotExists(path: string, content: string, label: string): void {
  if (existsSync(path)) {
    console.log(`  skip: ${label} (already exists)`);
  } else {
    writeFileSync(path, content, "utf-8");
    console.log(`  created: ${label}`);
  }
}

export async function configValidate(): Promise<void> {
  const config = loadConfig();
  let warnings = 0;

  console.log("Validating config...\n");

  // Check prompt files
  if (config.prompts.system_prompt) {
    const resolved = resolveHome(config.prompts.system_prompt);
    if (!existsSync(resolved)) {
      console.log(`  WARNING: system_prompt not found: ${resolved}`);
      warnings++;
    } else {
      console.log(`  OK: system_prompt: ${resolved}`);
    }
  }

  if (config.prompts.instructions) {
    const resolved = resolveHome(config.prompts.instructions);
    if (!existsSync(resolved)) {
      console.log(`  WARNING: instructions not found: ${resolved}`);
      warnings++;
    } else {
      console.log(`  OK: instructions: ${resolved}`);
    }
  }

  // Check technique prompt files
  for (const [name, technique] of Object.entries(config.prompts.techniques)) {
    const resolved = resolveHome(technique.prompt_file);
    if (!existsSync(resolved)) {
      console.log(`  WARNING: technique "${name}" prompt not found: ${resolved}`);
      warnings++;
    } else {
      console.log(`  OK: technique "${name}": ${resolved}`);
    }
  }

  // Check launcher commands exist
  for (const [name, tool] of Object.entries(config.launchers.tools)) {
    if (!tool.enabled) continue;
    const found = await commandExists(tool.command);
    if (!found) {
      console.log(`  WARNING: tool "${name}" command not found: ${tool.command}`);
      warnings++;
    } else {
      console.log(`  OK: tool "${name}": ${tool.command}`);
    }
  }

  console.log(
    warnings === 0
      ? "\nConfig is valid."
      : `\n${warnings} warning(s) found.`
  );
}

async function configShow(): Promise<void> {
  const config = loadConfig();
  console.log(stringifyYAML(config));
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}
