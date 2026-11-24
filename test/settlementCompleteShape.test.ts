import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  isSettlementComplete,
  reconcilePayouts,
  unreconciledPayouts,
} from "../src/index.js";

/**
 * `isSettlementComplete(task)` — shape guard (backlog #1362).
 *
 * The predicate used to read `task.state` and walk `task.history`
 * with no shape check at all: a `null` task died as a bare
 * `TypeError` reading `state`, and a PAID hand-built stand-in
 * carrying a `null` history entry died reading `event` — the same
 * bare-`TypeError` hole the batch settlement readers had already
 * closed for their batch entries (#1337/#1341/#1342), while the
 * predicate's own entry scan was left open. The fix adds the
 * single-task shape guard {@link assertTask} (string `id`, string
 * `state`, array `history`) plus a per-entry object check naming
 * the offending index, in the `entry[N]` convention
 * `verifyHistoryChain` uses (#1339).
 *
 * Rules under test:
 *  - a non-task input throws a named error, never a bare TypeError
 *  - a null / non-object history entry throws naming its index
 *  - the #893 defensive stand-in (PAID, no PAYOUT_COMPLETE entry)
 *    still returns false
 *  - a valid PAYOUT_COMPLETE entry still completes the task, and a
 *    hand-built entry object still counts (the guard checks shape,
 *    not class)
 *  - the entry scan only runs for PAID tasks: a non-PAID task with
 *    a null history entry returns false without throwing
 *  - the two callers inherit the guard through the shared
 *    predicate: `unreconciledPayouts` and `reconcilePayouts` report
 *    the predicate's named entry error for a `[null]`-entry task
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

/** A PAID hand-built stand-in whose history is the given entries. */
function paidStandIn(id: string, history: unknown[]): TaskLifecycle {
  return { id, state: "PAID", history } as unknown as TaskLifecycle;
}

test("shape: a null task throws a named error, not a bare TypeError", () => {
  assert.throws(
    () => isSettlementComplete(null as unknown as TaskLifecycle),
    /invalid isSettlementComplete: task must be a TaskLifecycle/,
  );
});

test("shape: a string task throws a named error", () => {
  assert.throws(
    () => isSettlementComplete("x" as unknown as TaskLifecycle),
    /invalid isSettlementComplete: task must be a TaskLifecycle/,
  );
});

test("shape: a numeric task throws a named error", () => {
  assert.throws(
    () => isSettlementComplete(42 as unknown as TaskLifecycle),
    /invalid isSettlementComplete: task must be a TaskLifecycle/,
  );
});

test("shape: a null history entry throws, naming its index", () => {
  assert.throws(
    () => isSettlementComplete(paidStandIn("null-entry", [null])),
    /invalid isSettlementComplete: entry\[0\]: history entry must be an object, got null/,
  );
});

test("shape: a string history entry throws, naming its index", () => {
  assert.throws(
    () => isSettlementComplete(paidStandIn("string-entry", ["x"])),
    /invalid isSettlementComplete: entry\[0\]: history entry must be an object, got string/,
  );
});

test("shape: a numeric history entry throws, naming its index", () => {
  assert.throws(
    () =>
      isSettlementComplete(
        paidStandIn("number-entry", [
          { seq: 1, event: "PUBLISH", from: "DRAFT", to: "OPEN" },
          42,
        ]),
      ),
    /invalid isSettlementComplete: entry\[1\]: history entry must be an object, got number/,
  );
});

test("shape: an array history entry is rejected, not treated as an object", () => {
  assert.throws(
    () => isSettlementComplete(paidStandIn("array-entry", [[]])),
    /invalid isSettlementComplete: entry\[0\]: history entry must be an object, got object/,
  );
});

test("shape: the #893 stand-in (PAID, no completion entry) still returns false", () => {
  assert.equal(isSettlementComplete(paidStandIn("no-completion", [])), false);
});

test("shape: a hand-built PAYOUT_COMPLETE entry still completes the task", () => {
  // The guard checks shape, not class: a plain-object entry carrying
  // both settlement fields is settlement evidence, the same as a
  // dispatched one.
  const standIn = paidStandIn("hand-built-complete", [
    {
      seq: 1,
      event: "PAYOUT_COMPLETE",
      from: "PAYOUT_REQUESTED",
      to: "PAID",
      payoutRef: "xfer-9",
      payoutAmount: 100,
    },
  ]);
  assert.equal(isSettlementComplete(standIn), true);
});

test("shape: a hand-built entry missing one settlement field is incomplete", () => {
  const standIn = paidStandIn("hand-built-no-ref", [
    {
      seq: 1,
      event: "PAYOUT_COMPLETE",
      from: "PAYOUT_REQUESTED",
      to: "PAID",
      payoutAmount: 100,
    },
  ]);
  assert.equal(isSettlementComplete(standIn), false);
});

test("shape: a non-PAID task with a null history entry returns false without throwing", () => {
  // The entry scan only runs for PAID tasks: the predicate returns
  // false on the state check before ever touching the history.
  const standIn = {
    id: "draft-null-entry",
    state: "DRAFT",
    history: [null],
  } as unknown as TaskLifecycle;
  assert.equal(isSettlementComplete(standIn), false);
});

test("verdicts unchanged: real PAID tasks keep their three-state answers", () => {
  assert.equal(isSettlementComplete(toPaid("v-complete", "xfer-1", 100)), true);
  assert.equal(isSettlementComplete(toPaid("v-no-amount", "xfer-2")), false);
  assert.equal(isSettlementComplete(toPaid("v-no-ref", undefined, 50)), false);
});

test("inheritance: unreconciledPayouts reports the predicate's entry error", () => {
  assert.throws(
    () => unreconciledPayouts([paidStandIn("unrec-null-entry", [null])]),
    /invalid isSettlementComplete: entry\[0\]: history entry must be an object, got null/,
  );
});

test("inheritance: reconcilePayouts reports the predicate's entry error", () => {
  assert.throws(
    () =>
      reconcilePayouts([paidStandIn("rec-null-entry", [null])], []),
    /invalid isSettlementComplete: entry\[0\]: history entry must be an object, got null/,
  );
});
