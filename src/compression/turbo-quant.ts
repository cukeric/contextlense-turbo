/**
 * TurboQuant — combined PolarQuant + QJL compression pipeline.
 *
 * Single entry point for the indexer (encode) and search engine (similarity, searchTopK).
 *
 * Two-stage architecture:
 *   Stage 1: PolarQuant — coarse representation with 3-bit angles
 *   Stage 2: QJL — residual error correction with 1-bit sign projections
 *
 * Approximate cosine similarity:
 *   sim(query, compressed) = (pqDot + qjlCorrection) / (||query|| * finalRadius)
 */

import {
  polarQuantEncode,
  polarQuantDecode,
  polarQuantDotProduct,
  l2Norm,
  type PolarQuantEncoded,
} from "./polar-quant.js";
import { qjlEncode, qjlDotProductCorrection, type QJLEncoded } from "./qjl.js";

// QJL random projections.
// Lower = faster search (O(projectedDims × dims) per candidate), slightly less residual correction.
// 64 is the sweet spot for 4-bit PolarQuant: PQ already provides ~0.95 cosine accuracy,
// so QJL is a correction term, not the primary signal. 64 projections vs 192 = 3x faster scan.
const DEFAULT_QJL_PROJECTED_DIMS = 64;

export interface CompressedVector {
  finalRadius: number;           // PolarQuant final scalar magnitude
  pqAngles: Uint8Array;          // PolarQuant 3-bit packed angle codes
  qjlBits: Uint8Array;           // QJL 1-bit packed residual sign bits
  dimensions: number;            // Original vector dimensions
  numAngles: number;             // Number of PolarQuant angle codes
  projectedDimensions: number;   // Number of QJL projections
}

export interface ScoredId {
  entityId: string;
  score: number;
}

/**
 * Encode a float32 embedding vector using TurboQuant (PolarQuant + QJL).
 *
 * Steps:
 *   1. Normalize the input vector to unit length (cosine similarity requires this)
 *   2. PolarQuant encode → pqEncoded
 *   3. Decode PolarQuant → reconstruction
 *   4. Compute residual = original - reconstruction
 *   5. QJL encode residual → qjlEncoded
 *   6. Return CompressedVector
 */
export function turboQuantEncode(
  vector: Float32Array,
  projectedDims: number = DEFAULT_QJL_PROJECTED_DIMS
): CompressedVector {
  // Step 1: L2-normalize for cosine similarity
  const norm = l2Norm(vector);
  const normalized = norm > 1e-10
    ? Float32Array.from(vector, (x) => x / norm)
    : vector;

  // Step 2: PolarQuant encode
  const pqEncoded: PolarQuantEncoded = polarQuantEncode(normalized);

  // Step 3: Decode to get reconstruction
  const reconstruction = polarQuantDecode(pqEncoded);

  // Step 4: Compute residual
  const residual = new Float32Array(vector.length);
  for (let i = 0; i < normalized.length; i++) {
    residual[i] = normalized[i]! - reconstruction[i]!;
  }

  // Step 5: QJL encode residual
  const qjlEncoded: QJLEncoded = qjlEncode(residual, projectedDims);

  return {
    finalRadius: pqEncoded.finalRadius,
    pqAngles: pqEncoded.angles,
    qjlBits: qjlEncoded.bits,
    dimensions: vector.length,
    numAngles: pqEncoded.numAngles,
    projectedDimensions: projectedDims,
  };
}

/**
 * Compute approximate cosine similarity between a raw query vector and a CompressedVector.
 *
 * Steps:
 *   1. Normalize query to unit vector
 *   2. Reconstruct pqEncoded struct from CompressedVector fields
 *   3. pqDot = PolarQuant dot product (query · pq_reconstruction)
 *   4. qjlCorrection = QJL correction term
 *   5. approxDot = pqDot + qjlCorrection
 *   6. cosineSim = approxDot / (||query_normalized|| · compressed.finalRadius)
 *      Since both are normalized: cosineSim ≈ approxDot / finalRadius
 *
 * The result is an approximate cosine similarity in approximately [-1, 1].
 * Suitable for ranking; not suitable for exact distance computation.
 */
export function turboQuantSimilarity(
  query: Float32Array,
  compressed: CompressedVector
): number {
  // Normalize query
  const queryNorm = l2Norm(query);
  const normalizedQuery = queryNorm > 1e-10
    ? Float32Array.from(query, (x) => x / queryNorm)
    : query;

  // Reconstruct PolarQuantEncoded interface for dot product computation
  const pqEncoded: PolarQuantEncoded = {
    finalRadius: compressed.finalRadius,
    angles: compressed.pqAngles,
    numAngles: compressed.numAngles,
    dimensions: compressed.dimensions,
  };

  // PolarQuant dot product (normalized query · normalized pq reconstruction)
  const pqDot = polarQuantDotProduct(normalizedQuery, pqEncoded);

  // QJL correction
  const qjlEncoded: QJLEncoded = {
    bits: compressed.qjlBits,
    projectedDimensions: compressed.projectedDimensions,
  };
  const qjlCorrection = qjlDotProductCorrection(normalizedQuery, qjlEncoded);

  const approxDot = pqDot + qjlCorrection;

  // Cosine similarity: approxDot / finalRadius (since query is unit-length after normalization)
  // finalRadius ≈ 1 for normalized vectors, but include it for robustness
  if (compressed.finalRadius < 1e-10) return 0;
  return approxDot / compressed.finalRadius;
}

/**
 * Scan a list of (entityId, compressed) pairs and return the top-K by similarity.
 * This is the brute-force vector search path.
 *
 * Performance: O(n * d) where d=384 for a full brute-force scan.
 * At 10,000 symbols with d=384: ~4M float operations, ~2-5ms on modern CPU.
 */
export function searchTopK(
  query: Float32Array,
  candidates: Array<{ entityId: string; compressed: CompressedVector }>,
  k: number
): ScoredId[] {
  if (candidates.length === 0) return [];

  // Normalize query once — reused across all similarity calls
  const queryNorm = l2Norm(query);
  const normalizedQuery = queryNorm > 1e-10
    ? Float32Array.from(query, (x) => x / queryNorm)
    : query;

  // Score all candidates
  const scored: ScoredId[] = candidates.map(({ entityId, compressed }) => ({
    entityId,
    score: turboQuantSimilarity(normalizedQuery, compressed),
  }));

  // Partial sort: find top-K without fully sorting
  if (scored.length <= k) {
    return scored.sort((a, b) => b.score - a.score);
  }

  // For large candidate sets, use a min-heap approach (simulated with sort for correctness)
  // TODO: replace with a proper min-heap for very large indices (>50K symbols)
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Compute the exact number of angle codes produced by polarQuantEncode for a d-dimensional input.
 *
 * PolarQuant collects ceil(size/2) angles at each recursion level as `size` shrinks from d to 1.
 * This is NOT equal to d-1 for non-powers-of-2.
 *
 * Example for d=384: 192+96+48+24+12+6+3+2+1 = 384 (not 383).
 */
function computeNumAngles(d: number): number {
  let total = 0;
  let size = d;
  while (size > 1) {
    total += Math.ceil(size / 2);
    size = Math.ceil(size / 2);
  }
  return total;
}

/**
 * Deserialize a CompressedVector from raw SQLite BLOB values.
 * SQLite returns BLOBs as Buffer objects in better-sqlite3.
 */
export function deserializeCompressedVector(row: {
  final_radius: number;
  pq_angles: Buffer;
  qjl_bits: Buffer;
  pq_dimensions: number;
  qjl_projected_dimensions: number;
  entity_id: string;
}): { entityId: string; compressed: CompressedVector } {
  // numAngles is deterministically computable from pq_dimensions.
  // Uses the exact recursion structure of polarQuantEncode — NOT pq_dimensions - 1.
  const numAngles = computeNumAngles(row.pq_dimensions);

  return {
    entityId: row.entity_id,
    compressed: {
      finalRadius: row.final_radius,
      pqAngles: new Uint8Array(row.pq_angles),
      qjlBits: new Uint8Array(row.qjl_bits),
      dimensions: row.pq_dimensions,
      numAngles,
      projectedDimensions: row.qjl_projected_dimensions,
    },
  };
}
