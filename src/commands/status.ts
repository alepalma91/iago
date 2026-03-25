import { createDatabase } from "../db/database.js";
import { createQueries } from "../db/queries.js";
import { loadConfig, getDataDir } from "../core/config.js";
import { join } from "path";
import type { PRReview } from "../types/index.js";

export function formatStatusTable(reviews: PRReview[]): string {
  if (reviews.length === 0) {
    return "No active PR reviews.";
  }

  const header = padRow(["ID", "Repo", "PR", "Status", "Title"]);
  const separator = "-".repeat(header.length);
  const rows = reviews.map((r) =>
    padRow([
      String(r.id),
      r.repo,
      `#${r.pr_number}`,
      r.status,
      truncate(r.title ?? "", 40),
    ])
  );

  return [header, separator, ...rows].join("\n");
}

function padRow(cols: string[]): string {
  const widths = [4, 25, 6, 12, 40];
  return cols.map((col, i) => col.padEnd(widths[i] ?? 10)).join("  ");
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const dataDir = getDataDir(config);
  const dbPath = join(dataDir, "the-reviewer.db");

  let db;
  try {
    db = createDatabase(dbPath);
  } catch {
    console.log("No active PR reviews.");
    return;
  }

  const queries = createQueries(db);
  const active = queries.getActivePRs();

  console.log(formatStatusTable(active));
  db.close();
}
