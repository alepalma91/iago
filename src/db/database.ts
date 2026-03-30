import { Database } from "bun:sqlite";

const CURRENT_SCHEMA_VERSION = 4;

export function createDatabase(path: string): Database {
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  migrate(db);

  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    )
  `);

  const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | null;

  const currentVersion = row?.version ?? 0;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pr_reviews (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_number     INTEGER NOT NULL,
        repo          TEXT NOT NULL,
        title         TEXT,
        author        TEXT,
        url           TEXT NOT NULL,
        branch        TEXT,
        base_branch   TEXT DEFAULT 'main',
        status        TEXT NOT NULL DEFAULT 'detected',
        tool_status   TEXT,
        worktree_path TEXT,
        created_at    TEXT DEFAULT (datetime('now')),
        updated_at    TEXT DEFAULT (datetime('now')),
        UNIQUE(repo, pr_number)
      );

      CREATE TABLE IF NOT EXISTS review_output (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_review_id  INTEGER REFERENCES pr_reviews(id),
        tool_name     TEXT NOT NULL,
        output        TEXT,
        exit_code     INTEGER,
        duration_ms   INTEGER,
        created_at    TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS review_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_review_id  INTEGER REFERENCES pr_reviews(id),
        event_type    TEXT NOT NULL,
        message       TEXT,
        created_at    TEXT DEFAULT (datetime('now'))
      );
    `);

    if (currentVersion === 0 && !row) {
      db.exec(`INSERT INTO schema_version (version) VALUES (1)`);
    } else {
      db.exec(`UPDATE schema_version SET version = 1`);
    }
  }

  if (currentVersion < 2) {
    db.exec(`ALTER TABLE pr_reviews ADD COLUMN opened_at TEXT`);
    db.exec(`UPDATE schema_version SET version = 2`);
  }

  if (currentVersion < 3) {
    db.exec(`ALTER TABLE pr_reviews ADD COLUMN github_state TEXT NOT NULL DEFAULT 'open'`);
    db.exec(`ALTER TABLE pr_reviews ADD COLUMN github_synced_at TEXT`);
    db.exec(`UPDATE schema_version SET version = 3`);
  }

  if (currentVersion < 4) {
    db.exec(`ALTER TABLE pr_reviews ADD COLUMN head_sha TEXT`);
    db.exec(`UPDATE schema_version SET version = 4`);
  }
}
