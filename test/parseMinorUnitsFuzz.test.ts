import test from "node:test";
import assert from "node:assert/strict";
import { formatMinorUnits, parseMinorUnits } from "../src/index.js";

/**
 * `parseMinorUnits` / `formatMinorUnits` property / fuzz tests
 * (backlog #1215).
 *
 * The fixed-case suite (`parseMinorUnits.test.ts`) only pins a handful
 * of round-trip integers and rejection strings. The parser is the
 * money entry point for reconciliation and CSV import, so its strictness
 * (at most 2 decimal places, no thousands separator, no scientific
 * notation, exact integer arithmetic) is covered here with seeded
 * random corpora instead of hand-picked samples:
 *
 *   - round-trip:  500+ random safe integers (edge values, small
 *                    magnitudes, random 15-digit numbers, values hugging
 *                    the 2^53 boundary) — `parse(format(n)) === n`,
 *                    never `-0`, and the formatted string matches an
 *                    independent BigInt oracle.
 *   - strict:      200+ random strict decimal strings (optional minus,
 *                    0–2 decimals, random leading zeros and surrounding
 *                    whitespace) — the parsed value matches hand-computed
 *                    integer arithmetic.
 *   - rejection:   200+ random bad strings (3 decimals, thousands
 *                    separators, scientific notation, empty, non-numeric,
 *                    over-safe-range integers) — every one throws a
 *                    clear `invalid minor units amount` / overflow error.
 *
 * Seed 20261117 is written down in the source so any run is
 * byte-identical; regenerating each corpus from the same seed is
 * asserted equal to the first run. mulberry32 is the same generator
 * as the sibling fuzz corpora (escrow #16, deterministic sequences).
 */

/** Fixed seed — change this and every corpus below is reproducible. */
const SEED = 20261117;

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
 * Independent oracle for `formatMinorUnits`, written with BigInt
 * instead of the implementation's float integer arithmetic, so a
 * shared arithmetic slip cannot hide in both.
 */
function expectedFormat(n: number): string {
  const value = BigInt(n);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / 100n;
  const cents = abs % 100n;
  return `${sign}${whole}.${cents.toString().padStart(2, "0")}`;
}

/**
 * The round-trip corpus: fixed edge values plus seeded random integers
 * across the whole safe range. Count is asserted >= 500 in the test.
 */
function generateIntegers(): number[] {
  const rand = mulberry32(SEED);
  const integers: number[] = [
    0,
    1,
    -1,
    2,
    -2,
    50,
    -50,
    99,
    -99,
    100,
    -100,
    9999,
    -9999,
    1000000,
    -1000000,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER - 1,
    -(Number.MAX_SAFE_INTEGER - 1),
    Number.MAX_SAFE_INTEGER - 99,
    -(Number.MAX_SAFE_INTEGER - 99),
    Number.MAX_SAFE_INTEGER - 100,
    -(Number.MAX_SAFE_INTEGER - 100),
    9007199254740990,
    -9007199254740990,
  ];
  // Small magnitudes, both signs.
  for (let i = 0; i < 200; i++) {
    integers.push(pickInt(rand, -100000, 100000));
  }
  // Random 15-digit magnitudes: 10^14 .. 10^15 - 1, both signs.
  for (let i = 0; i < 150; i++) {
    const magnitude = 100000000000000 + Math.floor(rand() * 900000000000000);
    integers.push(rand() < 0.5 ? -magnitude : magnitude);
  }
  // Hugging the 2^53 boundary from below, both signs.
  for (let i = 0; i < 100; i++) {
    const offset = pickInt(rand, 0, 100000);
    integers.push(
      rand() < 0.5
        ? Number.MAX_SAFE_INTEGER - offset
        : -(Number.MAX_SAFE_INTEGER - offset),
    );
  }
  // Random magnitudes across the whole safe range.
  for (let i = 0; i < 50; i++) {
    const magnitude = Math.floor(rand() * 9000000000000000);
    integers.push(rand() < 0.5 ? -magnitude : magnitude);
  }
  return integers;
}

/** A strict decimal string plus the minor units it must parse to. */
interface StrictCase {
  text: string;
  expected: number;
}

/**
 * The strict-string corpus: 200+ random decimal strings built from
 * seeded minor-unit values, with random representation choices
 * (0/1/2 fraction digits where the value allows, leading zeros,
 * surrounding whitespace). The expected value is computed with BigInt
 * from the parts, never by re-parsing.
 */
function generateStrictStrings(): StrictCase[] {
  const rand = mulberry32(SEED);
  const cases: StrictCase[] = [
    { text: "0.00", expected: 0 },
    { text: "-0.00", expected: 0 },
    { text: "-0", expected: 0 },
    { text: "90071992547409.91", expected: Number.MAX_SAFE_INTEGER },
    { text: "-90071992547409.91", expected: -Number.MAX_SAFE_INTEGER },
    { text: "  0012.30 ", expected: 1230 },
    { text: "\t0.5\n", expected: 50 },
    { text: "100", expected: 10000 },
  ];
  const whitespaces = ["", " ", "  ", "\t", "\n", " \t", "\n "];
  for (let i = 0; i < 220; i++) {
    const minor = BigInt(Math.floor(rand() * 8000000000000000));
    const negative = rand() < 0.35;
    const whole = minor / 100n;
    const cents = minor % 100n;
    // 2 fraction digits always valid; 1 digit only when cents end in
    // 0; no fraction only when cents are 0.
    const allowed = [2];
    if (cents % 10n === 0n) allowed.push(1);
    if (cents === 0n) allowed.push(0);
    const decimals = allowed[Math.floor(rand() * allowed.length)];
    let fraction = "";
    if (decimals === 2) fraction = `.${cents.toString().padStart(2, "0")}`;
    else if (decimals === 1) fraction = `.${(cents / 10n).toString()}`;
    const leadingZeros = "0".repeat(Math.floor(rand() * 4));
    const prefix = whitespaces[Math.floor(rand() * whitespaces.length)];
    const suffix = whitespaces[Math.floor(rand() * whitespaces.length)];
    const text = `${prefix}${negative ? "-" : ""}${leadingZeros}${whole}${fraction}${suffix}`;
    cases.push({ text, expected: Number(negative ? -minor : minor) });
  }
  return cases;
}

/**
 * The rejection corpus: 200+ random bad strings, one per failure mode
 * of the strict grammar — 3 fraction digits, thousands separators,
 * scientific notation, empty / whitespace-only, non-numeric junk, and
 * whole parts whose minor units overflow the safe range. Every entry
 * is constructed to fail the regex or the overflow check; a
 * trailing-space-only variant would trim to a valid amount and is
 * deliberately never generated here.
 */
function generateBadStrings(): string[] {
  const rand = mulberry32(SEED);
  const bad: string[] = [
    "",
    " ",
    "\t\n",
    "abc",
    "12a",
    "NaN",
    "Infinity",
    "-Infinity",
    "+12.34",
    ".5",
    "12.",
    "12 .34",
    "12. 34",
    "12.34.56",
    "--12.34",
    "12-34",
    "$12.34",
    "12.34USD",
    "1.2e3",
    "1e2",
    "12E2",
    "1,234.56",
    "1,234",
    "12.345",
    "12.340",
    "12.3.4",
    "1..2",
    "- 12.34",
    "12,34.56",
    "1_234.56",
    "0x12.34",
    "12.34a",
    "a12.34",
    "++1",
    "+-1",
    "99999999999999999999.99",
    "90071992547409.92",
    "-90071992547409.92",
    "１２.34",
    "１２３４",
  ];
  // 3 fraction digits (including trailing-zero ones like "12.340",
  // which look round but are still over-precision).
  for (let i = 0; i < 50; i++) {
    const whole = Math.floor(rand() * 100000);
    const fraction = String(Math.floor(rand() * 1000)).padStart(3, "0");
    bad.push(`${whole}.${fraction}`);
  }
  // Thousands separators, with and without a fraction.
  for (let i = 0; i < 40; i++) {
    const head = String(1 + Math.floor(rand() * 999));
    const tail = String(Math.floor(rand() * 1000)).padStart(3, "0");
    const cents = String(Math.floor(rand() * 100)).padStart(2, "0");
    bad.push(rand() < 0.5 ? `${head},${tail}.${cents}` : `${head},${tail}`);
  }
  // Scientific notation, both cases of the exponent marker.
  for (let i = 0; i < 40; i++) {
    const mantissa = `${Math.floor(rand() * 100)}.${Math.floor(rand() * 100)}`;
    const exponent = Math.floor(rand() * 10);
    const marker = rand() < 0.5 ? "e" : "E";
    const sign = rand() < 0.5 ? "" : "-";
    bad.push(`${mantissa}${marker}${sign}${exponent}`);
  }
  // Whole parts of 17–20 digits: even without a fraction their minor
  // units exceed Number.MAX_SAFE_INTEGER by orders of magnitude.
  for (let i = 0; i < 40; i++) {
    const digits = 17 + Math.floor(rand() * 4);
    let whole = String(1 + Math.floor(rand() * 9));
    for (let j = 1; j < digits; j++) {
      whole += String(Math.floor(rand() * 10));
    }
    const fraction = String(Math.floor(rand() * 100)).padStart(2, "0");
    bad.push(rand() < 0.5 ? `${whole}.${fraction}` : whole);
  }
  // Non-numeric junk and grammar impurities.
  const junk = [
    "abc",
    "NaN",
    "null",
    "undefined",
    "12a34",
    "a12.34",
    "12.34a",
    "--1",
    "++1",
    "+-1",
    "- 12.34",
    "12,34.56",
    "1_234.56",
    "0x12.34",
    "1.2.3",
    "1..2",
    "$12.34",
    "12.34USD",
    ".5",
    "12.",
    "+12.34",
  ];
  for (let i = 0; i < 30; i++) {
    bad.push(junk[Math.floor(rand() * junk.length)]);
  }
  return bad;
}

test("parseMinorUnits/formatMinorUnits round-trip over 500+ random safe integers", () => {
  const integers = generateIntegers();
  assert.ok(integers.length >= 500, `expected >= 500 cases, got ${integers.length}`);
  for (const n of integers) {
    assert.ok(Number.isInteger(n), `corpus must hold integers, got ${n}`);
    assert.ok(
      Math.abs(n) <= Number.MAX_SAFE_INTEGER,
      `corpus must stay in the safe range, got ${n}`,
    );
    // The formatted string matches the independent BigInt oracle first,
    // so the round-trip below cannot pass on two compensating slips.
    assert.equal(formatMinorUnits(n), expectedFormat(n), `format(${n})`);
    const parsed = parseMinorUnits(formatMinorUnits(n));
    assert.equal(parsed, n, `round-trip of ${n}`);
    assert.ok(!Object.is(parsed, -0), `round-trip of ${n} must never be -0`);
  }
});

test("parseMinorUnits parses 200+ random strict decimal strings to hand-computed minor units", () => {
  const cases = generateStrictStrings();
  assert.ok(cases.length >= 200, `expected >= 200 cases, got ${cases.length}`);
  for (const { text, expected } of cases) {
    const parsed = parseMinorUnits(text);
    assert.equal(parsed, expected, `parseMinorUnits(${JSON.stringify(text)})`);
    assert.ok(
      !Object.is(parsed, -0),
      `parseMinorUnits(${JSON.stringify(text)}) must never be -0`,
    );
  }
});

test("parseMinorUnits rejects 200+ random bad strings with a clear error", () => {
  const bad = generateBadStrings();
  assert.ok(bad.length >= 200, `expected >= 200 cases, got ${bad.length}`);
  for (const text of bad) {
    assert.throws(
      () => parseMinorUnits(text),
      (error: unknown) => {
        assert.ok(error instanceof Error, `expected an Error for ${JSON.stringify(text)}`);
        assert.match(
          error.message,
          /invalid minor units amount|too large to represent in minor units/,
          `error for ${JSON.stringify(text)} must name the failure`,
        );
        return true;
      },
      `expected ${JSON.stringify(text)} to be rejected`,
    );
  }
});

test("same seed regenerates identical corpora (determinism)", () => {
  assert.deepEqual(generateIntegers(), generateIntegers());
  assert.deepEqual(generateStrictStrings(), generateStrictStrings());
  assert.deepEqual(generateBadStrings(), generateBadStrings());
});
