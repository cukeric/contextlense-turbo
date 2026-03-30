/**
 * Bit-packing utilities for compressed vector storage.
 *
 * Three formats:
 *   - 4-bit packing: for PolarQuant angle codes (values 0-15, two nibbles per byte)
 *   - 3-bit packing: legacy, retained for reference — NOT used in current pipeline
 *   - 1-bit packing: for QJL sign bits (values 0 or 1)
 *
 * 4-bit packing: value[i] at high nibble (i even) or low nibble (i odd) of byte floor(i/2).
 * All packing is MSB-first within each byte.
 */

// ─────────────────────────────────────────────────────────────────
// 4-bit packing (PolarQuant angles, values 0–15, two nibbles per byte)
// ─────────────────────────────────────────────────────────────────

/**
 * Pack an array of 4-bit values (0–15) into a Uint8Array.
 * Two values per byte: value[2i] in high nibble, value[2i+1] in low nibble.
 */
export function pack4bit(values: readonly number[]): Uint8Array {
  const byteLen = packedByteLength(values.length, 4);
  const buf = new Uint8Array(byteLen);

  for (let i = 0; i < values.length; i++) {
    const v = values[i]! & 0xf;
    if ((i & 1) === 0) {
      // Even index: high nibble
      buf[i >> 1] = (buf[i >> 1]! & 0x0f) | (v << 4);
    } else {
      // Odd index: low nibble
      buf[i >> 1] = (buf[i >> 1]! & 0xf0) | v;
    }
  }

  return buf;
}

/**
 * Unpack a Uint8Array of 4-bit values back into a number array.
 */
export function unpack4bit(buf: Uint8Array, count: number): number[] {
  const values: number[] = new Array(count);

  for (let i = 0; i < count; i++) {
    if ((i & 1) === 0) {
      values[i] = (buf[i >> 1]! >> 4) & 0xf;
    } else {
      values[i] = buf[i >> 1]! & 0xf;
    }
  }

  return values;
}

// ─────────────────────────────────────────────────────────────────
// 3-bit packing (legacy — NOT used in current pipeline)
// ─────────────────────────────────────────────────────────────────

/**
 * Returns the number of bytes needed to store `n` values of `bitsPerValue` bits each.
 */
export function packedByteLength(n: number, bitsPerValue: number): number {
  return Math.ceil((n * bitsPerValue) / 8);
}

/**
 * Pack an array of 3-bit values (0–7) into a Uint8Array.
 * Bit layout: value[0] occupies bits 7-5 of byte 0, value[1] occupies bits 4-2 of byte 0, etc.
 */
export function pack3bit(values: readonly number[]): Uint8Array {
  const byteLen = packedByteLength(values.length, 3);
  const buf = new Uint8Array(byteLen);

  for (let i = 0; i < values.length; i++) {
    const v = values[i]! & 0x7; // clamp to 3 bits
    const bitOffset = i * 3;
    const byteIdx = bitOffset >> 3;
    const bitIdx = bitOffset & 7; // bit position within byte (0 = MSB)

    // Write 3 bits starting at bitIdx within byteIdx.
    // May span two bytes if bitIdx > 5.
    const shift = 5 - bitIdx; // how far to shift v into the first byte

    if (shift >= 0) {
      // All 3 bits fit in one byte
      buf[byteIdx] = (buf[byteIdx]! | (v << shift)) & 0xff;
    } else {
      // Spans two bytes: -shift bits overflow into byteIdx+1
      const overflow = -shift;
      buf[byteIdx] = (buf[byteIdx]! | (v >> overflow)) & 0xff;
      buf[byteIdx + 1] = (buf[byteIdx + 1]! | ((v << (8 - overflow)) & 0xff)) & 0xff;
    }
  }

  return buf;
}

/**
 * Unpack a Uint8Array of 3-bit values back into a number array.
 */
export function unpack3bit(buf: Uint8Array, count: number): number[] {
  const values: number[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const bitOffset = i * 3;
    const byteIdx = bitOffset >> 3;
    const bitIdx = bitOffset & 7;

    const shift = 5 - bitIdx;

    let v: number;
    if (shift >= 0) {
      v = (buf[byteIdx]! >> shift) & 0x7;
    } else {
      const overflow = -shift;
      const hi = (buf[byteIdx]! << overflow) & 0x7;
      const lo = buf[byteIdx + 1]! >> (8 - overflow);
      v = (hi | lo) & 0x7;
    }

    values[i] = v;
  }

  return values;
}

// ─────────────────────────────────────────────────────────────────
// 1-bit packing (QJL sign bits, values 0 or 1)
// ─────────────────────────────────────────────────────────────────

/**
 * Pack an array of sign bits (0 or 1) into a Uint8Array, MSB-first.
 * Bit `i` maps to: byteIndex = floor(i / 8), bitPos = 7 - (i % 8).
 */
export function pack1bit(bits: readonly number[]): Uint8Array {
  const byteLen = packedByteLength(bits.length, 1);
  const buf = new Uint8Array(byteLen);

  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      const byteIdx = i >> 3;
      const bitPos = 7 - (i & 7); // MSB-first
      buf[byteIdx] = buf[byteIdx]! | (1 << bitPos);
    }
  }

  return buf;
}

/**
 * Unpack 1-bit values from a Uint8Array.
 * Returns array of 0/1 values.
 */
export function unpack1bit(buf: Uint8Array, count: number): number[] {
  const bits: number[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const byteIdx = i >> 3;
    const bitPos = 7 - (i & 7);
    bits[i] = (buf[byteIdx]! >> bitPos) & 1;
  }

  return bits;
}

/**
 * Read a single bit from a packed buffer.
 * Used in hot-path similarity computation.
 */
export function readBit(buf: Uint8Array, index: number): number {
  return (buf[index >> 3]! >> (7 - (index & 7))) & 1;
}
