import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  payoutMismatch,
  verifyPayoutWebhook,
  type TaskHistoryEntry,
} from "../src/index.js";

/**
 * Payout webhook `quotedAmount` (backlog #202): the owed half of
 * quoted-vs-settled reconciliation, carried in the signed payload.
 *
 * Until now `buildPayoutWebhook` carried only the settled side
 * (`payoutRef`/`payoutAmount`, from the PAYOUT_COMPLETE entry), so a
 * receiver could not locally reproduce the `payoutMismatch()` judgment
 * without querying the sender's store — even though the quote was
 * already in the same history (the last ACCEPT entry's `quotedAmount`,
 * #133). Rules under test:
 *  - present when the last ACCEPT entry carries a quote, in canonical
 *    key order after `payoutAmount` and before `at`, signed like every
 *    other field (tampering fails verification)
 *  - omitted as a whole key when the last ACCEPT entry carries no
 *    quote (the advisory omission rule of `payoutRef`/`payoutAmount`),
 *    so legacy PAID tasks keep building and verifying unchanged
 *  - a recorded quote of 0 is a real quote and is NOT omitted
 *  - with several ACCEPT entries the LAST one wins — the exact
 *    derivation `payoutMismatch` uses, cross-checked against it
 *  - raw-body and parsed-object verification agree
 */

interface PaidOpts {
  quoted?: number;
  payoutRef?: string;
  payoutAmount?: number;
}

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(id: string, opts: PaidOpts = {}): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", {
    actor: "contributor",
    ...(opts.quoted !== undefined ? { quotedAmount: opts.quoted } : {}),
  });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    ...(opts.payoutRef !== undefined ? { payoutRef: opts.payoutRef } : {}),
    ...(opts.payoutAmount !== undefined
      ? { payoutAmount: opts.payoutAmount }
      : {}),
  });
  assert.equal(t.state, "PAID");
  return t;
}

const FIXED = { eventId: "evt-quoted-1", now: new Date("2026-10-11T12:00:00.000Z") };

test("payload carries quotedAmount from the ACCEPT entry, in canonical key order, and verifies", () => {
  const task = toPaid("task-quoted", {
    quoted: 120,
    payoutRef: "xfer-q1",
    payoutAmount: 100,
  });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  assert.equal(payload.quotedAmount, 120);
  assert.deepEqual(Object.keys(payload), [
    "event",
    "taskId",
    "payoutRef",
    "payoutAmount",
    "quotedAmount",
    "at",
    "eventId",
  ]);
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
  // Same-source cross-check: the webhook quote is exactly the quote
  // `payoutMismatch` derives in-repo for the same task.
  assert.deepEqual(payoutMismatch(task), { quoted: 120, paid: 100, delta: -20 });
  assert.equal(payload.quotedAmount, payoutMismatch(task)?.quoted);
});

test("tampering with quotedAmount fails verification on both body shapes", () => {
  const task = toPaid("task-quoted-tamper", { quoted: 120, payoutAmount: 120 });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  const raw = JSON.stringify(payload);
  assert.equal(
    verifyPayoutWebhook(raw.replace('"quotedAmount":120', '"quotedAmount":1'), signature, "s3cr3t"),
    false,
    "tampered raw-body quotedAmount",
  );
  assert.equal(
    verifyPayoutWebhook({ ...payload, quotedAmount: 1 }, signature, "s3cr3t"),
    false,
    "tampered object quotedAmount",
  );
  assert.equal(
    verifyPayoutWebhook({ ...payload, quotedAmount: undefined }, signature, "s3cr3t"),
    false,
    "quotedAmount stripped from the object body",
  );
});

test("no quote on the ACCEPT entry omits the whole key and still verifies", () => {
  const task = toPaid("task-no-quote", { payoutRef: "xfer-q2", payoutAmount: 42 });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  assert.ok(!("quotedAmount" in payload));
  assert.deepEqual(Object.keys(payload), [
    "event",
    "taskId",
    "payoutRef",
    "payoutAmount",
    "at",
    "eventId",
  ]);
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
  assert.equal(payoutMismatch(task), undefined, "no quote, no in-repo mismatch either");
});

test("a quoted amount of 0 is a real quote and is not omitted", () => {
  const task = toPaid("task-free", { quoted: 0, payoutAmount: 0 });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  assert.ok("quotedAmount" in payload);
  assert.equal(payload.quotedAmount, 0);
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
});

test("several ACCEPT entries: the last quote wins, exactly as payoutMismatch derives it", () => {
  // `dispatch` can only emit one ACCEPT today (OPEN is the only state
  // with an ACCEPT edge), but both history-derived readers define
  // last-ACCEPT-wins for any history shape they are handed — imported
  // or future logs must not split the webhook and the in-repo
  // screening. This stub exercises that shared derivation directly.
  const entry = (
    seq: number,
    event: TaskHistoryEntry["event"],
    extra: Partial<TaskHistoryEntry> = {},
  ): TaskHistoryEntry => ({
    seq,
    event,
    from: "OPEN",
    to: "PAID",
    at: "2026-10-11T00:00:00.000Z",
    ...extra,
  });
  const stub = {
    id: "task-multi-accept",
    state: "PAID",
    history: [
      entry(1, "ACCEPT", { quotedAmount: 999 }),
      entry(2, "ACCEPT", { quotedAmount: 80 }),
      entry(3, "PAYOUT_COMPLETE", { payoutAmount: 75 }),
    ],
  } as unknown as TaskLifecycle;
  const { payload, signature } = buildPayoutWebhook(stub, "s3cr3t", FIXED);
  assert.equal(payload.quotedAmount, 80, "last ACCEPT quote, not the first");
  assert.deepEqual(payoutMismatch(stub), { quoted: 80, paid: 75, delta: -5 });
  assert.equal(payload.quotedAmount, payoutMismatch(stub)?.quoted);
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
});

test("a later quoteless ACCEPT erases an earlier quote (last entry, not last quote)", () => {
  // Same last-wins derivation, the other direction: `payoutMismatch`
  // assigns `quoted = entry.quotedAmount` per ACCEPT, so a trailing
  // quoteless ACCEPT resets the quote to undefined — the payload must
  // omit the key rather than resurrect the stale earlier quote.
  const entry = (
    seq: number,
    event: TaskHistoryEntry["event"],
    extra: Partial<TaskHistoryEntry> = {},
  ): TaskHistoryEntry => ({
    seq,
    event,
    from: "OPEN",
    to: "PAID",
    at: "2026-10-11T00:00:00.000Z",
    ...extra,
  });
  const stub = {
    id: "task-quoteless-last",
    state: "PAID",
    history: [
      entry(1, "ACCEPT", { quotedAmount: 999 }),
      entry(2, "ACCEPT", {}),
      entry(3, "PAYOUT_COMPLETE", { payoutAmount: 75 }),
    ],
  } as unknown as TaskLifecycle;
  const { payload, signature } = buildPayoutWebhook(stub, "s3cr3t", FIXED);
  assert.ok(!("quotedAmount" in payload));
  assert.equal(payoutMismatch(stub), undefined);
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
});

test("raw-body and object verification agree for a quoted payload", () => {
  const task = toPaid("task-dual-path", {
    quoted: 10098.5,
    payoutRef: "xfer-q3",
    payoutAmount: 10098.5,
  });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
  assert.equal(verifyPayoutWebhook(payload, signature, "s3cr3t"), true);
  // Settled exactly as quoted: the payload still carries the quote so
  // the receiver can reach the same "no mismatch" conclusion locally.
  assert.equal(payoutMismatch(task), undefined);
  assert.equal(payload.quotedAmount, 10098.5);
});
