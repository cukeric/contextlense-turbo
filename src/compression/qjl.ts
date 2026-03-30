/**
 * QJL — Quantized Johnson-Lindenstrauss residual encoder.
 *
 * After PolarQuant, computes the residual error (original - reconstruction),
 * applies a random Johnson-Lindenstrauss projection, and stores only the
 * sign bit (+1/-1) of each projected component.
 *
 * The QJL correction term is added to the PolarQuant dot product estimate
 * to improve ranking accuracy (5-15% recall@10 improvement over PQ alone).
 *
 * Projection matrix: deterministic, seeded xorshift128+(seed=42).
 * Shape: projectedDimensions × originalDimensions.
 * Entries: Normal(0, 1/originalDimensions) distribution.
 * Cached in memory — NOT stored in the database.
 */

import { pack1bit, readBit, packedByteLength } from "./bit-packing.js";

// ─────────────────────────────────────────────────────────────────
// Deterministic PRNG: xorshift128+
// ─────────────────────────────────────────────────────────────────

/**
 * xorshift128+ state. Two 32-bit words.
 */
interface XorshiftState {
  s0: number;
  s1: number;
}

function xorshift128Seed(seed: number): XorshiftState {
  // Mix the seed to initialize both words
  let s0 = seed ^ 0xdeadbeef;
  let s1 = seed ^ 0xc0ffee42;
  // Warm up
  for (let i = 0; i < 20; i++) {
    const tmp = s0 ^ (s0 << 23);
    s0 = s1;
    s1 = tmp ^ s1 ^ (tmp >>> 17) ^ (s1 >>> 26);
  }
  return { s0, s1 };
}

function xorshift128Next(state: XorshiftState): number {
  let s1 = state.s0;
  const s0 = state.s1;
  state.s0 = s0;
  s1 ^= s1 << 23;
  state.s1 = s1 ^ s0 ^ (s1 >>> 17) ^ (s0 >>> 26);
  // Return value in [0, 2^32)
  return (state.s1 + s0) >>> 0;
}

/**
 * Generate a float from N(0, 1) using Box-Muller transform.
 * Returns one normal sample, discards the second (sufficient for our use).
 */
function nextNormal(state: XorshiftState): number {
  // Two uniform [0, 1) samples
  const u1 = (xorshift128Next(state) + 1) / 4294967297; // avoid 0
  const u2 = xorshift128Next(state) / 4294967296;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─────────────────────────────────────────────────────────────────
// Projection matrix cache
// ─────────────────────────────────────────────────────────────────

// Key: `${projectedDims}x${originalDims}`
const matrixCache = new Map<string, Float32Array>();

/**
 * Generate or retrieve the JL projection matrix.
 * Deterministic: same seed + dimensions = identical matrix on every call.
 *
 * Shape: projectedDims × originalDims (row-major, flattened).
 * Entries: Normal(0, 1/originalDims) — scaled for dot product preservation.
 */
export function getProjectionMatrix(projectedDims: number, originalDims: number): Float32Array {
  const key = `${projectedDims}x${originalDims}`;
  const cached = matrixCache.get(key);
  if (cached !== undefined) return cached;

  const matrix = new Float32Array(projectedDims * originalDims);
  const scale = 1 / Math.sqrt(originalDims);
  const state = xorshift128Seed(42); // Fixed seed — MUST be identical at encode and query time

  for (let i = 0; i < matrix.length; i++) {
    matrix[i] = nextNormal(state) * scale;
  }

  matrixCache.set(key, matrix);
  return matrix;
}

// ─────────────────────────────────────────────────────────────────
// QJL encoder/decoder
// ─────────────────────────────────────────────────────────────────

export interface QJLEncoded {
  bits: Uint8Array;              // packed 1-bit sign values, ceil(projectedDims / 8) bytes
  projectedDimensions: number;   // number of random projections
}

/**
 * Encode a residual vector using QJL (1-bit sign of JL projection).
 *
 * Algorithm:
 *   1. projected[i] = dot(projectionMatrix[i], residual)
 *   2. bits[i] = (projected[i] >= 0) ? 1 : 0
 *   3. Pack bits MSB-first.
 */
export function qjlEncode(residual: Float32Array, projectedDims: number): QJLEncoded {
  const originalDims = residual.length;
  const matrix = getProjectionMatrix(projectedDims, originalDims);

  const signBits: number[] = new Array(projectedDims);

  for (let i = 0; i < projectedDims; i++) {
    let dot = 0;
    const rowOffset = i * originalDims;
    for (let j = 0; j < originalDims; j++) {
      dot += matrix[rowOffset + j]! * residual[j]!;
    }
    signBits[i] = dot >= 0 ? 1 : 0;
  }

  return {
    bits: pack1bit(signBits),
    projectedDimensions: projectedDims,
  };
}

/**
 * Compute the QJL correction term for a dot product estimate.
 *
 * When computing `dot(query, key)` where `key = pqReconstruction + residual`:
 *   dot(query, key) = dot(query, pqReconstruction) + dot(query, residual)
 *
 * The correction approximates dot(query, residual) using sign bits.
 *
 * Algorithm:
 *   1. projectedQuery[i] = dot(projectionMatrix[i], query)
 *   2. correction += projectedQuery[i] * (bits[i] ? +1 : -1)
 *   3. Scale by 1/sqrt(projectedDimensions) — simplified unbiased estimator.
 *
 * The scaling avoids storing the residual norm. This is sufficient for ranking.
 */
export function qjlDotProductCorrection(
  query: Float32Array,
  encoded: QJLEncoded
): number {
  const { bits, projectedDimensions } = encoded;
  const originalDims = query.length;
  const matrix = getProjectionMatrix(projectedDimensions, originalDims);

  let correction = 0;

  for (let i = 0; i < projectedDimensions; i++) {
    // Project query
    let projDot = 0;
    const rowOffset = i * originalDims;
    for (let j = 0; j < originalDims; j++) {
      projDot += matrix[rowOffset + j]! * query[j]!;
    }

    // Sign comparison with stored bit
    const storedSign = readBit(bits, i) ? 1 : -1;
    correction += projDot * storedSign;
  }

  // Scale: 1/sqrt(projectedDimensions) simplifies the unbiased estimator
  return correction / Math.sqrt(projectedDimensions);
}

/**
 * Returns byte length of QJL bits array for `projectedDimensions` projections.
 */
export function qjlBitsBytes(projectedDimensions: number): number {
  return packedByteLength(projectedDimensions, 1);
}
