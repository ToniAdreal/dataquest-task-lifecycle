import test from "node:test";
import assert from "node:assert/strict";
import { fromMinorUnits, toMinorUnits } from "../src/index.js";

/**
 * `toMinorUnits` / `fromMinorUnits` property / fuzz tests
 * (backlog #1239).
 *
 * The fixed-case suite (`minorUnits.test.ts`) only pins a handful of
 * conversions (`19.99` -> `1999`, `10.005` -> `1001`) and two
 * rejection strings. The converter is the money entry point for
 * reconciliation, CSV import, and settlement summaries, so its
 * rounding semantics (nearest cent, half-cent boundary, negative
 * amounts) and its overflow rejection are covered here with seeded
 * random corpora instead of hand-picked samples:
 *
 *   - round-trip: 500+ random amounts (edge values, random exactly
 *     2-decimal amounts, half-cent boundary values, random 3-decimal
 *     amounts, random large amounts) — `fromMinorUnits` of the
 *     converted value is always within half a cent of the input,
 *     and exactly equal for the exactly-2-decimal amounts.
 *   - rejection:  200+ random fractional minor units — every one
 *     throws a clear `minor units must be an integer` error.
 *   - overflow:   200+ random overflow amounts (non-finite, huge
 *     finite values whose cent product overflows the double range)
 *     — every one throws a clear `minor units conversion
 *     overflowed` error.
 *
 * Seed 20261118 is written down in the source so any run is
 * byte-identical; regenerating each corpus from the same seed is
 * asserted equal to the first run. mulberry32 is the same generator
 * as the sibling fuzz corpora (escrow #16, deterministic sequences,
 * `parseMinorUnitsFuzz` #1215).
 */

/** Fixed seed — change this and every corpus below is reproducible. */
const SEED = 20261118;

/** mulberry32: tiny, deterministic, good-enough PRNG for test corpora. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max] (inclusive), from a seeded generator. */
function pickInt(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/**
 * One round-trip case: the amount, plus whether it has exactly two
 * decimal places (built as integer cents / 100), in which case the
 * round-trip must be exact rather than merely within half a cent.
 */
interface AmountCase {
  value: number;
  exact: boolean;
}

/**
 * The round-trip corpus: fixed edge values plus seeded random
 * amounts. Count is asserted >= 500 in the test.
 */
function generateAmounts(): AmountCase[] {
  const rand = mulberry32(SEED);
  const amounts: AmountCase[] = [
    { value: 0, exact: true },
    { value: 0.01, exact: true },
    { value: -0.01, exact: true },
    { value: 0.005, exact: false },
    { value: -0.005, exact: false },
    { value: 0.015, exact: false },
    { value: -0.015, exact: false },
    { value: 2.675, exact: false },
    { value: 10.005, exact: false },
    { value: -10.005, exact: false },
    { value: 0.125, exact: false },
    { value: 0.333, exact: false },
    { value: 0.999, exact: false },
    { value: 1.005, exact: false },
    { value: 100.005, exact: false },
    { value: 1234.565, exact: false },
    { value: 9999.995, exact: false },
    { value: 0.004, exact: false },
    { value: 0.006, exact: false },
    { value: 19.99, exact: true },
    { value: 0.29, exact: true },
    { value: 3750.5, exact: true },
  ];
  // Random exactly-2-decimal amounts, built as integer cents / 100
  // so the input double is the nearest double to that decimal value.
  // Small magnitudes, both signs.
  for (let i = 0; i < 250; i++) {
    amounts.push({ value: pickInt(rand, -100000, 100000) / 100, exact: true });
  }
  // Medium magnitudes, both signs.
  for (let i = 0; i < 100; i++) {
    amounts.push({
      value: pickInt(rand, -100000000, 100000000) / 100,
      exact: true,
    });
  }
  // Large magnitudes (amounts up to 1e10, cents up to 1e12 — far
  // inside the safe range, so `amount * 100` stays exact enough
  // for Math.round to land on the intended integer).
  for (let i = 0; i < 50; i++) {
    amounts.push({
      value: pickInt(rand, -1000000000000, 1000000000000) / 100,
      exact: true,
    });
  }
  // Half-cent boundary values: odd numerator / 200, i.e. x.xx5.
  // These sit exactly on the rounding boundary in decimal; the
  // double nearest to them is a hair above or below it, so they are
  // the cases that stress the half-cent bound below.
  for (let i = 0; i < 100; i++) {
    const numerator = 2 * pickInt(rand, -50000, 50000) + 1;
    amounts.push({ value: numerator / 200, exact: false });
  }
  // Random 3-decimal amounts, both signs.
  for (let i = 0; i < 60; i++) {
    amounts.push({
      value: Number((rand() * 2000 - 1000).toFixed(3)),
      exact: false,
    });
  }
  return amounts;
}

/**
 * The fractional-minor-units corpus: fixed edge values plus seeded
 * random non-integers (an integer plus a fractional part). Count is
 * asserted >= 200 in the test.
 */
function generateFractionalMinorUnits(): number[] {
  const rand = mulberry32(SEED);
  const values: number[] = [
    10.5,
    -10.5,
    0.5,
    0.001,
    0.999,
    1e-7,
    -0.5,
    Number.NaN,
    Infinity,
    -Infinity,
  ];
  const fractions = [0.1, 0.25, 0.5, 0.75, 0.001, 0.999];
  for (let i = 0; i < 200; i++) {
    const whole = pickInt(rand, -1000000000000, 1000000000000);
    values.push(whole + fractions[i % fractions.length]);
  }
  return values;
}

/**
 * The overflow corpus: fixed edge values plus seeded random huge
 * amounts. Every entry must make `toMinorUnits` throw: the non-finite
 * ones fail the finiteness check, the huge finite ones overflow the
 * double range when multiplied by 100 (`1.8e306 * 100` is already
 * past `Number.MAX_VALUE`). Count is asserted >= 200 in the test.
 */
function generateOverflowAmounts(): number[] {
  const rand = mulberry32(SEED);
  const values: number[] = [
    Number.NaN,
    Infinity,
    -Infinity,
    1e308,
    -1e308,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    1.8e306,
    -1.8e306,
  ];
  // Random huge magnitudes: (1.8 .. 8.8)e306, both signs. The amount
  // itself stays finite (below MAX_VALUE); only amount * 100
  // overflows, which is exactly the failure the converter guards.
  for (let i = 0; i < 110; i++) {
    const magnitude = (1.8 + rand() * 7) * 1e306;
    values.push(rand() < 0.5 ? -magnitude : magnitude);
  }
  // Hugging the overflow threshold from above: 1.8e306 * (1 .. 1.001).
  for (let i = 0; i < 100; i++) {
    const magnitude = 1.8e306 * (1 + rand() * 0.001);
    values.push(rand() < 0.5 ? -magnitude : magnitude);
  }
  return values;
}

test("toMinorUnits/fromMinorUnits round-trip over 500+ random amounts", () => {
  const amounts = generateAmounts();
  assert.ok(amounts.length >= 500, `expected >= 500 cases, got ${amounts.length}`);
  for (const { value: x, exact } of amounts) {
    const minor = toMinorUnits(x);
    assert.ok(Number.isInteger(minor), `toMinorUnits(${x}) must be an integer, got ${minor}`);
    const back = fromMinorUnits(minor);
    // The converter rounds to the nearest cent, so the round-trip
    // error is at most half a cent — plus binary-float representation
    // noise at the half-cent boundary (observed worst excess over
    // this corpus is ~5.2e-14, far inside the 1e-9 slack below).
    assert.ok(
      Math.abs(back - x) <= 0.005 + 1e-9,
      `round-trip of ${x} must stay within half a cent, got ${back} (diff ${Math.abs(back - x)})`,
    );
    // An amount with exactly two decimals converts to its exact
    // cent count and back to the identical double.
    if (exact) {
      assert.equal(back, x, `exact round-trip of ${x}`);
    }
  }
});

test("fromMinorUnits rejects 200+ random fractional minor units", () => {
  const values = generateFractionalMinorUnits();
  assert.ok(values.length >= 200, `expected >= 200 cases, got ${values.length}`);
  for (const value of values) {
    assert.throws(
      () => fromMinorUnits(value),
      /minor units must be an integer, got /,
      `expected ${value} to be rejected`,
    );
  }
});

test("toMinorUnits rejects 200+ random overflow amounts", () => {
  const values = generateOverflowAmounts();
  assert.ok(values.length >= 200, `expected >= 200 cases, got ${values.length}`);
  for (const value of values) {
    assert.throws(
      () => toMinorUnits(value),
      /minor units conversion overflowed/,
      `expected ${value} to be rejected`,
    );
  }
});

test("same seed regenerates identical corpora (determinism)", () => {
  assert.deepEqual(generateAmounts(), generateAmounts());
  assert.deepEqual(generateFractionalMinorUnits(), generateFractionalMinorUnits());
  assert.deepEqual(generateOverflowAmounts(), generateOverflowAmounts());
});
