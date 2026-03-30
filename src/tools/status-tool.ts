import type Database from "better-sqlite3";
import type { Statements } from "../store/database.js";
import type { EmbeddingService } from "../embeddings/embedding-service.js";
import { statSync } from "node:fs";

export interface StatusResult {
  project_root: string;
  db_path: string;
  db_size_bytes: number;
  files: number;
  symbols: number;
  sections: number;
  vectors: {
    count: number;
    storage_bytes: number;
    compression_ratio: string;
    coverage_percent: number;
  };
  semantic_search: {
    available: boolean;
    model: string;
    dimensions: number;
    state: string;
    error?: string;
  };
}

/**
 * Enhanced status tool — reports all index stats plus vector coverage and model state.
 */
export function handleStatus(
  projectRoot: string,
  dbPath: string,
  db: Database.Database,
  stmts: Statements,
  embeddingService: EmbeddingService
): StatusResult {
  const stats = stmts.getStats.get() as {
    file_count: number;
    symbol_count: number;
    section_count: number;
  };

  const vectorStats = stmts.getVectorStats.get() as {
    vector_count: number;
    vector_bytes: number;
  };

  // DB file size
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath).size;
  } catch {
    // DB not yet created on disk
  }

  // Vector coverage: percentage of (symbols + sections) that have vectors
  const totalEntities = stats.symbol_count + stats.section_count;
  const coveragePct = totalEntities > 0
    ? Math.round((vectorStats.vector_count / totalEntities) * 100)
    : 0;

  // Compression ratio: float32 uncompressed would be vector_count * 384 * 4 bytes
  const uncompressedBytes = vectorStats.vector_count * 384 * 4;
  const compressionRatio = uncompressedBytes > 0 && vectorStats.vector_bytes > 0
    ? `${(uncompressedBytes / vectorStats.vector_bytes).toFixed(1)}:1`
    : "N/A";

  const embStatus = embeddingService.getStatus();

  return {
    project_root: projectRoot,
    db_path: dbPath,
    db_size_bytes: dbSizeBytes,
    files: stats.file_count,
    symbols: stats.symbol_count,
    sections: stats.section_count,
    vectors: {
      count: vectorStats.vector_count,
      storage_bytes: vectorStats.vector_bytes,
      compression_ratio: compressionRatio,
      coverage_percent: coveragePct,
    },
    semantic_search: {
      available: embStatus.state === "ready",
      model: embStatus.model,
      dimensions: embStatus.dimensions,
      state: embStatus.state,
      ...(embStatus.error ? { error: embStatus.error } : {}),
    },
  };
}
