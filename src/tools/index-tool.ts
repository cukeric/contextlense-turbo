import type Database from "better-sqlite3";
import type { Statements } from "../store/database.js";
import { collectFiles } from "../utils/files.js";
import { isCodeFile, isDocFile, getLanguage } from "../utils/project.js";
import { indexCodeFile } from "../indexers/code-indexer.js";
import { indexDocFile } from "../indexers/doc-indexer.js";
import type { EmbeddingService } from "../embeddings/embedding-service.js";
import { invalidateVectorCache } from "./search-tool.js";

export interface IndexResult {
  files_indexed: number;
  symbols_found: number;
  sections_found: number;
  vectors_generated: number;
  skipped_unchanged: number;
  semantic_search: boolean;
  duration_ms: number;
}

/**
 * Index or re-index the project. Incremental by default.
 *
 * Enhanced over contextlens: after symbols/sections are stored,
 * generates TurboQuant-compressed embeddings for each entity if
 * the embedding service is ready (lazy-loaded on first call).
 */
export async function handleIndex(
  args: { path?: string; force?: boolean },
  projectRoot: string,
  db: Database.Database,
  stmts: Statements,
  embeddingService: EmbeddingService
): Promise<IndexResult> {
  const start = Date.now();
  const targetPath = args.path ?? projectRoot;
  const force = args.force ?? false;

  // Trigger lazy model load (non-blocking — if already loading, awaits completion)
  // We catch here so a model failure doesn't block indexing
  try {
    await embeddingService.load();
  } catch {
    // Model failed to load — semantic indexing will be skipped gracefully
  }

  const files = collectFiles(targetPath);
  const semanticEnabled = embeddingService.isReady();

  let filesIndexed = 0;
  let symbolsFound = 0;
  let sectionsFound = 0;
  let vectorsGenerated = 0;
  let skippedUnchanged = 0;

  for (const file of files) {
    // Incremental: skip unchanged files
    if (!force) {
      const existing = stmts.getFileHash.get(file.relativePath) as { hash: string } | undefined;
      if (existing && existing.hash === file.hash) {
        skippedUnchanged++;
        continue;
      }
    }

    // Clear old data for this file (vectors cascade via FK for symbols; app-managed for sections)
    stmts.deleteVectorsByFile.run(file.relativePath, file.relativePath);
    stmts.deleteFileSearchEntries.run(file.relativePath, file.relativePath);
    stmts.deleteFileTrigramEntries.run(file.relativePath, file.relativePath);
    stmts.deleteFileSymbols.run(file.relativePath);
    stmts.deleteFileSections.run(file.relativePath);

    const language = getLanguage(file.absolutePath) ?? "doc";
    stmts.insertFile.run({
      path: file.relativePath,
      hash: file.hash,
      size: file.size,
      language,
    });

    if (isCodeFile(file.absolutePath)) {
      const result = await indexCodeFile(file, stmts, projectRoot, embeddingService);
      symbolsFound += result.symbols;
      vectorsGenerated += result.vectors;
    }

    if (isDocFile(file.absolutePath)) {
      const result = await indexDocFile(file, stmts, embeddingService);
      sectionsFound += result.sections;
      vectorsGenerated += result.vectors;
    }

    filesIndexed++;
  }

  // Any file that was re-indexed may have changed vectors — bust the search cache.
  if (filesIndexed > 0) {
    invalidateVectorCache();
  }

  return {
    files_indexed: filesIndexed,
    symbols_found: symbolsFound,
    sections_found: sectionsFound,
    vectors_generated: vectorsGenerated,
    skipped_unchanged: skippedUnchanged,
    semantic_search: semanticEnabled,
    duration_ms: Date.now() - start,
  };
}
