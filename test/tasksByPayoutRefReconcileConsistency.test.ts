import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  reconcilePayouts,
  tasksByPayoutRef,
} from "../src/index.js";
import type { LedgerPayout } from "../src/index.js";

/**
 * `tasksByPayoutRef` × `reconcilePayouts` pairing consistency
 * (backlog #922).
 *
 * Both helpers pair tasks against an external payout reference by
 * reading the `payoutRef` on the `PAYOUT_COMPLETE` entry — the same
 * evidence rule — but nothing pinned that they cannot drift apart:
 * `tasksByPayoutRef` is the per-reference listing ("every task settled
 * under this transfer"), while `reconcilePayouts` splits the same
 * population into matched / task-only / amount-mismatch / unreconciled
 * by pairing against a ledger. If either one quietly changed its
 * screen (a reference on `REQUEST_PAYOUT` counting, a non-PAID task
 * slipping in, the last completion entry not being the one read), a
 * task could appear in the listing but in no reconciliation group —
 * or in a group but not in its transfer's listing — with no test
 * catching the split. This is the same untested-combination shape
 * #893 closed for `payoutAging` × `reconcilePayouts`.
 *
 * Rules under test, over one shared mixed batch:
 *  - for every ref R, `tasksByPayoutRef(batch, R)` ids equal the ids
 *    of the `matched` + `taskOnly` + `amountMismatch` tasks whose
 *    completion entry carries R, in input order
 *  - a PAID task with no ref on its completion entry enters
 *    `unreconciled` and no `tasksByPayoutRef` result
 *  - a ref carried only by the ledger (or only by a `REQUEST_PAYOUT`
 *    entry, or only by a non-PAID task) selects no tasks
 *  - two tasks sharing one ref (one transfer settling a batch) are
 *    both selected, in input order, and both land in `matched` —
 *    the ledger row for their ref records the batch total (60 for
 *    two 30 tasks), because a shared reference is compared as a
 *    group total, not per task (backlog #1054)
 */

const COMPLETE_AT = "2026-03-20T00:00:00.000Z";

/** Drive a task DRAFT → … → PAID, completion at COMPLETE_AT. */
function toPaid(
  id: string,
  opts: {
    completionRef?: string;
    completionAmount?: number;
    requestRef?: string;
  } = {},
): TaskLifecycle {
  const t = new TaskLifecycle(id);
  const completeMs = Date.parse(COMPLETE_AT);
  // dispatch() rejects an `at` earlier than the previous entry's, so
  // every step carries its own timestamp, one minute apart, ending
  // exactly at the completion time.
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
    at: COMPLETE_AT,
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
    // Matched: ref + amount agree with a ledger row.
    toPaid("m-a", { completionRef: "xfer-a", completionAmount: 100 }),
    // Matched, second ref.
    toPaid("m-b", { completionRef: "xfer-b", completionAmount: 50 }),
    // Task-only: ref no ledger row carries.
    toPaid("t-a", { completionRef: "xfer-taskonly", completionAmount: 25 }),
    // Amount mismatch: ref pairs, amounts disagree.
    toPaid("mm-a", { completionRef: "xfer-mismatch", completionAmount: 90 }),
    // Shared ref: one transfer settling two tasks, both matched —
    // the ledger row records the batch total (30 + 30 = 60).
    toPaid("s-1", { completionRef: "xfer-shared", completionAmount: 30 }),
    toPaid("s-2", { completionRef: "xfer-shared", completionAmount: 30 }),
    // Unreconciled: no ref on the completion entry.
    toPaid("no-ref"),
    // Unreconciled: ref on REQUEST_PAYOUT only, none on completion.
    toPaid("req-ref", { requestRef: "xfer-reqref" }),
    // Non-PAID: in payout flight, request carries a ref, but no
    // settlement exists yet — in no group, selected by no ref.
    toPayoutPending("pending-req", "xfer-pending"),
  ];
}

const LEDGER: LedgerPayout[] = [
  { payoutRef: "xfer-a", payoutAmount: 100 },
  { payoutRef: "xfer-b", payoutAmount: 50 },
  { payoutRef: "xfer-mismatch", payoutAmount: 100 },
  // Batch total for the shared ref: two tasks at 30 each.
  { payoutRef: "xfer-shared", payoutAmount: 60 },
  // Carried only by the ledger: ledger-only, selects no task.
  { payoutRef: "xfer-ledger-only", payoutAmount: 7 },
  // Matches only a REQUEST_PAYOUT ref (non-PAID task): ledger-only.
  { payoutRef: "xfer-pending", payoutAmount: 5 },
  // Matches only a REQUEST_PAYOUT ref on a PAID task whose completion
  // carries no ref: still ledger-only, task stays unreconciled.
  { payoutRef: "xfer-reqref", payoutAmount: 40 },
];

/** The `payoutRef` on a task's (last) `PAYOUT_COMPLETE` entry. */
function completionRef(task: TaskLifecycle): string | undefined {
  let ref: string | undefined;
  for (const entry of task.history) {
    if (entry.event === "PAYOUT_COMPLETE") ref = entry.payoutRef;
  }
  return ref;
}

/**
 * The ids `reconcilePayouts` places in its three paired groups
 * (matched + task-only + amount-mismatch) whose completion entry
 * carries `ref` — the other spelling of `tasksByPayoutRef(batch, ref)`.
 */
function pairedIdsForRef(
  reconciled: ReturnType<typeof reconcilePayouts>,
  ref: string,
): string[] {
  return [
    ...reconciled.matched,
    ...reconciled.taskOnly,
    ...reconciled.amountMismatch.map((m) => m.task),
  ]
    .filter((task) => completionRef(task) === ref)
    .map((task) => task.id);
}

test("matched ref: listing equals the paired groups for that ref", () => {
  const tasks = mixedBatch();
  const reconciled = reconcilePayouts(tasks, LEDGER);
  assert.deepEqual(
    tasksByPayoutRef(tasks, "xfer-a").map((t) => t.id),
    ["m-a"],
  );
  assert.deepEqual(pairedIdsForRef(reconciled, "xfer-a"), ["m-a"]);
  assert.deepEqual(
    tasksByPayoutRef(tasks, "xfer-b").map((t) => t.id),
    ["m-b"],
  );
  assert.deepEqual(pairedIdsForRef(reconciled, "xfer-b"), ["m-b"]);
});

test("task-only ref: listing still selects its task", () => {
  const tasks = mixedBatch();
  const reconciled = reconcilePayouts(tasks, LEDGER);
  assert.deepEqual(
    tasksByPayoutRef(tasks, "xfer-taskonly").map((t) => t.id),
    ["t-a"],
  );
  assert.deepEqual(pairedIdsForRef(reconciled, "xfer-taskonly"), ["t-a"]);
  assert.deepEqual(
    reconciled.taskOnly.map((t) => t.id),
    ["t-a"],
  );
});

test("amount-mismatch ref: listing still selects its task", () => {
  const tasks = mixedBatch();
  const reconciled = reconcilePayouts(tasks, LEDGER);
  assert.deepEqual(
    tasksByPayoutRef(tasks, "xfer-mismatch").map((t) => t.id),
    ["mm-a"],
  );
  assert.deepEqual(pairedIdsForRef(reconciled, "xfer-mismatch"), ["mm-a"]);
  assert.equal(reconciled.amountMismatch.length, 1);
  assert.equal(reconciled.amountMismatch[0].task.id, "mm-a");
  assert.equal(reconciled.amountMismatch[0].taskAmount, 90);
  assert.equal(reconciled.amountMismatch[0].ledgerAmount, 100);
});

test("shared ref: both batch tasks selected, in input order, both matched", () => {
  const tasks = mixedBatch();
  const reconciled = reconcilePayouts(tasks, LEDGER);
  assert.deepEqual(
    tasksByPayoutRef(tasks, "xfer-shared").map((t) => t.id),
    ["s-1", "s-2"],
  );
  assert.deepEqual(pairedIdsForRef(reconciled, "xfer-shared"), [
    "s-1",
    "s-2",
  ]);
  assert.deepEqual(
    reconciled.matched.map((t) => t.id),
    ["m-a", "m-b", "s-1", "s-2"],
  );
});

test("no-ref PAID task is unreconciled and selected by no ref", () => {
  const tasks = mixedBatch();
  const reconciled = reconcilePayouts(tasks, LEDGER);
  assert.deepEqual(
    reconciled.unreconciled.map((t) => t.id),
    ["no-ref", "req-ref"],
  );
  // Every ref either side mentions selects no unreconciled task.
  for (const ref of [
    "xfer-a",
    "xfer-b",
    "xfer-taskonly",
    "xfer-mismatch",
    "xfer-shared",
    "xfer-ledger-only",
    "xfer-pending",
    "xfer-reqref",
  ]) {
    const ids = tasksByPayoutRef(tasks, ref).map((t) => t.id);
    assert.equal(ids.includes("no-ref"), false, `ref ${ref}`);
    assert.equal(ids.includes("req-ref"), false, `ref ${ref}`);
  }
});

test("ledger-only ref selects no tasks", () => {
  const tasks = mixedBatch();
  const reconciled = reconcilePayouts(tasks, LEDGER);
  assert.deepEqual(tasksByPayoutRef(tasks, "xfer-ledger-only"), []);
  assert.deepEqual(pairedIdsForRef(reconciled, "xfer-ledger-only"), []);
  assert.deepEqual(
    reconciled.ledgerOnly.map((row) => row.payoutRef),
    ["xfer-ledger-only", "xfer-pending", "xfer-reqref"],
  );
});

test("request-only ref selects no tasks, on PAID or non-PAID tasks", () => {
  const tasks = mixedBatch();
  const reconciled = reconcilePayouts(tasks, LEDGER);
  // The PAID task's ref lives on REQUEST_PAYOUT only: not settlement
  // evidence, so neither helper pairs it.
  assert.deepEqual(tasksByPayoutRef(tasks, "xfer-reqref"), []);
  assert.deepEqual(pairedIdsForRef(reconciled, "xfer-reqref"), []);
  // The non-PAID task's request ref likewise selects nothing.
  assert.deepEqual(tasksByPayoutRef(tasks, "xfer-pending"), []);
  assert.deepEqual(pairedIdsForRef(reconciled, "xfer-pending"), []);
  // And the non-PAID task enters no reconciliation group at all.
  const allGrouped = [
    ...reconciled.matched,
    ...reconciled.taskOnly,
    ...reconciled.amountMismatch.map((m) => m.task),
    ...reconciled.unreconciled,
  ].map((t) => t.id);
  assert.equal(allGrouped.includes("pending-req"), false);
});

test("union over all refs equals the three paired groups", () => {
  const tasks = mixedBatch();
  const reconciled = reconcilePayouts(tasks, LEDGER);
  const refs = [
    "xfer-a",
    "xfer-b",
    "xfer-taskonly",
    "xfer-mismatch",
    "xfer-shared",
  ];
  const listed = refs.flatMap((ref) =>
    tasksByPayoutRef(tasks, ref).map((t) => t.id),
  );
  const paired = [
    ...reconciled.matched,
    ...reconciled.taskOnly,
    ...reconciled.amountMismatch.map((m) => m.task),
  ].map((t) => t.id);
  // Same tasks, in input order, each exactly once — no task is listed
  // under a ref it did not settle under, and no paired task is
  // missing from its transfer's listing.
  assert.deepEqual(listed, ["m-a", "m-b", "t-a", "mm-a", "s-1", "s-2"]);
  assert.deepEqual(paired, ["m-a", "m-b", "s-1", "s-2", "t-a", "mm-a"]);
  assert.deepEqual([...listed].sort(), [...paired].sort());
  assert.equal(new Set(listed).size, listed.length);
});

test("input order is preserved across interleaved refs", () => {
  // Refs interleave in the batch: the listing for each ref still
  // follows input order, not ref or group order.
  const tasks = [
    toPaid("first-shared", {
      completionRef: "xfer-shared",
      completionAmount: 30,
    }),
    toPaid("only-a", { completionRef: "xfer-a", completionAmount: 100 }),
    toPaid("second-shared", {
      completionRef: "xfer-shared",
      completionAmount: 30,
    }),
    toPaid("only-b", { completionRef: "xfer-b", completionAmount: 50 }),
  ];
  assert.deepEqual(
    tasksByPayoutRef(tasks, "xfer-shared").map((t) => t.id),
    ["first-shared", "second-shared"],
  );
  const reconciled = reconcilePayouts(tasks, LEDGER);
  assert.deepEqual(pairedIdsForRef(reconciled, "xfer-shared"), [
    "first-shared",
    "second-shared",
  ]);
  assert.deepEqual(
    reconciled.matched.map((t) => t.id),
    ["first-shared", "only-a", "second-shared", "only-b"],
  );
});

test("empty batch and empty ledger: both helpers return nothing", () => {
  assert.deepEqual(tasksByPayoutRef([], "xfer-a"), []);
  const empty = reconcilePayouts([], []);
  assert.deepEqual(empty.matched, []);
  assert.deepEqual(empty.taskOnly, []);
  assert.deepEqual(empty.ledgerOnly, []);
  assert.deepEqual(empty.amountMismatch, []);
  assert.deepEqual(empty.unreconciled, []);
  // An empty reference still fails fast instead of silently matching
  // nothing: a typo cannot masquerade as "no task settled".
  assert.throws(() => tasksByPayoutRef(mixedBatch(), ""), /non-empty string/);
});
