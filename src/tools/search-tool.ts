import type Database from "better-sqlite3";
import type { Statements } from "../store/database.js";
import type { EmbeddingService } from "../embeddings/embedding-service.js";
import { searchTopK, deserializeCompressedVector, type ScoredId, type CompressedVector } from "../compression/turbo-quant.js";

// ─────────────────────────────────────────────────────────────────
// In-memory vector cache — avoids re-deserializing DB BLOBs every search.
// Invalidated by calling invalidateVectorCache() from the index tool.
// ─────────────────────────────────────────────────────────────────

interface CachedVector {
  entityId: string;
  entityType: string;
  compressed: CompressedVector;
}

let vectorCache: CachedVector[] | null = null;

/**
 * Invalidate the in-memory vector cache.
 * Must be called after any index run that modifies vector_index.
 */
export function invalidateVectorCache(): void {
  vectorCache = null;
}

export interface SearchResult {
  id: string;
  type: "symbol" | "section";
  name: string;
  score: number;
  kind?: string;
  file_path?: string;
  signature?: string;
  line_start?: number;
  line_end?: number;
  title?: string;
  level?: number;
  summary?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  strategy: "fts5" | "trigram" | "fts5+trigram" | "semantic" | "hybrid";
  semantic_available: boolean;
}

/**
 * Hybrid search: FTS5 keyword search + TurboQuant semantic search, merged via RRF.
 *
 * Strategy selection:
 *   - If embedding service is ready: "hybrid" (FTS5 + semantic → RRF fusion)
 *   - If embedding service not ready: "fts5" or "trigram" (keyword-only fallback)
 *
 * Reciprocal Rank Fusion (RRF):
 *   score(d) = 1/(60 + rank_keyword) + 1/(60 + rank_semantic)
 *   Scale-invariant — works regardless of FTS5 BM25 vs cosine similarity score scales.
 */
export async function handleSearch(
  args: {
    query: string;
    type?: "symbol" | "section" | "all";
    limit?: number;
    fuzzy?: boolean;
    semantic?: boolean;
  },
  db: Database.Database,
  stmts: Statements,
  embeddingService: EmbeddingService
): Promise<SearchResponse> {
  const limit = args.limit ?? 10;
  const searchType = args.type ?? "all";
  const query = args.query.trim();
  const wantSemantic = args.semantic !== false; // default true

  if (!query) {
    return { results: [], query, strategy: "fts5", semantic_available: embeddingService.isReady() };
  }

  // ── Step 1: Keyword search (FTS5 + trigram fallback) ──────────────────────
  const keywordResults = runKeywordSearch(query, searchType, limit * 2, args.fuzzy ?? false, stmts);

  // ── Step 2: Semantic search (if model ready and desired) ──────────────────
  let semanticResults: ScoredId[] = [];
  let strategy: SearchResponse["strategy"] = keywordResults.strategy;

  if (wantSemantic && embeddingService.isReady()) {
    const queryEmbedding = await embeddingService.embed(query);
    if (queryEmbedding !== null) {
      semanticResults = await runSemanticSearch(queryEmbedding, searchType, limit * 2, stmts);
    }
  }

  // ── Step 3: Merge with RRF or return keyword-only ─────────────────────────
  let mergedIds: string[];

  if (semanticResults.length > 0) {
    strategy = "hybrid";
    mergedIds = reciprocalRankFusion(
      keywordResults.results.map((r) => r.id),
      semanticResults.map((r) => r.entityId),
      limit
    );
  } else {
    mergedIds = keywordResults.results.map((r) => r.id).slice(0, limit);
  }

  // ── Step 4: Enrich results with metadata ─────────────────────────────────
  const enriched: SearchResult[] = [];
  for (const id of mergedIds) {
    // Build score for this result (RRF score from merged list)
    const kwRank = keywordResults.results.findIndex((r) => r.id === id);
    const semRank = semanticResults.findIndex((r) => r.entityId === id);
    const rrfScore = rrfScore_compute(kwRank, semRank);

    const result = enrichResult(id, rrfScore, stmts);
    if (result !== null) {
      if (searchType !== "all" && result.type !== searchType) continue;
      enriched.push(result);
    }
  }

  return {
    results: enriched,
    query,
    strategy,
    semantic_available: embeddingService.isReady(),
  };
}

// ─────────────────────────────────────────────────────────────────
// Keyword search (FTS5 + trigram)
// ─────────────────────────────────────────────────────────────────

interface KeywordSearchResult {
  results: Array<{ id: string; score: number }>;
  strategy: "fts5" | "trigram" | "fts5+trigram";
}

function runKeywordSearch(
  query: string,
  searchType: string,
  limit: number,
  fuzzy: boolean,
  stmts: Statements
): KeywordSearchResult {
  let results: Array<{ id: string; score: number }> = [];
  let strategy: KeywordSearchResult["strategy"] = "fts5";

  try {
    const ftsQuery = buildFtsQuery(query);
    const rows = stmts.searchFts.all(ftsQuery, limit * 2) as Array<{
      entity_id: string;
      entity_type: string;
      name: string;
      score: number;
    }>;

    for (const row of rows) {
      if (searchType !== "all" && row.entity_type !== searchType) continue;
      results.push({ id: row.entity_id, score: row.score });
    }
  } catch {
    // FTS5 syntax error — fall through to trigram
  }

  if (results.length < 3 || fuzzy) {
    strategy = results.length > 0 ? "fts5+trigram" : "trigram";
    try {
      const trigramQuery = `"${query}"`;
      const rows = stmts.searchTrigram.all(trigramQuery, limit) as Array<{
        entity_id: string;
        name: string;
        score: number;
      }>;
      const existingIds = new Set(results.map((r) => r.id));
      for (const row of rows) {
        if (existingIds.has(row.entity_id)) continue;
        const type = row.entity_id.includes("#") ? "section" : "symbol";
        if (searchType !== "all" && type !== searchType) continue;
        results.push({ id: row.entity_id, score: row.score * 0.8 });
      }
    } catch {
      // Trigram failed — use what we have
    }
  }

  results.sort((a, b) => b.score - a.score);
  results = results.slice(0, limit);

  return { results, strategy };
}

function buildFtsQuery(query: string): string {
  const expanded = query.replace(/([a-z])([A-Z])/g, "$1 $2");
  const terms = expanded
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"*`);
  return terms.join(" OR ");
}

// ─────────────────────────────────────────────────────────────────
// Semantic search (TurboQuant brute-force scan)
// ─────────────────────────────────────────────────────────────────

async function runSemanticSearch(
  queryEmbedding: Float32Array,
  searchType: string,
  k: number,
  stmts: Statements
): Promise<ScoredId[]> {
  // Populate cache on first call (or after invalidation).
  // getAllVectors is always loaded for the full cache — type filtering happens below.
  if (vectorCache === null) {
    const rows = stmts.getAllVectors.all() as Array<{
      entity_id: string;
      entity_type: string;
      final_radius: number;
      pq_angles: Buffer;
      qjl_bits: Buffer;
      pq_dimensions: number;
      qjl_projected_dimensions: number;
    }>;

    vectorCache = rows.map((row) => ({
      entityId: row.entity_id,
      entityType: row.entity_type,
      compressed: deserializeCompressedVector(row).compressed,
    }));
  }

  const candidates = searchType === "all"
    ? vectorCache.map(({ entityId, compressed }) => ({ entityId, compressed }))
    : vectorCache
        .filter((v) => v.entityType === searchType)
        .map(({ entityId, compressed }) => ({ entityId, compressed }));

  if (candidates.length === 0) return [];

  return searchTopK(queryEmbedding, candidates, k);
}

// ─────────────────────────────────────────────────────────────────
// Reciprocal Rank Fusion
// ─────────────────────────────────────────────────────────────────

const RRF_K = 60; // Standard RRF constant

/**
 * Merge two ranked lists using Reciprocal Rank Fusion.
 * Returns the top-k IDs ordered by combined RRF score.
 */
function reciprocalRankFusion(
  keywordIds: string[],
  semanticIds: string[],
  k: number
): string[] {
  const scores = new Map<string, number>();

  for (let i = 0; i < keywordIds.length; i++) {
    const id = keywordIds[i]!;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  }

  for (let i = 0; i < semanticIds.length; i++) {
    const id = semanticIds[i]!;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => id);
}

function rrfScore_compute(kwRank: number, semRank: number): number {
  let score = 0;
  if (kwRank >= 0) score += 1 / (RRF_K + kwRank + 1);
  if (semRank >= 0) score += 1 / (RRF_K + semRank + 1);
  return score;
}

// ─────────────────────────────────────────────────────────────────
// Result enrichment
// ─────────────────────────────────────────────────────────────────

function enrichResult(
  entityId: string,
  score: number,
  stmts: Statements
): SearchResult | null {
  // Determine type: section IDs contain '#level' suffix, symbol IDs don't
  const isSection = /#{1}\d+$/.test(entityId);

  if (!isSection) {
    const sym = stmts.getSymbolById.get(entityId) as any;
    if (!sym) return null;
    return {
      id: entityId,
      type: "symbol",
      name: sym.name,
      score,
      kind: sym.kind,
      file_path: sym.file_path,
      signature: sym.signature,
      line_start: sym.line_start,
      line_end: sym.line_end,
    };
  }

  const sec = stmts.getSectionById.get(entityId) as any;
  if (!sec) return null;
  return {
    id: entityId,
    type: "section",
    name: sec.title,
    score,
    title: sec.title,
    level: sec.level,
    file_path: sec.file_path,
    summary: sec.summary,
  };
}
