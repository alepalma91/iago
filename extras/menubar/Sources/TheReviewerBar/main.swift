import AppKit
import Foundation

// ── Singleton: ensure only one instance runs ──
let home = FileManager.default.homeDirectoryForCurrentUser.path
let lockPath = "\(home)/.local/share/iago/iago-bar.lock"

// Ensure directory exists
try? FileManager.default.createDirectory(
    atPath: "\(home)/.local/share/iago",
    withIntermediateDirectories: true
)

let lockFd = open(lockPath, O_CREAT | O_RDWR, 0o644)
guard lockFd >= 0 else {
    fputs("iago-bar: failed to open lock file\n", stderr)
    exit(1)
}

var lock = flock()
lock.l_type = Int16(F_WRLCK)
lock.l_whence = Int16(SEEK_SET)
if fcntl(lockFd, F_SETLK, &lock) == -1 {
    // Another instance holds the lock — exit silently
    close(lockFd)
    exit(0)
}

// Write our PID to the lock file
let pidStr = "\(ProcessInfo.processInfo.processIdentifier)\n"
ftruncate(lockFd, 0)
write(lockFd, pidStr, pidStr.utf8.count)
// Keep lockFd open for the lifetime of the process (lock released on exit)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = StatusBarController()
controller.setup()

app.run()
