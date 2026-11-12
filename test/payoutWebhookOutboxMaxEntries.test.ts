import test from "node:test";
import assert from "node:assert/strict";
import { PayoutWebhookOutbox } from "../src/index.js";

/**
 * Capacity limit for `PayoutWebhookOutbox` (backlog #1073).
 *
 * The outbox is a failure ledger, not a queue, but without a cap a
 * long-lived process that keeps meeting new failing
 * `(endpoint, eventId)` pairs grows it without bound — and
 * `restore()` would accept an arbitrarily large persisted snapshot.
 * The sibling `PayoutEventDedupe` already caps at `maxEntries`
 * (default 10_000, LRU eviction, snapshot trim); this file pins the
 * same cap for the outbox, with the outbox's own eviction policy.
 * Rules under test:
 *  - `maxEntries` defaults to 10_000 and must be a positive integer
 *    in the constructor and at `restore()` (same error style as
 *    `maxAttempts`)
 *  - recording a failure for a new pair past the cap evicts
 *    dead-lettered pairs first (oldest `lastAt` first) and only then
 *    the oldest pending pair — eviction never drops a pending pair
 *    while a dead letter is available
 *  - re-failing a pair the ledger already tracks never evicts: the
 *    ledger does not grow, so no room needs making
 *  - `size` never exceeds `maxEntries`, even across a burst of
 *    fresh pairs; eviction leaves the surviving pairs' `attempts`
 *    and pending/dead-letter status untouched, and an evicted pair
 *    re-fails from `attempts` 1
 *  - `restore()` trims an over-capacity snapshot to the newest
 *    `maxEntries` pairs by `lastAt` (ties break by snapshot order,
 *    earliest first), mirroring `PayoutEventDedupe.restore`; the
 *    signed restore funnels through the same path and trims the
 *    same way
 */

const A = "https://payouts.example/hooks/payout";
const B = "https://ledger.example/hooks/payout";
const SECRET = "outbox-max-entries-test-secret";

function fail(
  outbox: PayoutWebhookOutbox,
  endpoint: string,
  eventId: string,
  at: number,
  times = 1,
): void {
  for (let i = 0; i < times; i++) {
    outbox.recordAttempt({ endpoint, eventId, ok: false, error: "boom", at });
  }
}

function pendingIds(outbox: PayoutWebhookOutbox): string[] {
  return outbox.pending().map((entry) => entry.eventId);
}

function deadIds(outbox: PayoutWebhookOutbox): string[] {
  return outbox.deadLetter().map((entry) => entry.eventId);
}

test("a new pair past the cap evicts the oldest pending pair", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 3 });
  fail(outbox, A, "evt-1", 1000);
  fail(outbox, A, "evt-2", 2000);
  fail(outbox, A, "evt-3", 3000);
  assert.equal(outbox.size, 3);

  fail(outbox, A, "evt-4", 4000);
  assert.equal(outbox.size, 3);
  assert.deepEqual(pendingIds(outbox), ["evt-2", "evt-3", "evt-4"]);
  assert.deepEqual(deadIds(outbox), []);
});

test("maxEntries: 1 keeps only the newest pair", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 1 });
  fail(outbox, A, "evt-1", 1000);
  fail(outbox, A, "evt-2", 2000);
  assert.equal(outbox.size, 1);
  assert.deepEqual(pendingIds(outbox), ["evt-2"]);
});

test("a dead-lettered pair is evicted before any pending pair", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 3 });
  // evt-1 dead-letters (3 failures at the default maxAttempts: 3).
  fail(outbox, A, "evt-1", 1000, 3);
  fail(outbox, A, "evt-2", 2000);
  fail(outbox, A, "evt-3", 3000);
  assert.deepEqual(deadIds(outbox), ["evt-1"]);
  assert.deepEqual(pendingIds(outbox), ["evt-2", "evt-3"]);

  fail(outbox, A, "evt-4", 4000);
  assert.equal(outbox.size, 3);
  assert.deepEqual(deadIds(outbox), []);
  assert.deepEqual(pendingIds(outbox), ["evt-2", "evt-3", "evt-4"]);
});

test("among dead-lettered pairs the oldest lastAt goes first", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 3 });
  fail(outbox, A, "evt-old-dead", 1000, 3);
  fail(outbox, A, "evt-new-dead", 3000, 3);
  fail(outbox, A, "evt-pending", 2000);
  assert.deepEqual(deadIds(outbox), ["evt-old-dead", "evt-new-dead"]);

  fail(outbox, A, "evt-4", 4000);
  assert.equal(outbox.size, 3);
  assert.deepEqual(deadIds(outbox), ["evt-new-dead"]);
  assert.deepEqual(pendingIds(outbox), ["evt-pending", "evt-4"]);
});

test("pending pairs are evicted only once no dead letter remains", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 3 });
  fail(outbox, A, "evt-dead", 1000, 3);
  fail(outbox, A, "evt-2", 2000);
  fail(outbox, A, "evt-3", 3000);
  // First insert takes the dead letter; the second insert, with no
  // dead letter left, takes the oldest pending pair.
  fail(outbox, A, "evt-4", 4000);
  assert.deepEqual(deadIds(outbox), []);
  fail(outbox, A, "evt-5", 5000);
  assert.equal(outbox.size, 3);
  assert.deepEqual(pendingIds(outbox), ["evt-3", "evt-4", "evt-5"]);
});

test("a burst of fresh pairs never pushes size past maxEntries", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 10 });
  for (let i = 0; i < 50; i++) {
    fail(outbox, A, `evt-${String(i).padStart(2, "0")}`, 1000 + i);
    assert.ok(outbox.size <= 10, `size ${outbox.size} after ${i + 1} pairs`);
  }
  assert.equal(outbox.size, 10);
  assert.deepEqual(
    pendingIds(outbox),
    Array.from({ length: 10 }, (_, i) => `evt-${40 + i}`),
  );
});

test("re-failing a tracked pair at capacity evicts nothing", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 2 });
  fail(outbox, A, "evt-1", 1000);
  fail(outbox, A, "evt-2", 2000);
  fail(outbox, A, "evt-1", 3000);
  assert.equal(outbox.size, 2);
  assert.deepEqual(
    outbox.pending().map((entry) => [entry.eventId, entry.attempts]),
    [
      ["evt-1", 2],
      ["evt-2", 1],
    ],
  );
});

test("an evicted pair re-fails from attempts 1", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 1 });
  fail(outbox, A, "evt-1", 1000);
  fail(outbox, A, "evt-2", 2000);
  assert.deepEqual(pendingIds(outbox), ["evt-2"]);
  fail(outbox, A, "evt-1", 3000);
  assert.deepEqual(pendingIds(outbox), ["evt-1"]);
  assert.equal(outbox.pending()[0].attempts, 1);
  assert.equal(outbox.pending()[0].lastAt, 3000);
});

test("eviction leaves surviving pairs' attempts and status untouched", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 3 });
  fail(outbox, A, "evt-dead-kept", 2000, 3);
  fail(outbox, A, "evt-dead-dropped", 1000, 3);
  fail(outbox, A, "evt-pending", 3000, 2);
  fail(outbox, A, "evt-4", 4000);
  assert.deepEqual(deadIds(outbox), ["evt-dead-kept"]);
  assert.deepEqual(
    outbox.deadLetter().map((entry) => entry.attempts),
    [3],
  );
  assert.deepEqual(
    outbox.pending().map((entry) => [entry.eventId, entry.attempts]),
    [
      ["evt-pending", 2],
      ["evt-4", 1],
    ],
  );
});

test("restore trims an over-capacity snapshot to the newest pairs by lastAt", () => {
  const source = new PayoutWebhookOutbox();
  for (let i = 1; i <= 5; i++) fail(source, A, `evt-${i}`, i * 1000);
  const snapshot = source.exportSnapshot();
  assert.equal(snapshot.entries.length, 5);

  const restored = PayoutWebhookOutbox.restore(snapshot, { maxEntries: 3 });
  assert.equal(restored.size, 3);
  assert.deepEqual(pendingIds(restored), ["evt-3", "evt-4", "evt-5"]);
});

test("restore trims by lastAt, not by snapshot order", () => {
  const source = new PayoutWebhookOutbox();
  // Snapshot order is newest-first here; the trim must still drop
  // the two oldest by lastAt, wherever they sit in the array.
  fail(source, A, "evt-newest", 5000);
  fail(source, A, "evt-oldest", 1000);
  fail(source, A, "evt-mid", 3000);
  fail(source, A, "evt-old", 2000);
  fail(source, A, "evt-new", 4000);
  const snapshot = source.exportSnapshot();
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.eventId),
    ["evt-newest", "evt-oldest", "evt-mid", "evt-old", "evt-new"],
  );

  const restored = PayoutWebhookOutbox.restore(snapshot, { maxEntries: 3 });
  assert.equal(restored.size, 3);
  assert.deepEqual(
    pendingIds(restored).sort(),
    ["evt-mid", "evt-new", "evt-newest"],
  );
});

test("restore keeps the whole snapshot when it fits the cap", () => {
  const source = new PayoutWebhookOutbox();
  fail(source, A, "evt-1", 1000);
  fail(source, A, "evt-2", 2000);
  const restored = PayoutWebhookOutbox.restore(source.exportSnapshot(), {
    maxEntries: 3,
  });
  assert.equal(restored.size, 2);
  assert.deepEqual(pendingIds(restored), ["evt-1", "evt-2"]);
});

test("illegal maxEntries is rejected in the constructor and at restore", () => {
  const bad = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3"];
  for (const value of bad) {
    assert.throws(
      () => new PayoutWebhookOutbox({ maxEntries: value as never }),
      /PayoutWebhookOutbox: maxEntries must be a positive integer/,
    );
    assert.throws(
      () =>
        PayoutWebhookOutbox.restore(
          { v: 1, entries: [] },
          { maxEntries: value as never },
        ),
      /PayoutWebhookOutbox: maxEntries must be a positive integer/,
    );
  }
  // `null`/`undefined` fall back to the 10_000 default, the same
  // `??` convention as `maxAttempts` (and `PayoutEventDedupe`).
  assert.equal(new PayoutWebhookOutbox({ maxEntries: null as never }).size, 0);
  // maxEntries: 1 is the smallest legal cap.
  assert.equal(new PayoutWebhookOutbox({ maxEntries: 1 }).size, 0);
});

test("default maxEntries is 10_000", () => {
  const outbox = new PayoutWebhookOutbox();
  for (let i = 0; i < 10_001; i++) {
    fail(outbox, A, `evt-${i}`, 1000 + i);
  }
  assert.equal(outbox.size, 10_000);
  assert.deepEqual(
    outbox.pending().map((entry) => entry.eventId).slice(0, 1),
    ["evt-1"],
  );
  assert.ok(
    outbox.pending().some((entry) => entry.eventId === "evt-10000"),
  );
});

test("signed snapshot restore trims over-capacity the same way", () => {
  const source = new PayoutWebhookOutbox();
  for (let i = 1; i <= 5; i++) fail(source, A, `evt-${i}`, i * 1000);
  const envelope = source.exportSignedSnapshot(SECRET);
  const restored = PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
    maxEntries: 3,
  });
  assert.equal(restored.size, 3);
  assert.deepEqual(pendingIds(restored), ["evt-3", "evt-4", "evt-5"]);
});

test("eviction spans endpoints: a dead letter on another endpoint goes first", () => {
  const outbox = new PayoutWebhookOutbox({ maxEntries: 2 });
  fail(outbox, A, "evt-1", 1000, 3);
  fail(outbox, B, "evt-2", 2000);
  fail(outbox, A, "evt-3", 3000);
  assert.equal(outbox.size, 2);
  assert.deepEqual(deadIds(outbox), []);
  assert.deepEqual(pendingIds(outbox), ["evt-2", "evt-3"]);
});
