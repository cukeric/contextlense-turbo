import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { shouldIgnoreDir, shouldIgnoreFile, isCodeFile, isDocFile } from "./project.js";

export interface FileEntry {
  absolutePath: string;
  relativePath: string;
  hash: string;
  size: number;
  content: string;
}

/**
 * Walk the project directory and collect all indexable files.
 * Respects ignore rules for dirs and files.
 */
export function collectFiles(projectRoot: string): FileEntry[] {
  const files: FileEntry[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable dirs
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldIgnoreDir(entry.name)) {
          walk(join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        if (shouldIgnoreFile(entry.name)) continue;

        const absPath = join(dir, entry.name);
        const relPath = relative(projectRoot, absPath);

        if (!isCodeFile(absPath) && !isDocFile(absPath)) continue;

        try {
          const content = readFileSync(absPath, "utf-8");
          const stat = statSync(absPath);
          const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);

          files.push({
            absolutePath: absPath,
            relativePath: relPath,
            hash,
            size: stat.size,
            content,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(projectRoot);
  return files;
}

/**
 * Read a byte range from a file efficiently.
 */
export function readByteRange(filePath: string, start: number, end: number): string {
  const buf = Buffer.alloc(end - start);
  const fd = require("node:fs").openSync(filePath, "r");
  try {
    require("node:fs").readSync(fd, buf, 0, end - start, start);
    return buf.toString("utf-8");
  } finally {
    require("node:fs").closeSync(fd);
  }
}

/**
 * Estimate token count from a string (rough: 1 token ~ 4 chars).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate content to fit within a token budget.
 * Returns [truncatedContent, wasTruncated].
 */
export function truncateToTokenBudget(
  content: string,
  maxTokens: number
): [string, boolean] {
  const estimated = estimateTokens(content);
  if (estimated <= maxTokens) {
    return [content, false];
  }
  const maxChars = maxTokens * 4;
  const truncated = content.slice(0, maxChars);
  // Cut at last newline to avoid mid-line truncation
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > maxChars * 0.8) {
    return [truncated.slice(0, lastNewline) + "\n... [truncated]", true];
  }
  return [truncated + "\n... [truncated]", true];
}
