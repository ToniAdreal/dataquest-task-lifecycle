import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  isSettlementComplete,
  reconcilePayouts,
  unreconciledPayouts,
} from "../src/index.js";

/**
 * `isSettlementComplete(task)` — named settlement-complete predicate
 * (backlog #1243).
 *
 * The settlement-complete screen (PAID, and the last `PAYOUT_COMPLETE`
 * entry carries both a `payoutRef` and a `payoutAmount`) used to live
 * as two hand-written inline predicates, one in `unreconciledPayouts`
 * and one in `reconcilePayouts`' first pass, with nothing stopping
 * them drifting apart. This file pins the extracted function and the
 * two callers' agreement with it.
 *
 * Rules under test:
 *  - a PAID task whose last PAYOUT_COMPLETE entry carries both a
 *    payoutRef and a payoutAmount is complete
 *  - missing either field makes it incomplete (each field on its own)
 *  - a non-PAID task is never complete, even mid payout flight
 *  - a PAID task with no PAYOUT_COMPLETE entry at all is not complete
 *    (defensive stand-in: unreachable through dispatch/fromJSON/
 *    fromHistory, but the predicate aligns with unreconciledPayouts'
 *    "no completion entry is unreconciled" rule, not with the state
 *    alone)
 *  - an amount of 0 still counts as recorded (a zero-value settlement
 *    is still a settlement, the same rule the requirePayoutAmount
 *    gate uses)
 *  - a payoutRef on REQUEST_PAYOUT alone does not complete the task:
 *    only the PAYOUT_COMPLETE entry is settlement evidence
 *  - the two callers agree with the predicate: unreconciledPayouts
 *    excludes complete tasks and includes incomplete ones, and
 *    reconcilePayouts pairs complete tasks while its unreconciled
 *    group holds exactly the incomplete ones
 *  - pure: calling the predicate changes neither the task's state
 *    nor its history
 */

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

/** DRAFT → … → PAID, with an optional payoutRef and payoutAmount on the completion entry. */
function toPaid(
  id: string,
  completionRef?: string,
  completionAmount?: number,
): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    ...(completionRef !== undefined ? { payoutRef: completionRef } : {}),
    ...(completionAmount !== undefined
      ? { payoutAmount: completionAmount }
      : {}),
  });
  assert.equal(t.state, "PAID");
  return t;
}

test("complete: PAID with both a payoutRef and a payoutAmount", () => {
  assert.equal(
    isSettlementComplete(toPaid("complete", "xfer-1", 100)),
    true,
  );
});

test("incomplete: PAID with a payoutRef but no payoutAmount", () => {
  assert.equal(isSettlementComplete(toPaid("no-amount", "xfer-2")), false);
});

test("incomplete: PAID with a payoutAmount but no payoutRef", () => {
  assert.equal(isSettlementComplete(toPaid("no-ref", undefined, 100)), false);
});

test("incomplete: PAID with neither a payoutRef nor a payoutAmount", () => {
  assert.equal(isSettlementComplete(toPaid("bare")), false);
});

test("incomplete: non-PAID task is never complete, even in payout flight", () => {
  const t = toApproved("in-flight");
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "xfer-3",
  });
  assert.notEqual(t.state, "PAID");
  assert.equal(isSettlementComplete(t), false);
});

test("incomplete: PAID with no PAYOUT_COMPLETE entry at all", () => {
  // Defensive stand-in, same shape as payoutAging.test.ts: PAID with
  // no completion entry cannot arise through the validated paths.
  const standIn = {
    id: "no-completion",
    state: "PAID",
    history: [],
  } as unknown as TaskLifecycle;
  assert.equal(isSettlementComplete(standIn), false);
});

test("complete: an amount of 0 still counts as recorded", () => {
  assert.equal(
    isSettlementComplete(toPaid("zero-amount", "xfer-4", 0)),
    true,
  );
});

test("incomplete: a payoutRef on REQUEST_PAYOUT alone does not complete", () => {
  const t = toApproved("request-only-ref");
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "xfer-5",
  });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" }); // no ref on completion
  assert.equal(t.state, "PAID");
  assert.equal(isSettlementComplete(t), false);
});

test("callers agree: unreconciledPayouts and reconcilePayouts share the verdict", () => {
  const complete = toPaid("agree-complete", "xfer-6", 100);
  const noAmount = toPaid("agree-no-amount", "xfer-7");
  const noRef = toPaid("agree-no-ref", undefined, 50);
  const pending = toApproved("agree-pending");
  pending.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const batch = [complete, noAmount, noRef, pending];

  assert.deepEqual(
    unreconciledPayouts(batch).map((t) => t.id),
    ["agree-no-amount", "agree-no-ref"],
  );

  const reconciled = reconcilePayouts(batch, [
    { payoutRef: "xfer-6", payoutAmount: 100 },
  ]);
  assert.deepEqual(
    reconciled.matched.map((t) => t.id),
    ["agree-complete"],
  );
  assert.deepEqual(
    reconciled.unreconciled.map((t) => t.id),
    ["agree-no-amount", "agree-no-ref"],
  );
});

test("pure: the predicate changes neither state nor history", () => {
  const complete = toPaid("pure-complete", "xfer-8", 100);
  const incomplete = toPaid("pure-incomplete");
  const beforeComplete = JSON.stringify(complete.toJSON());
  const beforeIncomplete = JSON.stringify(incomplete.toJSON());

  assert.equal(isSettlementComplete(complete), true);
  assert.equal(isSettlementComplete(incomplete), false);

  assert.equal(complete.state, "PAID");
  assert.equal(incomplete.state, "PAID");
  assert.equal(JSON.stringify(complete.toJSON()), beforeComplete);
  assert.equal(JSON.stringify(incomplete.toJSON()), beforeIncomplete);
});
