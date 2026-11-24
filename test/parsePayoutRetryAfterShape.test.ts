import test from "node:test";
import assert from "node:assert/strict";
import { parsePayoutRetryAfter } from "../src/index.js";

/**
 * A non-string `value` must fail closed with a named configuration error,
 * never a bare `TypeError` from `value.trim()`: the function is exported,
 * so a caller that passes a parsed number or boolean by mistake would
 * otherwise see the failure surface from deep inside retry scheduling,
 * and an outer "no hint" fallback could swallow it and silently reroute
 * the retry onto exponential backoff. The error is a plain `Error`
 * (never a `TypeError`) naming the function and the offending value —
 * rendered `JSON.stringify`-style, so objects and arrays are shown
 * without expanding them. Mirror of the escrow-side `parseRetryAfter`
 * guard (backlog #1386), with the `got` rendering spelled out per
 * value instead of `typeof`-only.
 */
function assertValueConfigError(value: unknown, expectedGot: string): void {
  assert.throws(
    () => parsePayoutRetryAfter(value as string, FIXED_NOW),
    (error: unknown) => {
      assert.ok(error instanceof Error, "must throw an Error");
      assert.ok(
        !(error instanceof TypeError),
        "a configuration error, not a TypeError",
      );
      assert.equal(
        error.message,
        `parsePayoutRetryAfter: value must be a string, got ${expectedGot}`,
      );
      return true;
    },
  );
}

const FIXED_NOW = Date.parse("2026-11-21T12:00:00.000Z");
const FUTURE_HTTP_DATE = new Date(FIXED_NOW + 5000).toUTCString();
const PAST_HTTP_DATE = new Date(FIXED_NOW - 1000).toUTCString();

test("parsePayoutRetryAfter: number 5 throws a named error, not a TypeError", () => {
  assertValueConfigError(5, "5");
});

test("parsePayoutRetryAfter: number 0 throws a named error, not a TypeError", () => {
  assertValueConfigError(0, "0");
});

test("parsePayoutRetryAfter: boolean true throws a named error, not a TypeError", () => {
  assertValueConfigError(true, "true");
});

test("parsePayoutRetryAfter: object throws a named error, not a TypeError", () => {
  assertValueConfigError({}, "{}");
});

test("parsePayoutRetryAfter: array throws a named error, not a TypeError", () => {
  assertValueConfigError(["30"], '["30"]');
});

test("parsePayoutRetryAfter: bigint throws a named error, not a TypeError", () => {
  // `JSON.stringify(30n)` throws, so the guard must render the bigint
  // through its fallback instead of throwing a TypeError of its own.
  assertValueConfigError(30n, "bigint");
});

test("parsePayoutRetryAfter: null and undefined still return undefined", () => {
  assert.equal(parsePayoutRetryAfter(null, FIXED_NOW), undefined);
  assert.equal(parsePayoutRetryAfter(undefined, FIXED_NOW), undefined);
});

test("parsePayoutRetryAfter: legal string values are unchanged", () => {
  assert.equal(parsePayoutRetryAfter("120", FIXED_NOW), 120_000);
  assert.equal(parsePayoutRetryAfter("  30 ", FIXED_NOW), 30_000);
  assert.equal(parsePayoutRetryAfter("banana", FIXED_NOW), undefined);
  assert.equal(parsePayoutRetryAfter("-5", FIXED_NOW), undefined);
  const delta = parsePayoutRetryAfter(FUTURE_HTTP_DATE, FIXED_NOW);
  assert.ok(
    delta !== undefined && delta > 4000 && delta <= 5000,
    `HTTP-date delta ${delta}ms`,
  );
  assert.equal(parsePayoutRetryAfter(PAST_HTTP_DATE, FIXED_NOW), 0);
});

test("parsePayoutRetryAfter: illegal nowMs still throws its own error", () => {
  assert.throws(
    () => parsePayoutRetryAfter("120", Number.NaN),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.match(error.message, /nowMs must be a finite epoch-millisecond/);
      return true;
    },
  );
  assert.throws(
    () => parsePayoutRetryAfter("120", "2026-11-21T12:00:00.000Z" as unknown as number),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.match(error.message, /nowMs must be a finite epoch-millisecond/);
      return true;
    },
  );
});

test("parsePayoutRetryAfter: guard order — bad nowMs is reported before a bad value", () => {
  // The nowMs guard runs first, so a broken clock is never masked by a
  // bad value (and vice versa: the value guard never runs on a broken
  // clock).
  assert.throws(
    () => parsePayoutRetryAfter(5 as unknown as string, Number.NaN),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.match(error.message, /nowMs must be a finite epoch-millisecond/);
      return true;
    },
  );
});
