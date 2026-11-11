import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, unreconciledPayouts } from "../src/index.js";

/**
 * `unreconciledPayouts(tasks)` — settlement reconciliation screening.
 *
 * The `dispatch()` docs name the use case: a `PAYOUT_COMPLETE` without a
 * `payoutRef` is legal (advisory only), so finance ops need a pure helper
 * to find `PAID` tasks whose settlement lacks external payment evidence.
 *
 * Rules under test:
 *  - a PAID task whose PAYOUT_COMPLETE entry has no payoutRef is selected
 *  - a PAID task whose PAYOUT_COMPLETE entry has a payoutRef but no
 *    payoutAmount is selected too: a reference without a settled amount
 *    cannot be checked against a ledger by amount (backlog #1046)
 *  - a PAID task WITH a payoutRef AND a payoutAmount on PAYOUT_COMPLETE
 *    is not selected; an amount of 0 still counts as recorded
 *  - a PAID task with no payoutRef but a payoutAmount is still selected
 *    (the old rule is unchanged)
 *  - non-PAID tasks are never selected (even in payout flight or
 *    terminated in another terminal state)
 *  - the check reads the PAYOUT_COMPLETE entry, not REQUEST_PAYOUT: a
 *    ref on the request alone still leaves the task unreconciled
 *  - empty input returns an empty array (a fresh one)
 *  - pure: the input list and every task (state + history) are unchanged
 *  - works on fromJSON()-rehydrated tasks
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
  return t;
}

test("mixed list: only un-referenced PAID tasks are selected", () => {
  // The with-ref task carries an amount too: under the #1046 rule a
  // reference without a settled amount is unreconciled, so the
  // "reconciled" side of this fixture must record both fields.
  const paidWithRef = toPaid("paid-with-ref", "xfer-88f2", 1000);
  const paidNoRef = toPaid("paid-no-ref");
  const inFlight = toApproved("in-flight"); // not PAID yet
  inFlight.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const expired = new TaskLifecycle("expired");
  expired.dispatch("PUBLISH", { actor: "researcher" });
  expired.dispatch("EXPIRE", { actor: "system" }); // terminal, not PAID

  const out = unreconciledPayouts([paidWithRef, paidNoRef, inFlight, expired]);
  assert.deepEqual(
    out.map((t) => t.id),
    ["paid-no-ref"],
  );
});

test("a payoutRef on REQUEST_PAYOUT alone does not reconcile the task", () => {
  const t = toApproved("request-only-ref");
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "batch-2026-1007",
  });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" }); // no ref on completion
  assert.equal(t.state, "PAID");

  const out = unreconciledPayouts([t]);
  assert.deepEqual(out.map((x) => x.id), ["request-only-ref"]);
});

test("empty input returns an empty array", () => {
  // Array.prototype.filter always builds a fresh array, so the empty
  // result cannot alias the input list.
  assert.deepEqual(unreconciledPayouts([]), []);
});

test("pure: inputs are not mutated and the returned list is detached", () => {
  const a = toPaid("pure-a"); // unreconciled -> selected
  const b = toPaid("pure-b", "xfer-1", 500); // reconciled -> not selected
  const tasks = [a, b];
  const statesBefore = tasks.map((t) => t.state);
  const historiesBefore = tasks.map((t) => JSON.stringify(t.history));

  const out = unreconciledPayouts(tasks);
  assert.deepEqual(out.map((t) => t.id), ["pure-a"]);
  assert.notEqual(out, tasks); // new array, not the input reference

  // No task was touched: state and full audit history byte-identical.
  assert.deepEqual(
    tasks.map((t) => t.state),
    statesBefore,
  );
  assert.deepEqual(
    tasks.map((t) => JSON.stringify(t.history)),
    historiesBefore,
  );
});

test("works on fromJSON()-rehydrated tasks", () => {
  const rehydratedNoRef = TaskLifecycle.fromJSON(toPaid("rehyd-no-ref").toJSON());
  const rehydratedWithRef = TaskLifecycle.fromJSON(
    toPaid("rehyd-with-ref", "xfer-99", 750).toJSON(),
  );
  assert.equal(rehydratedNoRef.state, "PAID");
  assert.equal(rehydratedWithRef.state, "PAID");

  const out = unreconciledPayouts([rehydratedNoRef, rehydratedWithRef]);
  assert.deepEqual(out.map((t) => t.id), ["rehyd-no-ref"]);
});

test("PAID tasks stay selected regardless of list position and duplicates", () => {
  const noRef = toPaid("pos-no-ref");
  const withRef = toPaid("pos-with-ref", "xfer-2", 250);
  // Same unreconciled task twice is reported twice: the helper filters,
  // it does not dedupe — callers own identity semantics.
  const out = unreconciledPayouts([withRef, noRef, noRef]);
  assert.deepEqual(out.map((t) => t.id), ["pos-no-ref", "pos-no-ref"]);
});

test("a payoutRef without a payoutAmount is still unreconciled (backlog #1046)", () => {
  const refNoAmount = toPaid("ref-no-amount", "xfer-77");
  assert.equal(refNoAmount.state, "PAID");
  assert.equal(
    refNoAmount.history.at(-1)!.payoutRef,
    "xfer-77",
  );
  assert.equal(refNoAmount.history.at(-1)!.payoutAmount, undefined);

  assert.deepEqual(unreconciledPayouts([refNoAmount]).map((t) => t.id), [
    "ref-no-amount",
  ]);
});

test("a payoutRef WITH a payoutAmount is reconciled", () => {
  const refWithAmount = toPaid("ref-with-amount", "xfer-78", 1200);
  assert.deepEqual(unreconciledPayouts([refWithAmount]), []);
});

test("no payoutRef with a payoutAmount is still unreconciled (old rule unchanged)", () => {
  const noRefWithAmount = toPaid("no-ref-with-amount", undefined, 900);
  assert.deepEqual(
    unreconciledPayouts([noRefWithAmount]).map((t) => t.id),
    ["no-ref-with-amount"],
  );
});

test("a payoutAmount of 0 still counts as recorded", () => {
  // A zero-value settlement is still a settlement (same rule the
  // requirePayoutAmount gate uses): only `undefined` is missing.
  const zeroAmount = toPaid("zero-amount", "xfer-79", 0);
  assert.deepEqual(unreconciledPayouts([zeroAmount]), []);
});

test("a non-PAID task with a payoutRef and a payoutAmount is never selected", () => {
  // REQUEST_PAYOUT carries both fields, but the task has not settled.
  const inFlight = toApproved("in-flight-ref-amount");
  inFlight.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "xfer-80",
    payoutAmount: 300,
  });
  assert.notEqual(inFlight.state, "PAID");
  assert.deepEqual(unreconciledPayouts([inFlight]), []);
});

test("a request-only ref does not save a ref-without-amount completion", () => {
  const t = toApproved("request-ref-completion-ref-no-amount");
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "batch-2026-1111",
  });
  // The completion entry carries a ref of its own, but no amount:
  // the screen reads the completion entry, and the amount gap alone
  // leaves the settlement unreconciled.
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutRef: "xfer-81" });
  assert.equal(t.state, "PAID");
  assert.deepEqual(
    unreconciledPayouts([t]).map((x) => x.id),
    ["request-ref-completion-ref-no-amount"],
  );
});

test("fromJSON rehydration keeps the ref-without-amount verdict", () => {
  const rehydratedRefNoAmount = TaskLifecycle.fromJSON(
    toPaid("rehyd-ref-no-amount", "xfer-82").toJSON(),
  );
  const rehydratedRefWithAmount = TaskLifecycle.fromJSON(
    toPaid("rehyd-ref-with-amount", "xfer-83", 400).toJSON(),
  );
  assert.equal(rehydratedRefNoAmount.state, "PAID");
  assert.equal(rehydratedRefWithAmount.state, "PAID");

  assert.deepEqual(
    unreconciledPayouts([rehydratedRefNoAmount, rehydratedRefWithAmount]).map(
      (t) => t.id,
    ),
    ["rehyd-ref-no-amount"],
  );
});

test("pure: a ref-without-amount task is unchanged by the screen", () => {
  const t = toPaid("pure-ref-no-amount", "xfer-84");
  const historyBefore = JSON.stringify(t.history);
  const out = unreconciledPayouts([t]);
  assert.deepEqual(out.map((x) => x.id), ["pure-ref-no-amount"]);
  assert.equal(t.state, "PAID");
  assert.equal(JSON.stringify(t.history), historyBefore);
});
