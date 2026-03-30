/**
 * contextlens-turbo benchmark
 * Usage: node bench.mjs <project-path> [--no-vectors]
 *
 * Phases timed:
 *   1. DB open + migrate
 *   2. Embedding model load (first-ever vs cached)
 *   3. Incremental file discovery
 *   4. Indexing (FTS5 + symbols/sections + optional vectors)
 *   5. Search: FTS5 keyword
 *   6. Search: TurboQuant semantic (if vectors available)
 *   7. DB stats summary
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const projectPath = process.argv[2];
if (!projectPath) {
  console.error("Usage: node bench.mjs <project-path> [--no-vectors]");
  process.exit(1);
}

const noVectors = process.argv.includes("--no-vectors");
const projectRoot = resolve(projectPath);

if (!existsSync(projectRoot)) {
  console.error(`Project path not found: ${projectRoot}`);
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function hr() {
  console.log("─".repeat(62));
}

// ─── Load modules ─────────────────────────────────────────────────────────────

const { openDatabase, createStatements, getDbPath } = await import("./dist/store/database.js");
const { EmbeddingService } = await import("./dist/embeddings/embedding-service.js");
const { handleIndex } = await import("./dist/tools/index-tool.js");
const { handleSearch } = await import("./dist/tools/search-tool.js");
const { handleStatus } = await import("./dist/tools/status-tool.js");

// ─── Phase 1: DB open ─────────────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log(`║  contextlens-turbo benchmark                             ║`);
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  Project: ${projectRoot.split("/").slice(-2).join("/").padEnd(47)}║`);
console.log(`║  Vectors: ${noVectors ? "disabled (--no-vectors)".padEnd(47) : "enabled (TurboQuant 4-bit PolarQuant + QJL)".padEnd(47)}║`);
console.log("╚══════════════════════════════════════════════════════════╝\n");

let t = performance.now();
const dbPath = getDbPath(projectRoot);
const db = openDatabase(dbPath);
const stmts = createStatements(db);
const dbOpenMs = performance.now() - t;
console.log(`[1] DB open + migrate         ${fmt(dbOpenMs).padStart(8)}`);

// ─── Phase 2: Embedding model load ───────────────────────────────────────────

const embedder = new EmbeddingService();
t = performance.now();
await embedder.load();
const modelLoadMs = performance.now() - t;
const embStatus = embedder.getStatus();
console.log(`[2] Model load (${embStatus.state})     ${fmt(modelLoadMs).padStart(8)}  ← ${embStatus.state === "ready" ? "loaded from cache" : "FAILED"}`);

// ─── Phase 3+4: Index ─────────────────────────────────────────────────────────

hr();
console.log(`[3] Indexing…`);
t = performance.now();

const forceReindex = process.argv.includes("--force");
const indexResult = await handleIndex(
  { force: forceReindex },
  projectRoot,
  db,
  stmts,
  embedder
);

const indexMs = performance.now() - t;
console.log(`    files indexed:    ${String(indexResult.files_indexed).padStart(6)}`);
console.log(`    files skipped:    ${String(indexResult.skipped_unchanged).padStart(6)}  (unchanged)`);
console.log(`    symbols found:    ${String(indexResult.symbols_found).padStart(6)}`);
console.log(`    sections found:   ${String(indexResult.sections_found).padStart(6)}`);
console.log(`    vectors created:  ${String(indexResult.vectors_generated).padStart(6)}`);
console.log(`    semantic:         ${indexResult.semantic_search ? "yes" : "no (model not ready)"}`);
console.log(`    TOTAL index time: ${fmt(indexMs).padStart(8)}`);

if (indexResult.files_indexed > 0) {
  const perFile = indexMs / indexResult.files_indexed;
  console.log(`    avg per file:     ${fmt(perFile).padStart(8)}`);
}

if (indexResult.vectors_generated > 0) {
  const perVector = indexMs / indexResult.vectors_generated;
  console.log(`    avg per vector:   ${fmt(perVector).padStart(8)}`);
}

// ─── Phase 5: Keyword search ──────────────────────────────────────────────────

hr();
console.log(`[4] Search benchmarks (10 queries each, avg):`);

const keywordQueries = [
  "function",
  "authentication",
  "database",
  "error handler",
  "component props",
];

let totalKwMs = 0;
for (const q of keywordQueries) {
  t = performance.now();
  await handleSearch({ query: q, limit: 10, semantic: false }, db, stmts, embedder);
  const elapsed = performance.now() - t;
  totalKwMs += elapsed;
  console.log(`    fts5  "${q.padEnd(20)}"  ${fmt(elapsed).padStart(6)}`);
}
console.log(`    avg keyword search:         ${fmt(totalKwMs / keywordQueries.length).padStart(8)}`);

// ─── Phase 6: Semantic search ─────────────────────────────────────────────────

if (embStatus.state === "ready" && !noVectors) {
  hr();
  const semanticQueries = [
    "user authentication flow",
    "database query optimization",
    "react component lifecycle",
    "error handling middleware",
    "file upload processing",
  ];

  let totalSemMs = 0;
  for (const q of semanticQueries) {
    t = performance.now();
    await handleSearch({ query: q, limit: 10, semantic: true }, db, stmts, embedder);
    const elapsed = performance.now() - t;
    totalSemMs += elapsed;
    console.log(`    sem   "${q.padEnd(30)}"  ${fmt(elapsed).padStart(6)}`);
  }
  console.log(`    avg semantic search:        ${fmt(totalSemMs / semanticQueries.length).padStart(8)}`);
}

// ─── Phase 7: Status summary ──────────────────────────────────────────────────

hr();
const status = handleStatus(projectRoot, dbPath, db, stmts, embedder);
console.log(`[5] Index stats:`);
console.log(`    files:            ${String(status.files).padStart(6)}`);
console.log(`    symbols:          ${String(status.symbols).padStart(6)}`);
console.log(`    sections:         ${String(status.sections).padStart(6)}`);
console.log(`    vectors:          ${String(status.vectors.count).padStart(6)}  (${status.vectors.coverage_percent}% coverage)`);
console.log(`    compression:      ${status.vectors.compression_ratio.padStart(6)}`);
console.log(`    DB size:          ${(status.db_size_bytes / 1024 / 1024).toFixed(2).padStart(5)}MB`);
hr();
console.log();
