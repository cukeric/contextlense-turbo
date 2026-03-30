import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Statements } from "../store/database.js";

export interface Reference {
  file: string;
  line: number;
  context: string; // The line containing the reference
}

export interface ReferencesResult {
  symbol: string;
  references: Reference[];
  count: number;
}

/**
 * Find all references to a symbol name across indexed files.
 * Uses a combination of FTS5 search and direct grep through indexed file content.
 */
export function handleReferences(
  args: { name: string; limit?: number },
  db: Database.Database,
  stmts: Statements,
  projectRoot: string
): ReferencesResult {
  const name = args.name;
  const limit = args.limit ?? 20;

  // Search for the symbol name across all indexed content
  const references: Reference[] = [];

  // Get all files that might contain the reference
  const allFiles = stmts.getAllFiles.all() as Array<{ path: string; hash: string }>;

  for (const file of allFiles) {
    try {
      const content = readFileSync(join(projectRoot, file.path), "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.includes(name)) {
          references.push({
            file: file.path,
            line: i + 1,
            context: lines[i]?.trim().slice(0, 200) ?? "",
          });

          if (references.length >= limit) break;
        }
      }

      if (references.length >= limit) break;
    } catch {
      // Skip unreadable files
    }
  }

  return {
    symbol: name,
    references,
    count: references.length,
  };
}
