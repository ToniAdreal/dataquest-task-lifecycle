import test from "node:test";
import assert from "node:assert/strict";
import { formatMinorUnits, parseMinorUnits } from "../src/index.js";

/**
 * String → minor-unit parsing (backlog #853).
 *
 * Reconciliation and CSV-import callers receive amounts as text.
 * Going through `Number()` first gave no single answer for
 * `"12.345"`, `"1,234.56"`, or `"1.2e3"` — this parser is the one
 * strict answer: optional minus, at most 2 decimal places, no
 * thousands separator, no scientific notation, exact integer
 * arithmetic throughout.
 */

test("parseMinorUnits converts strict decimals to integer cents", () => {
  assert.equal(parseMinorUnits("12.34"), 1234);
  assert.equal(parseMinorUnits("-0.50"), -50);
  assert.equal(parseMinorUnits("0"), 0);
  assert.equal(parseMinorUnits("0.00"), 0);
  assert.equal(parseMinorUnits("12.3"), 1230);
  assert.equal(parseMinorUnits("2500"), 250000);
  assert.equal(parseMinorUnits("-10098.50"), -1009850);
});

test("parseMinorUnits trims surrounding whitespace and keeps leading zeros", () => {
  assert.equal(parseMinorUnits("  12.34  "), 1234);
  assert.equal(parseMinorUnits("\t12.34\n"), 1234);
  assert.equal(parseMinorUnits("0012.34"), 1234);
});

test("parseMinorUnits never returns -0", () => {
  assert.equal(parseMinorUnits("-0.00"), 0);
  assert.equal(parseMinorUnits("-0"), 0);
  // assert/strict equal distinguishes -0 from 0, so this is a real check.
  assert.ok(!Object.is(parseMinorUnits("-0.00"), -0));
});

test("parseMinorUnits round-trips with formatMinorUnits", () => {
  for (const n of [
    0,
    1,
    -1,
    100,
    -100,
    1234,
    1009850,
    1634900,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
  ]) {
    assert.equal(parseMinorUnits(formatMinorUnits(n)), n);
  }
});

test("parseMinorUnits rejects over-precision, separators, and notation", () => {
  for (const bad of [
    "12.345",
    "12.001",
    "1,234.56",
    "1,234",
    "1.2e3",
    "1e2",
    "12E2",
    ".5",
    "12.",
    "+12.34",
    "12 .34",
    "12. 34",
    "12.34.56",
    "abc",
    "NaN",
    "Infinity",
    "-Infinity",
    "--12.34",
    "12-34",
    "$12.34",
    "12.34USD",
  ]) {
    assert.throws(
      () => parseMinorUnits(bad),
      /invalid minor units amount/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("parseMinorUnits rejects empty and non-string input", () => {
  for (const bad of ["", "   ", "\t\n"]) {
    assert.throws(
      () => parseMinorUnits(bad),
      /invalid minor units amount/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
  for (const bad of [12.34, 0, null, undefined, {}, [], true] as unknown[]) {
    assert.throws(
      () => parseMinorUnits(bad as string),
      /invalid minor units amount: expected a string/,
      `expected ${String(bad)} to be rejected`,
    );
  }
});

test("parseMinorUnits rejects amounts beyond the safe-integer range", () => {
  // 90071992547409.92 -> 9007199254740992 minor units, one past safe.
  assert.throws(
    () => parseMinorUnits("90071992547409.92"),
    /too large to represent in minor units/,
  );
  assert.throws(
    () => parseMinorUnits("99999999999999999999.99"),
    /too large to represent in minor units/,
  );
  // Just inside the boundary still parses exactly.
  assert.equal(
    parseMinorUnits("90071992547409.91"),
    Number.MAX_SAFE_INTEGER,
  );
});
