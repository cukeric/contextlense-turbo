/**
 * Unit tests for bit-packing.ts
 * Verifies pack/unpack round-trips for all three packing formats.
 */

import { describe, it, expect } from "vitest";
import {
  pack4bit,
  unpack4bit,
  pack3bit,
  unpack3bit,
  pack1bit,
  unpack1bit,
  packedByteLength,
} from "../bit-packing.js";

// ─────────────────────────────────────────────────────────────────
// packedByteLength
// ─────────────────────────────────────────────────────────────────

describe("packedByteLength", () => {
  it("computes 4-bit packed byte length correctly", () => {
    expect(packedByteLength(0, 4)).toBe(0);
    expect(packedByteLength(1, 4)).toBe(1);
    expect(packedByteLength(2, 4)).toBe(1);
    expect(packedByteLength(3, 4)).toBe(2);
    expect(packedByteLength(384, 4)).toBe(192);
  });

  it("computes 3-bit packed byte length correctly", () => {
    expect(packedByteLength(8, 3)).toBe(3);
    expect(packedByteLength(384, 3)).toBe(144);
  });

  it("computes 1-bit packed byte length correctly", () => {
    expect(packedByteLength(8, 1)).toBe(1);
    expect(packedByteLength(192, 1)).toBe(24);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4-bit pack/unpack round-trip
// ─────────────────────────────────────────────────────────────────

describe("pack4bit / unpack4bit", () => {
  it("round-trips a single value", () => {
    const values = [7];
    const packed = pack4bit(values);
    const unpacked = unpack4bit(packed, 1);
    expect(unpacked).toEqual(values);
  });

  it("round-trips two values (one full byte)", () => {
    const values = [5, 11];
    const packed = pack4bit(values);
    expect(packed.byteLength).toBe(1);
    const unpacked = unpack4bit(packed, 2);
    expect(unpacked).toEqual(values);
  });

  it("round-trips all 16 possible nibble values", () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const packed = pack4bit(values);
    expect(packed.byteLength).toBe(8);
    const unpacked = unpack4bit(packed, 16);
    expect(unpacked).toEqual(values);
  });

  it("round-trips an odd-length array (3 values)", () => {
    const values = [0, 15, 7];
    const packed = pack4bit(values);
    expect(packed.byteLength).toBe(2);
    const unpacked = unpack4bit(packed, 3);
    expect(unpacked).toEqual(values);
  });

  it("round-trips 384 random-ish 4-bit values", () => {
    // Values generated deterministically via xorshift-like sequence
    const values: number[] = Array.from({ length: 384 }, (_, i) => (i * 7 + 3) & 0xf);
    const packed = pack4bit(values);
    expect(packed.byteLength).toBe(192);
    const unpacked = unpack4bit(packed, 384);
    expect(unpacked).toEqual(values);
  });

  it("stores even-index values in the high nibble", () => {
    // value[0]=0xA in high nibble, value[1]=0x5 in low nibble → byte should be 0xA5
    const packed = pack4bit([0xa, 0x5]);
    expect(packed[0]).toBe(0xa5);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3-bit pack/unpack round-trip (legacy format, retained for reference)
// ─────────────────────────────────────────────────────────────────

describe("pack3bit / unpack3bit", () => {
  it("round-trips all 8 possible 3-bit values", () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7];
    const packed = pack3bit(values);
    const unpacked = unpack3bit(packed, 8);
    expect(unpacked).toEqual(values);
  });

  it("round-trips a sequence that spans byte boundaries", () => {
    // 3 values × 3 bits = 9 bits → spans byte 0 and byte 1
    const values = [7, 0, 5]; // 111 000 101
    const packed = pack3bit(values);
    const unpacked = unpack3bit(packed, 3);
    expect(unpacked).toEqual(values);
  });

  it("round-trips 384 values", () => {
    const values: number[] = Array.from({ length: 384 }, (_, i) => i % 8);
    const packed = pack3bit(values);
    expect(packed.byteLength).toBe(Math.ceil((384 * 3) / 8)); // 144 bytes
    const unpacked = unpack3bit(packed, 384);
    expect(unpacked).toEqual(values);
  });
});

// ─────────────────────────────────────────────────────────────────
// 1-bit pack/unpack round-trip (QJL sign bits)
// ─────────────────────────────────────────────────────────────────

describe("pack1bit / unpack1bit", () => {
  it("round-trips 8 bits into exactly 1 byte", () => {
    const bits = [1, 0, 1, 1, 0, 0, 1, 0]; // 0b10110010 = 0xB2
    const packed = pack1bit(bits);
    expect(packed.byteLength).toBe(1);
    expect(packed[0]).toBe(0b10110010);
    const unpacked = unpack1bit(packed, 8);
    expect(unpacked).toEqual(bits);
  });

  it("round-trips 192 sign bits (QJL default projection count)", () => {
    const bits: number[] = Array.from({ length: 192 }, (_, i) => i % 2);
    const packed = pack1bit(bits);
    expect(packed.byteLength).toBe(24);
    const unpacked = unpack1bit(packed, 192);
    expect(unpacked).toEqual(bits);
  });

  it("round-trips all-zeros and all-ones", () => {
    const zeros = new Array(16).fill(0);
    expect(unpack1bit(pack1bit(zeros), 16)).toEqual(zeros);

    const ones = new Array(16).fill(1);
    expect(unpack1bit(pack1bit(ones), 16)).toEqual(ones);
  });
});
