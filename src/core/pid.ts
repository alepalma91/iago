import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getDataDir } from "./config.js";

function getPidPath(): string {
  const dataDir = getDataDir();
  return join(dataDir, "daemon.pid");
}

export function writePidFile(pid?: number): void {
  const pidPath = getPidPath();
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, String(pid ?? process.pid), "utf-8");
}

export function readPidFile(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;

  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  const pidPath = getPidPath();
  try {
    unlinkSync(pidPath);
  } catch {
    // File may not exist
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
