import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook x RESUBMIT (backlog #791).
 *
 * `test/payoutWebhook*.test.ts` never mentioned resubmit, and
 * `test/resubmitPayoutRef.test.ts` only pinned the payoutRef field
 * itself — nothing pinned what a payout webhook looks like after a
 * task was rejected, resubmitted, and only then paid out.
 *
 * What the implementation actually says (read before writing, not
 * assumed): RESUBMIT only runs from REJECTED to CAPTURING, and PAID
 * is terminal, so a resubmitted task announces exactly one payout —
 * there is no second PAID build from the same task to compare
 * against. The webhook payload therefore carries the payoutRef (and
 * payoutAmount) from that one PAYOUT_COMPLETE entry, never a ref
 * attached to an earlier, non-payout entry. On the receiver side
 * `PayoutEventDedupe` keys on the verified body's `eventId` alone
 * (`checkAndRecord` returns false = first sighting, true =
 * duplicate), and a RESUBMIT on the sender's task does not touch
 * the receiver's store at all.
 *
 * Rules pinned here, in the documented receiver order (verify the
 * raw body first, `checkAndRecord` only after a true verification):
 *  - a resubmitted task's webhook carries the new payoutRef from
 *    its PAYOUT_COMPLETE entry, not a ref carried by the earlier
 *    REJECT entry
 *  - that webhook's first delivery is a first sighting and its
 *    redelivery is a duplicate
 *  - an eventId the receiver already recorded before the resubmit
 *    (the pre-resubmit notification) is still a duplicate when
 *    replayed after the resubmit, while the new eventId is a first
 *    sighting — the resubmit does not reset dedupe
 *  - two distinct eventIds for the same resubmitted settlement are
 *    both first sightings: dedupe keys on eventId, not on
 *    taskId/payoutRef
 *  - a tampered resubmitted webhook fails verification, records
 *    nothing, and the true delivery afterwards is still a first
 *    sighting
 *  - no webhook can be built mid-resubmit: a resubmitted task in
 *    CAPTURING or PAYOUT_PENDING still throws the only-PAID error
 */

const SECRET = "whsec_test_payout_resubmit_20261101";
const URL = "https://receiver.example.com/hooks/payout";
const NOW = new Date("2026-11-01T00:00:00.000Z");
const NOW_ISO = "2026-11-01T00:00:00.000Z";
const TAMPERED_ISO = "2026-11-01T00:00:01.000Z";

/** Drive a fresh task to REJECTED. The REJECT entry deliberately
 *  carries a payoutRef of its own, so the payload test can show
 *  that only the PAYOUT_COMPLETE entry's ref is ever announced. */
function toRejected(task: TaskLifecycle): void {
  task.dispatch("PUBLISH");
  task.dispatch("ACCEPT");
  task.dispatch("START_CAPTURE");
  task.dispatch("SUBMIT");
  task.dispatch("BEGIN_REVIEW");
  task.dispatch("REJECT", { payoutRef: "xfer-rejected-attempt" });
}

/** Drive a REJECTED task through RESUBMIT to PAID. */
function resubmitToPaid(
  task: TaskLifecycle,
  payoutRef: string,
  payoutAmount: number,
): void {
  task.dispatch("RESUBMIT"); // REJECTED -> CAPTURING
  task.dispatch("SUBMIT");
  task.dispatch("BEGIN_REVIEW");
  task.dispatch("APPROVE");
  task.dispatch("REQUEST_PAYOUT");
  task.dispatch("PAYOUT_COMPLETE", { payoutRef, payoutAmount });
}

/** A fresh task rejected, resubmitted, then paid out with a new ref. */
function resubmittedPaidTask(
  id: string,
  payoutRef = "xfer-resubmit-new",
  payoutAmount = 9000,
): TaskLifecycle {
  const task = new TaskLifecycle(id);
  toRejected(task);
  resubmitToPaid(task, payoutRef, payoutAmount);
  assert.equal(task.state, "PAID");
  return task;
}

type ReceiveOutcome = "accepted" | "duplicate" | "rejected";

/**
 * The documented receiver order: verify the raw body first; only
 * a verified delivery reaches `checkAndRecord`. A rejected
 * delivery never touches the dedupe store.
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

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records every call and answers 200. */
function recordingFetch(): {
  fetchImpl: PayoutWebhookFetchImpl;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: PayoutWebhookFetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  return { fetchImpl, calls };
}

function bodyOf(call: RecordedCall): string {
  return String(call.init.body);
}
function signatureOf(call: RecordedCall): string {
  return String(new Headers(call.init.headers).get("x-hub-signature-256"));
}

describe("payout webhook x resubmit", () => {
  it("resubmitted task's webhook carries the new PAYOUT_COMPLETE payoutRef, not the REJECT entry's ref", () => {
    const task = resubmittedPaidTask("task-resubmit-1");
    // The REJECT entry in this task's history does carry a ref —
    // prove it is there, so the payload assertion below is a real
    // discrimination and not a vacuous absence.
    const rejectEntry = task.history.find((e) => e.event === "REJECT");
    assert.equal(rejectEntry?.payoutRef, "xfer-rejected-attempt");
    const completeEntry = task.history.find(
      (e) => e.event === "PAYOUT_COMPLETE",
    );
    assert.equal(completeEntry?.payoutRef, "xfer-resubmit-new");

    const webhook = buildPayoutWebhook(task, SECRET, {
      eventId: "evt-resubmit-new-1",
      now: NOW,
    });
    assert.equal(webhook.payload.taskId, "task-resubmit-1");
    assert.equal(webhook.payload.event, "PAYOUT_COMPLETE");
    assert.equal(webhook.payload.payoutRef, "xfer-resubmit-new");
    assert.equal(webhook.payload.payoutAmount, 9000);
    assert.equal(webhook.payload.eventId, "evt-resubmit-new-1");
    assert.equal(webhook.payload.at, NOW_ISO);
    assert.equal(
      verifyPayoutWebhook(JSON.stringify(webhook.payload), webhook.signature, SECRET),
      true,
    );
  });

  it("new event first sighting, redelivery duplicate", () => {
    const task = resubmittedPaidTask("task-resubmit-2");
    const webhook = buildPayoutWebhook(task, SECRET, {
      eventId: "evt-resubmit-new-2",
      now: NOW,
    });
    const raw = JSON.stringify(webhook.payload);
    const dedupe = new PayoutEventDedupe();
    assert.equal(receive(raw, webhook.signature, dedupe), "accepted");
    assert.equal(receive(raw, webhook.signature, dedupe), "duplicate");
    assert.deepEqual(dedupe.stats(), {
      size: 1,
      hits: 1,
      misses: 1,
      evictions: 0,
    });
  });

  it("old eventId recorded before the resubmit is still duplicate afterwards; new eventId is first sighting", async () => {
    // The receiver's store is independent of the sender's task: the
    // old notification was recorded before the resubmit completed,
    // and the resubmit itself must not reopen its dedupe window.
    const dedupe = new PayoutEventDedupe();
    assert.equal(dedupe.checkAndRecord("evt-resubmit-old"), false);

    const task = resubmittedPaidTask("task-resubmit-3");
    const webhook = buildPayoutWebhook(task, SECRET, {
      eventId: "evt-resubmit-new-3",
      now: NOW,
    });
    const raw = JSON.stringify(webhook.payload);
    // New event: first sighting.
    assert.equal(receive(raw, webhook.signature, dedupe), "accepted");
    // Old event replayed after the resubmit: still a duplicate,
    // even though the task has since moved on to a new payoutRef.
    assert.equal(dedupe.checkAndRecord("evt-resubmit-old"), true);
    assert.equal(dedupe.checkAndRecord("evt-resubmit-old"), true);
    assert.deepEqual(dedupe.stats(), {
      size: 2,
      hits: 2,
      misses: 2,
      evictions: 0,
    });
  });

  it("two distinct eventIds for the same resubmitted settlement are both first sightings", () => {
    const task = resubmittedPaidTask("task-resubmit-4");
    const first = buildPayoutWebhook(task, SECRET, {
      eventId: "evt-resubmit-4a",
      now: NOW,
    });
    const second = buildPayoutWebhook(task, SECRET, {
      eventId: "evt-resubmit-4b",
      now: NOW,
    });
    // Same task, same payoutRef, same amount — only the eventId
    // differs, and that alone must make the second a new event.
    assert.equal(first.payload.payoutRef, second.payload.payoutRef);
    assert.equal(first.payload.payoutAmount, second.payload.payoutAmount);
    assert.notEqual(first.payload.eventId, second.payload.eventId);

    const dedupe = new PayoutEventDedupe();
    assert.equal(
      receive(JSON.stringify(first.payload), first.signature, dedupe),
      "accepted",
    );
    assert.equal(
      receive(JSON.stringify(second.payload), second.signature, dedupe),
      "accepted",
    );
    assert.deepEqual(dedupe.stats(), {
      size: 2,
      hits: 0,
      misses: 2,
      evictions: 0,
    });
  });

  it("delivered resubmitted webhook: wire body verifies, header carries the new eventId, receiver accepts once then duplicates", async () => {
    const task = resubmittedPaidTask("task-resubmit-5");
    const webhook = buildPayoutWebhook(task, SECRET, {
      eventId: "evt-resubmit-new-5",
      now: NOW,
    });
    const { fetchImpl, calls } = recordingFetch();
    const result = await deliverPayoutWebhook(URL, webhook, { fetchImpl });
    assert.deepEqual(result, { ok: true, attempts: 1, status: 200 });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(bodyOf(call), JSON.stringify(webhook.payload));
    assert.equal(
      String(new Headers(call.init.headers).get("x-event-id")),
      "evt-resubmit-new-5",
    );

    const dedupe = new PayoutEventDedupe();
    assert.equal(receive(bodyOf(call), signatureOf(call), dedupe), "accepted");
    assert.equal(receive(bodyOf(call), signatureOf(call), dedupe), "duplicate");
    assert.equal(dedupe.size, 1);
  });

  it("tampered resubmitted webhook verifies false, records nothing, true delivery still first-seen", () => {
    const task = resubmittedPaidTask("task-resubmit-6");
    const webhook = buildPayoutWebhook(task, SECRET, {
      eventId: "evt-resubmit-new-6",
      now: NOW,
    });
    const raw = JSON.stringify(webhook.payload);
    const tampered = raw.replace(NOW_ISO, TAMPERED_ISO);
    assert.notEqual(tampered, raw);
    assert.equal(
      (JSON.parse(tampered) as { eventId: string }).eventId,
      "evt-resubmit-new-6",
    );
    assert.equal(verifyPayoutWebhook(tampered, webhook.signature, SECRET), false);

    const dedupe = new PayoutEventDedupe();
    assert.equal(receive(tampered, webhook.signature, dedupe), "rejected");
    assert.equal(dedupe.size, 0);
    assert.equal(receive(raw, webhook.signature, dedupe), "accepted");
    assert.equal(receive(raw, webhook.signature, dedupe), "duplicate");
    assert.equal(dedupe.size, 1);
  });

  it("no webhook mid-resubmit: CAPTURING and PAYOUT_PENDING tasks still throw the only-PAID error", () => {
    const capturing = new TaskLifecycle("task-resubmit-7a");
    toRejected(capturing);
    capturing.dispatch("RESUBMIT");
    assert.equal(capturing.state, "CAPTURING");
    assert.throws(
      () => buildPayoutWebhook(capturing, SECRET, { now: NOW }),
      (err: unknown) =>
        err instanceof Error &&
        /only PAID tasks have a completed settlement/.test(err.message),
      "a resubmitted task in CAPTURING has no settlement to announce",
    );

    const pending = new TaskLifecycle("task-resubmit-7b");
    toRejected(pending);
    pending.dispatch("RESUBMIT");
    pending.dispatch("SUBMIT");
    pending.dispatch("BEGIN_REVIEW");
    pending.dispatch("APPROVE");
    pending.dispatch("REQUEST_PAYOUT");
    assert.equal(pending.state, "PAYOUT_PENDING");
    assert.throws(
      () => buildPayoutWebhook(pending, SECRET, { now: NOW }),
      (err: unknown) =>
        err instanceof Error &&
        /only PAID tasks have a completed settlement/.test(err.message),
      "a resubmitted task still in PAYOUT_PENDING has no completed settlement yet",
    );
  });
});
