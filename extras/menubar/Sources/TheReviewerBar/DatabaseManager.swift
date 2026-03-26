import Foundation
import SQLite3

final class DatabaseManager {
    private let dbPath: String

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        dbPath = "\(home)/.local/share/the-reviewer/the-reviewer.db"
    }

    var databaseExists: Bool {
        FileManager.default.fileExists(atPath: dbPath)
    }

    // MARK: - Setup

    func ensureOpenedAtColumn() {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            return
        }
        defer { sqlite3_close(db) }

        // Check if opened_at column exists
        let pragmaSql = "PRAGMA table_info(pr_reviews)"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, pragmaSql, -1, &stmt, nil) == SQLITE_OK else {
            return
        }
        defer { sqlite3_finalize(stmt) }

        var hasColumn = false
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let name = sqlite3_column_text(stmt, 1) {
                if String(cString: name) == "opened_at" {
                    hasColumn = true
                    break
                }
            }
        }

        if !hasColumn {
            sqlite3_exec(db, "ALTER TABLE pr_reviews ADD COLUMN opened_at TEXT", nil, nil, nil)
        }
    }

    // MARK: - Queries

    func fetchRecentPRs() -> [PRReview] {
        let sql = """
            SELECT id, pr_number, repo, title, status, url, opened_at
            FROM pr_reviews
            WHERE status != 'dismissed'
              AND updated_at >= datetime('now', '-24 hours')
            ORDER BY updated_at DESC
            LIMIT 8
            """
        return query(sql)
    }

    func fetchBadgeCounts() -> BadgeCounts {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            return BadgeCounts(errorCount: 0, actionCount: 0, reviewingCount: 0, doneUnopenedCount: 0)
        }
        defer { sqlite3_close(db) }

        func countQuery(_ sql: String) -> Int {
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
            defer { sqlite3_finalize(stmt) }
            if sqlite3_step(stmt) == SQLITE_ROW {
                return Int(sqlite3_column_int(stmt, 0))
            }
            return 0
        }

        let errorCount = countQuery("""
            SELECT COUNT(*) FROM pr_reviews
            WHERE status = 'error'
              AND updated_at >= datetime('now', '-24 hours')
            """)

        let actionCount = countQuery("""
            SELECT COUNT(*) FROM pr_reviews
            WHERE status IN ('detected', 'notified')
              AND updated_at >= datetime('now', '-24 hours')
            """)

        let reviewingCount = countQuery("""
            SELECT COUNT(*) FROM pr_reviews
            WHERE status IN ('accepted', 'cloning', 'reviewing')
            """)

        let doneUnopenedCount = countQuery("""
            SELECT COUNT(*) FROM pr_reviews
            WHERE status = 'done'
              AND opened_at IS NULL
              AND updated_at >= datetime('now', '-24 hours')
            """)

        return BadgeCounts(
            errorCount: errorCount,
            actionCount: actionCount,
            reviewingCount: reviewingCount,
            doneUnopenedCount: doneUnopenedCount
        )
    }

    // MARK: - Actions

    func dismissPR(id: Int) {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            return
        }
        defer { sqlite3_close(db) }

        let sql = "UPDATE pr_reviews SET status='dismissed', updated_at=datetime('now') WHERE id=?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            return
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(id))
        sqlite3_step(stmt)
    }

    func markOpened(id: Int) {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            return
        }
        defer { sqlite3_close(db) }

        let sql = "UPDATE pr_reviews SET opened_at=datetime('now') WHERE id=? AND status='done'"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            return
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(id))
        sqlite3_step(stmt)
    }

    // MARK: - Private

    private func query(_ sql: String) -> [PRReview] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_close(db) }

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_finalize(stmt) }

        var results: [PRReview] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = Int(sqlite3_column_int(stmt, 0))
            let prNumber = Int(sqlite3_column_int(stmt, 1))
            let repo = String(cString: sqlite3_column_text(stmt, 2))
            let title: String? = sqlite3_column_text(stmt, 3).map { String(cString: $0) }
            let status = String(cString: sqlite3_column_text(stmt, 4))
            let url = String(cString: sqlite3_column_text(stmt, 5))
            let openedAt: String? = sqlite3_column_text(stmt, 6).map { String(cString: $0) }
            results.append(PRReview(
                id: id, prNumber: prNumber, repo: repo,
                title: title, status: status, url: url,
                openedAt: openedAt
            ))
        }
        return results
    }
}
