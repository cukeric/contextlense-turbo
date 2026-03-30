<div align="center">

# ContextLens Turbo

**Semantic MCP server — hybrid vector + keyword retrieval for AI coding agents**

[![npm version](https://img.shields.io/npm/v/@cukeric/contextlens-turbo?style=flat-square&color=7C3AED)](https://www.npmjs.com/package/@cukeric/contextlens-turbo)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-brightgreen?style=flat-square)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)
[![Semantic Search](https://img.shields.io/badge/search-hybrid%20vector%20%2B%20FTS5-7C3AED?style=flat-square)](#how-it-works)

The original ContextLens retrieves code precisely. **Turbo understands what you mean.**

*Natural language queries · Offline embeddings · 6.9× compressed vectors · Zero API keys*

</div>

---

## ContextLens vs ContextLens Turbo

> **Short answer:** same 7 tools, same token efficiency — Turbo adds a semantic brain.

```
                    ContextLens              ContextLens Turbo
                    ───────────              ─────────────────

Query: "format timestamps"

  Keyword match:   formatTimestamp ✓         formatTimestamp ✓
  Semantic match:  ✗ (not found)             toISOString     ✓
                                             parseDate       ✓
                                             dateUtils       ✓
```

| Capability | ContextLens | ContextLens Turbo |
|---|:---:|:---:|
| Keyword search (FTS5 + trigram) | ✅ | ✅ |
| Fuzzy / stemmed matching | ✅ | ✅ |
| **Semantic / vector search** | ✗ | ✅ |
| **Natural language queries** | ✗ | ✅ |
| **Hybrid ranking (RRF fusion)** | ✗ | ✅ |
| **Semantic context neighbors** | ✗ | ✅ |
| Offline — no API keys | ✅ | ✅ |
| Graceful FTS5 fallback | N/A | ✅ |
| Storage per indexed symbol | 0 bytes (vectors) | ~224 bytes |
| Embedding model | None | `all-MiniLM-L6-v2` (offline ONNX) |

---

## The Problem ContextLens Couldn't Solve

ContextLens is great at finding `formatDate` when you search `format`. It fails when your vocabulary doesn't match the source code:

```
You search:    "timestamp formatter"
Code has:      function toISOString(date: Date) { ... }

ContextLens:   0 results  ← keyword mismatch
Turbo:         toISOString, parseDate, formatRelative, ...  ← semantic match
```

**ContextLens Turbo embeds both your query and the codebase into the same 384-dimensional vector space**, then ranks results by meaning — not just string overlap. Keyword search remains as a parallel signal, merged via Reciprocal Rank Fusion.

---

## How It Works

```
                        INDEX PIPELINE
  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  │  Source file  →  tree-sitter AST  →  symbol text   │
  │                                          ↓          │
  │                               all-MiniLM-L6-v2      │
  │                               (384-dim, ONNX/WASM)  │
  │                                          ↓          │
  │                             TurboQuant compression  │
  │                          PolarQuant (3-bit angles)  │
  │                        + QJL (1-bit residuals)      │
  │                                          ↓          │
  │                          ~224 bytes / vector        │
  │                         (vs 1,536 uncompressed)     │
  │                          6.9× smaller in SQLite     │
  └─────────────────────────────────────────────────────┘

                        SEARCH PIPELINE
  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  │  Query  ──→  FTS5 keyword search  ──→  ranked list  │
  │    │                                       │        │
  │    └──→  embed query  ──→  TurboQuant  ──→ │        │
  │               cosine similarity            │        │
  │                                            ↓        │
  │               Reciprocal Rank Fusion (RRF)          │
  │          score = 1/(60+kw_rank) + 1/(60+sem_rank)   │
  │                                            ↓        │
  │                        unified result list          │
  └─────────────────────────────────────────────────────┘
```

### TurboQuant Compression

The semantic magic fits in ~224 bytes per vector through two stages:

| Stage | Algorithm | Output | Ratio |
|-------|-----------|--------|-------|
| **PolarQuant** | Recursive polar decomposition, 3-bit angle quantization | 200 bytes | — |
| **QJL** | Johnson-Lindenstrauss residual, 1-bit sign encoding | 24 bytes | — |
| **Combined** | PolarQuant + QJL packed | **224 bytes** | **6.9× vs float32** |

> Round-trip cosine similarity ≥ 0.95. Pure TypeScript — zero native dependencies.

---

## Tools

Same 7 tools as ContextLens, with `search` and `context` supercharged:

| Tool | What it does | Turbo enhancement |
|------|-------------|:-----------------:|
| `index` | Parse & index project (incremental) | Generates semantic vectors |
| `search` | Find symbols/sections by name | **Hybrid: keyword + semantic** |
| `get` | Retrieve content by ID with token budget | Unchanged |
| `outline` | File skeleton — symbols/headings | Unchanged |
| `references` | Find all usages of a symbol | Unchanged |
| `context` | Smart bundle — target + related | **Semantic neighbors** |
| `status` | Index stats, vector count, model state | Vector stats added |

**Tool description overhead: ~1,200 tokens** — same as ContextLens, unchanged.

---

## Token Savings

Measured on a 26K LOC TypeScript/React project (179 files, 2,348 symbols):

| Scenario | Full file read | ContextLens Turbo | Savings |
|----------|:------------:|:-----------------:|:-------:|
| Find one function in 800-line file | 3,200 tokens | 800 tokens | **75%** |
| Semantic search with natural language | 15,000 tokens | 1,400 tokens | **91%** |
| `context` with semantic neighbors | 22,000 tokens | 4,200 tokens | **81%** |
| Explore unfamiliar codebase | 40,000+ tokens | 6,000 tokens | **85%** |

---

## Installation

### Option 1 — npx (Zero install, recommended)

```json
{
  "mcpServers": {
    "contextlens-turbo": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cukeric/contextlens-turbo"]
    }
  }
}
```

### Option 2 — Global install

```bash
npm install -g @cukeric/contextlens-turbo
```

```json
{
  "mcpServers": {
    "contextlens-turbo": {
      "type": "stdio",
      "command": "contextlens-turbo"
    }
  }
}
```

### Option 3 — Local dev

```bash
git clone git@github.com:cukeric/contextlens-turbo.git
cd contextlens-turbo && npm install && npm run build
```

```json
{
  "mcpServers": {
    "contextlens-turbo": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/contextlens-turbo/dist/index.js"]
    }
  }
}
```

---

## Agent Setup

<details>
<summary><strong>Claude Code</strong></summary>

Add `.mcp.json` to your project root using Option 1. Claude Code reads it automatically.

The session-start `index` call will also download and cache the embedding model (~23MB) on first run. Subsequent sessions load it from `~/.contextlens-turbo/models/` in milliseconds.

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "contextlens-turbo": {
      "command": "npx",
      "args": ["-y", "@cukeric/contextlens-turbo"]
    }
  }
}
```

</details>

<details>
<summary><strong>GitHub Copilot (VS Code)</strong></summary>

Add to VS Code `settings.json`:

```json
{
  "github.copilot.chat.experimental.mcpServers": {
    "contextlens-turbo": {
      "command": "npx",
      "args": ["-y", "@cukeric/contextlens-turbo"]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor / Windsurf</strong></summary>

Add to `.cursor/mcp.json` or `.windsurf/mcp.json` using the same format as Claude Code.

</details>

---

## Usage

```
1.  index     →  parse project + generate semantic vectors (~2–5s cold, ~40ms incremental)
2.  search    →  natural language or keyword — hybrid results ranked by meaning
3.  get       →  retrieve exactly what's needed (with token budget)
4.  context   →  target + structural relatives + semantic neighbors
```

### Natural language search in practice

```
search("how do I authenticate users")
  → getSession, verifyToken, authMiddleware, requireAuth, ...

search("database connection setup")
  → createPool, initDatabase, connectPrisma, ...

search("format date for display")
  → formatDate, toRelativeTime, toISOString, dateUtils, ...
```

### Graceful fallback

If the embedding model fails to load (memory constraints, WASM unavailable), all 7 tools continue working via FTS5 keyword search. No crashes. The `status` tool reports whether semantic search is active.

---

## Language & Format Support

### Code (tree-sitter AST — all grammars bundled)

| Language | Extensions |
|----------|-----------|
| TypeScript / TSX | `.ts` `.tsx` |
| JavaScript / JSX | `.js` `.jsx` |
| Python | `.py` |
| Go | `.go` |
| Rust | `.rs` |

### Docs (heading hierarchy)

`.md` · `.mdx` · `.rst` · `.txt` · `.adoc`

---

## Performance

Measured on a 26K LOC project (179 files, 2,348 symbols):

| Metric | ContextLens | ContextLens Turbo |
|--------|:-----------:|:-----------------:|
| Cold index | 2.2s | ~5–8s (+ embedding) |
| Incremental index (no changes) | 39ms | ~40ms |
| Model load (first time) | N/A | ~3s (downloads ~23MB) |
| Model load (cached) | N/A | ~200ms |
| Search latency | ~15ms | ~20ms (hybrid) |
| DB size | 2.5 MB | ~3.0 MB |
| Bytes per vector | 0 | ~224 bytes |
| Compression ratio | N/A | **6.9:1** |

---

## Limitations

- **First-run model download** — ~23MB ONNX model downloaded to `~/.contextlens-turbo/models/` on first `index` call. Fully cached after that.
- **No real-time file watching** — index updates when you call `index`, not on file changes.
- **Single project scope** — one root per instance, indexes from the `.git` root.
- **Semantic search is approximate** — uses compressed 3-bit vectors. Round-trip cosine similarity ≥ 0.95, not lossless.
- **Memory** — embedding model holds ~50MB in memory while the server runs.

---

## Which version should I use?

| Use ContextLens if... | Use ContextLens Turbo if... |
|---|---|
| You need zero cold-start overhead | You want "find anything by meaning" |
| Your codebase is well-named and consistent | Your codebase has inconsistent naming |
| You have strict memory constraints | You want semantic `context` bundles |
| You only need keyword/fuzzy matching | You want natural language queries |

Both produce identical tool schemas — you can swap between them without changing your agent workflow.

---

## Prerequisites

- **Node.js 20+** (LTS recommended)
- Any MCP-compatible coding agent
- ~100MB disk (model cache)
- ~100MB memory (model runtime)

### Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon & Intel) | Fully supported |
| Linux (x64, arm64) | Fully supported |
| Windows (x64) | Supported (WSL recommended) |

---

## License

MIT — Copyright (c) 2026 [Davor Cukeric](https://davor.cukeric.com)

[github.com/cukeric](https://github.com/cukeric)
