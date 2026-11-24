import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OUTBOX_ERROR_LENGTH,
  PayoutWebhookOutbox,
  truncateOutboxError,
} from "../src/index.js";

/**
 * `truncateOutboxError` input shape (backlog #1364, mirrors
 * escrow #1364).
 *
 * The helper is the outbox failure ledger's truncation entry point:
 * `recordAttempt()` hands it whatever `error` the delivery layer
 * reported, and until this change the helper read `.length`/`.slice`
 * with no type guard, so a `null` or numeric error escaped as a bare
 * `TypeError` instead of a named error. Rules under test:
 *  - `null` / `undefined` / a number / an object / an array each
 *    throw the named `truncateOutboxError: error must be a string,
 *    got …` error (never a `TypeError`)
 *  - the guard runs before any length check, so it also fires for
 *    values that would otherwise pass the cap test
 *  - short and exactly-at-cap strings still pass through unchanged,
 *    and over-cap strings still truncate to exactly the cap with
 *    the `…[truncated]` marker
 *  - `recordAttempt()` already guards `attempt.error` itself
 *    (`PayoutWebhookOutbox: error must be a string`, thrown before
 *    the helper is reached), so a non-string `error` there still
 *    throws a named error and records nothing; an omitted `error`
 *    still leaves `lastError` unset
 */

const ENDPOINT = "https://billing.example.test/hook";
const EVENT = "evt_truncate_shape";
const MARKER = "…[truncated]";

test("null input throws a named error, not a bare TypeError", () => {
  assert.throws(
    () => truncateOutboxError(null as never),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(
        (error as Error).message,
        "truncateOutboxError: error must be a string, got null",
      );
      return true;
    },
  );
});

test("undefined input throws a named error", () => {
  assert.throws(
    () => truncateOutboxError(undefined as never),
    /truncateOutboxError: error must be a string, got undefined/,
  );
});

test("numeric input throws a named error", () => {
  assert.throws(
    () => truncateOutboxError(42 as never),
    /truncateOutboxError: error must be a string, got number/,
  );
});

test("object and array inputs throw a named error", () => {
  assert.throws(
    () => truncateOutboxError({} as never),
    /truncateOutboxError: error must be a string, got object/,
  );
  assert.throws(
    () => truncateOutboxError([] as never),
    /truncateOutboxError: error must be a string, got object/,
  );
});

test("short and at-cap strings still pass through unchanged", () => {
  assert.equal(truncateOutboxError(""), "");
  assert.equal(truncateOutboxError("server responded with status 500"), "server responded with status 500");
  const atCap = "a".repeat(MAX_OUTBOX_ERROR_LENGTH);
  assert.equal(truncateOutboxError(atCap), atCap);
});

test("over-cap strings still truncate to exactly the cap with a marker", () => {
  const over = "b".repeat(MAX_OUTBOX_ERROR_LENGTH + 1);
  const truncated = truncateOutboxError(over);
  assert.equal(truncated.length, MAX_OUTBOX_ERROR_LENGTH);
  assert.ok(truncated.endsWith(MARKER));
  assert.equal(
    truncated,
    "b".repeat(MAX_OUTBOX_ERROR_LENGTH - MARKER.length) + MARKER,
  );
});

test("recordAttempt still rejects a non-string error with a named error and records nothing", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3, now: () => 0 });
  assert.throws(
    () =>
      outbox.recordAttempt({
        endpoint: ENDPOINT,
        eventId: EVENT,
        ok: false,
        error: null as never,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(
        (error as Error).message,
        "PayoutWebhookOutbox: error must be a string",
      );
      return true;
    },
  );
  assert.equal(outbox.pending().length, 0);
  assert.equal(outbox.deadLetter().length, 0);
});

test("recordAttempt with no error still leaves lastError unset", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3, now: () => 0 });
  outbox.recordAttempt({ endpoint: ENDPOINT, eventId: EVENT, ok: false });
  const [entry] = outbox.pending();
  assert.equal(entry.lastError, undefined);
  assert.equal(entry.attempts, 1);
});
