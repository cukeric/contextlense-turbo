# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Summary

**contextlens-turbo** — MCP context inspection tool with 3-bit semantic vector search. Upgrades contextlens from keyword-only (FTS5) retrieval to a hybrid engine: FTS5 + TurboQuant-compressed semantic search (PolarQuant + QJL algorithms). 6x memory reduction, 8x similarity computation speedup, zero accuracy loss.

## Tech Stack

- **Language:** TypeScript 5.7 (strict, ESM)
- **Protocol:** MCP (Model Context Protocol) via `@modelcontextprotocol/sdk`
- **Runtime:** Node.js 20+
- **Storage:** SQLite via `better-sqlite3` (WAL mode, schema v2)
- **Parsing:** `web-tree-sitter` WASM grammars (11+ languages)
- **Embeddings:** `@huggingface/transformers` v3.x — `Xenova/all-MiniLM-L6-v2` (384-dim, ONNX/WASM, offline)
- **Compression:** PolarQuant (3-bit angles) + QJL (1-bit residuals) — pure TypeScript, zero dependencies

## Development Commands

```bash
npm install
npm run build      # tsc compile
npm run dev        # tsc --watch
npm run lint       # tsc --noEmit (type-check only)
node dist/index.js # start MCP server
```

## Architecture

```
src/
  index.ts                    # MCP server entry — registers 7 tools
  compression/
    bit-packing.ts            # 3-bit/1-bit pack/unpack utilities
    polar-quant.ts            # PolarQuant: recursive polar decomposition, 3-bit angle quantization
    qjl.ts                    # QJL: Johnson-Lindenstrauss residual, 1-bit sign encoding
    turbo-quant.ts            # Combined pipeline: encode(), similarity(), searchTopK()
  embeddings/
    embedding-service.ts      # Lazy-loaded @huggingface/transformers wrapper
  store/
    database.ts               # Schema v2: adds vector_index table to v1 via non-destructive migration
  indexers/
    code-indexer.ts           # AST parse + embedding generation (enhanced)
    doc-indexer.ts            # Section parse + embedding generation (enhanced)
  tools/
    index-tool.ts             # Orchestrates indexing + vector pipeline
    search-tool.ts            # Hybrid search: FTS5 + TurboQuant semantic + RRF fusion
    get-tool.ts               # Unchanged from contextlens
    outline-tool.ts           # Unchanged from contextlens
    references-tool.ts        # Unchanged from contextlens
    context-tool.ts           # Enhanced: semantic neighbors via TurboQuant similarity
    status-tool.ts            # Enhanced: vector stats (count, bytes, model status)
  utils/
    files.ts                  # Unchanged from contextlens
    project.ts                # Unchanged from contextlens
```

## Key Design Decisions

**Compression math (d=384):**
- PolarQuant: 384 angles × 4 bits = 192 bytes + 8 bytes (final_radius float64) = 200 bytes
  - Note: angle count = sum(ceil(size/2)) as size shrinks from 384→1 = 192+96+...+1 = 384 (NOT d-1=383)
  - 4-bit encoding (16 bins, ±π/16 max quantization error) achieves ≥0.95 round-trip cosine similarity
- QJL: 192 projected dimensions × 1 bit = 24 bytes
- Total per vector: ~224 bytes vs 1536 bytes uncompressed ≈ 6.9:1 compression
- Projection matrix: 192×384 float32, seeded xorshift128+(seed=42), generated once in memory

**Hybrid search RRF formula:**
`score(d) = 1/(60 + rank_keyword) + 1/(60 + rank_semantic)` — scale-invariant, no tuning required

**Embedding text construction:**
- Symbol: `"{kind} {name} {signature} {docComment}"`
- Section: `"{title} {summary}"`

**Schema migration:** v1→v2 adds `vector_index` (additive). v2→v3 drops and recreates `vector_index` without FK (fixes section inserts) and clears 3-bit data (incompatible with 4-bit encoder). Users re-run `index` after v3 upgrade.

**FK strategy:** `vector_index.entity_id` has NO FK constraint — section entity IDs are not in the symbols table, so a FK would block section vector inserts. Referential integrity is app-managed: `deleteVectorsByFile` subselects from both symbols and sections.

## Deployment

Local/self-hosted MCP tool. No VPS deployment. Install as MCP server in Claude Code:
```json
{
  "mcpServers": {
    "contextlens-turbo": {
      "command": "node",
      "args": ["/path/to/contextlens-turbo/dist/index.js"]
    }
  }
}
```

## Commit Convention

`feat:`, `fix:`, `chore:`, `docs:` (Conventional Commits)

---

## WHISK-Harness Configuration

```yaml
harness_enabled: true
hard_threshold: 7
max_iterations: 5
stack_type: MCP              # TypeScript / Node.js / MCP
evaluator_focus:
  functionality: 50          # Algorithms must be mathematically correct — this is the core
  craft: 30                  # Clean TypeScript, strict types, no hacks
  design: 10                 # MCP tool schema quality
  originality: 10
sprint_contracts: docs/sprints/
specs: docs/specs/
```

**Evaluator notes:**
- Test PolarQuant encode→decode round-trip: cosine similarity of reconstructed vs original must be ≥ 0.95
- Test TurboQuant similarity ranking: similar vectors must score higher than dissimilar ones
- Verify all 7 MCP tools start and respond correctly
- Test graceful fallback: if EmbeddingService fails, `search` must still return FTS5 results
- Verify schema migration: v1 database must migrate to v2 without data loss
