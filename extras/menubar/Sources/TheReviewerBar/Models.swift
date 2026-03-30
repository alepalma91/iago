import Foundation

struct PRReview {
    let id: Int
    let prNumber: Int
    let repo: String
    let title: String?
    let status: String
    let url: String
    let openedAt: String?

    var shortRepo: String {
        repo.split(separator: "/").last.map(String.init) ?? repo
    }

    var shortTitle: String {
        guard let title else { return "" }
        if title.count <= 40 { return title }
        return String(title.prefix(37)) + "..."
    }

    var sfSymbolName: String {
        switch status {
        case "detected":           return "eye"
        case "notified":           return "bell"
        case "accepted":           return "checkmark"
        case "cloning":            return "arrow.down.circle"
        case "reviewing":          return "magnifyingglass"
        case "running_tools":      return "hammer"
        case "done":               return "checkmark.circle"
        case "changes_requested":  return "arrow.triangle.2.circlepath"
        case "updated":            return "arrow.up.circle"
        case "error":              return "exclamationmark.triangle"
        case "dismissed":          return "xmark.circle"
        default:                   return "questionmark.circle"
        }
    }

    var menuLabel: String {
        let pr = "\(shortRepo)#\(prNumber)"
        if shortTitle.isEmpty { return pr }
        return "\(pr)  \(shortTitle)"
    }

    /// Whether this PR can be reviewed (or re-reviewed/retried)
    var canReview: Bool {
        switch status {
        case "detected", "notified", "dismissed", "done", "error", "changes_requested", "updated":
            return true
        default:
            return false
        }
    }

    /// Label for the review action button
    var reviewActionLabel: String {
        switch status {
        case "done", "changes_requested":  return "Re-launch Review"
        case "updated":                    return "Re-review"
        case "error":                      return "Retry"
        default:                           return "Launch Review"
        }
    }

    /// SF Symbol for the review action button
    var reviewActionSymbol: String {
        switch status {
        case "done", "error", "changes_requested", "updated": return "arrow.counterclockwise"
        default:                                               return "play.fill"
        }
    }

    /// Whether this PR can be dismissed/ignored
    var canDismiss: Bool {
        switch status {
        case "reviewing", "cloning", "accepted", "dismissed":
            return false
        default:
            return true
        }
    }

    /// Whether this PR is currently in progress
    var isInProgress: Bool {
        switch status {
        case "reviewing", "cloning", "accepted":
            return true
        default:
            return false
        }
    }
}

struct BadgeCounts {
    let errorCount: Int
    let actionCount: Int
    let reviewingCount: Int
    let doneUnopenedCount: Int
}
