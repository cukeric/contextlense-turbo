import Database, { type Statement as BetterSqlite3Statement } from "better-sqlite3";

export type { BetterSqlite3Statement };
import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

// Schema v3: removes FK on vector_index (allows section vectors) + clears 3-bit data (4-bit upgrade).
const SCHEMA_VERSION = 3;

export interface SymbolRow {
  id: string;
  file_path: string;
  name: string;
  qualified_name: string;
  kind: string;
  language: string;
  signature: string;
  line_start: number;
  line_end: number;
  byte_start: number;
  byte_end: number;
  parent_id: string | null;
  doc_comment: string | null;
}

export interface SectionRow {
  id: string;
  file_path: string;
  title: string;
  level: number;
  parent_id: string | null;
  byte_start: number;
  byte_end: number;
  summary: string | null;
}

export interface FileRow {
  path: string;
  hash: string;
  size: number;
  language: string;
  indexed_at: string;
}

export interface VectorRow {
  entity_id: string;
  entity_type: string;          // 'symbol' | 'section'
  embedding_text: string;
  final_radius: number;
  pq_angles: Buffer;
  qjl_bits: Buffer;
  pq_dimensions: number;
  qjl_projected_dimensions: number;
  model_id: string;
  created_at: string;
}

export function getDbPath(projectRoot: string): string {
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  const dirName = `${projectRoot.split("/").pop()}-${hash}`;
  const dir = join(homedir(), ".contextlens-turbo", dirName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "index.db");
}

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000"); // 64MB cache
  db.pragma("foreign_keys = ON");

  const version = db.pragma("user_version", { simple: true }) as number;

  if (version < SCHEMA_VERSION) {
    migrate(db, version);
  }

  return db;
}

function migrate(db: Database.Database, fromVersion: number): void {
  db.transaction(() => {
    if (fromVersion < 1) {
      // v1: Core tables (identical to contextlens v1)
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          language TEXT NOT NULL DEFAULT 'unknown',
          indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS symbols (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
          name TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          language TEXT NOT NULL,
          signature TEXT NOT NULL DEFAULT '',
          line_start INTEGER NOT NULL,
          line_end INTEGER NOT NULL,
          byte_start INTEGER NOT NULL,
          byte_end INTEGER NOT NULL,
          parent_id TEXT REFERENCES symbols(id) ON DELETE SET NULL,
          doc_comment TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
        CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);

        CREATE TABLE IF NOT EXISTS sections (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
          title TEXT NOT NULL,
          level INTEGER NOT NULL,
          parent_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
          byte_start INTEGER NOT NULL,
          byte_end INTEGER NOT NULL,
          summary TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sections_file ON sections(file_path);
        CREATE INDEX IF NOT EXISTS idx_sections_level ON sections(level);
        CREATE INDEX IF NOT EXISTS idx_sections_parent ON sections(parent_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
          entity_id,
          entity_type,
          name,
          content,
          tokenize='porter unicode61'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS trigram_index USING fts5(
          entity_id,
          name,
          tokenize='trigram'
        );
      `);
    }

    if (fromVersion < 2) {
      // v2: Add vector_index table (additive — never drops v1 data).
      // NOTE: v2 had a FK bug (entity_id REFERENCES symbols(id)) that blocked section vectors.
      // v3 migration below fixes this by dropping and recreating the table.
      db.exec(`
        CREATE TABLE IF NOT EXISTS vector_index (
          entity_id TEXT PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL,
          embedding_text TEXT NOT NULL,
          final_radius REAL NOT NULL,
          pq_angles BLOB NOT NULL,
          qjl_bits BLOB NOT NULL,
          pq_dimensions INTEGER NOT NULL,
          qjl_projected_dimensions INTEGER NOT NULL,
          model_id TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_vector_entity_type ON vector_index(entity_type);
      `);
    }

    if (fromVersion < 3) {
      // v3: Two fixes in one:
      //   1. Remove FK on entity_id — section entity IDs are not in symbols table,
      //      so the v2 FK blocked all section vector inserts with "FOREIGN KEY constraint failed".
      //   2. Clear v2 data — v3 switches PolarQuant from 3-bit (8 bins) to 4-bit (16 bins);
      //      old pq_angles BLOBs are incompatible with the new decoder.
      // Users must re-run `index` to regenerate all vectors after this migration.
      db.exec(`
        DROP TABLE IF EXISTS vector_index;

        CREATE TABLE IF NOT EXISTS vector_index (
          entity_id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          embedding_text TEXT NOT NULL,
          final_radius REAL NOT NULL,
          pq_angles BLOB NOT NULL,
          qjl_bits BLOB NOT NULL,
          pq_dimensions INTEGER NOT NULL,
          qjl_projected_dimensions INTEGER NOT NULL,
          model_id TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_vector_entity_type ON vector_index(entity_type);
      `);
    }

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

export function createStatements(db: Database.Database): Statements {
  return {
    // ── File ops ────────────────────────────────────────────────
    insertFile: db.prepare(`
      INSERT OR REPLACE INTO files (path, hash, size, language, indexed_at)
      VALUES (@path, @hash, @size, @language, datetime('now'))
    `),
    getFileByPath: db.prepare(`SELECT * FROM files WHERE path = ?`),
    getFileHash: db.prepare(`SELECT hash FROM files WHERE path = ?`),
    getAllFiles: db.prepare(`SELECT path, hash FROM files`),
    deleteFile: db.prepare(`DELETE FROM files WHERE path = ?`),

    // ── Symbol ops ──────────────────────────────────────────────
    insertSymbol: db.prepare(`
      INSERT OR REPLACE INTO symbols
        (id, file_path, name, qualified_name, kind, language, signature,
         line_start, line_end, byte_start, byte_end, parent_id, doc_comment)
      VALUES
        (@id, @file_path, @name, @qualified_name, @kind, @language, @signature,
         @line_start, @line_end, @byte_start, @byte_end, @parent_id, @doc_comment)
    `),
    getSymbolById: db.prepare(`SELECT * FROM symbols WHERE id = ?`),
    getSymbolsByFile: db.prepare(`SELECT * FROM symbols WHERE file_path = ? ORDER BY line_start`),
    getSymbolChildren: db.prepare(`SELECT * FROM symbols WHERE parent_id = ? ORDER BY line_start`),
    deleteFileSymbols: db.prepare(`DELETE FROM symbols WHERE file_path = ?`),

    // ── Section ops ─────────────────────────────────────────────
    insertSection: db.prepare(`
      INSERT OR REPLACE INTO sections
        (id, file_path, title, level, parent_id, byte_start, byte_end, summary)
      VALUES
        (@id, @file_path, @title, @level, @parent_id, @byte_start, @byte_end, @summary)
    `),
    getSectionById: db.prepare(`SELECT * FROM sections WHERE id = ?`),
    getSectionsByFile: db.prepare(`SELECT * FROM sections WHERE file_path = ? ORDER BY byte_start`),
    getSectionChildren: db.prepare(`SELECT * FROM sections WHERE parent_id = ? ORDER BY byte_start`),
    deleteFileSections: db.prepare(`DELETE FROM sections WHERE file_path = ?`),

    // ── FTS5 / trigram search ───────────────────────────────────
    insertSearchEntry: db.prepare(`
      INSERT INTO search_index (entity_id, entity_type, name, content)
      VALUES (@entity_id, @entity_type, @name, @content)
    `),
    insertTrigramEntry: db.prepare(`
      INSERT INTO trigram_index (entity_id, name)
      VALUES (@entity_id, @name)
    `),
    searchFts: db.prepare(`
      SELECT entity_id, entity_type, name, rank * -1 AS score
      FROM search_index
      WHERE search_index MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
    searchTrigram: db.prepare(`
      SELECT entity_id, name, rank * -1 AS score
      FROM trigram_index
      WHERE trigram_index MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
    deleteFileSearchEntries: db.prepare(`
      DELETE FROM search_index
      WHERE entity_id IN (SELECT id FROM symbols WHERE file_path = ?)
         OR entity_id IN (SELECT id FROM sections WHERE file_path = ?)
    `),
    deleteFileTrigramEntries: db.prepare(`
      DELETE FROM trigram_index
      WHERE entity_id IN (SELECT id FROM symbols WHERE file_path = ?)
         OR entity_id IN (SELECT id FROM sections WHERE file_path = ?)
    `),

    // ── Vector index ops ────────────────────────────────────────
    insertVector: db.prepare(`
      INSERT OR REPLACE INTO vector_index
        (entity_id, entity_type, embedding_text, final_radius, pq_angles, qjl_bits,
         pq_dimensions, qjl_projected_dimensions, model_id)
      VALUES
        (@entity_id, @entity_type, @embedding_text, @final_radius, @pq_angles, @qjl_bits,
         @pq_dimensions, @qjl_projected_dimensions, @model_id)
    `),
    getVectorByEntityId: db.prepare(`SELECT * FROM vector_index WHERE entity_id = ?`),
    getAllVectors: db.prepare(`
      SELECT entity_id, entity_type, final_radius, pq_angles, qjl_bits,
             pq_dimensions, qjl_projected_dimensions
      FROM vector_index
    `),
    getAllVectorsByType: db.prepare(`
      SELECT entity_id, entity_type, final_radius, pq_angles, qjl_bits,
             pq_dimensions, qjl_projected_dimensions
      FROM vector_index WHERE entity_type = ?
    `),
    deleteVectorsByFile: db.prepare(`
      DELETE FROM vector_index
      WHERE entity_id IN (SELECT id FROM symbols WHERE file_path = ?)
         OR entity_id IN (SELECT id FROM sections WHERE file_path = ?)
    `),
    getVectorStats: db.prepare(`
      SELECT
        COUNT(*) AS vector_count,
        COALESCE(SUM(LENGTH(pq_angles) + LENGTH(qjl_bits) + 8), 0) AS vector_bytes
      FROM vector_index
    `),

    // ── Global stats ────────────────────────────────────────────
    getStats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files) AS file_count,
        (SELECT COUNT(*) FROM symbols) AS symbol_count,
        (SELECT COUNT(*) FROM sections) AS section_count
    `),
  };
}

export interface Statements {
  // File ops
  insertFile: BetterSqlite3Statement;
  getFileByPath: BetterSqlite3Statement;
  getFileHash: BetterSqlite3Statement;
  getAllFiles: BetterSqlite3Statement;
  deleteFile: BetterSqlite3Statement;
  // Symbol ops
  insertSymbol: BetterSqlite3Statement;
  getSymbolById: BetterSqlite3Statement;
  getSymbolsByFile: BetterSqlite3Statement;
  getSymbolChildren: BetterSqlite3Statement;
  deleteFileSymbols: BetterSqlite3Statement;
  // Section ops
  insertSection: BetterSqlite3Statement;
  getSectionById: BetterSqlite3Statement;
  getSectionsByFile: BetterSqlite3Statement;
  getSectionChildren: BetterSqlite3Statement;
  deleteFileSections: BetterSqlite3Statement;
  // FTS / trigram
  insertSearchEntry: BetterSqlite3Statement;
  insertTrigramEntry: BetterSqlite3Statement;
  searchFts: BetterSqlite3Statement;
  searchTrigram: BetterSqlite3Statement;
  deleteFileSearchEntries: BetterSqlite3Statement;
  deleteFileTrigramEntries: BetterSqlite3Statement;
  // Vector index
  insertVector: BetterSqlite3Statement;
  getVectorByEntityId: BetterSqlite3Statement;
  getAllVectors: BetterSqlite3Statement;
  getAllVectorsByType: BetterSqlite3Statement;
  deleteVectorsByFile: BetterSqlite3Statement;
  getVectorStats: BetterSqlite3Statement;
  // Stats
  getStats: BetterSqlite3Statement;
}
