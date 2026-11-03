import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  tasksByPayoutRef,
  unreconciledPayouts,
} from "../src/index.js";
import type { DispatchOptions } from "../src/index.js";

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

test("tasksByPayoutRef: picks every task settled under the ref, in input order", () => {
  const batch = [
    toPaid("t-a", { payoutRef: "xfer-88f2" }),
    toPaid("t-b", { payoutRef: "xfer-99g3" }),
    toPaid("t-c", { payoutRef: "xfer-88f2" }),
    toPaid("t-d"),
  ];
  assert.deepEqual(
    tasksByPayoutRef(batch, "xfer-88f2").map((t) => t.id),
    ["t-a", "t-c"],
  );
  assert.deepEqual(
    tasksByPayoutRef(batch, "xfer-99g3").map((t) => t.id),
    ["t-b"],
  );
  assert.deepEqual(tasksByPayoutRef(batch, "xfer-nope"), []);
});

test("tasksByPayoutRef: a PAID task with no reference never matches", () => {
  const batch = [toPaid("t-noref")];
  assert.deepEqual(tasksByPayoutRef(batch, "xfer-88f2"), []);
});

test("tasksByPayoutRef: a request-only reference does not match", () => {
  // REQUEST_PAYOUT names the batch, but the PAYOUT_COMPLETE entry that
  // evidences the settlement carries no reference — the task is still
  // unreconciled, and a reverse lookup by the request ref must not
  // claim it as settled under that transfer.
  const t = toApproved("t-reqonly");
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "batch-2026-1006",
  });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.deepEqual(tasksByPayoutRef([t], "batch-2026-1006"), []);
});

test("tasksByPayoutRef: a reference on a non-payout event does not match", () => {
  // dispatch accepts payoutRef as generic audit metadata on any event,
  // so a ref attached to ACCEPT (or any pre-settlement event) is not
  // settlement evidence and must not match.
  const t = new TaskLifecycle("t-earlyref");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor", payoutRef: "xfer-early" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.deepEqual(tasksByPayoutRef([t], "xfer-early"), []);
});

test("tasksByPayoutRef: a task matching twice still appears exactly once", () => {
  // Both the request and the completion name the same transfer — the
  // task is one settlement, so it appears once, holding the same object.
  const t = toApproved("t-twice");
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "xfer-88f2",
  });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutRef: "xfer-88f2" });
  const result = tasksByPayoutRef([t], "xfer-88f2");
  assert.equal(result.length, 1);
  assert.equal(result[0], t);
});

test("tasksByPayoutRef: matching is exact — references are case-sensitive", () => {
  const batch = [toPaid("t-a", { payoutRef: "Xfer-88f2" })];
  assert.deepEqual(tasksByPayoutRef(batch, "xfer-88f2"), []);
  assert.deepEqual(
    tasksByPayoutRef(batch, "Xfer-88f2").map((t) => t.id),
    ["t-a"],
  );
});

test("tasksByPayoutRef: non-PAID tasks never match, even with a completion-shaped history", () => {
  const batch = [
    toApproved("t-approved"),
    new TaskLifecycle("t-fresh"),
  ];
  assert.deepEqual(tasksByPayoutRef(batch, "xfer-88f2"), []);
});

test("tasksByPayoutRef: empty input gives empty output", () => {
  assert.deepEqual(tasksByPayoutRef([], "xfer-88f2"), []);
});

test("tasksByPayoutRef: never mutates — input array, states and histories unchanged", () => {
  const batch = [
    toPaid("t-a", { payoutRef: "xfer-88f2" }),
    toPaid("t-b"),
  ];
  const statesBefore = batch.map((t) => t.state);
  const historiesBefore = batch.map((t) => t.history);
  const arrayBefore = [...batch];
  tasksByPayoutRef(batch, "xfer-88f2");
  assert.deepEqual(batch, arrayBefore);
  assert.deepEqual(
    batch.map((t) => t.state),
    statesBefore,
  );
  assert.deepEqual(
    batch.map((t) => t.history),
    historiesBefore,
  );
});

test("tasksByPayoutRef: illegal reference values fail fast", () => {
  const batch = [toPaid("t-a", { payoutRef: "xfer-88f2" })];
  assert.throws(
    () => tasksByPayoutRef(batch, ""),
    /invalid tasksByPayoutRef: payoutRef must be a non-empty string/,
  );
  for (const bad of [42, null, undefined, {}, ["xfer-88f2"]] as unknown[]) {
    assert.throws(
      () => tasksByPayoutRef(batch, bad as string),
      /invalid tasksByPayoutRef: payoutRef must be a non-empty string/,
    );
  }
});

test("tasksByPayoutRef: agrees with unreconciledPayouts on the completion-entry rule", () => {
  const settled = toPaid("t-settled", { payoutRef: "xfer-88f2" });
  const reqOnly = toApproved("t-reqonly");
  reqOnly.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "batch-2026-1006",
  });
  reqOnly.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  const noref = toPaid("t-noref");
  const batch = [settled, reqOnly, noref];
  // Settled under xfer-88f2: found by lookup, not flagged unreconciled.
  assert.deepEqual(
    tasksByPayoutRef(batch, "xfer-88f2").map((t) => t.id),
    ["t-settled"],
  );
  // Request-only and no-ref tasks: flagged unreconciled, found by no lookup.
  assert.deepEqual(
    unreconciledPayouts(batch).map((t) => t.id),
    ["t-reqonly", "t-noref"],
  );
  assert.deepEqual(tasksByPayoutRef(batch, "batch-2026-1006"), []);
});
