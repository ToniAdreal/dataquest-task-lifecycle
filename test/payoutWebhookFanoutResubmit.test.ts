import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook fan-out x dedupe x RESUBMIT (backlog #803).
 *
 * `test/payoutWebhookFanout*.test.ts` never mentioned resubmit, and
 * `test/payoutWebhookResubmit.test.ts` (#791) only pinned the
 * single-endpoint receiver flow. What the implementation actually
 * says (read before writing, not assumed):
 *  - PAID is terminal and RESUBMIT only runs from REJECTED to
 *    CAPTURING, so a resubmitted task announces exactly one payout:
 *    there is no second PAID build from the same task to compare
 *    against. The "old event" below is therefore not a second payout
 *    from this task — it is the pre-resubmit notification's eventId,
 *    already recorded by the receivers before the resubmit completed
 *    (exactly the shape #791 pinned for one receiver).
 *  - `deliverPayoutWebhookToMany` fans one logical event out under
 *    one shared `eventId` (and one shared `at`), signed per endpoint
 *    with that endpoint's own secret.
 *  - Receiver-side `PayoutEventDedupe` keys on the verified body's
 *    `eventId` alone, per receiver: it knows nothing about the
 *    sender's task, its payoutRef, or whether a RESUBMIT happened.
 *
 * Rules pinned here, with one independent `PayoutEventDedupe` per
 * endpoint and the documented receiver order (verify the raw wire
 * body first, `checkAndRecord` only after a `true` verification):
 *  - the resubmitted task's payout fanned out to 4 endpoints: every
 *    receiver accepts its own per-endpoint-signed copy as a first
 *    sighting, the payload carries the new PAYOUT_COMPLETE
 *    payoutRef (not the REJECT entry's ref), and all four copies
 *    share one eventId
 *  - an old eventId recorded before the resubmit is still a
 *    duplicate when replayed after the new fan-out, on all four
 *    receivers, while the new eventId's own replay is a duplicate
 *    too — the resubmit does not reopen any dedupe window
 *  - re-fanning out the same new eventId (a second
 *    `deliverPayoutWebhookToMany` call with the same eventId) yields
 *    byte-identical wire bodies that every receiver reports as
 *    duplicates
 *  - two distinct eventIds for the same resubmitted settlement are
 *    both first sightings on fresh receivers: dedupe distinguishes
 *    by eventId, not by the shared taskId/payoutRef — so whether the
 *    old id is a first sighting or a duplicate depends only on
 *    whether it was already recorded (contrast the second test),
 *    never on the resubmit itself
 *  - no fan-out mid-resubmit: a resubmitted task still in CAPTURING
 *    throws the only-PAID error before any fetch
 */

const SECRET_A = "whsec_fanout_resubmit_billing";
const SECRET_B = "whsec_fanout_resubmit_risk";
const SECRET_C = "whsec_fanout_resubmit_ledger";
const SECRET_D = "whsec_fanout_resubmit_audit";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const URL_C = "https://ledger.example.com/hooks/payout";
const URL_D = "https://audit.example.com/hooks/payout";
const NOW = new Date("2026-11-01T00:00:00.000Z");
const EVENT_NEW = "evt-fanout-resubmit-new";
const EVENT_OLD = "evt-fanout-resubmit-old";

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
  payoutRef = "xfer-fanout-resubmit-new",
  payoutAmount = 9000,
): TaskLifecycle {
  const task = new TaskLifecycle(id);
  toRejected(task);
  resubmitToPaid(task, payoutRef, payoutAmount);
  assert.equal(task.state, "PAID");
  return task;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records every call and always answers 200. */
function recordingFetch(): {
  fetchImpl: PayoutWebhookFetchImpl;
  callsTo: (url: string) => RecordedCall[];
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: PayoutWebhookFetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  return { fetchImpl, callsTo: (u) => calls.filter((c) => c.url === u), calls };
}

function bodyOf(call: RecordedCall): string {
  return String(call.init.body);
}
function signatureOf(call: RecordedCall): string {
  return String(new Headers(call.init.headers).get("x-hub-signature-256"));
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
  secret: string,
): ReceiveOutcome {
  if (!verifyPayoutWebhook(raw, signature, secret)) return "rejected";
  const payload = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(payload.eventId) ? "duplicate" : "accepted";
}

const ENDPOINTS = [
  { url: URL_A, secret: SECRET_A },
  { url: URL_B, secret: SECRET_B },
  { url: URL_C, secret: SECRET_C },
  { url: URL_D, secret: SECRET_D },
];
const SECRETS = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
const URLS = [URL_A, URL_B, URL_C, URL_D];

test("resubmitted payout fanned out to 4 endpoints: every receiver accepts its own copy as first sighting", async () => {
  const task = resubmittedPaidTask("task-fanout-resubmit-1");
  // The REJECT entry in this task's history does carry a ref —
  // prove it is there, so the payload assertion below is a real
  // discrimination and not a vacuous absence.
  const rejectEntry = task.history.find((e) => e.event === "REJECT");
  assert.equal(rejectEntry?.payoutRef, "xfer-rejected-attempt");

  const { fetchImpl, callsTo } = recordingFetch();
  const out = await deliverPayoutWebhookToMany(task, ENDPOINTS, {
    fetchImpl,
    sleepImpl: async () => {},
    now: NOW,
    eventId: EVENT_NEW,
  });
  assert.equal(out.delivered, 4);
  assert.equal(out.failed, 0);
  assert.deepEqual(
    out.results.map((r) => r.ok),
    [true, true, true, true],
  );

  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  const bodies: string[] = [];
  const signatures: string[] = [];
  for (let i = 0; i < 4; i++) {
    const [call] = callsTo(URLS[i]);
    const raw = bodyOf(call);
    const sig = signatureOf(call);
    bodies.push(raw);
    signatures.push(sig);
    const payload = JSON.parse(raw) as {
      eventId: string;
      taskId: string;
      payoutRef: string;
      payoutAmount: number;
      at: string;
    };
    assert.equal(payload.eventId, EVENT_NEW);
    assert.equal(payload.taskId, "task-fanout-resubmit-1");
    assert.equal(payload.payoutRef, "xfer-fanout-resubmit-new");
    assert.notEqual(payload.payoutRef, "xfer-rejected-attempt");
    assert.equal(payload.payoutAmount, 9000);
    assert.equal(payload.at, "2026-11-01T00:00:00.000Z");
    // Per-endpoint signing: the copy verifies with its own secret
    // and with no other endpoint's secret.
    assert.equal(verifyPayoutWebhook(raw, sig, SECRETS[i]), true);
    assert.equal(
      verifyPayoutWebhook(raw, sig, SECRETS[(i + 1) % 4]),
      false,
    );
    assert.equal(receive(raw, sig, dedupes[i], SECRETS[i]), "accepted");
    assert.equal(dedupes[i].size, 1);
  }
  // One logical event: identical bodies, distinct signatures.
  assert.ok(bodies.every((b) => b === bodies[0]));
  assert.equal(new Set(signatures).size, 4);
});

test("old eventId recorded before the resubmit stays duplicate after the new fan-out, on all four receivers", async () => {
  const task = resubmittedPaidTask("task-fanout-resubmit-2");
  // The pre-resubmit notification, recorded by every receiver
  // before the resubmit completed. The resubmit itself must not
  // reopen this dedupe window.
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  for (const dedupe of dedupes) {
    assert.equal(dedupe.checkAndRecord(EVENT_OLD), false);
  }

  const { fetchImpl, callsTo } = recordingFetch();
  await deliverPayoutWebhookToMany(task, ENDPOINTS, {
    fetchImpl,
    sleepImpl: async () => {},
    now: NOW,
    eventId: EVENT_NEW,
  });
  for (let i = 0; i < 4; i++) {
    const [call] = callsTo(URLS[i]);
    // The new event is a first sighting even though the old id is
    // already recorded: dedupe keys on eventId, not on the task.
    assert.equal(
      receive(bodyOf(call), signatureOf(call), dedupes[i], SECRETS[i]),
      "accepted",
    );
    assert.equal(dedupes[i].size, 2);
    // The old event replayed after the resubmit: still a duplicate.
    assert.equal(dedupes[i].checkAndRecord(EVENT_OLD), true);
    // And the new event replayed: a duplicate too.
    assert.equal(
      receive(bodyOf(call), signatureOf(call), dedupes[i], SECRETS[i]),
      "duplicate",
    );
    assert.deepEqual(dedupes[i].stats(), {
      size: 2,
      hits: 2,
      misses: 2,
      evictions: 0,
    });
  }
});

test("re-fan-out of the same new eventId: second round deliveries are duplicates on all four receivers", async () => {
  const task = resubmittedPaidTask("task-fanout-resubmit-3");
  const { fetchImpl, callsTo } = recordingFetch();
  const fanoutOpts = {
    fetchImpl,
    sleepImpl: async () => {},
    now: NOW,
    eventId: EVENT_NEW,
  };
  const first = await deliverPayoutWebhookToMany(task, ENDPOINTS, fanoutOpts);
  assert.equal(first.delivered, 4);
  const second = await deliverPayoutWebhookToMany(task, ENDPOINTS, fanoutOpts);
  assert.equal(second.delivered, 4);

  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  for (let i = 0; i < 4; i++) {
    const [round1, round2] = callsTo(URLS[i]);
    // Same eventId, same timestamp, same settlement: the second
    // fan-out's wire body is byte-identical to the first's.
    assert.equal(bodyOf(round2), bodyOf(round1));
    assert.equal(signatureOf(round2), signatureOf(round1));
    assert.equal(
      receive(bodyOf(round1), signatureOf(round1), dedupes[i], SECRETS[i]),
      "accepted",
    );
    assert.equal(
      receive(bodyOf(round2), signatureOf(round2), dedupes[i], SECRETS[i]),
      "duplicate",
    );
    assert.equal(dedupes[i].size, 1);
    assert.deepEqual(dedupes[i].stats(), {
      size: 1,
      hits: 1,
      misses: 1,
      evictions: 0,
    });
  }
});

test("distinct eventIds for the same resubmitted settlement are both first sightings on fresh receivers", async () => {
  const task = resubmittedPaidTask("task-fanout-resubmit-4");
  const { fetchImpl, callsTo } = recordingFetch();
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  // Fresh receivers: neither id has been recorded, so both fan-outs
  // are first sightings even though taskId and payoutRef are
  // identical across the two events. Contrast the previous test,
  // where the old id was pre-recorded and therefore replayed as a
  // duplicate: the resubmit changes nothing — only prior recording
  // decides.
  for (const eventId of [EVENT_NEW, EVENT_OLD]) {
    const out = await deliverPayoutWebhookToMany(task, ENDPOINTS, {
      fetchImpl,
      sleepImpl: async () => {},
      now: NOW,
      eventId,
    });
    assert.equal(out.delivered, 4);
  }
  for (let i = 0; i < 4; i++) {
    const [first, second] = callsTo(URLS[i]);
    assert.equal(JSON.parse(bodyOf(first)).eventId, EVENT_NEW);
    assert.equal(JSON.parse(bodyOf(second)).eventId, EVENT_OLD);
    assert.equal(
      receive(bodyOf(first), signatureOf(first), dedupes[i], SECRETS[i]),
      "accepted",
    );
    assert.equal(
      receive(bodyOf(second), signatureOf(second), dedupes[i], SECRETS[i]),
      "accepted",
    );
    assert.equal(dedupes[i].size, 2);
    assert.deepEqual(dedupes[i].stats(), {
      size: 2,
      hits: 0,
      misses: 2,
      evictions: 0,
    });
  }
  // The two events announce the same settlement: same payoutRef and
  // amount, differing only in eventId — the key dedupe actually uses.
  const [newCall] = callsTo(URL_A);
  const [, oldCall] = callsTo(URL_A);
  const newPayload = JSON.parse(bodyOf(newCall)) as {
    payoutRef: string;
    payoutAmount: number;
  };
  const oldPayload = JSON.parse(bodyOf(oldCall)) as {
    payoutRef: string;
    payoutAmount: number;
  };
  assert.equal(oldPayload.payoutRef, newPayload.payoutRef);
  assert.equal(oldPayload.payoutAmount, newPayload.payoutAmount);
});

test("no fan-out mid-resubmit: a resubmitted task in CAPTURING throws the only-PAID error before any fetch", async () => {
  const task = new TaskLifecycle("task-fanout-resubmit-5");
  toRejected(task);
  task.dispatch("RESUBMIT");
  assert.equal(task.state, "CAPTURING");
  const { fetchImpl, calls } = recordingFetch();
  await assert.rejects(
    () =>
      deliverPayoutWebhookToMany(task, ENDPOINTS, {
        fetchImpl,
        sleepImpl: async () => {},
        now: NOW,
        eventId: EVENT_NEW,
      }),
    (err: unknown) =>
      err instanceof Error &&
      /only PAID tasks have a completed settlement/.test(err.message),
    "a resubmitted task in CAPTURING has no settlement to announce",
  );
  assert.equal(calls.length, 0);

  // The same guard holds through the single-endpoint build path.
  assert.throws(
    () => buildPayoutWebhook(task, SECRET_A, { now: NOW }),
    (err: unknown) =>
      err instanceof Error &&
      /only PAID tasks have a completed settlement/.test(err.message),
  );
});
