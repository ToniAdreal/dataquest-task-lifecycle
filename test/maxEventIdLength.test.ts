import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  MAX_EVENT_ID_LENGTH,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  verifyPayoutWebhook,
  PayoutEventDedupe,
  PayoutWebhookOutbox,
} from "../src/index.js";

/**
 * Payout webhook `eventId` length cap (backlog #1060, mirrors escrow
 * #1059): an `eventId` is a short deduplication key — the default is
 * a UUID (36 characters) — but the build, the receiver-side dedupe,
 * and the outbox used to accept any length and write it verbatim into
 * the signed payload, the dedupe memory keys, and the persisted
 * snapshots.
 *
 * Rules under test:
 *  - the cap is MAX_EVENT_ID_LENGTH = 256, exported from the index
 *  - buildPayoutWebhook() rejects an injected eventId longer than the
 *    cap (never truncates: truncating would change the deduplication
 *    key), and an eventId of exactly the cap builds verbatim and
 *    verifies
 *  - PayoutEventDedupe.checkAndRecord() rejects an overlong id with
 *    zero residue, and an at-cap id records and deduplicates
 *  - PayoutEventDedupe.restore() rejects a snapshot carrying an
 *    overlong id, and restores an at-cap id as a live duplicate
 *  - PayoutWebhookOutbox.recordAttempt() rejects an overlong id with
 *    zero residue, and an at-cap id records as pending
 *  - PayoutWebhookOutbox.restore() rejects a snapshot carrying an
 *    overlong id, and restores an at-cap id as pending
 *  - buildPayoutWebhooks(): an eventIdFactory returning an overlong id
 *    fails only that task — the rest of the batch still builds
 *  - the demo's existing fixed eventIds are far below the cap and
 *    keep working at every entry point
 */

const SECRET = "whsec_test_payout_evtid_cap_20261111";

/** Drive a task from DRAFT to APPROVED (one step before payout). */
function toApproved(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

/** Drive a task from DRAFT to PAID. */
function toPaid(id: string): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(t.state, "PAID");
  return t;
}

const overlongId = "e".repeat(MAX_EVENT_ID_LENGTH + 1);
const atCapId = "e".repeat(MAX_EVENT_ID_LENGTH);

test("MAX_EVENT_ID_LENGTH is 256", () => {
  assert.equal(MAX_EVENT_ID_LENGTH, 256);
});

test("build rejects an overlong eventId, before signing anything", () => {
  const t = toPaid("evcap-1");
  assert.throws(
    () => buildPayoutWebhook(t, SECRET, { eventId: overlongId }),
    /cannot build payout webhook: 'eventId' must be at most 256 characters, got 257 for task evcap-1/,
  );
  // The task itself is untouched: the build never mutates it.
  assert.equal(t.state, "PAID");
  assert.equal(t.history.length, 8);
});

test("build accepts an eventId of exactly the cap verbatim, and it verifies", () => {
  const t = toPaid("evcap-2");
  const { payload, signature } = buildPayoutWebhook(t, SECRET, {
    eventId: atCapId,
  });
  assert.equal(payload.eventId, atCapId);
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
});

test("dedupe rejects an overlong eventId with zero residue", () => {
  const dedupe = new PayoutEventDedupe();
  assert.throws(
    () => dedupe.checkAndRecord(overlongId),
    /PayoutEventDedupe: eventId must be at most 256 characters, got 257/,
  );
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  // A short id afterwards still records as a first sighting.
  assert.equal(dedupe.checkAndRecord("evt-ok-1"), false);
  assert.equal(dedupe.size, 1);
});

test("dedupe records an at-cap eventId and deduplicates its redelivery", () => {
  const dedupe = new PayoutEventDedupe();
  assert.equal(dedupe.checkAndRecord(atCapId), false);
  assert.equal(dedupe.checkAndRecord(atCapId), true);
  assert.equal(dedupe.size, 1);
});

test("dedupe restore rejects a snapshot carrying an overlong eventId", () => {
  assert.throws(
    () =>
      PayoutEventDedupe.restore({
        v: 1,
        entries: [[overlongId, 1000]],
      }),
    /PayoutEventDedupe: invalid snapshot: entries\[0\]: eventId must be at most 256 characters, got 257/,
  );
  // A snapshot with a good id first and the bad id second fails too —
  // the whole restore is atomic, never partially installed.
  assert.throws(
    () =>
      PayoutEventDedupe.restore({
        v: 1,
        entries: [
          ["evt-ok-1", 1000],
          [overlongId, 1000],
        ],
      }),
    /entries\[1\]: eventId must be at most 256 characters, got 257/,
  );
});

test("dedupe restore accepts an at-cap eventId as a live duplicate", () => {
  const now = () => 10_000;
  const dedupe = PayoutEventDedupe.restore(
    { v: 1, entries: [[atCapId, 9000]] },
    { now },
  );
  assert.equal(dedupe.size, 1);
  assert.equal(dedupe.checkAndRecord(atCapId), true);
});

test("outbox recordAttempt rejects an overlong eventId with zero residue", () => {
  const outbox = new PayoutWebhookOutbox();
  assert.throws(
    () =>
      outbox.recordAttempt({
        endpoint: "https://receiver.example.com/hooks/payout",
        eventId: overlongId,
        ok: false,
        status: 500,
      }),
    /PayoutWebhookOutbox: eventId must be at most 256 characters, got 257/,
  );
  assert.equal(outbox.size, 0);
  assert.deepEqual(outbox.pending(), []);
  assert.deepEqual(outbox.deadLetter(), []);
});

test("outbox recordAttempt accepts an at-cap eventId as pending", () => {
  const outbox = new PayoutWebhookOutbox();
  outbox.recordAttempt({
    endpoint: "https://receiver.example.com/hooks/payout",
    eventId: atCapId,
    ok: false,
    status: 500,
  });
  assert.equal(outbox.size, 1);
  assert.deepEqual(
    outbox.pending().map((entry) => entry.eventId),
    [atCapId],
  );
});

test("outbox restore rejects a snapshot carrying an overlong eventId", () => {
  assert.throws(
    () =>
      PayoutWebhookOutbox.restore({
        v: 1,
        entries: [
          {
            endpoint: "https://receiver.example.com/hooks/payout",
            eventId: overlongId,
            attempts: 1,
            lastAt: 1000,
          },
        ],
      }),
    /PayoutWebhookOutbox: invalid snapshot: entries\[0\]: eventId must be at most 256 characters, got 257/,
  );
});

test("outbox restore accepts an at-cap eventId as pending", () => {
  const outbox = PayoutWebhookOutbox.restore({
    v: 1,
    entries: [
      {
        endpoint: "https://receiver.example.com/hooks/payout",
        eventId: atCapId,
        attempts: 1,
        lastAt: 1000,
      },
    ],
  });
  assert.equal(outbox.size, 1);
  assert.deepEqual(
    outbox.pending().map((entry) => entry.eventId),
    [atCapId],
  );
});

test("batch: an overlong factory eventId fails only that task", () => {
  const tasks = [toPaid("evcap-11a"), toPaid("evcap-11b"), toPaid("evcap-11c")];
  const factoryValues = ["evt-batch-1", overlongId, "evt-batch-3"];
  let i = 0;
  const results = buildPayoutWebhooks(tasks, SECRET, {
    eventIdFactory: () => factoryValues[i++],
  });
  assert.equal(results.length, 3);
  assert.equal(results[0].webhook?.payload.eventId, "evt-batch-1");
  assert.match(
    results[1].error ?? "",
    /cannot build payout webhook: 'eventId' must be at most 256 characters, got 257 for task evcap-11b/,
  );
  assert.equal(results[1].webhook, undefined);
  assert.equal(results[2].webhook?.payload.eventId, "evt-batch-3");
  // The surviving webhooks are real signed payloads, not stubs.
  assert.equal(
    verifyPayoutWebhook(
      results[0].webhook!.payload,
      results[0].webhook!.signature,
      SECRET,
    ),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(
      results[2].webhook!.payload,
      results[2].webhook!.signature,
      SECRET,
    ),
    true,
  );
});

test("the demo's existing fixed eventIds are unaffected by the cap", () => {
  const t = toPaid("evcap-12");
  for (const demoId of [
    "evt_demo_payout_001",
    "evt_demo_outbox_001",
    "evt_demo_fanout_001",
  ]) {
    const { payload, signature } = buildPayoutWebhook(t, SECRET, {
      eventId: demoId,
    });
    assert.equal(payload.eventId, demoId);
    assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
  }
  const dedupe = new PayoutEventDedupe();
  assert.equal(dedupe.checkAndRecord("evt_demo_payout_001"), false);
  const outbox = new PayoutWebhookOutbox();
  outbox.recordAttempt({
    endpoint: "https://receiver.example.com/hooks/payout",
    eventId: "evt_demo_outbox_001",
    ok: false,
    status: 500,
  });
  assert.equal(outbox.size, 1);
});
