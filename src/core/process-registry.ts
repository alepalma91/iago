import type { Subprocess } from "bun";

export interface ProcessEntry {
  pid: number;
  sessionId: string;
  proc: Subprocess;
  startedAt: number;
}

const registry = new Map<number, ProcessEntry>();

export function registerProcess(prId: number, entry: ProcessEntry): void {
  registry.set(prId, entry);
}

export function unregisterProcess(prId: number): void {
  registry.delete(prId);
}

export function getProcess(prId: number): ProcessEntry | undefined {
  return registry.get(prId);
}

export function killProcess(prId: number): boolean {
  const entry = registry.get(prId);
  if (!entry) return false;
  try {
    entry.proc.kill();
    registry.delete(prId);
    return true;
  } catch {
    registry.delete(prId);
    return false;
  }
}

export function getAllProcesses(): Map<number, ProcessEntry> {
  return registry;
}
