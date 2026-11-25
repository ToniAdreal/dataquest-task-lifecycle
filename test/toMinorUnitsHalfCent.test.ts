import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMinorUnits,
  parseMinorUnits,
  toMinorUnits,
} from "../src/index.js";

/**
 * Half-cent rounding rule (backlog #1405).
 *
 * `toMinorUnits` rounds to the nearest cent with ties rounding half
 * away from zero (round half up in magnitude): `10.005` → `1001`
 * and `-10.005` → `-1001`. The rule #1404 shipped followed
 * `Math.round` (toward +Infinity), which rounded a negative tie
 * toward zero (`-10.005` → `-1000`): a negative half-cent came out
 * a cent short of its positive mirror, so a payout and its refund
 * did not mirror each other to the cent. The fix is a one-line
 * change in `decimalMinorUnits` (the tie test no longer depends on
 * the sign); everything else about the conversion — decimal-exact
 * integer arithmetic, overflow rejection, zero always `0` — is
 * unchanged, and the tests below pin both boundaries so the old
 * asymmetry cannot come back silently.
 */

test("toMinorUnits pins the positive half-cent boundary", () => {
  assert.equal(toMinorUnits(10.005), 1001);
  assert.equal(toMinorUnits(0.005), 1);
  assert.equal(toMinorUnits(0.125), 13);
  assert.equal(toMinorUnits(2.675), 268);
  assert.equal(toMinorUnits(1.005), 101);
  assert.equal(toMinorUnits(100.005), 10001);
  assert.equal(toMinorUnits(9999.995), 1000000);
});

test("toMinorUnits pins the negative half-cent boundary", () => {
  // The fix: each of these is the exact mirror of its positive
  // counterpart — under the old Math.round rule every one of them
  // was a cent short (-1000, 0, -12, -267, -100, -10000, -999999).
  assert.equal(toMinorUnits(-10.005), -1001);
  assert.equal(toMinorUnits(-0.005), -1);
  assert.equal(toMinorUnits(-0.125), -13);
  assert.equal(toMinorUnits(-2.675), -268);
  assert.equal(toMinorUnits(-1.005), -101);
  assert.equal(toMinorUnits(-100.005), -10001);
  assert.equal(toMinorUnits(-9999.995), -1000000);
});

test("toMinorUnits pins just below and just above the half-cent boundary", () => {
  assert.equal(toMinorUnits(10.004), 1000);
  assert.equal(toMinorUnits(-10.004), -1000);
  assert.equal(toMinorUnits(10.006), 1001);
  assert.equal(toMinorUnits(-10.006), -1001);
  assert.equal(toMinorUnits(0.004), 0);
  assert.equal(toMinorUnits(-0.004), 0);
  assert.equal(toMinorUnits(0.006), 1);
  assert.equal(toMinorUnits(-0.006), -1);
  assert.equal(toMinorUnits(0.124), 12);
  assert.equal(toMinorUnits(-0.124), -12);
  assert.equal(toMinorUnits(0.126), 13);
  assert.equal(toMinorUnits(-0.126), -13);
});

test("toMinorUnits is sign-symmetric at ties and elsewhere", () => {
  // toMinorUnits(-x) === -toMinorUnits(x) for every finite x: a
  // payout and its refund mirror each other to the cent.
  for (const x of [
    10.005, 0.005, 0.125, 2.675, 1.005, 100.005, 9999.995, 19.99,
    0.29, 0.333, 0.006, 1234567.89, 3750.555, 0.001, 1234.567,
  ]) {
    // +0 normalizes the -0 that negating a zero result produces;
    // the converter itself always returns +0 (pinned below).
    assert.equal(toMinorUnits(-x) + 0, -toMinorUnits(x) + 0, `symmetry of ${x}`);
  }
  // A zero result is always +0, never -0, on either sign.
  assert.ok(Object.is(toMinorUnits(0.004), 0));
  assert.ok(Object.is(toMinorUnits(-0.004), 0));
  assert.ok(Object.is(toMinorUnits(-0), 0));
});

test("toMinorUnits keeps typical amounts unchanged on both signs", () => {
  assert.equal(toMinorUnits(19.99), 1999);
  assert.equal(toMinorUnits(-19.99), -1999);
  assert.equal(toMinorUnits(0.29), 29);
  assert.equal(toMinorUnits(-0.29), -29);
  assert.equal(toMinorUnits(1234567.89), 123456789);
  assert.equal(toMinorUnits(-1234567.89), -123456789);
  assert.equal(toMinorUnits(0.333), 33);
  assert.equal(toMinorUnits(-0.333), -33);
  assert.equal(toMinorUnits(0), 0);
  assert.equal(toMinorUnits(2500), 250000);
  assert.equal(toMinorUnits(-2500), -250000);
});

test("half-cent ties agree with the string and display paths", () => {
  // The string parser only accepts exact two-decimal amounts, so a
  // tie amount read as text is the rounded amount itself — and the
  // converter must agree with it on both signs.
  assert.equal(parseMinorUnits("10.01"), toMinorUnits(10.01));
  assert.equal(parseMinorUnits("-10.01"), toMinorUnits(-10.01));
  assert.equal(parseMinorUnits("0.29"), toMinorUnits(0.29));
  assert.equal(parseMinorUnits("-0.29"), toMinorUnits(-0.29));
  // Formatting a converted tie renders the rounded cent, mirrored.
  assert.equal(formatMinorUnits(toMinorUnits(10.005)), "10.01");
  assert.equal(formatMinorUnits(toMinorUnits(-10.005)), "-10.01");
  assert.equal(formatMinorUnits(toMinorUnits(0.005)), "0.01");
  assert.equal(formatMinorUnits(toMinorUnits(-0.005)), "-0.01");
});
