import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";

/**
 * Payout webhook x `toJSON()`/`fromJSON()` snapshot restore x
 * `PayoutEventDedupe` receiver (backlog #820).
 *
 * The two halves already had their own coverage, but never together:
 * `test/payoutWebhookSnapshotRestore.test.ts` pins that a PAID task
 * restored from a snapshot builds the same webhook (no dedupe), and
 * `test/payoutWebhookVerifyDedupe.test.ts` pins the verify-then-record
 * receiver flow (no snapshot restore). Nothing pinned the combination:
 * whether a webhook built from a restored task deduplicates against
 * the original task's webhook on the same `eventId`, and whether a
 * tampered snapshot that fails restore leaves the receiver's dedupe
 * store untouched.
 *
 * Rules pinned here:
 *  - a webhook built from a `fromJSON`-restored PAID task, with the
 *    same `eventId`/`now`/secret, is payload- and signature-identical
 *    to the original task's webhook, so the receiver reports it as a
 *    duplicate of the original delivery, not a second payout
 *  - the order does not matter: a restored-first delivery is accepted
 *    and the original task's redelivery of the same `eventId` is then
 *    the duplicate
 *  - dedupe keys on `eventId`, not on task or payout: the same
 *    restored payout re-announced under a fresh `eventId` is accepted
 *    (this keeps the duplicate verdicts above from being vacuous)
 *  - a snapshot with a tampered `payoutAmount` fails restore, so no
 *    task — and therefore no webhook — can be produced from it, and
 *    the dedupe store stays empty
 *  - a failed tampered restore does not poison the dedupe store: the
 *    clean restored delivery afterwards, under the same `eventId`, is
 *    still a first sighting
 *  - a tampered body of a restored webhook is rejected and records
 *    nothing, so the true restored delivery afterwards is accepted
 *
 * Honest boundary, stated in the test rather than implied: a restored
 * PAID task cannot dispatch a second payout — PAID is terminal and
 * any further dispatch throws `invalid transition`. `buildPayoutWebhook`
 * itself is a pure announcement builder: it does not consume the
 * settlement, so rebuilding the same `eventId` is always possible and
 * only the receiver-side dedupe prevents double-processing. The test
 * pins exactly that split: dispatch-side terminal lock plus
 * receiver-side duplicate verdict, never a claim that rebuilding is
 * blocked.
 */

const SECRET = "whsec_test_payout_snapshot_dedupe_20261102";
const NOW = new Date("2026-11-02T00:00:00.000Z");
const EVENT_ID = "evt-snapshot-dedupe-1";

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(
  id: string,
  payoutRef = "xfer-snapshot-dedupe-1",
  payoutAmount = 4200,
): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 4500 });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef,
    payoutAmount,
  });
  assert.equal(t.state, "PAID");
  return t;
}

/** Restore a task through the JSON wire format a store would use. */
function restoreThroughJson(task: TaskLifecycle): TaskLifecycle {
  const wire = JSON.stringify(task.toJSON());
  return TaskLifecycle.fromJSON(JSON.parse(wire));
}

type ReceiveOutcome = "accepted" | "duplicate" | "rejected";

/**
 * The documented receiver order: verify the raw wire body first; only
 * a verified delivery reaches `checkAndRecord`. A rejected delivery
 * never touches the dedupe store.
 */
function receive(
  raw: string,
  signature: string,
  dedupe: PayoutEventDedupe,
): ReceiveOutcome {
  if (!verifyPayoutWebhook(raw, signature, SECRET)) return "rejected";
  const payload = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(payload.eventId) ? "duplicate" : "accepted";
}

describe("payout webhook x snapshot restore x PayoutEventDedupe", () => {
  it("restored-task delivery of the same eventId is a duplicate of the original", () => {
    const task = paidTask("task-snapshot-dedupe-1");
    const original = buildPayoutWebhook(task, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    const restored = restoreThroughJson(task);
    const rebuilt = buildPayoutWebhook(restored, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    // Same settlement, same event: the restored build is not a new
    // payout announcement, it is the same announcement rebuilt.
    assert.deepEqual(rebuilt.payload, original.payload);
    assert.equal(rebuilt.signature, original.signature);

    const dedupe = new PayoutEventDedupe();
    assert.equal(
      receive(JSON.stringify(original.payload), original.signature, dedupe),
      "accepted",
    );
    assert.equal(
      receive(JSON.stringify(rebuilt.payload), rebuilt.signature, dedupe),
      "duplicate",
    );
    assert.equal(dedupe.size, 1);
    assert.deepEqual(dedupe.stats(), {
      size: 1,
      hits: 1,
      misses: 1,
      evictions: 0,
    });
  });

  it("restored-first delivery is accepted, the original redelivery is the duplicate", () => {
    const task = paidTask("task-snapshot-dedupe-2");
    const original = buildPayoutWebhook(task, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    const restored = restoreThroughJson(task);
    const rebuilt = buildPayoutWebhook(restored, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });

    const dedupe = new PayoutEventDedupe();
    assert.equal(
      receive(JSON.stringify(rebuilt.payload), rebuilt.signature, dedupe),
      "accepted",
    );
    assert.equal(
      receive(JSON.stringify(original.payload), original.signature, dedupe),
      "duplicate",
    );
    assert.equal(dedupe.size, 1);
  });

  it("the same restored payout under a fresh eventId is accepted, not a duplicate", () => {
    const task = paidTask("task-snapshot-dedupe-3");
    const original = buildPayoutWebhook(task, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    const restored = restoreThroughJson(task);
    const fresh = buildPayoutWebhook(restored, SECRET, {
      eventId: "evt-snapshot-dedupe-fresh",
      now: NOW,
    });
    assert.notEqual(fresh.payload.eventId, original.payload.eventId);

    const dedupe = new PayoutEventDedupe();
    assert.equal(
      receive(JSON.stringify(original.payload), original.signature, dedupe),
      "accepted",
    );
    // Dedupe keys on eventId, not on task or payout: a fresh eventId
    // is a distinct delivery even though the settlement is identical.
    assert.equal(
      receive(JSON.stringify(fresh.payload), fresh.signature, dedupe),
      "accepted",
    );
    assert.equal(dedupe.size, 2);
  });

  it("a snapshot with a tampered payoutAmount fails restore and leaves dedupe empty", () => {
    const task = paidTask("task-snapshot-dedupe-4");
    const snapshot = task.toJSON() as unknown as {
      history: Array<{ payoutAmount?: number }>;
    };
    const complete = snapshot.history.find(
      (e) => "payoutAmount" in e && e.payoutAmount === 4200,
    );
    assert.notEqual(complete, undefined);
    complete!.payoutAmount = 4201;

    const dedupe = new PayoutEventDedupe();
    let restored: TaskLifecycle | undefined;
    assert.throws(() => {
      restored = TaskLifecycle.fromJSON(snapshot);
    });
    // fromJSON threw, so there is no task object from which a webhook
    // could be built at all, and nothing ever reached the receiver.
    assert.equal(restored, undefined);
    assert.equal(dedupe.size, 0);
    assert.deepEqual(dedupe.stats(), {
      size: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
    });
  });

  it("a failed tampered restore does not poison dedupe: the clean delivery is first-seen", () => {
    const task = paidTask("task-snapshot-dedupe-5");
    const snapshot = task.toJSON() as unknown as {
      history: Array<{ payoutAmount?: number }>;
    };
    const complete = snapshot.history.find(
      (e) => "payoutAmount" in e && e.payoutAmount === 4200,
    );
    assert.notEqual(complete, undefined);
    complete!.payoutAmount = 4201;

    const dedupe = new PayoutEventDedupe();
    assert.throws(() => TaskLifecycle.fromJSON(snapshot));
    assert.equal(dedupe.size, 0);

    // The clean restore under the same eventId is still a first
    // sighting: the failed attempt recorded nothing.
    const clean = restoreThroughJson(task);
    const webhook = buildPayoutWebhook(clean, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    assert.equal(
      receive(JSON.stringify(webhook.payload), webhook.signature, dedupe),
      "accepted",
    );
    assert.equal(dedupe.size, 1);
  });

  it("a tampered body of a restored webhook is rejected and records nothing", () => {
    const task = paidTask("task-snapshot-dedupe-6");
    const restored = restoreThroughJson(task);
    const webhook = buildPayoutWebhook(restored, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    const raw = JSON.stringify(webhook.payload);
    const tampered = JSON.stringify({
      ...webhook.payload,
      payoutAmount: 4201,
    });
    assert.notEqual(tampered, raw);

    const dedupe = new PayoutEventDedupe();
    assert.equal(verifyPayoutWebhook(tampered, webhook.signature, SECRET), false);
    assert.equal(receive(tampered, webhook.signature, dedupe), "rejected");
    assert.equal(dedupe.size, 0);
    // The forgery did not poison the store: the true restored
    // delivery is still a first sighting.
    assert.equal(receive(raw, webhook.signature, dedupe), "accepted");
    assert.equal(receive(raw, webhook.signature, dedupe), "duplicate");
  });

  it("restored PAID task cannot dispatch a second payout; re-announcing is a duplicate, not a new payout", () => {
    const task = paidTask("task-snapshot-dedupe-7");
    const restored = restoreThroughJson(task);
    const webhook = buildPayoutWebhook(restored, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    const historyBefore = restored.history;
    // Terminal lock is dispatch-side: no second PAYOUT_COMPLETE, no
    // new history entry, no new settlement — only the receiver-side
    // dedupe verdict guards against double-processing a rebuild.
    assert.throws(
      () =>
        restored.dispatch("PAYOUT_COMPLETE", {
          actor: "system",
          payoutRef: "xfer-snapshot-dedupe-again",
          payoutAmount: 4200,
        }),
      /invalid transition: PAYOUT_COMPLETE from PAID/,
    );
    assert.deepEqual(restored.history, historyBefore);
    assert.equal(restored.state, "PAID");

    const dedupe = new PayoutEventDedupe();
    assert.equal(
      receive(JSON.stringify(webhook.payload), webhook.signature, dedupe),
      "accepted",
    );
    const rebuilt = buildPayoutWebhook(restored, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    assert.deepEqual(rebuilt.payload, webhook.payload);
    assert.equal(rebuilt.signature, webhook.signature);
    assert.equal(
      receive(JSON.stringify(rebuilt.payload), rebuilt.signature, dedupe),
      "duplicate",
    );
  });
});
