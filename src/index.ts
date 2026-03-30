#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { openDatabase, createStatements, getDbPath } from "./store/database.js";
import { detectProjectRoot } from "./utils/project.js";
import { EmbeddingService } from "./embeddings/embedding-service.js";
import { handleIndex } from "./tools/index-tool.js";
import { handleSearch } from "./tools/search-tool.js";
import { handleGet } from "./tools/get-tool.js";
import { handleOutline } from "./tools/outline-tool.js";
import { handleReferences } from "./tools/references-tool.js";
import { handleContext } from "./tools/context-tool.js";
import { handleStatus } from "./tools/status-tool.js";

// ── Bootstrap ──────────────────────────────────────────────────────────────
const projectRoot = detectProjectRoot();
const dbPath = getDbPath(projectRoot);
const db = openDatabase(dbPath);
const stmts = createStatements(db);
const embedder = new EmbeddingService();

const server = new McpServer(
  { name: "@cukeric/contextlens-turbo", version: "1.0.0" },
  { capabilities: { logging: {} } }
);

// ── Tool 1: index ──────────────────────────────────────────────────────────
server.registerTool(
  "index",
  {
    description:
      "Index project code and docs. Incremental by default. Generates TurboQuant-compressed semantic vectors for hybrid search.",
    inputSchema: z.object({
      path: z.string().optional().describe("Subdirectory to index (default: project root)"),
      force: z.boolean().optional().describe("Re-index all files, including unchanged"),
    }),
  },
  async (args) => {
    const result = await handleIndex(
      {
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.force !== undefined ? { force: args.force } : {}),
      },
      projectRoot,
      db,
      stmts,
      embedder
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool 2: search ─────────────────────────────────────────────────────────
server.registerTool(
  "search",
  {
    description:
      "Hybrid semantic + keyword search. Finds symbols and docs by meaning, not just keyword overlap. Falls back to FTS5 if model not loaded.",
    inputSchema: z.object({
      query: z.string().describe("Natural language or keyword query"),
      type: z.enum(["symbol", "section", "all"]).optional().describe("Filter by type (default: all)"),
      limit: z.number().optional().describe("Max results (default: 10)"),
      fuzzy: z.boolean().optional().describe("Enable fuzzy trigram matching"),
      semantic: z.boolean().optional().describe("Use semantic search (default: true, requires prior index)"),
    }),
  },
  async (args) => {
    const result = await handleSearch(
      {
        query: args.query,
        ...(args.type !== undefined ? { type: args.type } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.fuzzy !== undefined ? { fuzzy: args.fuzzy } : {}),
        ...(args.semantic !== undefined ? { semantic: args.semantic } : {}),
      },
      db,
      stmts,
      embedder
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool 3: get ────────────────────────────────────────────────────────────
server.registerTool(
  "get",
  {
    description: "Get content by ID with token budget. Returns symbol, section, or file content.",
    inputSchema: z.object({
      id: z.string().describe("Symbol/section/file ID from search results"),
      max_tokens: z.number().optional().describe("Token budget (default: 2000)"),
    }),
  },
  async (args) => {
    const result = handleGet(
      { id: args.id, ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}) },
      projectRoot,
      stmts
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool 4: outline ────────────────────────────────────────────────────────
server.registerTool(
  "outline",
  {
    description: "File structure: symbols for code, headings for docs. No content returned.",
    inputSchema: z.object({
      file: z.string().describe("Relative file path"),
    }),
  },
  async (args) => {
    const result = handleOutline({ file: args.file }, stmts);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool 5: references ─────────────────────────────────────────────────────
server.registerTool(
  "references",
  {
    description: "Find where a symbol name is used across the project.",
    inputSchema: z.object({
      name: z.string().describe("Symbol name to find references for"),
      limit: z.number().optional().describe("Max results (default: 20)"),
    }),
  },
  async (args) => {
    const result = handleReferences(
      { name: args.name, ...(args.limit !== undefined ? { limit: args.limit } : {}) },
      db,
      stmts,
      projectRoot
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool 6: context ────────────────────────────────────────────────────────
server.registerTool(
  "context",
  {
    description:
      "Smart context bundle: target content + structural relationships + semantic neighbors + usage references, within token budget.",
    inputSchema: z.object({
      id: z.string().describe("Symbol/section ID to build context around"),
      max_tokens: z.number().optional().describe("Total token budget (default: 3000)"),
      include_references: z.boolean().optional().describe("Include usage references (default: true)"),
    }),
  },
  async (args) => {
    const result = await handleContext(
      {
        id: args.id,
        ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}),
        ...(args.include_references !== undefined ? { include_references: args.include_references } : {}),
      },
      projectRoot,
      db,
      stmts,
      embedder
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool 7: status ─────────────────────────────────────────────────────────
server.registerTool(
  "status",
  {
    description:
      "Index stats: files, symbols, sections, vector count, compression ratio, semantic search availability.",
    inputSchema: z.object({}),
  },
  async () => {
    const result = handleStatus(projectRoot, dbPath, db, stmts, embedder);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("contextlens-turbo failed to start:", err);
  process.exit(1);
});
