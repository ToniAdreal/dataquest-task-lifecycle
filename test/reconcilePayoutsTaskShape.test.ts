import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, reconcilePayouts } from "../src/index.js";
import type { DispatchOptions, LedgerPayout } from "../src/index.js";

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

/** Drive a task from DRAFT to PAID, with the given completion options. */
function toPaid(
  id: string,
  completeOpts: DispatchOptions = {},
): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", ...completeOpts });
  assert.equal(t.state, "PAID");
  return t;
}

const LEDGER: LedgerPayout[] = [{ payoutRef: "xfer-1", payoutAmount: 10 }];

test("reconcilePayouts: a null task entry throws, naming its index", () => {
  assert.throws(
    () => reconcilePayouts([null as never], []),
    /invalid reconcilePayouts: tasks\[0\] must be a task object with a string id, string state, and array history, got null/,
  );
});

test("reconcilePayouts: an undefined task entry throws, naming its index", () => {
  assert.throws(
    () => reconcilePayouts([undefined as never], []),
    /invalid reconcilePayouts: tasks\[0\] must be a task object with a string id, string state, and array history, got undefined/,
  );
});

test("reconcilePayouts: a numeric task entry throws, naming its index", () => {
  assert.throws(
    () => reconcilePayouts([42 as never], []),
    /invalid reconcilePayouts: tasks\[0\] must be a task object with a string id, string state, and array history, got 42/,
  );
});

test("reconcilePayouts: a string task entry throws, naming its index", () => {
  assert.throws(
    () => reconcilePayouts(["x" as never], []),
    /invalid reconcilePayouts: tasks\[0\] must be a task object with a string id, string state, and array history, got "x"/,
  );
});

test("reconcilePayouts: a plain object with a numeric id throws", () => {
  assert.throws(
    () => reconcilePayouts([{ id: 1 } as never], []),
    /invalid reconcilePayouts: tasks\[0\] must be a task object with a string id, string state, and array history, got \{"id":1\}/,
  );
});

test("reconcilePayouts: a defensive stand-in shaped like a task still passes", () => {
  // Backlog #893 deliberately passes a plain object shaped like a
  // task — PAID with no PAYOUT_COMPLETE entry at all — so the guard
  // checks the shape the function reads, not the class. The stand-in
  // lands in unreconciled, exactly like a real task with no
  // completion entry.
  const standIn = {
    id: "unrec-unknown",
    state: "PAID",
    history: [],
  } as unknown as TaskLifecycle;
  const result = reconcilePayouts([standIn], []);
  assert.deepEqual(
    result.unreconciled.map((t) => t.id),
    ["unrec-unknown"],
  );
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.taskOnly, []);
  assert.deepEqual(result.ledgerOnly, []);
  assert.deepEqual(result.amountMismatch, []);
});

test("reconcilePayouts: a plain object with a string id throws too", () => {
  // The entry carries a string id, but it is missing the state and
  // history legs the pairing loop reads — without them it would
  // either die as a bare TypeError or slip through silently (a
  // non-PAID-looking entry lands in no group at all).
  assert.throws(
    () => reconcilePayouts([{ id: "t-a" } as never], []),
    /invalid reconcilePayouts: tasks\[0\] must be a task object with a string id, string state, and array history, got \{"id":"t-a"\}/,
  );
});

test("reconcilePayouts: the shape error names the first bad index, not 0", () => {
  const a = toApproved("t-a");
  const b = toApproved("t-b");
  assert.throws(
    () => reconcilePayouts([a, b, null as never], []),
    /invalid reconcilePayouts: tasks\[2\] must be a task object with a string id, string state, and array history, got null/,
  );
});

test("reconcilePayouts: a non-array tasks value throws before any pairing", () => {
  for (const bad of [null, "x", 42]) {
    assert.throws(
      () => reconcilePayouts(bad as never, LEDGER),
      /invalid reconcilePayouts: tasks must be an array/,
    );
  }
});

test("reconcilePayouts: a non-array ledger value throws before any pairing", () => {
  const t = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  for (const bad of [null, "x", 42]) {
    assert.throws(
      () => reconcilePayouts([t], bad as never),
      /invalid reconcilePayouts: ledger must be an array/,
    );
  }
});

test("reconcilePayouts: a mixed batch with one bad entry throws and pairs nothing", () => {
  // The good task would match the ledger row on its own; the null
  // entry must fail the whole batch before any group is placed.
  const t = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  assert.throws(
    () => reconcilePayouts([t, null as never], LEDGER),
    /invalid reconcilePayouts: tasks\[1\] must be a task object with a string id, string state, and array history, got null/,
  );
});

test("reconcilePayouts: the task-side shape error beats a malformed ledger", () => {
  // Same precedence the duplicate-task check already had: a task
  // error is the one the caller sees even when the ledger is also
  // malformed.
  assert.throws(
    () => reconcilePayouts([null as never], null as never),
    /invalid reconcilePayouts: tasks\[0\] must be a task object with a string id, string state, and array history, got null/,
  );
});

test("reconcilePayouts: a legal batch still reconciles, shared ref included", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 6 });
  const b = toPaid("t-b", { payoutRef: "xfer-1", payoutAmount: 4 });
  const c = toPaid("t-c", { payoutRef: "xfer-2", payoutAmount: 7 });
  const result = reconcilePayouts(
    [a, b, c],
    [
      { payoutRef: "xfer-1", payoutAmount: 10 },
      { payoutRef: "xfer-2", payoutAmount: 7 },
    ],
  );
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-a", "t-b", "t-c"],
  );
  assert.deepEqual(result.taskOnly, []);
  assert.deepEqual(result.ledgerOnly, []);
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.unreconciled, []);
});

test("reconcilePayouts: the duplicate-task rejection still fires", () => {
  const t = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  assert.throws(
    () => reconcilePayouts([t, t], LEDGER),
    /invalid reconcilePayouts: duplicate task "t-a"/,
  );
});
