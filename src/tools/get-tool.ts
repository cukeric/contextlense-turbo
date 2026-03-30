import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Statements } from "../store/database.js";
import { truncateToTokenBudget, estimateTokens } from "../utils/files.js";

export interface GetResult {
  id: string;
  type: "symbol" | "section" | "file";
  content: string;
  tokens: number;
  truncated: boolean;
  metadata: Record<string, unknown>;
}

/**
 * Retrieve content by ID with token budget awareness.
 * Uses byte offsets for precise extraction — no reading full files.
 */
export function handleGet(
  args: { id: string; max_tokens?: number },
  projectRoot: string,
  stmts: Statements
): GetResult {
  const maxTokens = args.max_tokens ?? 2000;
  const id = args.id;

  // Determine type from ID format
  // Sections: "path/to/file.md::slug#level"
  // Symbols: "path/to/file.ts::qualifiedName"
  if (id.includes("#")) {
    return getSection(id, maxTokens, projectRoot, stmts);
  }

  // Try symbol first
  const sym = stmts.getSymbolById.get(id) as any;
  if (sym) {
    return getSymbol(sym, maxTokens, projectRoot);
  }

  // Try section
  const sec = stmts.getSectionById.get(id) as any;
  if (sec) {
    return getSectionRow(sec, maxTokens, projectRoot);
  }

  // Try as file path
  const fileRow = stmts.getFileByPath.get(id) as any;
  if (fileRow) {
    return getFile(id, maxTokens, projectRoot);
  }

  return {
    id,
    type: "symbol",
    content: `Not found: ${id}`,
    tokens: 0,
    truncated: false,
    metadata: {},
  };
}

function getSymbol(sym: any, maxTokens: number, projectRoot: string): GetResult {
  const filePath = join(projectRoot, sym.file_path);
  let content: string;

  try {
    const fileContent = readFileSync(filePath, "utf-8");
    content = fileContent.slice(sym.byte_start, sym.byte_end);
  } catch {
    content = `[Could not read ${sym.file_path}]`;
  }

  const [truncated, wasTruncated] = truncateToTokenBudget(content, maxTokens);

  return {
    id: sym.id,
    type: "symbol",
    content: truncated,
    tokens: estimateTokens(truncated),
    truncated: wasTruncated,
    metadata: {
      name: sym.name,
      kind: sym.kind,
      file: sym.file_path,
      lines: `${sym.line_start}-${sym.line_end}`,
      signature: sym.signature,
      doc_comment: sym.doc_comment,
    },
  };
}

function getSection(id: string, maxTokens: number, projectRoot: string, stmts: Statements): GetResult {
  const sec = stmts.getSectionById.get(id) as any;
  if (!sec) {
    return {
      id,
      type: "section",
      content: `Not found: ${id}`,
      tokens: 0,
      truncated: false,
      metadata: {},
    };
  }
  return getSectionRow(sec, maxTokens, projectRoot);
}

function getSectionRow(sec: any, maxTokens: number, projectRoot: string): GetResult {
  const filePath = join(projectRoot, sec.file_path);
  let content: string;

  try {
    const fileContent = readFileSync(filePath, "utf-8");
    content = fileContent.slice(sec.byte_start, sec.byte_end);
  } catch {
    content = `[Could not read ${sec.file_path}]`;
  }

  const [truncated, wasTruncated] = truncateToTokenBudget(content, maxTokens);

  return {
    id: sec.id,
    type: "section",
    content: truncated,
    tokens: estimateTokens(truncated),
    truncated: wasTruncated,
    metadata: {
      title: sec.title,
      level: sec.level,
      file: sec.file_path,
      parent_id: sec.parent_id,
      summary: sec.summary,
    },
  };
}

function getFile(filePath: string, maxTokens: number, projectRoot: string): GetResult {
  const absPath = join(projectRoot, filePath);
  let content: string;

  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    content = `[Could not read ${filePath}]`;
  }

  const [truncated, wasTruncated] = truncateToTokenBudget(content, maxTokens);

  return {
    id: filePath,
    type: "file",
    content: truncated,
    tokens: estimateTokens(truncated),
    truncated: wasTruncated,
    metadata: { file: filePath },
  };
}
