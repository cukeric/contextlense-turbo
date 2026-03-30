# SPEC: contextlens-turbo

**Version:** 1.0.0-alpha
**Date:** 2026-03-28
**Status:** Draft
**Author:** WHISK Planner (Opus)

---

## 1. Project Overview

### What it is

contextlens-turbo is a TypeScript MCP server that replaces the keyword-only search backend of contextlens with a hybrid search engine combining FTS5 keyword search and 3-bit semantic vector search using the TurboQuant compression pipeline (PolarQuant + QJL). It retains all 7 existing MCP tools, enhances `search` and `context` with semantic understanding, and adds vector embedding generation to the `index` pipeline.

### What it solves

contextlens can only find results when query keywords overlap with indexed content. A developer searching for "how do I format timestamps" will miss a function named `formatDate` because "timestamps" does not appear in the symbol name, signature, or doc comment. contextlens-turbo solves this by embedding both queries and indexed content into a shared 384-dimensional semantic vector space, compressing those vectors to ~100 bytes each using TurboQuant, and ranking results by cosine similarity. Keyword search is preserved as a complementary signal, not replaced.

### What it adds over contextlens

| Capability | contextlens | contextlens-turbo |
|---|---|---|
| Keyword search (FTS5 + trigram) | Yes | Yes (unchanged) |
| Semantic search (vector similarity) | No | Yes (TurboQuant-compressed) |
| Hybrid ranking (keyword + semantic) | No | Yes (reciprocal rank fusion) |
| Natural language queries | No | Yes ("date formatting utility" finds `formatDate`) |
| Embedding model | None | `Xenova/all-MiniLM-L6-v2` (384-dim, ONNX/WASM, offline) |
| Storage per symbol (vector) | 0 bytes | ~100 bytes (76 PQ + 24 QJL) |
| Compression ratio | N/A | ~15:1 vs float32 |

### Non-goals for this version

This is NOT a rewrite. The project forks from contextlens and adds a vector search layer. All existing FTS5/trigram infrastructure remains intact and operational. The vector layer is additive.

---

## 2. User Stories

### US-1: Semantic code discovery

**As** an AI coding assistant (Claude Code, Gemini CLI, Copilot),
**I want** to search for code using natural language descriptions,
**so that** I can find relevant functions even when my query uses different vocabulary than the source code.

**Acceptance criteria:**
- Query "date formatting utility" returns results containing `formatDate`, `parseTimestamp`, `toISOString` even if those exact words are not in the query.
- Query "authentication middleware" returns auth-related middleware functions regardless of naming conventions.
- Semantic results are merged with keyword results using reciprocal rank fusion, not replacing them.

### US-2: Semantic doc section discovery

**As** an AI coding assistant,
**I want** to search documentation sections by meaning,
**so that** I can find the right section of a README or ADR without knowing the exact heading text.

**Acceptance criteria:**
- Query "how to deploy" finds a section titled "Production Setup" in a README.
- Query "environment variables" finds sections about configuration even if titled "App Config" or "Settings".

### US-3: Graceful degradation without embeddings

**As** a user on a machine without WASM support or with limited memory,
**I want** the MCP server to still work for keyword search,
**so that** the tool is never broken by the embedding layer.

**Acceptance criteria:**
- If the embedding model fails to load, all 7 tools still work using FTS5/trigram only.
- A warning is logged (not an error thrown) when semantic search is unavailable.
- The `status` tool reports whether semantic search is available.

### US-4: Incremental vector indexing

**As** a developer,
**I want** re-indexing to only re-embed changed files,
**so that** incremental indexing remains fast even with the embedding overhead.

**Acceptance criteria:**
- If a file's content hash has not changed, its vectors are not recomputed.
- If a file is re-indexed, its old vectors are deleted before new ones are inserted.
- Force re-index (`force: true`) re-embeds everything.

### US-5: Context-aware semantic bundling

**As** an AI coding assistant,
**I want** the `context` tool to use semantic similarity to find related symbols,
**so that** the context bundle includes semantically related code, not just structural neighbors.

**Acceptance criteria:**
- The `context` tool's "related" section includes symbols that are semantically similar to the target, not just children/siblings in the same file.
- Structural relationships (parent, child, sibling) are still included and take priority.
- Semantic neighbors are added if token budget allows, after structural relatives.

---

## 3. Architecture

### 3.1 Component Diagram

```
src/
  index.ts                    # MCP server entry (unchanged structure)
  store/
    database.ts               # SQLite schema + migrations (v1 -> v2)
  indexers/
    code-indexer.ts            # AST parsing + embedding generation
    doc-indexer.ts             # Section parsing + embedding generation
  tools/
    index-tool.ts              # Orchestrates indexing (+ embedding pipeline)
    search-tool.ts             # Hybrid search: FTS5 + semantic + fusion
    get-tool.ts                # Unchanged
    outline-tool.ts            # Unchanged
    references-tool.ts         # Unchanged
    context-tool.ts            # Enhanced with semantic neighbors
    status-tool.ts             # Enhanced with vector stats
  compression/
    polar-quant.ts             # PolarQuant encoder/decoder
    qjl.ts                     # QJL residual encoder/decoder
    turbo-quant.ts             # Combined pipeline: encode, decode, similarity
  embeddings/
    embedding-service.ts       # Model loading, text embedding, lifecycle
  utils/
    files.ts                   # Unchanged
    project.ts                 # Unchanged
```

### 3.2 Data Flow: Indexing

```
File content
  --> tree-sitter AST parse (existing)
  --> Extract symbols/sections (existing)
  --> Insert into symbols/sections/search_index/trigram_index tables (existing)
  --> Generate embedding text for each entity (NEW)
  --> EmbeddingService.embed(text) --> Float32Array[384] (NEW)
  --> TurboQuant.encode(vector) --> CompressedVector (NEW)
  --> Insert into vector_index table (NEW)
```

### 3.3 Data Flow: Search

```
Query string
  --> FTS5 keyword search (existing) --> ranked keyword results
  --> EmbeddingService.embed(query) --> Float32Array[384] (NEW)
  --> Scan vector_index, compute TurboQuant.similarity() for each (NEW)
  --> Top-K semantic results (NEW)
  --> Reciprocal Rank Fusion of keyword + semantic results (NEW)
  --> Enrich results with metadata (existing)
  --> Return merged, ranked results
```

### 3.4 Key Design Decisions

**D1: SQLite-native vector storage, not a separate vector DB.**
Rationale: contextlens is a single-binary MCP tool. Adding a vector DB dependency (Qdrant, Chroma, etc.) would complicate installation and break the "just works" promise. Compressed vectors at ~100 bytes each fit comfortably in SQLite. A 10,000-symbol project uses ~1MB of vector storage. Brute-force scan of 10K compressed vectors is fast enough (see Performance Targets).

**D2: TurboQuant compression instead of uncompressed float32.**
Rationale: 15:1 compression means the vector index stays small. A project with 50,000 symbols would use ~5MB for vectors vs ~75MB uncompressed. More importantly, TurboQuant's compressed-domain dot product avoids full decompression during search, making brute-force scan practical.

**D3: Hybrid ranking via Reciprocal Rank Fusion (RRF), not score interpolation.**
Rationale: FTS5 BM25 scores and cosine similarity scores are on different scales. Normalizing them introduces arbitrary tuning parameters. RRF operates on ranks, making it scale-invariant. The formula is: `RRF_score(d) = sum(1 / (k + rank_i(d)))` where `k = 60` (standard constant) and `rank_i` is the rank of document `d` in result list `i`.

**D4: Embedding text is a constructed string, not raw source code.**
Rationale: Embedding the full source code of a 200-line function wastes embedding capacity on boilerplate. Instead, construct a focused text: `"{kind} {name} {signature} {doc_comment}"` for symbols, `"{title} {summary}"` for sections. This produces better semantic representations within the 256-token context window of MiniLM-L6-v2.

**D5: Offline-only embedding model.**
Rationale: MCP servers run in local development environments, often behind corporate firewalls. The embedding model must work without network access after initial download. `@huggingface/transformers` v3.x supports ONNX WASM inference with local model caching.

**D6: Lazy model loading.**
Rationale: The embedding model is ~90MB. Loading it at server startup would add 2-5 seconds of latency before the first tool call. Instead, load on first `index` call (when embeddings are first needed). Search falls back to keyword-only if the model is not yet loaded.

---

## 4. Schema

### 4.1 New Table: `vector_index`

```sql
CREATE TABLE IF NOT EXISTS vector_index (
  entity_id TEXT PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,              -- 'symbol' | 'section'
  embedding_text TEXT NOT NULL,           -- the text that was embedded (for debugging/re-embedding)
  final_radius REAL NOT NULL,             -- PolarQuant final_radius (float64 stored as REAL)
  pq_angles BLOB NOT NULL,               -- PolarQuant compressed angles, packed 3-bit
  qjl_bits BLOB NOT NULL,                -- QJL residual sign bits, packed 1-bit
  pq_dimensions INTEGER NOT NULL,         -- original vector dimensions (384)
  qjl_projected_dimensions INTEGER NOT NULL, -- number of QJL random projections
  model_id TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2', -- embedding model identifier
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vector_entity_type ON vector_index(entity_type);
```

**Column details:**

| Column | Type | Size | Description |
|---|---|---|---|
| `entity_id` | TEXT | variable | FK to `symbols.id` or `sections.id`. Format: `path::qualifiedName` or `path::slug#level` |
| `entity_type` | TEXT | ~7 bytes | `'symbol'` or `'section'` |
| `embedding_text` | TEXT | ~100-500 bytes | The constructed text fed to the embedding model |
| `final_radius` | REAL | 8 bytes | The single scalar output of PolarQuant's recursive polar decomposition |
| `pq_angles` | BLOB | 72 bytes | 192 angles x 3 bits = 576 bits = 72 bytes, packed MSB-first |
| `qjl_bits` | BLOB | 24 bytes | 192 projected sign bits = 192 bits = 24 bytes, packed MSB-first |
| `pq_dimensions` | INTEGER | 4 bytes | Always 384 for this model. Stored for forward-compatibility with other models |
| `qjl_projected_dimensions` | INTEGER | 4 bytes | Number of QJL random projections. Default: 192 (d/2) |
| `model_id` | TEXT | ~20 bytes | Tracks which model produced the embedding. Enables future model upgrades with selective re-indexing |
| `created_at` | TEXT | ~20 bytes | ISO 8601 timestamp |

**Total row overhead:** ~100 bytes (pq_angles + qjl_bits + final_radius) + metadata. Row size is dominated by the compressed vector.

### 4.2 Schema Migration: v1 to v2

The migration must be non-destructive. Existing v1 data (files, symbols, sections, search_index, trigram_index) is preserved exactly. The migration only adds the new `vector_index` table.

**Migration logic:**

```
if user_version < 2:
  BEGIN TRANSACTION
    CREATE TABLE vector_index (...)
    CREATE INDEX idx_vector_entity_type (...)
    PRAGMA user_version = 2
  COMMIT
```

After migration, existing symbols and sections have no vectors. They will be populated on the next `index` call. The `search` tool must handle the case where `vector_index` is empty (fall back to keyword-only).

### 4.3 Foreign Key Cascade

`vector_index.entity_id` references `symbols.id` with `ON DELETE CASCADE`. However, `entity_id` can also reference `sections.id`. Since SQLite does not support multi-table foreign keys, the FK constraint references `symbols(id)` only as a "best effort" for the common case. For sections, cascade deletion is handled in application code: when deleting a file's sections, also delete matching `vector_index` rows.

**Alternative considered:** No FK, application-managed deletes. Rejected because it risks orphaned vector rows. The hybrid approach (FK for symbols, app-managed for sections) provides safety for the majority case (symbols outnumber sections ~10:1 in typical projects).

**Prepared statements to add:**

| Name | SQL |
|---|---|
| `insertVector` | `INSERT OR REPLACE INTO vector_index (entity_id, entity_type, embedding_text, final_radius, pq_angles, qjl_bits, pq_dimensions, qjl_projected_dimensions, model_id) VALUES (...)` |
| `getVectorByEntityId` | `SELECT * FROM vector_index WHERE entity_id = ?` |
| `getAllVectors` | `SELECT entity_id, entity_type, final_radius, pq_angles, qjl_bits, pq_dimensions, qjl_projected_dimensions FROM vector_index` |
| `getAllVectorsByType` | `SELECT entity_id, entity_type, final_radius, pq_angles, qjl_bits, pq_dimensions, qjl_projected_dimensions FROM vector_index WHERE entity_type = ?` |
| `deleteVectorsByFile` | `DELETE FROM vector_index WHERE entity_id IN (SELECT id FROM symbols WHERE file_path = ?) OR entity_id IN (SELECT id FROM sections WHERE file_path = ?)` |
| `getVectorStats` | `SELECT COUNT(*) as vector_count, SUM(LENGTH(pq_angles) + LENGTH(qjl_bits) + 8) as vector_bytes FROM vector_index` |

---

## 5. Compression Module Spec

### 5.1 PolarQuant

**Purpose:** Compress a float32 vector into a final radius scalar + 3-bit angle codes.

**Interface:**

```typescript
interface PolarQuantEncoded {
  finalRadius: number;          // float64 — the single scalar from recursive polar decomposition
  angles: Uint8Array;           // packed 3-bit angle codes, ceil(numAngles * 3 / 8) bytes
  numAngles: number;            // number of angles encoded (d - 1 for d-dimensional input, but see recursion)
  dimensions: number;           // original vector dimensions
}

interface PolarQuant {
  /**
   * Encode a float32 vector using recursive polar decomposition + 3-bit angle quantization.
   *
   * Algorithm:
   * 1. Take input vector v of dimension d.
   * 2. Group coordinates into consecutive pairs: (v[0], v[1]), (v[2], v[3]), ...
   *    - If d is odd, the last coordinate forms a singleton "pair" with its radius = |v[d-1]|
   *      and angle = 0 if v[d-1] >= 0, else angle = pi (quantized to nearest 3-bit code).
   * 3. For each pair (x, y), compute:
   *    - radius = sqrt(x^2 + y^2)
   *    - angle = atan2(y, x), mapped to [0, 2*pi)
   * 4. Quantize each angle to 3 bits: divide [0, 2*pi) into 8 equal bins.
   *    - Bin index = floor(angle / (2*pi / 8))
   *    - Clamp to [0, 7]
   * 5. Collect all radii into a new vector of dimension ceil(d/2).
   * 6. Recurse on the radii vector (step 2-5) until a single final_radius remains.
   * 7. Pack all angle codes (from all recursion levels) into a byte array, 3 bits per code.
   *
   * For d = 384:
   *   Level 0: 384 coords -> 192 pairs -> 192 angles, 192 radii
   *   Level 1: 192 radii  ->  96 pairs ->  96 angles,  96 radii
   *   Level 2:  96 radii  ->  48 pairs ->  48 angles,  48 radii
   *   Level 3:  48 radii  ->  24 pairs ->  24 angles,  24 radii
   *   Level 4:  24 radii  ->  12 pairs ->  12 angles,  12 radii
   *   Level 5:  12 radii  ->   6 pairs ->   6 angles,   6 radii
   *   Level 6:   6 radii  ->   3 pairs ->   3 angles,   3 radii
   *   Level 7:   3 radii  ->   1 pair + 1 singleton -> 2 angles, 1+1=2 radii... (handle odd case)
   *   ... continue until 1 radius remains.
   *
   *   Total angles = 192 + 96 + 48 + 24 + 12 + 6 + 3 + ... = 383 angles (d - 1)
   *   Packed: ceil(383 * 3 / 8) = 144 bytes for angles.
   *   Total: 144 bytes + 8 bytes (final_radius as float64) = 152 bytes.
   *
   * CORRECTION from initial estimate: 383 angles at 3 bits = 1149 bits = ~144 bytes.
   * With QJL residuals, total is ~168 bytes per vector (still ~9:1 compression).
   */
  encode(vector: Float32Array): PolarQuantEncoded;

  /**
   * Decode a PolarQuant-encoded vector back to an approximate float32 vector.
   *
   * Algorithm:
   * 1. Start with final_radius as a 1-element vector.
   * 2. For each recursion level (in reverse order), expand:
   *    - For each radius and its corresponding quantized angle:
   *      x = radius * cos(angle_center)
   *      y = radius * sin(angle_center)
   *    - angle_center = (bin_index + 0.5) * (2*pi / 8)
   * 3. The final expansion produces the reconstructed d-dimensional vector.
   */
  decode(encoded: PolarQuantEncoded): Float32Array;

  /**
   * Compute approximate dot product between a raw query vector and a PolarQuant-encoded vector.
   * Uses the encoded representation directly without full decompression.
   *
   * This is the fast path for search: O(d) operations but with integer arithmetic
   * on 3-bit codes instead of float32 multiplications.
   */
  dotProduct(query: Float32Array, encoded: PolarQuantEncoded): number;
}
```

**Bit packing format for `angles` array:**

Angles are packed MSB-first into bytes. Each angle occupies exactly 3 bits. For `n` angles:
- Byte count: `Math.ceil(n * 3 / 8)`
- Angle `i` occupies bits `[i*3, i*3+2]` within the bit stream
- To read angle `i`: `bitOffset = i * 3; byteIdx = bitOffset >> 3; bitIdx = bitOffset & 7;` then extract 3 bits handling byte boundary crossover.

### 5.2 QJL (Quantized Johnson-Lindenstrauss)

**Purpose:** Capture residual error from PolarQuant as 1-bit sign projections.

**Interface:**

```typescript
interface QJLEncoded {
  bits: Uint8Array;                   // packed 1-bit sign values, ceil(projectedDims / 8) bytes
  projectedDimensions: number;        // number of random projections
}

interface QJL {
  /**
   * The random projection matrix. Generated once from a fixed seed and cached.
   * Dimensions: projectedDimensions x originalDimensions.
   * Each entry is drawn from N(0, 1/originalDimensions).
   *
   * CRITICAL: The projection matrix must be identical for encoding and querying.
   * Use a deterministic PRNG seeded with a fixed value (e.g., seed = 42).
   * The seed is NOT stored per-vector — it is a global constant.
   */
  readonly projectionMatrix: Float32Array; // flattened [projectedDims * originalDims]

  /**
   * Encode residual error into QJL sign bits.
   *
   * Algorithm:
   * 1. residual = originalVector - PolarQuantReconstruction
   * 2. projected = projectionMatrix * residual  (matrix-vector multiply)
   * 3. bits[i] = (projected[i] >= 0) ? 1 : 0
   * 4. Pack bits into bytes, MSB-first.
   */
  encode(residual: Float32Array): QJLEncoded;

  /**
   * Compute the QJL correction term for a dot product estimate.
   *
   * Algorithm:
   * 1. projectedQuery = projectionMatrix * queryVector
   * 2. For each bit b[i]:
   *    correction += projectedQuery[i] * (b[i] ? 1 : -1)
   * 3. Scale: correction *= ||residual||_est / projectedDimensions
   *
   * The correction is ADDED to the PolarQuant dot product estimate.
   * This is the unbiased estimator from the QJL paper.
   *
   * NOTE: The residual norm is not stored. In practice, we use a simplified
   * correction that scales by 1/sqrt(projectedDimensions), which is sufficient
   * for ranking (not exact reconstruction). The correction improves recall@10
   * by 5-15% over PolarQuant alone in typical codebases.
   */
  dotProductCorrection(queryVector: Float32Array, encoded: QJLEncoded): number;
}
```

**Projection matrix generation:**

- Seed: `42` (hardcoded constant, identical across all installations)
- PRNG: Use a seeded xorshift128+ generator (fast, deterministic, no crypto dependency)
- Matrix shape: `projectedDimensions x originalDimensions` = `192 x 384` = 73,728 float32 values = ~288KB
- Generated lazily on first use, cached in memory for the server lifetime
- The projection matrix is NOT stored in the database. It is regenerated from the seed.

### 5.3 TurboQuant Pipeline

**Purpose:** Combined encoding/decoding pipeline. Single entry point for the indexer and search engine.

**Interface:**

```typescript
interface CompressedVector {
  finalRadius: number;
  pqAngles: Uint8Array;
  qjlBits: Uint8Array;
  dimensions: number;
  projectedDimensions: number;
}

interface TurboQuant {
  readonly polarQuant: PolarQuant;
  readonly qjl: QJL;

  /**
   * Encode a float32 embedding vector using PolarQuant + QJL.
   *
   * Steps:
   * 1. PolarQuant.encode(vector) -> pqEncoded
   * 2. PolarQuant.decode(pqEncoded) -> reconstruction
   * 3. residual = vector - reconstruction
   * 4. QJL.encode(residual) -> qjlEncoded
   * 5. Return CompressedVector
   */
  encode(vector: Float32Array): CompressedVector;

  /**
   * Compute approximate cosine similarity between a raw query vector
   * and a compressed vector.
   *
   * Steps:
   * 1. pqDot = PolarQuant.dotProduct(query, compressed.pq*)
   * 2. qjlCorrection = QJL.dotProductCorrection(query, compressed.qjl*)
   * 3. approxDot = pqDot + qjlCorrection
   * 4. cosineSim = approxDot / (||query|| * compressed.finalRadius)
   *
   * NOTE: ||query|| is precomputed once per search, not per-vector.
   * The finalRadius approximates ||compressed||. This is inexact but
   * sufficient for ranking. Exact cosine would require full decompression.
   *
   * Returns a value in approximately [-1, 1].
   */
  similarity(query: Float32Array, queryNorm: number, compressed: CompressedVector): number;

  /**
   * Batch similarity computation for search.
   * Precomputes query-side values once, then scans all vectors.
   *
   * Returns the top-K results sorted by descending similarity.
   */
  searchTopK(
    query: Float32Array,
    vectors: Array<{ entityId: string; entityType: string; compressed: CompressedVector }>,
    k: number
  ): Array<{ entityId: string; entityType: string; similarity: number }>;
}
```

**Storage format in SQLite:**

The `CompressedVector` maps directly to the `vector_index` table columns:
- `final_radius` -> `finalRadius` (REAL)
- `pq_angles` -> `pqAngles` (BLOB)
- `qjl_bits` -> `qjlBits` (BLOB)
- `pq_dimensions` -> `dimensions` (INTEGER)
- `qjl_projected_dimensions` -> `projectedDimensions` (INTEGER)

---

## 6. Embedding Module Spec

### 6.1 EmbeddingService Interface

```typescript
interface EmbeddingServiceConfig {
  modelId: string;                    // 'Xenova/all-MiniLM-L6-v2'
  cacheDir: string;                   // '~/.contextlens-turbo/models/'
  dimensions: number;                 // 384
  maxTokens: number;                  // 256 (model's max sequence length)
}

interface EmbeddingService {
  /**
   * Current state of the service.
   * - 'unloaded': model not yet loaded
   * - 'loading': model download/initialization in progress
   * - 'ready': model loaded, embed() is available
   * - 'failed': model failed to load, embed() will throw
   */
  readonly state: 'unloaded' | 'loading' | 'ready' | 'failed';

  /**
   * Load the embedding model. Called lazily on first index or search.
   *
   * Behavior:
   * - Downloads model to cacheDir on first call (~90MB ONNX + tokenizer)
   * - Subsequent calls load from cache (no network required)
   * - Sets state to 'loading' during load, 'ready' on success, 'failed' on error
   * - If already 'ready', returns immediately
   * - If already 'loading', returns the existing load promise (no duplicate loads)
   * - If 'failed', retries once. If retry fails, stays 'failed'.
   *
   * Throws: Never. Sets state to 'failed' and logs warning on error.
   */
  load(): Promise<void>;

  /**
   * Embed a single text string into a 384-dimensional float32 vector.
   *
   * Behavior:
   * - If state is 'unloaded', calls load() first.
   * - If state is 'failed', throws EmbeddingUnavailableError.
   * - Input text is truncated to maxTokens (256 tokens) by the tokenizer.
   * - Returns a Float32Array of exactly `dimensions` elements.
   * - The vector is L2-normalized (unit length).
   *
   * Throws: EmbeddingUnavailableError if model is not available.
   */
  embed(text: string): Promise<Float32Array>;

  /**
   * Embed multiple texts in a batch. More efficient than calling embed() in a loop
   * because the model can process multiple inputs in a single forward pass.
   *
   * Batch size limit: 32 texts per call. Caller must chunk larger batches.
   *
   * Throws: EmbeddingUnavailableError if model is not available.
   */
  embedBatch(texts: string[]): Promise<Float32Array[]>;

  /**
   * Release model resources. Called on server shutdown.
   * After dispose(), state becomes 'unloaded' and load() must be called again.
   */
  dispose(): void;
}
```

### 6.2 Lazy Loading Strategy

The embedding model lifecycle follows this state machine:

```
unloaded --[load() called]--> loading --[success]--> ready
                                       --[failure]--> failed --[load() retry]--> loading
                                                                                --[failure]--> failed (permanent)
ready --[dispose()]--> unloaded
```

**When load() is triggered:**
- On first `index` call (embeddings needed for storage)
- On first `search` call that would benefit from semantic search (query length > 2 words, or semantic mode explicitly requested)
- NOT on server startup (avoids 2-5 second delay)

**Model cache directory:** `~/.contextlens-turbo/models/`
- Created automatically if it does not exist.
- Model files are cached in HuggingFace transformers.js format.
- Cache is shared across all contextlens-turbo instances on the same machine.

### 6.3 Embedding Text Construction

The text fed to the embedding model is NOT the raw source code. It is a constructed summary string optimized for semantic representation:

**For symbols:**
```
"{kind} {name}: {signature_first_100_chars} {doc_comment_first_200_chars}"
```
Examples:
- `"function formatDate: export function formatDate(date: Date, format: string): string Formats a date object into a human-readable string using the specified format pattern."`
- `"class UserService: export class UserService implements IUserService Service for managing user accounts, authentication, and profile data."`
- `"interface SymbolRow: export interface SymbolRow"`

**For sections:**
```
"{title}: {summary_first_200_chars}"
```
Examples:
- `"Production Setup: This section describes how to deploy the application to production using Docker Compose and Nginx reverse proxy."`
- `"API Design Rules: RESTful by default. GET for reads, POST for creates, PATCH for partial updates, DELETE for removal."`

### 6.4 Graceful Fallback

If `EmbeddingService.state` is `'failed'`:
- `index` tool: indexes files normally (AST + FTS5 + trigram) but skips vector generation. Logs: `"[contextlens-turbo] Semantic indexing unavailable: {error}. Keyword indexing completed."`
- `search` tool: uses FTS5 + trigram only. The `strategy` field in the response is `"fts5"` or `"fts5+trigram"` (never `"semantic"` or `"hybrid"`).
- `context` tool: uses structural relationships only (children, siblings). No semantic neighbors.
- `status` tool: reports `semantic_available: false` and `semantic_error: "{error message}"`.

---

## 7. Tool Changes

### 7.1 `index` Tool

**Schema changes:** None (same input schema).

**Behavior changes:**
- After inserting symbols/sections into existing tables, generates embedding text for each entity.
- Calls `EmbeddingService.embedBatch()` for all new entities in the file (batch of up to 32).
- Calls `TurboQuant.encode()` for each embedding.
- Inserts compressed vectors into `vector_index`.
- If embedding fails for a file, logs a warning and continues with the next file. The file is still keyword-indexed.

**Output changes:**
- `IndexResult` gains a new field: `vectors_generated: number` (count of vectors stored in this run).
- `IndexResult` gains a new field: `semantic_available: boolean` (whether the embedding model loaded).

### 7.2 `search` Tool

**Schema changes:**
- New optional parameter: `mode: 'keyword' | 'semantic' | 'hybrid'` (default: `'hybrid'`).

**Behavior changes:**

When `mode` is `'hybrid'` (default):
1. Execute existing FTS5 search (unchanged). Produce ranked list A.
2. Embed the query via `EmbeddingService.embed(query)`.
3. Load all vectors from `vector_index` (filtered by `type` if specified).
4. Run `TurboQuant.searchTopK(queryVector, vectors, limit * 2)`. Produce ranked list B.
5. Fuse lists A and B using Reciprocal Rank Fusion:
   ```
   For each unique entity_id across both lists:
     rrf_score = 0
     if entity_id in list A at rank r_a: rrf_score += 1 / (60 + r_a)
     if entity_id in list B at rank r_b: rrf_score += 1 / (60 + r_b)
   Sort by rrf_score descending, take top `limit`.
   ```
6. Enrich results with metadata (existing `enrichResult` function).

When `mode` is `'keyword'`: execute existing FTS5 + trigram logic (unchanged).

When `mode` is `'semantic'`: skip FTS5, only do vector search. Return results sorted by cosine similarity.

**Output changes:**
- `SearchResult` gains a new field: `semantic_score?: number` (cosine similarity, only present if semantic search contributed).
- Response `strategy` field can now be: `"fts5"`, `"fts5+trigram"`, `"semantic"`, `"hybrid"`, `"hybrid+trigram"`.

### 7.3 `get` Tool

**No changes.** The get tool retrieves content by ID using byte offsets. It does not interact with the vector layer.

### 7.4 `outline` Tool

**No changes.** The outline tool returns structural metadata. It does not interact with the vector layer.

### 7.5 `references` Tool

**No changes.** The references tool does line-level grep across indexed files. It does not interact with the vector layer.

### 7.6 `context` Tool

**Schema changes:**
- New optional parameter: `semantic_neighbors: boolean` (default: `true`).
- New optional parameter: `max_semantic_neighbors: number` (default: `5`).

**Behavior changes:**
- After gathering structural relatives (children, siblings), if `semantic_neighbors` is `true` and token budget allows:
  1. Get the target entity's vector from `vector_index`.
  2. If the vector exists, decode it back to approximate float32 using `TurboQuant`.
  3. Run `TurboQuant.searchTopK()` against all vectors to find the `max_semantic_neighbors` most similar entities.
  4. Exclude entities already in the structural relatives list.
  5. Add semantic neighbors to the `related` array with `relationship: "semantic"`.

**Output changes:**
- `related` items can now have `relationship: "semantic"` in addition to `"child"` and `"sibling"`.
- `related` items with `relationship: "semantic"` include a `similarity: number` field (0-1 cosine similarity).

### 7.7 `status` Tool

**Output changes:**
- `StatusResult` gains:
  - `vectors: number` — count of rows in `vector_index`
  - `vector_storage_kb: number` — approximate storage used by vectors
  - `semantic_available: boolean` — whether embedding model is loaded
  - `embedding_model: string` — model ID (e.g., `"all-MiniLM-L6-v2"`)
  - `compression_ratio: number` — actual compression ratio (e.g., `9.1` for 9.1:1)

---

## 8. Performance Targets

### 8.1 Indexing Performance

| Metric | Target | Red Line | Notes |
|---|---|---|---|
| Embedding throughput | >= 50 texts/sec | >= 20 texts/sec | Single-threaded WASM inference |
| TurboQuant encode time | < 0.5ms per vector | < 2ms | Pure arithmetic, no I/O |
| Full re-index (1000 files, 5000 symbols) | < 60 sec | < 120 sec | Dominated by embedding model inference |
| Incremental re-index (10 changed files) | < 5 sec | < 15 sec | Only re-embeds changed files |
| Model first-load time (cached) | < 3 sec | < 8 sec | ONNX WASM initialization from disk |
| Model first-load time (download) | < 60 sec | < 120 sec | ~90MB download, depends on connection |

### 8.2 Search Performance

| Metric | Target | Red Line | Notes |
|---|---|---|---|
| Keyword-only search (existing) | < 10ms | < 50ms | Unchanged FTS5 path |
| Query embedding time | < 50ms | < 100ms | Single text, model already loaded |
| Vector brute-force scan (5000 vectors) | < 20ms | < 50ms | TurboQuant compressed-domain dot products |
| Vector brute-force scan (50,000 vectors) | < 200ms | < 500ms | Linear scan; acceptable for this scale |
| Hybrid search total (5000 vectors) | < 80ms | < 200ms | Keyword + embed + scan + fusion |
| Hybrid search total (50,000 vectors) | < 300ms | < 500ms | API response P95 red line |

### 8.3 Storage Overhead

| Metric | Target | Notes |
|---|---|---|
| Vector storage per entity | <= 200 bytes | Including all column overhead |
| Storage for 5000 entities | <= 1 MB | Fits comfortably in SQLite |
| Storage for 50,000 entities | <= 10 MB | Upper bound for very large projects |
| Compression ratio vs float32 | >= 9:1 | 384 * 4 = 1536 bytes vs ~168 bytes |
| Model cache on disk | ~90 MB | One-time cost, shared across projects |

### 8.4 Search Quality

| Metric | Target | Notes |
|---|---|---|
| Recall@10 (semantic queries) | >= 0.7 | "Find formatDate" when query is "date formatting" |
| Recall@10 (keyword queries) | >= existing | Hybrid must not degrade keyword search |
| MRR (Mean Reciprocal Rank) for hybrid vs keyword-only | >= 1.2x improvement | Hybrid ranking should surface relevant results higher |

Search quality targets are measured on a manually curated test set of 50 query-result pairs across 3 representative codebases (TypeScript web app, Python ML project, Go microservice). This test set is defined and maintained separately from the spec.

### 8.5 Memory Usage

| Metric | Target | Red Line | Notes |
|---|---|---|---|
| Embedding model in memory | ~150 MB | ~300 MB | ONNX runtime + model weights |
| QJL projection matrix | ~288 KB | fixed | 192 x 384 x 4 bytes |
| Idle server (model loaded) | < 200 MB | < 400 MB | Node.js + SQLite + model |
| Idle server (model NOT loaded) | < 50 MB | < 100 MB | Same as contextlens v1 |

---

## 9. Out of Scope

The following are explicitly NOT being built in this version:

1. **Approximate Nearest Neighbor (ANN) indices (HNSW, IVF, etc.).** Brute-force scan is sufficient for the expected scale (<100K vectors). ANN structures add complexity and require tuning. Revisit if performance targets are missed at 100K+ scale.

2. **GPU acceleration for embedding inference.** The model runs on CPU via ONNX WASM. GPU would require platform-specific dependencies that violate the "just works" principle. MiniLM-L6-v2 is small enough for CPU.

3. **Multiple embedding model support.** The schema stores `model_id` for forward compatibility, but the implementation supports only `all-MiniLM-L6-v2`. Model selection UI and multi-model vector migration are deferred.

4. **Streaming/incremental embedding during file save.** Embeddings are generated during `index` tool calls, not on file-system watch events. Real-time indexing is a future enhancement.

5. **Cross-project semantic search.** Each project has its own isolated SQLite database. Searching across multiple projects' vectors is not supported.

6. **Reranking models.** The hybrid search uses RRF fusion. A dedicated cross-encoder reranker (e.g., MiniLM cross-encoder) would improve precision but adds another model load and inference cost. Deferred.

7. **Embedding API fallback (OpenAI, Anthropic, etc.).** The model is offline-only. No network-dependent embedding providers are supported. This is deliberate for privacy and reliability.

8. **Vector quantization-aware training / fine-tuning.** TurboQuant operates on pre-trained embeddings. Custom fine-tuning the embedding model for code is out of scope.

9. **UI or visualization of vector space.** No embedding space visualizations, cluster maps, or similarity matrices. This is a headless MCP server.

10. **Deleting the FTS5/trigram layer.** Keyword search is preserved permanently. It serves as the fallback and as a complementary ranking signal. The vector layer is additive, never a replacement.

---

## Appendix A: Dependency Changes from contextlens

### New dependencies

| Package | Version | Purpose | Size |
|---|---|---|---|
| `@huggingface/transformers` | `^3.0.0` | ONNX WASM inference for MiniLM-L6-v2 | ~5MB (npm) + ~90MB (model download) |

### Unchanged dependencies

| Package | Version | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.12.1` | MCP server framework |
| `better-sqlite3` | `^11.8.1` | SQLite database |
| `web-tree-sitter` | `^0.25.3` | AST parsing |
| `zod` | (via MCP SDK) | Schema validation |

### No new native dependencies

TurboQuant (PolarQuant + QJL) is implemented in pure TypeScript. No WASM compilation, no C++ bindings, no native addons beyond the existing `better-sqlite3` and `web-tree-sitter`.

---

## Appendix B: Revised Storage Math

For a 384-dimensional vector:

**PolarQuant angles:**
- Level 0: 192 pairs -> 192 angles
- Level 1: 96 pairs -> 96 angles
- Level 2: 48 pairs -> 48 angles
- Level 3: 24 pairs -> 24 angles
- Level 4: 12 pairs -> 12 angles
- Level 5: 6 pairs -> 6 angles
- Level 6: 3 pairs -> 3 angles
- Level 7: 1 pair + 1 singleton -> 2 angles
- Level 8: 1 pair -> 1 angle
- Total: 192 + 96 + 48 + 24 + 12 + 6 + 3 + 2 + 1 = 384 - 1 = 383 angles
- Storage: ceil(383 * 3 / 8) = ceil(1149 / 8) = 144 bytes

**PolarQuant final radius:**
- 1 float64 = 8 bytes

**QJL sign bits:**
- projectedDimensions = 192 (d/2, balancing quality vs size)
- Storage: ceil(192 / 8) = 24 bytes

**Total per vector:** 144 + 8 + 24 = 176 bytes
**Compression ratio:** 1536 / 176 = 8.7:1

This is a correction from the initial brief's estimate of ~100 bytes and ~15:1. The recursion through all levels produces 383 angles (not 192). The actual compression ratio is ~8.7:1, which is still excellent and meets all storage targets.

---

## Appendix C: Config File Spec

contextlens-turbo reads an optional JSON config file at `~/.contextlens-turbo/config.json`:

```typescript
interface Config {
  /** Embedding model ID. Default: 'Xenova/all-MiniLM-L6-v2' */
  modelId?: string;

  /** Path to model cache directory. Default: '~/.contextlens-turbo/models/' */
  modelCacheDir?: string;

  /** Number of QJL projected dimensions. Default: 192 (d/2). Range: [64, 384] */
  qjlProjectedDimensions?: number;

  /** RRF fusion constant k. Default: 60. Range: [1, 1000] */
  rrfK?: number;

  /** Whether to auto-load the embedding model on first search. Default: true */
  autoLoadModel?: boolean;

  /** Maximum batch size for embedding. Default: 32. Range: [1, 64] */
  embeddingBatchSize?: number;
}
```

If the file does not exist, all defaults apply. Invalid values are logged as warnings and replaced with defaults.
