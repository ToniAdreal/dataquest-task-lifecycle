import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Payout webhook x `toJSON()`/`fromJSON()` snapshot restore (backlog #801).
 *
 * `test/payoutWebhook*.test.ts` never mentioned snapshots, and the
 * snapshot tests never built a payout webhook — so nothing pinned
 * that a PAID task restored from a persisted snapshot announces the
 * same settlement, with the same payoutRef and the same signature,
 * as the task it was restored from.
 *
 * What the implementation actually says (read before writing, not
 * assumed): `buildPayoutWebhook` derives everything it announces
 * from the task's history — the payoutRef/payoutAmount of the last
 * PAYOUT_COMPLETE entry and the quotedAmount of the last ACCEPT
 * entry — plus caller-supplied `eventId`/`now`. The snapshot
 * envelope (`toJSON()`) carries the full history, so a restored
 * task rebuilt with the same `eventId`/`now` must produce a
 * byte-identical payload and signature. The signature covers the
 * canonical JSON body alone, so equality of payload + signature is
 * the real discrimination here, not just equality of the
 * caller-supplied `eventId`.
 *
 * One honest reading note on the backlog wording: "restored task
 * keeps dispatching" cannot mean a successful post-PAID dispatch —
 * PAID is terminal, and any dispatch from it throws `invalid
 * transition`. The testable form of that clause is therefore that
 * a failed dispatch on the restored task leaves an already-built
 * webhook untouched: same payload, same signature, still verifies.
 *
 * Rules pinned here:
 *  - a snapshot restored through a JSON stringify/parse round-trip
 *    (the store path) rebuilds the same webhook: payload deep-equal
 *    and signature identical to the pre-restore build
 *  - the restored task's state and history are identical to the
 *    original snapshot, including the PAYOUT_COMPLETE payoutRef /
 *    payoutAmount and the ACCEPT quotedAmount
 *  - the restored webhook verifies, while a tampered body and a
 *    wrong secret both fail verification (so the pass is not vacuous)
 *  - a failed dispatch on the restored PAID task changes neither
 *    its history nor an already-built webhook
 *  - a corrupted snapshot fails restore, so no task — and therefore
 *    no webhook — can be produced from it (tampered payoutAmount,
 *    and a history entry removed mid-chain, both fail)
 *  - a non-PAID task restored from a snapshot still cannot build a
 *    payout webhook: the only-PAID guard applies after restore too
 */

const SECRET = "whsec_test_payout_snapshot_restore_20261101";
const NOW = new Date("2026-11-01T00:00:00.000Z");
const EVENT_ID = "evt-snapshot-restore-1";

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(
  id: string,
  payoutRef = "xfer-snapshot-restore-1",
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

describe("payout webhook x snapshot restore", () => {
  it("restored task builds a payload-identical, signature-identical webhook", () => {
    const task = paidTask("task-snapshot-restore-1");
    const before = buildPayoutWebhook(task, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    assert.equal(before.payload.payoutRef, "xfer-snapshot-restore-1");
    assert.equal(before.payload.payoutAmount, 4200);
    assert.equal(before.payload.quotedAmount, 4500);

    const restored = restoreThroughJson(task);
    const after = buildPayoutWebhook(restored, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    assert.deepEqual(after.payload, before.payload);
    assert.equal(after.signature, before.signature);
    assert.equal(
      verifyPayoutWebhook(JSON.stringify(after.payload), after.signature, SECRET),
      true,
    );
    assert.equal(
      verifyPayoutWebhook(JSON.stringify(before.payload), before.signature, SECRET),
      true,
    );
  });

  it("restored task keeps the same state, history, and snapshot", () => {
    const task = paidTask("task-snapshot-restore-2");
    const snapshot = task.toJSON();
    const restored = restoreThroughJson(task);
    assert.equal(restored.state, "PAID");
    assert.deepEqual(restored.toJSON(), snapshot);
    const complete = restored.history.find(
      (e) => e.event === "PAYOUT_COMPLETE",
    );
    assert.equal(complete?.payoutRef, "xfer-snapshot-restore-1");
    assert.equal(complete?.payoutAmount, 4200);
  });

  it("restored webhook verifies, tampered body and wrong secret do not", () => {
    const task = paidTask("task-snapshot-restore-3");
    const restored = restoreThroughJson(task);
    const webhook = buildPayoutWebhook(restored, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    const raw = JSON.stringify(webhook.payload);
    assert.equal(verifyPayoutWebhook(raw, webhook.signature, SECRET), true);
    const tampered = JSON.stringify({ ...webhook.payload, payoutAmount: 4201 });
    assert.equal(verifyPayoutWebhook(tampered, webhook.signature, SECRET), false);
    assert.equal(
      verifyPayoutWebhook(raw, webhook.signature, "whsec_wrong_secret"),
      false,
    );
  });

  it("a failed dispatch on the restored PAID task leaves a built webhook untouched", () => {
    const task = paidTask("task-snapshot-restore-4");
    const restored = restoreThroughJson(task);
    const webhook = buildPayoutWebhook(restored, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    const historyBefore = restored.history;
    assert.throws(
      () => restored.dispatch("PUBLISH"),
      /invalid transition: PUBLISH from PAID/,
    );
    assert.deepEqual(restored.history, historyBefore);
    assert.equal(restored.state, "PAID");
    assert.equal(
      verifyPayoutWebhook(
        JSON.stringify(webhook.payload),
        webhook.signature,
        SECRET,
      ),
      true,
    );
  });

  it("a snapshot with a tampered payoutAmount fails restore and yields no webhook", () => {
    const task = paidTask("task-snapshot-restore-5");
    const snapshot = task.toJSON() as unknown as {
      history: Array<{ payoutAmount?: number }>;
    };
    const complete = snapshot.history.find(
      (e) => "payoutAmount" in e && e.payoutAmount === 4200,
    );
    assert.notEqual(complete, undefined);
    complete!.payoutAmount = 4201;
    assert.throws(() => TaskLifecycle.fromJSON(snapshot));
    // fromJSON threw, so there is no task object from which a
    // webhook could be built at all — the failure is the guard.
  });

  it("a snapshot with a history entry removed mid-chain fails restore", () => {
    const task = paidTask("task-snapshot-restore-6");
    const snapshot = task.toJSON() as unknown as {
      history: unknown[];
    };
    snapshot.history = snapshot.history.filter(
      (_e, i) => i !== 2,
    );
    assert.throws(() => TaskLifecycle.fromJSON(snapshot));
  });

  it("a non-PAID task restored from a snapshot still cannot build a webhook", () => {
    const t = new TaskLifecycle("task-snapshot-restore-7");
    t.dispatch("PUBLISH", { actor: "researcher" });
    t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 4500 });
    const restored = restoreThroughJson(t);
    assert.equal(restored.state, "ACCEPTED");
    assert.throws(
      () =>
        buildPayoutWebhook(restored, SECRET, {
          eventId: EVENT_ID,
          now: NOW,
        }),
      /only PAID tasks have a completed settlement/,
    );
  });

  it("two restored tasks keep their own payoutRefs, with no cross-contamination", () => {
    const first = restoreThroughJson(
      paidTask("task-snapshot-restore-8a", "xfer-snapshot-a", 4200),
    );
    const second = restoreThroughJson(
      paidTask("task-snapshot-restore-8b", "xfer-snapshot-b", 9100),
    );
    const firstWebhook = buildPayoutWebhook(first, SECRET, {
      eventId: "evt-snapshot-a",
      now: NOW,
    });
    const secondWebhook = buildPayoutWebhook(second, SECRET, {
      eventId: "evt-snapshot-b",
      now: NOW,
    });
    assert.equal(firstWebhook.payload.payoutRef, "xfer-snapshot-a");
    assert.equal(firstWebhook.payload.payoutAmount, 4200);
    assert.equal(secondWebhook.payload.payoutRef, "xfer-snapshot-b");
    assert.equal(secondWebhook.payload.payoutAmount, 9100);
    assert.notEqual(firstWebhook.signature, secondWebhook.signature);
  });
});
