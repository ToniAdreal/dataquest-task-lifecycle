import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OUTBOX_ERROR_LENGTH,
  PayoutWebhookOutbox,
  truncateOutboxError,
} from "../src/index.js";

/**
 * Outbox `lastError` length cap (backlog #1044, mirrors escrow #1043).
 *
 * `recordAttempt()` stored the caller's `error` verbatim, so one
 * oversized failure (a full HTML error page, a long stack trace)
 * could bloat the failure ledger and the snapshot exported from it.
 * Rules under test:
 *  - an error longer than `MAX_OUTBOX_ERROR_LENGTH` (1024) is
 *    truncated at record time to exactly the cap, keeps its prefix,
 *    and ends with the `…[truncated]` marker
 *  - an error at or under the cap is stored byte-for-byte, with no
 *    marker
 *  - truncation happens at record time, so snapshots (unsigned and
 *    signed) exported afterwards carry the already-truncated value
 *    and round-trip unchanged
 *  - truncation is purely a storage cap: it does not touch the
 *    attempts count or the dead-letter boundary, and a later failure
 *    still refreshes `lastError` with its own (possibly short) text
 */

const ENDPOINT = "https://billing.example.test/hook";
const EVENT = "evt_last_error_cap";
const MARKER = "…[truncated]";

function failedOutbox(): PayoutWebhookOutbox {
  return new PayoutWebhookOutbox({ maxAttempts: 3, now: () => 0 });
}

test("overlong error is truncated to the cap with a marker", () => {
  const outbox = failedOutbox();
  const long = "x".repeat(MAX_OUTBOX_ERROR_LENGTH + 500);
  outbox.recordAttempt({ endpoint: ENDPOINT, eventId: EVENT, ok: false, error: long });
  const [entry] = outbox.pending();
  assert.equal(entry.lastError?.length, MAX_OUTBOX_ERROR_LENGTH);
  assert.equal(
    entry.lastError,
    "x".repeat(MAX_OUTBOX_ERROR_LENGTH - MARKER.length) + MARKER,
  );
  assert.ok(entry.lastError?.endsWith(MARKER));
  assert.equal(entry.attempts, 1);
});

test("error one character over the cap is truncated, at the cap is not", () => {
  const outbox = failedOutbox();
  const over = "y".repeat(MAX_OUTBOX_ERROR_LENGTH + 1);
  outbox.recordAttempt({ endpoint: ENDPOINT, eventId: EVENT, ok: false, error: over });
  const [entry] = outbox.pending();
  assert.equal(entry.lastError?.length, MAX_OUTBOX_ERROR_LENGTH);
  assert.ok(entry.lastError?.endsWith(MARKER));

  const atCap = "z".repeat(MAX_OUTBOX_ERROR_LENGTH);
  outbox.recordAttempt({ endpoint: ENDPOINT, eventId: EVENT, ok: false, error: atCap });
  const [refreshed] = outbox.pending();
  assert.equal(refreshed.lastError, atCap);
  assert.ok(!refreshed.lastError?.endsWith(MARKER));
});

test("short error is stored verbatim", () => {
  const outbox = failedOutbox();
  outbox.recordAttempt({
    endpoint: ENDPOINT,
    eventId: EVENT,
    ok: false,
    error: "server responded with status 500",
  });
  const [entry] = outbox.pending();
  assert.equal(entry.lastError, "server responded with status 500");
});

test("truncateOutboxError is the identity at or under the cap", () => {
  assert.equal(MAX_OUTBOX_ERROR_LENGTH, 1024);
  assert.equal(truncateOutboxError(""), "");
  assert.equal(truncateOutboxError("short"), "short");
  const atCap = "a".repeat(MAX_OUTBOX_ERROR_LENGTH);
  assert.equal(truncateOutboxError(atCap), atCap);
  assert.equal(truncateOutboxError(atCap + "b").length, MAX_OUTBOX_ERROR_LENGTH);
  assert.ok(truncateOutboxError(atCap + "b").endsWith(MARKER));
});

test("truncated lastError survives an unsigned snapshot round-trip", () => {
  const outbox = failedOutbox();
  const long = "e".repeat(2000);
  outbox.recordAttempt({ endpoint: ENDPOINT, eventId: EVENT, ok: false, error: long });
  const expected = truncateOutboxError(long);
  const restored = PayoutWebhookOutbox.restore(
    JSON.parse(JSON.stringify(outbox.exportSnapshot())) as never,
    { maxAttempts: 3, now: () => 0 },
  );
  const [entry] = restored.pending();
  assert.equal(entry.lastError, expected);
  assert.equal(entry.lastError?.length, MAX_OUTBOX_ERROR_LENGTH);
  assert.equal(entry.attempts, 1);
});

test("truncated lastError survives a signed snapshot round-trip", () => {
  const outbox = failedOutbox();
  const long = "<html>" + "f".repeat(2000);
  outbox.recordAttempt({ endpoint: ENDPOINT, eventId: EVENT, ok: false, error: long });
  const expected = truncateOutboxError(long);
  const envelope = outbox.exportSignedSnapshot("outbox-snapshot-secret");
  const restored = PayoutWebhookOutbox.restoreSignedSnapshot(
    JSON.parse(JSON.stringify(envelope)) as never,
    "outbox-snapshot-secret",
    { maxAttempts: 3, now: () => 0 },
  );
  const [entry] = restored.pending();
  assert.equal(entry.lastError, expected);
});

test("truncation does not affect attempts counting or the dead-letter boundary", () => {
  const outbox = failedOutbox();
  for (let i = 0; i < 3; i++) {
    outbox.recordAttempt({
      endpoint: ENDPOINT,
      eventId: EVENT,
      ok: false,
      error: `attempt ${i}: ` + "g".repeat(2000),
    });
  }
  assert.equal(outbox.pending().length, 0);
  const [dead] = outbox.deadLetter();
  assert.equal(dead.attempts, 3);
  assert.equal(dead.lastError?.length, MAX_OUTBOX_ERROR_LENGTH);
  assert.ok(dead.lastError?.endsWith(MARKER));
  assert.ok(dead.lastError?.startsWith("attempt 2: "));
});

test("a later short failure refreshes lastError without marker residue", () => {
  const outbox = failedOutbox();
  outbox.recordAttempt({ endpoint: ENDPOINT, eventId: EVENT, ok: false, error: "h".repeat(2000) });
  assert.ok(outbox.pending()[0].lastError?.endsWith(MARKER));
  outbox.recordAttempt({ endpoint: ENDPOINT, eventId: EVENT, ok: false, error: "now a short one" });
  const [entry] = outbox.pending();
  assert.equal(entry.lastError, "now a short one");
  assert.equal(entry.attempts, 2);
});
