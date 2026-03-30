import { readPidFile, removePidFile, isProcessRunning } from "../core/pid.js";

export async function stopCommand(): Promise<void> {
  const pid = readPidFile();

  if (!pid) {
    console.log("iago: no running daemon found");
    return;
  }

  if (!isProcessRunning(pid)) {
    console.log("iago: daemon not running (stale PID file), cleaning up");
    removePidFile();
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`iago: sent SIGTERM to daemon (PID ${pid})`);
    removePidFile();
  } catch (err: any) {
    console.error(`iago: failed to stop daemon: ${err.message}`);
  }
}
