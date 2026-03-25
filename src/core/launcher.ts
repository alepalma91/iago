import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import type { LauncherProfile } from "../types/index.js";

export interface LaunchResult {
  toolName: string;
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export function interpolateArgs(args: string[], variables: Record<string, string>): string[] {
  return args.map((arg) =>
    arg.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`)
  );
}

export function parseTimeout(timeout: string): number {
  const match = timeout.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) return 300_000; // default 5m

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 300_000;
  }
}

export async function launchTool(
  profile: LauncherProfile,
  variables: Record<string, string>,
  cwd: string
): Promise<LaunchResult> {
  const args = interpolateArgs(profile.args, variables);
  const timeoutMs = parseTimeout(profile.timeout);

  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (profile.env) {
    Object.assign(env, profile.env);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = performance.now();
  let timedOut = false;

  try {
    const proc = Bun.spawn([profile.command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env,
    });

    // Race between process completion and timeout
    const outputPromise = new Response(proc.stdout).text();
    const exitPromise = proc.exited;

    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs)
    );

    const race = await Promise.race([
      exitPromise.then(() => "done" as const),
      timeoutPromise,
    ]);

    if (race === "timeout") {
      proc.kill();
      const durationMs = Math.round(performance.now() - start);
      return {
        toolName: profile.display_name || profile.command,
        output: "",
        exitCode: -1,
        durationMs,
        timedOut: true,
      };
    }

    const output = await outputPromise;
    const exitCode = await exitPromise;
    const durationMs = Math.round(performance.now() - start);

    return {
      toolName: profile.display_name || profile.command,
      output: output.trim(),
      exitCode,
      durationMs,
      timedOut: false,
    };
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - start);

    return {
      toolName: profile.display_name || profile.command,
      output: err.message ?? "",
      exitCode: -1,
      durationMs,
      timedOut: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function launchAllTools(
  profiles: LauncherProfile[],
  variables: Record<string, string>,
  cwd: string,
  maxParallel: number = 3
): Promise<LaunchResult[]> {
  const results: LaunchResult[] = [];

  // Process in batches to respect maxParallel
  for (let i = 0; i < profiles.length; i += maxParallel) {
    const batch = profiles.slice(i, i + maxParallel);
    const batchResults = await Promise.allSettled(
      batch.map((profile) => launchTool(profile, variables, cwd))
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          toolName: "unknown",
          output: result.reason?.message ?? "Unknown error",
          exitCode: -1,
          durationMs: 0,
          timedOut: false,
        });
      }
    }
  }

  return results;
}

export function writeOutput(outputDir: string, toolName: string, output: string): string {
  mkdirSync(outputDir, { recursive: true });
  const safeName = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const filePath = join(outputDir, `${safeName}.md`);
  writeFileSync(filePath, output, "utf-8");
  return filePath;
}
