import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { writePidFile, readPidFile, removePidFile, isProcessRunning } from "../../src/core/pid.js";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// Override data dir for testing by testing the low-level functions
// We'll test the path-building functions directly

describe("isProcessRunning", () => {
  it("should detect the current process as running", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("should return false for a non-existent process", () => {
    // Use a very high PID that's unlikely to exist
    expect(isProcessRunning(999999)).toBe(false);
  });
});

describe("PID file operations", () => {
  // These tests use the actual PID file path from getDataDir
  // We test write/read/remove cycle

  it("should write and read PID", () => {
    writePidFile(12345);
    const pid = readPidFile();
    expect(pid).toBe(12345);
    removePidFile();
  });

  it("should return null when PID file missing", () => {
    removePidFile(); // ensure clean state
    const pid = readPidFile();
    expect(pid).toBeNull();
  });

  it("should remove PID file", () => {
    writePidFile(12345);
    removePidFile();
    const pid = readPidFile();
    expect(pid).toBeNull();
  });

  it("should handle double remove gracefully", () => {
    removePidFile();
    expect(() => removePidFile()).not.toThrow();
  });
});
