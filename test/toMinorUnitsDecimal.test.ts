import test from "node:test";
import assert from "node:assert/strict";
import { parseMinorUnits, toMinorUnits } from "../src/index.js";

/**
 * Decimal-exact `toMinorUnits` conversion (backlog #1404).
 *
 * The old implementation was `Math.round(amount * 100)`, which read
 * the binary double: `1.005 * 100` is `100.49999999999999`, so it
 * rounded down to `100` cents, and `37.785` lost a cent the same
 * way (`3778` instead of `3779`). The converter now reads the
 * amount as the shortest decimal that round-trips to it and converts
 * in integer arithmetic, so those values land on their decimal
 * cents. Ties follow `Math.round` (toward +Infinity) and the two
 * overflow errors are unchanged.
 */

test("toMinorUnits converts float-dust values to their decimal cents", () => {
  // Each of these lost (or risked losing) a cent under
  // Math.round(amount * 100); verified against the old code before
  // the fix (1.005 -> 100, 37.785 -> 3778).
  assert.equal(toMinorUnits(1.005), 101);
  assert.equal(toMinorUnits(37.785), 3779);
  assert.equal(toMinorUnits(0.575), 58);
  assert.equal(toMinorUnits(4.015), 402);
  assert.equal(toMinorUnits(2.675), 268);
  assert.equal(toMinorUnits(1234.565), 123457);
  assert.equal(toMinorUnits(9999.995), 1000000);
  // 0.045 * 100 is exactly 4.5 in binary, so the old path agreed
  // here; it stays 5 under the decimal path too.
  assert.equal(toMinorUnits(0.045), 5);
});

test("toMinorUnits keeps typical and boundary values exact", () => {
  assert.equal(toMinorUnits(19.99), 1999);
  assert.equal(toMinorUnits(0.29), 29);
  assert.equal(toMinorUnits(0), 0);
  assert.equal(toMinorUnits(-0), 0);
  assert.equal(toMinorUnits(2500), 250000);
  assert.equal(toMinorUnits(10098.5), 1009850);
  assert.equal(toMinorUnits(1234567.89), 123456789);
  assert.equal(toMinorUnits(99999999.99), 9999999999);
  // Sub-cent legacy input still rounds to the nearest cent.
  assert.equal(toMinorUnits(0.333), 33);
  assert.equal(toMinorUnits(0.335), 34);
});

test("toMinorUnits ties round half away from zero", () => {
  // Exactly on the half-cent boundary in decimal: both signs round
  // up in magnitude (backlog #1405) — the old Math.round rule
  // rounded negative ties toward zero, so -10.005 came out -1000
  // while +10.005 came out 1001.
  assert.equal(toMinorUnits(10.005), 1001);
  assert.equal(toMinorUnits(-10.005), -1001);
  assert.equal(toMinorUnits(-1.005), -101);
  assert.equal(toMinorUnits(-2.675), -268);
  assert.equal(toMinorUnits(0.005), 1);
  assert.equal(toMinorUnits(-0.005), -1);
});

test("toMinorUnits handles tiny and exponent-form values", () => {
  assert.equal(toMinorUnits(1e-7), 0);
  assert.equal(toMinorUnits(0.004), 0);
  assert.equal(toMinorUnits(0.006), 1);
  // 1e21 majors is 1e23 cents, past MAX_SAFE_INTEGER: since backlog
  // #1423 the converter rejects it instead of returning a rounded
  // integer no cent-sum can represent exactly.
  assert.throws(
    () => toMinorUnits(1e21),
    /minor units conversion overflowed: 1e\+21 exceeds Number\.MAX_SAFE_INTEGER in minor units/,
  );
  assert.equal(toMinorUnits(1.5e-3), 0);
  assert.equal(toMinorUnits(2.5e-3), 0);
});

test("toMinorUnits keeps large-but-safe amounts exact", () => {
  // 1e13 majors is 1e15 cents, inside the safe range; 1e15 majors
  // would be 1e17 cents, past it — since backlog #1423 that throws
  // instead of converting (the old pinning of 1e15 -> 1e17 belonged
  // to the finite-only contract #844 set, which #1423 supersedes:
  // 1e17 is exactly representable as a double but not a safe
  // integer, so adding a cent to it silently does nothing).
  assert.equal(toMinorUnits(1e13), 1e15);
  assert.equal(toMinorUnits(-1e13), -1e15);
  assert.throws(
    () => toMinorUnits(1e15),
    /minor units conversion overflowed: 1000000000000000 exceeds Number\.MAX_SAFE_INTEGER in minor units/,
  );
  assert.throws(
    () => toMinorUnits(-1e15),
    /minor units conversion overflowed: -1000000000000000 exceeds Number\.MAX_SAFE_INTEGER in minor units/,
  );
  assert.throws(
    () => toMinorUnits(1.7e306),
    /minor units conversion overflowed: .* exceeds Number\.MAX_SAFE_INTEGER in minor units/,
  );
  // The double nearest 90071992547409.91 prints as 90071992547409.9,
  // which is exactly 9007199254740990 cents, one below
  // MAX_SAFE_INTEGER, so the conversion is exact, not rounded off.
  assert.equal(toMinorUnits(90071992547409.9), 9007199254740990);
});

test("toMinorUnits agrees with parseMinorUnits on 2-decimal strings", () => {
  // The string parser was already decimal-exact (BigInt); the
  // number converter must give the same cents for the same decimal.
  const amounts = [
    "19.99",
    "0.29",
    "-100.98",
    "0.00",
    "-0.00",
    "16349.00",
    "0.07",
    "99999999.99",
    "0.01",
    "-0.01",
    "3750.50",
    "1234567.89",
  ];
  for (const text of amounts) {
    assert.equal(
      toMinorUnits(Number(text)),
      parseMinorUnits(text),
      `toMinorUnits(${text}) must equal parseMinorUnits(${text})`,
    );
  }
});

test("toMinorUnits keeps the existing overflow errors unchanged", () => {
  const OVERFLOW = /minor units conversion overflowed/;
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => toMinorUnits(bad), OVERFLOW);
    assert.throws(
      () => toMinorUnits(bad),
      /amount must be a finite number/,
    );
  }
  for (const bad of [1e308, -1e308, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    assert.throws(() => toMinorUnits(bad), OVERFLOW);
    assert.throws(
      () => toMinorUnits(bad),
      /is too large to represent in minor units/,
    );
  }
});
