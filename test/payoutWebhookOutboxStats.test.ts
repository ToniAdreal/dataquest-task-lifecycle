import test from "node:test";
import assert from "node:assert/strict";
import { PayoutWebhookOutbox } from "../src/index.js";

/**
 * `PayoutWebhookOutbox.stats()` observability counts (backlog #1124,
 * the dataquest-side mirror of escrow #1120).
 *
 * `stats()` returns `{ size, pending, deadLettered, totalAttempts }`:
 *  - `size` is the same number as the `size` getter (pending +
 *    dead-lettered)
 *  - `pending` counts pairs with `attempts < maxAttempts`, the same
 *    population as `pending()`, without materializing the list
 *  - `deadLettered` counts pairs with `attempts >= maxAttempts`,
 *    the same population as `deadLetter()`
 *  - `totalAttempts` sums `attempts` over every tracked pair,
 *    dead-lettered pairs included — a pair that failed three times
 *    contributes 3, not 1
 *  - pure read: calling `stats()` changes nothing in the ledger,
 *    and the returned object is a fresh copy
 */

const A = "https://payouts.example/hooks/payout";
const B = "https://ledger.example/hooks/payout";
const EVT_1 = "evt-0001";
const EVT_2 = "evt-0002";
const EVT_3 = "evt-0003";

function fail(
  outbox: PayoutWebhookOutbox,
  endpoint: string,
  eventId: string,
  times = 1,
  at = 1_000_000,
): void {
  for (let i = 0; i < times; i++) {
    outbox.recordAttempt({
      endpoint,
      eventId,
      ok: false,
      error: "server responded with status 500",
      at: at + i,
    });
  }
}

test("empty outbox reports all zeros", () => {
  const outbox = new PayoutWebhookOutbox();
  assert.deepEqual(outbox.stats(), {
    size: 0,
    pending: 0,
    deadLettered: 0,
    totalAttempts: 0,
  });
  assert.equal(outbox.size, 0);
});

test("mixed ledger counts pending, dead-lettered and attempts separately", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 1); // pending, 1 attempt
  fail(outbox, A, EVT_2, 2); // pending, 2 attempts
  fail(outbox, B, EVT_3, 3); // dead-lettered, 3 attempts (capped)

  assert.deepEqual(outbox.stats(), {
    size: 3,
    pending: 2,
    deadLettered: 1,
    totalAttempts: 6,
  });
  assert.equal(outbox.stats().size, outbox.size);
  assert.equal(outbox.pending().length, 2);
  assert.equal(outbox.deadLetter().length, 1);
});

test("dead-lettered pairs keep counting their capped attempts", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 3);
  // Further failures refresh lastError/lastAt but attempts stay capped.
  fail(outbox, A, EVT_1, 2, 2_000_000);
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 0,
    deadLettered: 1,
    totalAttempts: 3,
  });
  assert.equal(outbox.deadLetter()[0].attempts, 3);
});

test("counts follow recordAttempt across the pending to dead-letter boundary", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 1);
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 1,
    deadLettered: 0,
    totalAttempts: 1,
  });
  fail(outbox, A, EVT_1, 1);
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 1,
    deadLettered: 0,
    totalAttempts: 2,
  });
  fail(outbox, A, EVT_1, 1);
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 0,
    deadLettered: 1,
    totalAttempts: 3,
  });
});

test("acknowledge drops the pair and the counts follow", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 2);
  fail(outbox, B, EVT_2, 3);
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 1,
    deadLettered: 1,
    totalAttempts: 5,
  });
  outbox.acknowledge(A, EVT_1);
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 0,
    deadLettered: 1,
    totalAttempts: 3,
  });
  outbox.acknowledge(B, EVT_2);
  assert.deepEqual(outbox.stats(), {
    size: 0,
    pending: 0,
    deadLettered: 0,
    totalAttempts: 0,
  });
});

test("a successful attempt clears the pair and the counts follow", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 2);
  fail(outbox, A, EVT_2, 1);
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 2,
    deadLettered: 0,
    totalAttempts: 3,
  });
  outbox.recordAttempt({ endpoint: A, eventId: EVT_1, ok: true });
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 1,
    deadLettered: 0,
    totalAttempts: 1,
  });
});

test("clear resets every count to zero", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 3);
  fail(outbox, B, EVT_2, 1);
  assert.equal(outbox.stats().size, 2);
  outbox.clear();
  assert.deepEqual(outbox.stats(), {
    size: 0,
    pending: 0,
    deadLettered: 0,
    totalAttempts: 0,
  });
});

test("stats is a pure read: the ledger is byte-identical afterwards", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 2);
  fail(outbox, B, EVT_2, 3);
  const pendingBefore = JSON.stringify(outbox.pending());
  const deadBefore = JSON.stringify(outbox.deadLetter());
  const snapshotBefore = JSON.stringify(outbox.exportSnapshot());
  const stats = outbox.stats();
  assert.equal(JSON.stringify(outbox.pending()), pendingBefore);
  assert.equal(JSON.stringify(outbox.deadLetter()), deadBefore);
  assert.equal(JSON.stringify(outbox.exportSnapshot()), snapshotBefore);
  // Mutating the returned object does not touch the ledger either.
  stats.pending = 999;
  stats.totalAttempts = 999;
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 1,
    deadLettered: 1,
    totalAttempts: 5,
  });
});

test("restore preserves the counts, re-derived under the new maxAttempts", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 2); // pending under maxAttempts 3
  fail(outbox, B, EVT_2, 3); // dead-lettered under maxAttempts 3
  const snapshot = JSON.parse(JSON.stringify(outbox.exportSnapshot()));

  const same = PayoutWebhookOutbox.restore(snapshot, { maxAttempts: 3 });
  assert.deepEqual(same.stats(), outbox.stats());

  // Under a tighter cap the 2-attempt pair is dead-lettered too,
  // while totalAttempts is unchanged: the boundary is derived,
  // the attempts are carried.
  const tighter = PayoutWebhookOutbox.restore(snapshot, { maxAttempts: 2 });
  assert.deepEqual(tighter.stats(), {
    size: 2,
    pending: 0,
    deadLettered: 2,
    totalAttempts: 5,
  });
});

test("same eventId on two endpoints counts as two independent pairs", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 1);
  fail(outbox, B, EVT_1, 1);
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 2,
    deadLettered: 0,
    totalAttempts: 2,
  });
});
