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
 *  - a PAID task WITH a payoutRef on PAYOUT_COMPLETE is not selected
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

/** DRAFT → … → PAID, with an optional payoutRef on the completion entry. */
function toPaid(id: string, completionRef?: string): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  if (completionRef === undefined) {
    t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  } else {
    t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutRef: completionRef });
  }
  return t;
}

test("mixed list: only un-referenced PAID tasks are selected", () => {
  const paidWithRef = toPaid("paid-with-ref", "xfer-88f2");
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
  const b = toPaid("pure-b", "xfer-1"); // reconciled -> not selected
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
    toPaid("rehyd-with-ref", "xfer-99").toJSON(),
  );
  assert.equal(rehydratedNoRef.state, "PAID");
  assert.equal(rehydratedWithRef.state, "PAID");

  const out = unreconciledPayouts([rehydratedNoRef, rehydratedWithRef]);
  assert.deepEqual(out.map((t) => t.id), ["rehyd-no-ref"]);
});

test("PAID tasks stay selected regardless of list position and duplicates", () => {
  const noRef = toPaid("pos-no-ref");
  const withRef = toPaid("pos-with-ref", "xfer-2");
  // Same unreconciled task twice is reported twice: the helper filters,
  // it does not dedupe — callers own identity semantics.
  const out = unreconciledPayouts([withRef, noRef, noRef]);
  assert.deepEqual(out.map((t) => t.id), ["pos-no-ref", "pos-no-ref"]);
});
