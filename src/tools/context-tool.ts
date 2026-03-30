import type Database from "better-sqlite3";
import type { Statements } from "../store/database.js";
import type { EmbeddingService } from "../embeddings/embedding-service.js";
import { handleGet } from "./get-tool.js";
import { handleReferences } from "./references-tool.js";
import { searchTopK, deserializeCompressedVector } from "../compression/turbo-quant.js";

export interface ContextResult {
  target: {
    id: string;
    content: string;
    tokens: number;
  };
  related: Array<{
    id: string;
    relationship: "child" | "sibling" | "semantic_neighbor";
    name: string;
    file: string;
    signature?: string;
    similarity?: number;
  }>;
  references: Array<{
    file: string;
    line: number;
    context: string;
  }>;
  total_tokens: number;
}

/**
 * Enhanced smart context assembly — structural relationships + semantic neighbors.
 *
 * Token budget allocation:
 *   - 60% target content
 *   - 25% related (structural: child/sibling first, then semantic neighbors)
 *   - 15% references
 *
 * Enhancement over contextlens: semantic neighbors from TurboQuant similarity
 * are added after structural relationships, within remaining token budget.
 */
export async function handleContext(
  args: { id: string; max_tokens?: number; include_references?: boolean },
  projectRoot: string,
  db: Database.Database,
  stmts: Statements,
  embeddingService: EmbeddingService
): Promise<ContextResult> {
  const maxTokens = args.max_tokens ?? 3000;
  const includeRefs = args.include_references ?? true;

  const targetBudget = Math.floor(maxTokens * 0.6);
  const relatedBudget = Math.floor(maxTokens * 0.25);
  const refBudget = Math.floor(maxTokens * 0.15);

  // Get the target content
  const target = handleGet({ id: args.id, max_tokens: targetBudget }, projectRoot, stmts);

  const related: ContextResult["related"] = [];
  let relatedTokensUsed = 0;

  // ── Structural relationships (priority) ──────────────────────────────────
  if (target.type === "symbol") {
    // Children first
    const children = stmts.getSymbolChildren.all(args.id) as any[];
    for (const child of children) {
      if (relatedTokensUsed > relatedBudget) break;
      related.push({
        id: child.id,
        relationship: "child",
        name: child.name,
        file: child.file_path,
        signature: child.signature,
      });
      relatedTokensUsed += (child.signature?.length ?? 0) / 4;
    }

    // Siblings in same file
    const filePath = target.metadata.file as string;
    if (filePath) {
      const siblings = stmts.getSymbolsByFile.all(filePath) as any[];
      for (const sib of siblings) {
        if (sib.id === args.id) continue;
        if (relatedTokensUsed > relatedBudget * 0.7) break; // Reserve 30% for semantic
        related.push({
          id: sib.id,
          relationship: "sibling",
          name: sib.name,
          file: sib.file_path,
          signature: sib.signature,
        });
        relatedTokensUsed += (sib.signature?.length ?? 0) / 4;
      }
    }
  } else if (target.type === "section") {
    const children = stmts.getSectionChildren.all(args.id) as any[];
    for (const child of children) {
      if (relatedTokensUsed > relatedBudget) break;
      related.push({
        id: child.id,
        relationship: "child",
        name: child.title,
        file: child.file_path,
      });
      relatedTokensUsed += child.title.length / 4;
    }
  }

  // ── Semantic neighbors (fill remaining budget) ────────────────────────────
  const relatedBudgetRemaining = relatedBudget - relatedTokensUsed;
  if (relatedBudgetRemaining > 50 && embeddingService.isReady()) {
    // Get the stored vector for the target entity
    const targetVectorRow = stmts.getVectorByEntityId.get(args.id) as any;

    if (targetVectorRow !== undefined) {
      const { compressed: targetCompressed } = deserializeCompressedVector(targetVectorRow);

      // For semantic search we need the query as a raw float32 vector.
      // We re-embed the target's stored embedding_text to get the query vector.
      const targetEmbedding = await embeddingService.embed(targetVectorRow.embedding_text as string);

      if (targetEmbedding !== null) {
        // Get all vectors (excluding the target itself)
        const allRows = stmts.getAllVectors.all() as Array<{
          entity_id: string;
          entity_type: string;
          final_radius: number;
          pq_angles: Buffer;
          qjl_bits: Buffer;
          pq_dimensions: number;
          qjl_projected_dimensions: number;
        }>;

        const candidates = allRows
          .filter((r) => r.entity_id !== args.id)
          .map((row) => deserializeCompressedVector(row));

        const alreadyIncludedIds = new Set(related.map((r) => r.id));
        const semanticNeighbors = searchTopK(targetEmbedding, candidates, 10)
          .filter((r) => !alreadyIncludedIds.has(r.entityId) && r.score > 0.5);

        for (const neighbor of semanticNeighbors) {
          if (relatedTokensUsed > relatedBudget) break;

          // Enrich with metadata
          const isSection = /#{1}\d+$/.test(neighbor.entityId);
          if (!isSection) {
            const sym = stmts.getSymbolById.get(neighbor.entityId) as any;
            if (sym) {
              related.push({
                id: neighbor.entityId,
                relationship: "semantic_neighbor",
                name: sym.name,
                file: sym.file_path,
                signature: sym.signature,
                similarity: Math.round(neighbor.score * 100) / 100,
              });
              relatedTokensUsed += (sym.signature?.length ?? 0) / 4;
            }
          } else {
            const sec = stmts.getSectionById.get(neighbor.entityId) as any;
            if (sec) {
              related.push({
                id: neighbor.entityId,
                relationship: "semantic_neighbor",
                name: sec.title,
                file: sec.file_path,
                similarity: Math.round(neighbor.score * 100) / 100,
              });
              relatedTokensUsed += sec.title.length / 4;
            }
          }
        }
      }
    }
  }

  // ── References (usage sites) ──────────────────────────────────────────────
  const references: ContextResult["references"] = [];
  if (includeRefs && target.type === "symbol") {
    const name = target.metadata.name as string;
    if (name) {
      const refs = handleReferences({ name, limit: 10 }, db, stmts, projectRoot);
      for (const ref of refs.references) {
        references.push(ref);
      }
    }
  }

  const refsTokens = references.reduce((acc, r) => acc + r.context.length / 4, 0);

  return {
    target: {
      id: target.id,
      content: target.content,
      tokens: target.tokens,
    },
    related,
    references,
    total_tokens: target.tokens + relatedTokensUsed + refsTokens,
  };
}
