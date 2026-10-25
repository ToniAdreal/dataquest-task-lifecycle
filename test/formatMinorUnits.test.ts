import test from "node:test";
import assert from "node:assert/strict";
import { formatMinorUnits, fromMinorUnits } from "../src/index.js";

/**
 * Fixed-format display for integer minor units (backlog #577).
 *
 * `toMinorUnits` / `fromMinorUnits` only convert numbers — a caller
 * printing an amount for a statement had to build the string itself,
 * so decimal places, the minus sign and separators drifted per
 * caller. `formatMinorUnits` pins one bare format: exactly two
 * decimals, no thousands separator, no currency symbol.
 */

test("formatMinorUnits formats positive amounts with exactly two decimals", () => {
  assert.equal(formatMinorUnits(10098), "100.98");
  assert.equal(formatMinorUnits(1), "0.01");
  assert.equal(formatMinorUnits(99), "0.99");
  assert.equal(formatMinorUnits(100), "1.00");
  assert.equal(formatMinorUnits(101), "1.01");
  assert.equal(formatMinorUnits(250000), "2500.00");
});

test("formatMinorUnits formats zero without a minus sign", () => {
  assert.equal(formatMinorUnits(0), "0.00");
  assert.equal(formatMinorUnits(-0), "0.00");
});

test("formatMinorUnits keeps the leading minus on negative amounts", () => {
  assert.equal(formatMinorUnits(-100), "-1.00");
  assert.equal(formatMinorUnits(-1), "-0.01");
  assert.equal(formatMinorUnits(-10098), "-100.98");
  assert.equal(formatMinorUnits(-99), "-0.99");
});

test("formatMinorUnits never adds separators or a currency symbol", () => {
  for (const value of [1000000, 123456789, -123456789]) {
    const formatted = formatMinorUnits(value);
    assert.match(formatted, /^-?\d+\.\d{2}$/);
    assert.equal(formatted.includes(","), false);
    assert.equal(formatted.includes("$"), false);
  }
  assert.equal(formatMinorUnits(1000000), "10000.00");
});

test("formatMinorUnits formats large amounts without precision drift", () => {
  // At and above 10^9 minor units, the range the backlog item calls out.
  assert.equal(formatMinorUnits(1000000000), "10000000.00");
  assert.equal(formatMinorUnits(1234567890123), "12345678901.23");
  // Integer arithmetic, not float division + rounding: the largest
  // safe integer formats exactly (remainder 91, whole 90071992547409).
  assert.equal(
    formatMinorUnits(Number.MAX_SAFE_INTEGER),
    "90071992547409.91",
  );
  assert.equal(
    formatMinorUnits(-Number.MAX_SAFE_INTEGER),
    "-90071992547409.91",
  );
});

test("formatMinorUnits rejects non-integers with the fromMinorUnits wording", () => {
  for (const value of [10.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => formatMinorUnits(value),
      new RegExp(
        `minor units must be an integer, got ${String(value).replace(".", "\\.")}`,
      ),
      `expected ${String(value)} to be rejected`,
    );
  }
});

test("formatMinorUnits agrees numerically with fromMinorUnits", () => {
  for (const value of [0, 1, 99, 100, 10098, -100, -1, 1000000000,
    123456789, -123456789]) {
    assert.equal(Number(formatMinorUnits(value)), fromMinorUnits(value));
  }
});

test("formatMinorUnits is exported from the package entry point", async () => {
  const mod = await import("../src/index.js");
  assert.equal(typeof mod.formatMinorUnits, "function");
  assert.equal(mod.formatMinorUnits(10098), "100.98");
});
