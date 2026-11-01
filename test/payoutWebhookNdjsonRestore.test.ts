import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  historyFromNdjson,
  historyToNdjson,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Payout webhook x NDJSON restore (backlog #802).
 *
 * `test/ndjsonPayout.test.ts` (#674) pinned that payout fields
 * survive an NDJSON round-trip, and `test/payoutWebhook*.test.ts`
 * pinned that a PAID task announces a signed payout webhook — but
 * no file pinned the two together: a PAID task rebuilt from its
 * shipped NDJSON log must announce the very same settlement, with
 * the same payoutRef/payoutAmount and the same signature, as the
 * task the log was exported from.
 *
 * What the implementation actually says (read before writing, not
 * assumed): `buildPayoutWebhook` derives everything it announces
 * from the task's history — the payoutRef/payoutAmount of the last
 * PAYOUT_COMPLETE entry and the quotedAmount of the last ACCEPT
 * entry — plus the caller-supplied `eventId`/`now` and the task id.
 * The NDJSON log carries the full history but no task id, so the
 * restoring caller supplies the id explicitly to `fromHistory`
 * (exactly as `test/ndjsonPayout.test.ts` already does); restoring
 * under the original id with the same `eventId`/`now` must then
 * produce a byte-identical payload and signature. The signature
 * covers the canonical JSON body alone, so equality of payload +
 * signature is the real discrimination here, not just equality of
 * the caller-supplied `eventId`.
 *
 * Rules pinned here:
 *  - an NDJSON-restored PAID task builds a payload-identical,
 *    signature-identical webhook (same id, eventId, and timestamp)
 *  - the restored task's history is deep-equal to the original's,
 *    its state is PAID, and the payout fields ride on the
 *    PAYOUT_COMPLETE NDJSON line itself
 *  - the restored webhook verifies, while a tampered body and a
 *    wrong secret both fail verification (so the pass is not vacuous)
 *  - a payout line tampered to an invalid amount fails import with
 *    its NDJSON line number, so no task — and therefore no
 *    webhook — can be produced from it
 *  - a payout line rewritten to another valid amount is caught by
 *    the hash chain instead (field validation passes, so the chain
 *    is what fails closed — asserted as-is, not papered over)
 *  - a non-PAID task restored from NDJSON still cannot build a
 *    payout webhook: the only-PAID guard applies after restore too
 *  - blank-line-tolerant NDJSON (the shipper's trailing newline
 *    and stray blank lines) restores the same webhook
 *  - two restored tasks keep their own payoutRefs, with no
 *    cross-contamination
 */

const SECRET = "whsec_test_payout_ndjson_restore_20261101";
const NOW = new Date("2026-11-01T00:00:00.000Z");
const EVENT_ID = "evt-ndjson-restore-1";

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(
  id: string,
  payoutRef = "xfer-ndjson-restore-1",
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

/**
 * Restore a task through the NDJSON wire format a log shipper
 * would carry. The log carries no task id, so the caller supplies
 * the original id — the same explicit-id contract
 * `test/ndjsonPayout.test.ts` already uses.
 */
function restoreThroughNdjson(
  task: TaskLifecycle,
  id: string = task.id,
): TaskLifecycle {
  const text = historyToNdjson(task);
  return TaskLifecycle.fromHistory(id, historyFromNdjson(text));
}

/** Replace the PAYOUT_COMPLETE (last) NDJSON line with a mutated copy. */
function withMutatedLastLine(
  text: string,
  mutate: (entry: Record<string, unknown>) => void,
): string {
  const lines = text.trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  mutate(last);
  lines[lines.length - 1] = JSON.stringify(last);
  return lines.join("\n") + "\n";
}

describe("payout webhook x NDJSON restore", () => {
  it("restored task builds a payload-identical, signature-identical webhook", () => {
    const task = paidTask("task-ndjson-restore-1");
    const before = buildPayoutWebhook(task, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    assert.equal(before.payload.payoutRef, "xfer-ndjson-restore-1");
    assert.equal(before.payload.payoutAmount, 4200);
    assert.equal(before.payload.quotedAmount, 4500);

    const restored = restoreThroughNdjson(task);
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

  it("restored history is deep-equal, state is PAID, payout fields ride the last line", () => {
    const task = paidTask("task-ndjson-restore-2");
    const text = historyToNdjson(task);
    const lines = text.trim().split("\n");
    assert.equal(lines.length, task.history.length);
    for (const line of lines.slice(0, -1)) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      assert.equal("payoutRef" in entry, false);
      assert.equal("payoutAmount" in entry, false);
    }
    const lastLine = JSON.parse(lines[lines.length - 1]) as Record<
      string,
      unknown
    >;
    assert.equal(lastLine.payoutRef, "xfer-ndjson-restore-1");
    assert.equal(lastLine.payoutAmount, 4200);

    const restored = restoreThroughNdjson(task);
    assert.equal(restored.state, "PAID");
    assert.deepEqual([...restored.history], [...task.history]);
    const last = restored.history[restored.history.length - 1];
    assert.equal(last.event, "PAYOUT_COMPLETE");
    assert.equal(last.payoutRef, "xfer-ndjson-restore-1");
    assert.equal(last.payoutAmount, 4200);
  });

  it("restored webhook verifies, tampered body and wrong secret do not", () => {
    const task = paidTask("task-ndjson-restore-3");
    const restored = restoreThroughNdjson(task);
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

  it("a payout line tampered to a negative amount fails import with its line number", () => {
    const task = paidTask("task-ndjson-restore-4");
    const bad = withMutatedLastLine(historyToNdjson(task), (entry) => {
      entry.payoutAmount = -5;
    });
    assert.throws(
      () => historyFromNdjson(bad),
      /invalid ndjson: line 8: payoutAmount must be a non-negative finite number, got -5/,
    );
    // historyFromNdjson threw, so there is no task object from
    // which a webhook could be built at all — the failure is the
    // guard, and no settlement is announced from a damaged log.
  });

  it("a payout line rewritten to another valid amount is caught by the hash chain", () => {
    const task = paidTask("task-ndjson-restore-5");
    const tampered = withMutatedLastLine(historyToNdjson(task), (entry) => {
      entry.payoutAmount = 9999;
    });
    // Field validation passes (9999 is a legal amount), so the
    // hash chain is what catches it. The chain error carries no
    // entry index, so it is not retagged with a line number —
    // asserted exactly as the library reports it.
    assert.throws(
      () => historyFromNdjson(tampered),
      /history hash chain is broken/,
    );
  });

  it("a non-PAID task restored from NDJSON still cannot build a webhook", () => {
    const t = new TaskLifecycle("task-ndjson-restore-6");
    t.dispatch("PUBLISH", { actor: "researcher" });
    t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 4500 });
    const restored = restoreThroughNdjson(t);
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

  it("blank-line-tolerant NDJSON restores the same webhook", () => {
    const task = paidTask("task-ndjson-restore-7");
    const before = buildPayoutWebhook(task, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    const shipped = "\n" + historyToNdjson(task).trim().split("\n").join("\n\n") + "\n\n";
    const restored = TaskLifecycle.fromHistory(
      task.id,
      historyFromNdjson(shipped),
    );
    assert.equal(restored.state, "PAID");
    const after = buildPayoutWebhook(restored, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    assert.deepEqual(after.payload, before.payload);
    assert.equal(after.signature, before.signature);
  });

  it("two restored tasks keep their own payoutRefs, with no cross-contamination", () => {
    const first = restoreThroughNdjson(
      paidTask("task-ndjson-restore-8a", "xfer-ndjson-a", 4200),
    );
    const second = restoreThroughNdjson(
      paidTask("task-ndjson-restore-8b", "xfer-ndjson-b", 9100),
    );
    const firstWebhook = buildPayoutWebhook(first, SECRET, {
      eventId: "evt-ndjson-a",
      now: NOW,
    });
    const secondWebhook = buildPayoutWebhook(second, SECRET, {
      eventId: "evt-ndjson-b",
      now: NOW,
    });
    assert.equal(firstWebhook.payload.payoutRef, "xfer-ndjson-a");
    assert.equal(firstWebhook.payload.payoutAmount, 4200);
    assert.equal(secondWebhook.payload.payoutRef, "xfer-ndjson-b");
    assert.equal(secondWebhook.payload.payoutAmount, 9100);
    assert.notEqual(firstWebhook.signature, secondWebhook.signature);
  });
});
