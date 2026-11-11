import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  payoutAging,
  reconcilePayouts,
  unreconciledPayouts,
} from "../src/index.js";
import type { LedgerPayout } from "../src/index.js";

/**
 * `payoutAging` × `reconcilePayouts` × `unreconciledPayouts` population
 * consistency (backlog #893).
 *
 * The three helpers are three hand-written spellings of one rule — a
 * PAID task counts as unreconciled when its `PAYOUT_COMPLETE` entry
 * carries no `payoutRef` or no `payoutAmount` (or when it has no
 * completion entry at all) — but nothing pinned that they cannot
 * drift apart: `reconcilePayouts` documents its `unreconciled` group
 * as "the same population `unreconciledPayouts` returns", and
 * `payoutAging` documents that it ages exactly that population. If
 * any one of the three quietly changed its screen, a task could sit
 * in the aging buckets while missing from the reconciliation group
 * (or vice versa) with no test catching the split.
 *
 * Rules under test, over one shared mixed batch:
 *  - `reconcilePayouts(...).unreconciled` ids equal
 *    `unreconciledPayouts(...)` ids, in input order
 *  - the four `payoutAging` buckets' union (unknown bucket included)
 *    holds exactly the same id set
 *  - a reference on `REQUEST_PAYOUT` but none on `PAYOUT_COMPLETE`
 *    still counts as unreconciled: only the completion entry is
 *    settlement evidence
 *  - a PAID task with a reference but no settled amount is
 *    unreconciled too (backlog #1046), and its ledger row stays
 *    `ledgerOnly`: without a recorded amount there is nothing to
 *    pair it against by amount
 *  - a ledger row carrying that request-only reference (or any other
 *    unmatched reference) does not pull a no-ref task out of the
 *    unreconciled group: without a completion reference there is
 *    nothing to pair against, so the row stays `ledgerOnly`
 *  - ledger presence in general does not change unreconciled
 *    membership: the same ids come back against an empty ledger
 *  - reconciled PAID tasks (matched, task-only, amount-mismatched)
 *    and non-PAID tasks appear in no unreconciled population
 */

const NOW = new Date("2026-04-01T00:00:00.000Z");

/** Drive a task DRAFT → … → PAID, completion at `completeAt`. */
function toPaid(
  id: string,
  completeAt: string,
  opts: {
    completionRef?: string;
    completionAmount?: number;
    requestRef?: string;
  } = {},
): TaskLifecycle {
  const t = new TaskLifecycle(id);
  const completeMs = Date.parse(completeAt);
  // dispatch() rejects an `at` earlier than the previous entry's, so
  // every step carries its own timestamp, one minute apart, ending
  // exactly at the completion time under test.
  const at = (minutesBefore: number): string =>
    new Date(completeMs - minutesBefore * 60_000).toISOString();
  t.dispatch("PUBLISH", { actor: "researcher", at: at(8) });
  t.dispatch("ACCEPT", { actor: "contributor", at: at(7) });
  t.dispatch("START_CAPTURE", { actor: "contributor", at: at(6) });
  t.dispatch("SUBMIT", { actor: "contributor", at: at(5) });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: at(4) });
  t.dispatch("APPROVE", { actor: "reviewer", at: at(3) });
  if (opts.requestRef === undefined) {
    t.dispatch("REQUEST_PAYOUT", { actor: "contributor", at: at(2) });
  } else {
    t.dispatch("REQUEST_PAYOUT", {
      actor: "contributor",
      at: at(2),
      payoutRef: opts.requestRef,
    });
  }
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    at: completeAt,
    ...(opts.completionRef === undefined
      ? {}
      : { payoutRef: opts.completionRef }),
    ...(opts.completionAmount === undefined
      ? {}
      : { payoutAmount: opts.completionAmount }),
  });
  assert.equal(t.state, "PAID");
  return t;
}

/** Drive a task DRAFT → … → PAYOUT_PENDING (non-PAID). */
function toPayoutPending(id: string, requestRef?: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  if (requestRef === undefined) {
    t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  } else {
    t.dispatch("REQUEST_PAYOUT", {
      actor: "contributor",
      payoutRef: requestRef,
    });
  }
  assert.notEqual(t.state, "PAID");
  return t;
}

/** The shared mixed batch, in input order. */
function mixedBatch(): TaskLifecycle[] {
  return [
    // Reconciled: ref + amount agree with a ledger row.
    toPaid("rec-matched", "2026-03-20T00:00:00.000Z", {
      completionRef: "xfer-matched",
      completionAmount: 100,
    }),
    // Unreconciled: no ref on completion, 2 days old.
    toPaid("unrec-fresh", "2026-03-30T00:00:00.000Z"),
    // Reconciled shape, but no ledger row carries its ref: task-only,
    // never unreconciled.
    toPaid("rec-taskonly", "2026-03-20T00:00:00.000Z", {
      completionRef: "xfer-taskonly",
      completionAmount: 50,
    }),
    // Unreconciled: no ref, 22 days old.
    toPaid("unrec-22", "2026-03-10T00:00:00.000Z"),
    // Reconciled shape, amount disagrees with its ledger row: a
    // mismatch, never unreconciled.
    toPaid("rec-mismatch", "2026-03-20T00:00:00.000Z", {
      completionRef: "xfer-mismatch",
      completionAmount: 90,
    }),
    // Unreconciled: reference recorded, but no settled amount —
    // the reference alone cannot be checked against a ledger by
    // amount (backlog #1046). 4 days old.
    toPaid("unrec-ref-no-amount", "2026-03-28T00:00:00.000Z", {
      completionRef: "xfer-ref-no-amount",
    }),
    // Unreconciled: no ref, 59 days old.
    toPaid("unrec-59", "2026-02-01T00:00:00.000Z"),
    // Non-PAID: in payout flight, request carries a ref, but no
    // settlement exists yet — in no population.
    toPayoutPending("pending-reqref", "xfer-request"),
    // Defensive stand-in: PAID with no PAYOUT_COMPLETE entry at all.
    {
      id: "unrec-unknown",
      state: "PAID",
      history: [],
    } as unknown as TaskLifecycle,
    // Unreconciled: ref on REQUEST_PAYOUT only, none on completion,
    // 7 days old — the completion entry alone is settlement evidence.
    toPaid("unrec-reqref", "2026-03-25T00:00:00.000Z", {
      requestRef: "xfer-reqref",
    }),
  ];
}

const LEDGER: LedgerPayout[] = [
  { payoutRef: "xfer-matched", payoutAmount: 100 },
  { payoutRef: "xfer-mismatch", payoutAmount: 100 },
  { payoutRef: "xfer-ledger-only", payoutAmount: 7 },
  // Matches only a REQUEST_PAYOUT ref (non-PAID task): ledger-only.
  { payoutRef: "xfer-request", payoutAmount: 5 },
  // Matches only a REQUEST_PAYOUT ref on a PAID task whose completion
  // carries no ref: still ledger-only, and the task stays unreconciled.
  { payoutRef: "xfer-reqref", payoutAmount: 40 },
  // Matches only a completion ref on a PAID task whose completion
  // carries no amount: still ledger-only, and the task stays
  // unreconciled — without a recorded amount there is no pairing.
  { payoutRef: "xfer-ref-no-amount", payoutAmount: 40 },
];

const EXPECTED_UNRECONCILED = [
  "unrec-fresh",
  "unrec-22",
  "unrec-ref-no-amount",
  "unrec-59",
  "unrec-unknown",
  "unrec-reqref",
];

test("reconcile unreconciled group equals the unreconciled screen", () => {
  const tasks = mixedBatch();
  const reconciled = reconcilePayouts(tasks, LEDGER);
  assert.deepEqual(
    reconciled.unreconciled.map((t) => t.id),
    EXPECTED_UNRECONCILED,
  );
  assert.deepEqual(
    unreconciledPayouts(tasks).map((t) => t.id),
    EXPECTED_UNRECONCILED,
  );
  // The reconciled tasks land in their own groups, never unreconciled.
  assert.deepEqual(
    reconciled.matched.map((t) => t.id),
    ["rec-matched"],
  );
  assert.deepEqual(
    reconciled.taskOnly.map((t) => t.id),
    ["rec-taskonly"],
  );
  assert.equal(reconciled.amountMismatch.length, 1);
  assert.equal(reconciled.amountMismatch[0].task.id, "rec-mismatch");
  assert.deepEqual(
    reconciled.ledgerOnly.map((row) => row.payoutRef),
    ["xfer-ledger-only", "xfer-request", "xfer-reqref", "xfer-ref-no-amount"],
  );
  // The non-PAID task enters no group at all.
  const allGrouped = [
    ...reconciled.matched,
    ...reconciled.taskOnly,
    ...reconciled.amountMismatch.map((m) => m.task),
    ...reconciled.unreconciled,
  ].map((t) => t.id);
  assert.equal(allGrouped.includes("pending-reqref"), false);
});

test("payoutAging buckets union equals the same unreconciled set", () => {
  const tasks = mixedBatch();
  const aging = payoutAging(tasks, NOW);
  assert.deepEqual(aging.under7Days, [
    { id: "unrec-fresh", ageDays: 2 },
    { id: "unrec-ref-no-amount", ageDays: 4 },
  ]);
  assert.deepEqual(aging.days7To30, [
    { id: "unrec-22", ageDays: 22 },
    { id: "unrec-reqref", ageDays: 7 },
  ]);
  assert.deepEqual(aging.over30Days, [{ id: "unrec-59", ageDays: 59 }]);
  assert.deepEqual(aging.unknown, [{ id: "unrec-unknown" }]);
  // Buckets iterate in input order within each bucket, so the union
  // is compared as a set, not in bucket order.
  const union = [
    ...aging.under7Days,
    ...aging.days7To30,
    ...aging.over30Days,
    ...aging.unknown,
  ]
    .map((entry) => entry.id)
    .sort();
  assert.deepEqual(union, [...EXPECTED_UNRECONCILED].sort());
  // And the union agrees with both other spellings of the population.
  assert.deepEqual(
    union,
    unreconciledPayouts(tasks)
      .map((t) => t.id)
      .sort(),
  );
  assert.deepEqual(
    union,
    reconcilePayouts(tasks, LEDGER)
      .unreconciled.map((t) => t.id)
      .sort(),
  );
});

test("ledger presence does not change unreconciled membership", () => {
  const tasks = mixedBatch();
  // Empty ledger: reconciled tasks move to task-only, but the
  // unreconciled group is untouched.
  const empty = reconcilePayouts(tasks, []);
  assert.deepEqual(
    empty.unreconciled.map((t) => t.id),
    EXPECTED_UNRECONCILED,
  );
  assert.deepEqual(
    empty.taskOnly.map((t) => t.id),
    ["rec-matched", "rec-taskonly", "rec-mismatch"],
  );
  assert.deepEqual(empty.matched, []);
  assert.deepEqual(empty.amountMismatch, []);
  assert.deepEqual(empty.ledgerOnly, []);
  // Repeated calls agree: all three helpers are pure reads.
  assert.deepEqual(
    reconcilePayouts(tasks, LEDGER)
      .unreconciled.map((t) => t.id),
    reconcilePayouts(tasks, LEDGER)
      .unreconciled.map((t) => t.id),
  );
  assert.deepEqual(payoutAging(tasks, NOW), payoutAging(tasks, NOW));
});

test("empty batch: all three populations are empty", () => {
  assert.deepEqual(unreconciledPayouts([]), []);
  assert.deepEqual(reconcilePayouts([], []).unreconciled, []);
  assert.deepEqual(payoutAging([], NOW), {
    under7Days: [],
    days7To30: [],
    over30Days: [],
    unknown: [],
  });
});
