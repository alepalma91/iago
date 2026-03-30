import AppKit

enum BadgeColor {
    case red
    case orangeAction
    case orangeReviewing
    case green

    var color: NSColor {
        switch self {
        case .red:              return NSColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1.0) // #ef4444
        case .orangeAction:     return NSColor(red: 0.98, green: 0.65, blue: 0.10, alpha: 1.0) // #f9a61a
        case .orangeReviewing:  return NSColor(red: 0.98, green: 0.58, blue: 0.10, alpha: 1.0) // #f97316
        case .green:            return NSColor(red: 0.13, green: 0.77, blue: 0.37, alpha: 1.0) // #22c55e
        }
    }
}

final class StatusBarController: NSObject {
    private var statusItem: NSStatusItem!
    private let db = DatabaseManager()
    private var refreshTimer: Timer?
    private var appearanceObserver: NSObjectProtocol?
    private var activeProcesses: Set<Process> = []

    func setup() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        // Ensure opened_at column exists
        if db.databaseExists {
            db.ensureOpenedAtColumn()
        }

        refresh()

        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.refresh()
        }

        // Listen for dark/light mode changes
        appearanceObserver = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("AppleInterfaceThemeChangedNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.refresh()
        }
    }

    deinit {
        if let observer = appearanceObserver {
            DistributedNotificationCenter.default().removeObserver(observer)
        }
    }

    // MARK: - Menu Building

    @objc private func refresh() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        guard db.databaseExists else {
            let item = NSMenuItem(title: "No database found", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            appendFooter(to: menu)
            statusItem.menu = menu
            updateIcon(with: BadgeCounts(errorCount: 0, actionCount: 0, reviewingCount: 0, doneUnopenedCount: 0))
            return
        }

        let pending = db.fetchPendingPRs()
        let recent = db.fetchRecentCompletedPRs()
        let counts = db.fetchBadgeCounts()

        // Section 1: To Review
        let headerPending = NSMenuItem(title: "To Review", action: nil, keyEquivalent: "")
        headerPending.isEnabled = false
        let pendingAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        headerPending.attributedTitle = NSAttributedString(string: "TO REVIEW", attributes: pendingAttrs)
        menu.addItem(headerPending)

        if pending.isEmpty {
            let emptyItem = NSMenuItem(title: "No pending reviews", action: nil, keyEquivalent: "")
            emptyItem.isEnabled = false
            menu.addItem(emptyItem)
        } else {
            for pr in pending {
                menu.addItem(makeMenuItem(for: pr))
            }
        }

        menu.addItem(.separator())

        // Section 2: Recent
        let headerRecent = NSMenuItem(title: "Recent", action: nil, keyEquivalent: "")
        headerRecent.isEnabled = false
        let recentAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        headerRecent.attributedTitle = NSAttributedString(string: "RECENT", attributes: recentAttrs)
        menu.addItem(headerRecent)

        if recent.isEmpty {
            let emptyItem = NSMenuItem(title: "No recent reviews", action: nil, keyEquivalent: "")
            emptyItem.isEnabled = false
            menu.addItem(emptyItem)
        } else {
            for pr in recent {
                menu.addItem(makeMenuItem(for: pr))
            }
        }

        // Always show "More..." for easy dashboard access
        menu.addItem(.separator())
        let moreItem = NSMenuItem(title: "More\u{2026}", action: #selector(openDashboard), keyEquivalent: "")
        moreItem.target = self
        if let globe = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: "More") {
            moreItem.image = globe
        }
        menu.addItem(moreItem)

        menu.addItem(.separator())
        appendFooter(to: menu)

        statusItem.menu = menu
        updateIcon(with: counts)
    }

    private func makeMenuItem(for pr: PRReview) -> NSMenuItem {
        // Parent item — shows PR info with status icon
        let item = NSMenuItem(title: pr.menuLabel, action: nil, keyEquivalent: "")
        if let symbol = NSImage(systemSymbolName: pr.sfSymbolName, accessibilityDescription: pr.status) {
            item.image = symbol
        }

        // Submenu with actions
        let submenu = NSMenu()

        // Open in GitHub (always)
        let openItem = NSMenuItem(title: "Open in GitHub", action: #selector(openPR(_:)), keyEquivalent: "")
        openItem.target = self
        openItem.representedObject = ["url": pr.url, "id": pr.id] as [String: Any]
        if let safari = NSImage(systemSymbolName: "safari", accessibilityDescription: "Open") {
            openItem.image = safari
        }
        submenu.addItem(openItem)

        // Launch Review / Re-launch Review / Retry (status-dependent)
        if pr.canReview {
            let reviewItem = NSMenuItem(title: pr.reviewActionLabel, action: #selector(triggerReview(_:)), keyEquivalent: "")
            reviewItem.target = self
            reviewItem.representedObject = ["url": pr.url, "id": pr.id] as [String: Any]
            if let sym = NSImage(systemSymbolName: pr.reviewActionSymbol, accessibilityDescription: pr.reviewActionLabel) {
                reviewItem.image = sym
            }
            submenu.addItem(reviewItem)
        } else if pr.isInProgress {
            let progressItem = NSMenuItem(title: "In progress\u{2026}", action: nil, keyEquivalent: "")
            progressItem.isEnabled = false
            submenu.addItem(progressItem)
        }

        // Ignore / Dismiss
        if pr.canDismiss {
            let dismissItem = NSMenuItem(title: "Ignore", action: #selector(dismissPR(_:)), keyEquivalent: "")
            dismissItem.target = self
            dismissItem.representedObject = pr.id
            if let sym = NSImage(systemSymbolName: "xmark.circle", accessibilityDescription: "Ignore") {
                dismissItem.image = sym
            }
            submenu.addItem(dismissItem)
        }

        item.submenu = submenu
        return item
    }

    // MARK: - PR Actions

    @objc private func openPR(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: Any],
              let urlString = info["url"] as? String,
              let url = URL(string: urlString) else { return }

        // Mark done PRs as opened
        if let prId = info["id"] as? Int {
            db.markOpened(id: prId)
        }

        NSWorkspace.shared.open(url)
        refresh()
    }

    @objc private func triggerReview(_ sender: NSMenuItem) {
        debugLog("triggerReview called, representedObject type: \(type(of: sender.representedObject as Any))")

        guard let info = sender.representedObject as? [String: Any] else {
            debugLog("  FAILED: representedObject is not [String: Any]")
            return
        }
        guard let prUrl = info["url"] as? String else {
            debugLog("  FAILED: no 'url' key in info dict")
            return
        }

        debugLog("  url=\(prUrl), id=\(String(describing: info["id"]))")

        // Immediately update status to "accepted" so badge changes
        if let prId = info["id"] as? Int {
            db.updateStatus(id: prId, status: "accepted")
        }

        refresh()
        launchReview(url: prUrl)
    }

    private func debugLog(_ msg: String) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let logPath = "\(home)/.local/share/the-reviewer/menubar-debug.log"
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(timestamp)] \(msg)\n"
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: line.data(using: .utf8))
        } else if let handle = FileHandle(forWritingAtPath: logPath) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8) ?? Data())
            handle.closeFile()
        }
    }

    @objc private func dismissPR(_ sender: NSMenuItem) {
        guard let prId = sender.representedObject as? Int else { return }
        db.dismissPR(id: prId)
        refresh()
    }

    private func launchReview(url: String) {
        // Resolve CLI directory: try known locations
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/Documents/AI/the-reviwer",
            "\(home)/the-reviewer",
            "\(home)/src/the-reviewer",
        ]
        var cliDir: String?
        for dir in candidates {
            if FileManager.default.fileExists(atPath: "\(dir)/src/index.ts") {
                cliDir = dir
                break
            }
        }

        let bunPath = "\(home)/.bun/bin/bun"
        guard let cliDir, FileManager.default.fileExists(atPath: bunPath) else {
            // Fallback: open dashboard
            if let dashUrl = URL(string: "http://localhost:1460") {
                NSWorkspace.shared.open(dashUrl)
            }
            return
        }

        // Log file for debugging
        let logDir = "\(home)/.local/share/the-reviewer"
        let logPath = "\(logDir)/menubar-review.log"
        let logHandle: FileHandle
        if FileManager.default.fileExists(atPath: logPath) {
            logHandle = FileHandle(forWritingAtPath: logPath) ?? FileHandle.nullDevice
            logHandle.seekToEndOfFile()
        } else {
            FileManager.default.createFile(atPath: logPath, contents: nil)
            logHandle = FileHandle(forWritingAtPath: logPath) ?? FileHandle.nullDevice
        }

        // Write header
        let timestamp = ISO8601DateFormatter().string(from: Date())
        logHandle.write("[\(timestamp)] Launching review: \(url)\n".data(using: .utf8) ?? Data())

        let task = Process()
        task.executableURL = URL(fileURLWithPath: bunPath)
        task.currentDirectoryURL = URL(fileURLWithPath: cliDir)
        task.arguments = ["run", "src/index.ts", "review", url, "--force"]
        // Inherit full environment (needed for macOS Keychain access / Claude OAuth)
        // and ensure bun/homebrew are in PATH
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(env["PATH"] ?? "")"
        env["HOME"] = home
        task.environment = env
        task.standardOutput = logHandle
        task.standardError = logHandle

        // Keep process alive and refresh on completion
        activeProcesses.insert(task)
        task.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                self?.activeProcesses.remove(proc)
                self?.refresh()
            }
        }

        do {
            try task.run()
        } catch {
            logHandle.write("  ERROR: \(error.localizedDescription)\n".data(using: .utf8) ?? Data())
            activeProcesses.remove(task)
        }

        // Schedule periodic refreshes to show status changes during review
        for delay in [3.0, 8.0, 15.0, 30.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.refresh()
            }
        }
    }

    @objc private func openDashboard() {
        if let url = URL(string: "http://localhost:1460") {
            NSWorkspace.shared.open(url)
        }
    }

    private func appendFooter(to menu: NSMenu) {
        let dashboard = NSMenuItem(title: "Dashboard", action: #selector(openDashboard), keyEquivalent: "d")
        dashboard.target = self
        if let globe = NSImage(systemSymbolName: "globe", accessibilityDescription: "Dashboard") {
            dashboard.image = globe
        }
        menu.addItem(dashboard)

        let refreshItem = NSMenuItem(title: "Refresh", action: #selector(refresh), keyEquivalent: "r")
        refreshItem.target = self
        if let arrow = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Refresh") {
            refreshItem.image = arrow
        }
        menu.addItem(refreshItem)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    // MARK: - Badge Icon

    private func updateIcon(with counts: BadgeCounts) {
        let baseIcon = loadIcon()
        baseIcon.size = NSSize(width: 18, height: 18)

        // Determine badge based on priority
        if counts.errorCount > 0 {
            statusItem.button?.image = compositeIcon(base: baseIcon, badge: .red, count: counts.errorCount)
        } else if counts.actionCount > 0 {
            statusItem.button?.image = compositeIcon(base: baseIcon, badge: .orangeAction, count: counts.actionCount)
        } else if counts.reviewingCount > 0 {
            statusItem.button?.image = compositeIcon(base: baseIcon, badge: .orangeReviewing, count: counts.reviewingCount)
        } else if counts.doneUnopenedCount > 0 {
            statusItem.button?.image = compositeIcon(base: baseIcon, badge: .green, count: counts.doneUnopenedCount)
        } else {
            baseIcon.isTemplate = true
            statusItem.button?.image = baseIcon
        }
        statusItem.button?.title = ""
    }

    private func compositeIcon(base: NSImage, badge: BadgeColor, count: Int) -> NSImage {
        let size = NSSize(width: 22, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            // Tint base icon for appearance
            let isDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let tintColor = isDark ? NSColor.white : NSColor.black

            // Draw tinted parrot
            let parrotRect = NSRect(x: 0, y: 0, width: 18, height: 18)
            base.draw(in: parrotRect)

            // Draw tint overlay
            tintColor.withAlphaComponent(0.85).setFill()
            parrotRect.fill(using: .sourceAtop)

            // Badge circle (top-right)
            let badgeSize: CGFloat = 12
            let badgeX = rect.width - badgeSize
            let badgeY = rect.height - badgeSize
            let badgeRect = NSRect(x: badgeX, y: badgeY, width: badgeSize, height: badgeSize)

            badge.color.setFill()
            let path = NSBezierPath(ovalIn: badgeRect)
            path.fill()

            // Count text
            let countStr = count > 9 ? "9+" : "\(count)"
            let font = NSFont.systemFont(ofSize: 8, weight: .bold)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: NSColor.white,
            ]
            let textSize = (countStr as NSString).size(withAttributes: attrs)
            let textX = badgeRect.midX - textSize.width / 2
            let textY = badgeRect.midY - textSize.height / 2
            (countStr as NSString).draw(at: NSPoint(x: textX, y: textY), withAttributes: attrs)

            return true
        }
        image.isTemplate = false
        return image
    }

    // MARK: - Icon Loading

    private func loadIcon() -> NSImage {
        // Embedded parrot SVG (from parrot.svg in repo root)
        let svg = "<svg enable-background=\"new 0 0 511.834 511.834\" height=\"512\" viewBox=\"0 0 511.834 511.834\" width=\"512\" xmlns=\"http://www.w3.org/2000/svg\"><g><path d=\"m139.81 116.107c-34.41 0-62.404 27.995-62.404 62.405s27.994 62.405 62.404 62.405 62.405-27.995 62.405-62.405-27.995-62.405-62.405-62.405zm15.564 77.405h-31.128v-30h31.128z\"/><path d=\"m279.619 348.322v-169.81c0-77.091-62.719-139.81-139.81-139.81s-139.809 62.719-139.809 139.81v294.619h156.905c67.665 0 122.714-55.049 122.714-122.714zm-139.809-77.405c-50.952 0-92.404-41.453-92.404-92.405s41.452-92.405 92.404-92.405 92.405 41.453 92.405 92.405-41.453 92.405-92.405 92.405z\"/><path d=\"m309.619 193.515v124.008c65.133-6.98 117.019-58.875 124-124.008z\"/><path d=\"m511.834 178.512c0-77.091-62.719-139.81-139.81-139.81h-135.955c40.522 27.986 68.334 73.109 72.88 124.813h140.479c23.323-.001 45.327 8.581 62.405 24.251v-9.254z\"/></g></svg>"
        if let data = svg.data(using: .utf8), let img = NSImage(data: data) {
            return img
        }
        return NSImage(systemSymbolName: "bird", accessibilityDescription: "The Reviewer") ?? NSImage()
    }
}
