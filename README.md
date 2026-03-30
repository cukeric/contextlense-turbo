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

```mermaid
flowchart LR
    Q["🔎 query:\n'timestamp formatter'"]

    subgraph CL["ContextLens"]
        KW1["FTS5 keyword\nmatch"]
        R1["❌ 0 results\nno keyword overlap"]
    end

    subgraph CT["ContextLens Turbo"]
        KW2["FTS5 keyword\nmatch"]
        SEM["384-dim\nvector similarity"]
        RRF["Reciprocal\nRank Fusion"]
        R2["✅ toISOString\n✅ parseDate\n✅ formatRelative\n✅ dateUtils"]
    end

    Q --> CL
    Q --> CT
    KW1 --> R1
    KW2 & SEM --> RRF --> R2
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
| Storage per indexed symbol | 0 bytes | ~224 bytes |
| Embedding model | None | `all-MiniLM-L6-v2` (ONNX, offline) |

---

## Architecture

```mermaid
flowchart TD
    subgraph src["Your Project"]
        direction LR
        code["Source Code\n.ts .py .go .rs .js"]
        docs["Documentation\n.md .rst .txt"]
    end

    subgraph parse["Parse Layer"]
        ast["tree-sitter AST"]
        docp["Heading Hierarchy"]
    end

    subgraph embed["Semantic Layer"]
        model["all-MiniLM-L6-v2\n384-dim · ONNX · offline\n~23MB download once"]
        tq["TurboQuant Compression\nPolarQuant + QJL\n1,536 bytes → 224 bytes"]
    end

    subgraph store["SQLite Index"]
        sym["Symbols + Sections"]
        fts["FTS5 Index"]
        vec["Vector Index\n~224 bytes / symbol"]
    end

    subgraph search["Search Pipeline"]
        kw["Keyword Search\nFTS5 + trigram"]
        sem["Semantic Search\ncosine similarity"]
        rrf["Reciprocal Rank Fusion\nscore = 1÷(60+kw) + 1÷(60+sem)"]
    end

    agent["🤖 AI Agent"]

    code --> ast --> sym & fts
    docs --> docp --> sym
    ast & docp --> model --> tq --> vec

    sym --> store
    fts --> store
    vec --> store

    agent -->|query| kw & sem
    kw & sem --> rrf
    rrf -->|ranked results| agent
```

---

## TurboQuant Compression Pipeline

Raw embedding vectors are 1,536 bytes each. TurboQuant compresses them in two stages:

```mermaid
flowchart LR
    IN["float32 vector\n384 dimensions\n1,536 bytes"]

    subgraph pq["Stage 1 — PolarQuant"]
        direction TB
        pq1["Recursive polar\ndecomposition"]
        pq2["3-bit angle\nquantization\n16 bins · ±π/16 error"]
        pq3["200 bytes"]
        pq1 --> pq2 --> pq3
    end

    subgraph qjl["Stage 2 — QJL"]
        direction TB
        qjl1["Johnson-Lindenstrauss\nrandom projection\n192 dimensions"]
        qjl2["1-bit sign\nencoding"]
        qjl3["24 bytes\nresidual correction"]
        qjl1 --> qjl2 --> qjl3
    end

    OUT["Compressed\n224 bytes\n6.9× smaller\n≥ 0.95 cosine fidelity\nPure TypeScript · zero native deps"]

    IN --> pq --> qjl --> OUT
```

```mermaid
pie title Storage per vector
    "Compressed — TurboQuant (224 bytes)" : 224
    "Savings vs float32 (1,312 bytes)" : 1312
```

---

## Hybrid Search Flow

```mermaid
sequenceDiagram
    participant Agent as 🤖 AI Agent
    participant CL as ContextLens Turbo
    participant FTS as FTS5 Index
    participant VEC as Vector Index
    participant RRF as RRF Fusion

    Agent->>CL: search("how do I authenticate users")
    CL->>FTS: keyword match: "authenticate users"
    FTS-->>CL: [authMiddleware #3, verifyToken #7, ...]

    CL->>CL: embed query → 384-dim vector → TurboQuant
    CL->>VEC: cosine similarity scan
    VEC-->>CL: [getSession #1, requireAuth #2, verifyToken #4, ...]

    CL->>RRF: merge keyword + semantic ranks
    RRF-->>CL: fused scores
    CL-->>Agent: getSession · verifyToken · requireAuth · authMiddleware · ...
```

---

## Index Pipeline

```mermaid
sequenceDiagram
    participant Agent as 🤖 AI Agent
    participant CL as ContextLens Turbo
    participant DB as SQLite

    Agent->>CL: index()
    CL->>CL: walk files, hash content
    CL->>DB: skip unchanged files
    CL->>CL: tree-sitter AST → extract symbols
    CL->>CL: embed symbols → TurboQuant compress
    CL->>DB: store symbols + vectors
    DB-->>CL: 2,637 symbols · 5.5MB
    CL-->>Agent: ready in ~20s (cold) / <2s (incremental)
```

---

## Token Savings

```mermaid
xychart-beta
    title "Tokens consumed — Full file read vs ContextLens Turbo"
    x-axis ["Find function", "Semantic NL search", "Context + neighbors", "Explore codebase"]
    y-axis "Tokens" 0 --> 45000
    bar [3200, 15000, 22000, 40000]
    bar [800, 1400, 4200, 6000]
```

| Scenario | Full read | ContextLens Turbo | Savings |
|----------|----------:|:-----------------:|:-------:|
| Find one function in 800-line file | 3,200 | 800 | **75%** |
| Semantic search with natural language | 15,000 | 1,400 | **91%** |
| `context` with semantic neighbors | 22,000 | 4,200 | **81%** |
| Explore unfamiliar codebase | 40,000+ | 6,000 | **85%** |

---

## Tools

Same 7 tools as ContextLens — `search` and `context` supercharged:

| Tool | What it does | Turbo enhancement |
|------|-------------|:-----------------:|
| `index` | Parse & index project (incremental) | Generates semantic vectors |
| `search` | Find symbols/sections by name | **Hybrid: keyword + semantic** |
| `get` | Retrieve content by ID with token budget | Unchanged |
| `outline` | File skeleton — symbols/headings | Unchanged |
| `references` | Find all usages of a symbol | Unchanged |
| `context` | Smart bundle — target + related | **Semantic neighbors** |
| `status` | Index stats, vector count, model state | Vector stats added |

**Tool description overhead: ~1,200 tokens** — identical to ContextLens.

---

## Natural Language Search in Practice

```
search("how do I authenticate users")
  → getSession, verifyToken, authMiddleware, requireAuth

search("database connection setup")
  → createPool, initDatabase, connectPrisma

search("format date for display")
  → formatDate, toRelativeTime, toISOString, dateUtils

search("error boundary handling")
  → ErrorBoundary, handleError, withErrorBoundary, fallbackUI
```

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
git clone git@github.com:cukeric/contextlense-turbo.git
cd contextlense-turbo && npm install && npm run build
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

Add `.mcp.json` to your project root. Claude Code reads it automatically.

The first `index` call downloads and caches the embedding model (~23MB) to `~/.contextlens-turbo/models/`. Subsequent sessions load it in ~200ms.

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

## Performance

| Metric | ContextLens | ContextLens Turbo |
|--------|:-----------:|:-----------------:|
| Cold index (188-file project) | ~2s | ~20s |
| Incremental (3–5 changed files) | <100ms | <2s |
| Model load (first time) | N/A | ~3s + 23MB download |
| Model load (cached) | N/A | ~200ms |
| Search latency | ~15ms | ~20ms |
| DB size | 2.5 MB | ~5.5 MB |
| Bytes per vector | 0 | **224 bytes** |
| Compression ratio | N/A | **6.9:1** |

---

## Which Version Should I Use?

```mermaid
flowchart TD
    Q["Which ContextLens?"]

    Q --> A{"Strict memory\nor cold-start\nconstraints?"}
    A -->|Yes| CL["ContextLens\ngithub.com/cukeric/contextlens"]
    A -->|No| B{"Codebase has\ninconsistent\nnaming?"}
    B -->|No| C{"Need natural\nlanguage\nqueries?"}
    C -->|No| CL
    C -->|Yes| CT["ContextLens Turbo\ngithub.com/cukeric/contextlense-turbo"]
    B -->|Yes| CT
```

Both produce identical MCP tool schemas — swap between them without changing your agent workflow.

---

## Limitations

- **First-run model download** — ~23MB to `~/.contextlens-turbo/models/`. Fully cached after that.
- **No real-time file watching** — index updates on `index` calls, not on file changes.
- **Semantic search is approximate** — ≥0.95 cosine similarity, not lossless.
- **Memory** — embedding model holds ~50MB while the server runs.
- **Graceful fallback** — if the model fails to load, all 7 tools continue working via FTS5.

---

## License

MIT — Copyright (c) 2026 [Davor Cukeric](https://davor.cukeric.com) · [github.com/cukeric](https://github.com/cukeric)
