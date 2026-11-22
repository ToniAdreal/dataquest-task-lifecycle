import test from "node:test";
import assert from "node:assert/strict";
import { parsePayoutRetryAfter } from "../src/index.js";

/**
 * A non-finite `nowMs` must fail closed: without the guard the HTTP-date
 * branch returns `Math.max(0, when - NaN)` = NaN, `retryDelayMs` passes it
 * through, and `setTimeout(NaN)` treats it as 0 — a server-prescribed 429
 * backoff silently collapses into an immediate retry. The guard is a plain
 * configuration `Error` (never a `TypeError`), and it names both the
 * function and the offending argument so a caller can find the broken
 * clock. Mirror of the escrow-side `parseRetryAfter` guard (backlog #1319).
 */
function assertNowMsConfigError(value: string | null, nowMs: unknown): void {
  assert.throws(
    () => parsePayoutRetryAfter(value, nowMs as number),
    (error: unknown) => {
      assert.ok(error instanceof Error, "must throw an Error");
      assert.ok(
        !(error instanceof TypeError),
        "a configuration error, not a TypeError",
      );
      assert.match(error.message, /parsePayoutRetryAfter/);
      assert.match(error.message, /nowMs/);
      return true;
    },
  );
}

const FIXED_NOW = Date.parse("2026-11-21T12:00:00.000Z");
const FUTURE_HTTP_DATE = new Date(FIXED_NOW + 5000).toUTCString();

test("parsePayoutRetryAfter: NaN nowMs throws on the HTTP-date path", () => {
  assertNowMsConfigError(FUTURE_HTTP_DATE, Number.NaN);
});

test("parsePayoutRetryAfter: Infinity nowMs throws on the HTTP-date path", () => {
  assertNowMsConfigError(FUTURE_HTTP_DATE, Number.POSITIVE_INFINITY);
});

test("parsePayoutRetryAfter: -Infinity nowMs throws on the HTTP-date path", () => {
  assertNowMsConfigError(FUTURE_HTTP_DATE, Number.NEGATIVE_INFINITY);
});

test("parsePayoutRetryAfter: non-number nowMs throws on the HTTP-date path", () => {
  assertNowMsConfigError(FUTURE_HTTP_DATE, "2026-11-21T12:00:00.000Z");
});

test("parsePayoutRetryAfter: NaN nowMs throws on the delay-seconds path too", () => {
  // The guard runs before any parsing, so the branch that never reads
  // `nowMs` fails closed on a broken clock as well.
  assertNowMsConfigError("120", Number.NaN);
});

test("parsePayoutRetryAfter: NaN nowMs throws even when the value is absent", () => {
  // An absent value would otherwise return `undefined` without touching
  // the clock; a caller that explicitly passed a broken clock is told so.
  assertNowMsConfigError(null, Number.NaN);
});

test("parsePayoutRetryAfter: finite nowMs keeps HTTP-date and delay-seconds behavior", () => {
  const delta = parsePayoutRetryAfter(FUTURE_HTTP_DATE, FIXED_NOW);
  assert.ok(
    delta !== undefined && delta > 4000 && delta <= 5000,
    `HTTP-date delta ${delta}ms`,
  );
  assert.equal(parsePayoutRetryAfter("120", FIXED_NOW), 120_000);
  assert.equal(parsePayoutRetryAfter("0", FIXED_NOW), 0);
  assert.equal(
    parsePayoutRetryAfter(new Date(FIXED_NOW - 1000).toUTCString(), FIXED_NOW),
    0,
  );
});

test("parsePayoutRetryAfter: default nowMs still works for a future HTTP-date", () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const delta = parsePayoutRetryAfter(future);
  assert.ok(
    delta !== undefined && delta > 4000 && delta <= 5000,
    `default-clock HTTP-date delta ${delta}ms`,
  );
});
