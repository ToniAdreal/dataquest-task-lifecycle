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

test("reconcilePayouts: the same task object passed twice throws", () => {
  const t = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  assert.throws(
    () =>
      reconcilePayouts([t, t], [{ payoutRef: "xfer-1", payoutAmount: 10 }]),
    /invalid reconcilePayouts: duplicate task "t-a"/,
  );
});

test("reconcilePayouts: two objects sharing one task id throw", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  const b = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  assert.notEqual(a, b);
  assert.throws(
    () =>
      reconcilePayouts([a, b], [{ payoutRef: "xfer-1", payoutAmount: 10 }]),
    /invalid reconcilePayouts: duplicate task "t-a"/,
  );
});

test("reconcilePayouts: the duplicate-id scan covers tasks that would never pair", () => {
  // Neither task is PAID and neither carries a reference, so neither
  // would reach pairing — the pre-scan still rejects the batch,
  // because a duplicated id is a caller error, not a pairing detail.
  const a = toApproved("t-a");
  const b = toApproved("t-a");
  assert.throws(
    () => reconcilePayouts([a, b], []),
    /invalid reconcilePayouts: duplicate task "t-a"/,
  );
  // Same for PAID tasks with no settled amount (unreconciled).
  const c = toPaid("t-c");
  const d = toPaid("t-c");
  assert.throws(
    () => reconcilePayouts([c, d], []),
    /invalid reconcilePayouts: duplicate task "t-c"/,
  );
});

test("reconcilePayouts: the duplicate-task error fires before any pairing", () => {
  const t = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  // The ledger row records exactly the doubled sum (20): without the
  // pre-scan the two "tasks" would batch-sum to 20 and land in
  // `matched`, silently certifying money that was paid once.
  assert.throws(
    () =>
      reconcilePayouts([t, t], [{ payoutRef: "xfer-1", payoutAmount: 20 }]),
    /invalid reconcilePayouts: duplicate task "t-a"/,
  );
});

test("reconcilePayouts: the duplicate-task error fires before ledger validation", () => {
  const t = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  // The ledger is malformed too (empty payoutRef), but the task-side
  // pre-scan runs first, so the duplicate-task error is the one the
  // caller sees — the throw happens before any pairing or ledger work.
  assert.throws(
    () => reconcilePayouts([t, t], [{ payoutRef: "", payoutAmount: 10 }]),
    /invalid reconcilePayouts: duplicate task "t-a"/,
  );
});

test("reconcilePayouts: two distinct tasks sharing a reference still batch-sum", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-batch", payoutAmount: 30 });
  const b = toPaid("t-b", { payoutRef: "xfer-batch", payoutAmount: 30 });
  // Distinct ids, one shared reference: the legitimate batch case —
  // the row records the batch total (60), so both tasks match.
  const result = reconcilePayouts([a, b], [
    { payoutRef: "xfer-batch", payoutAmount: 60 },
  ]);
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-a", "t-b"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("reconcilePayouts: a single task still pairs exactly as before", () => {
  const t = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  const ledger: LedgerPayout[] = [
    { payoutRef: "xfer-1", payoutAmount: 10 },
    { payoutRef: "xfer-2", payoutAmount: 5 },
  ];
  const result = reconcilePayouts([t], ledger);
  assert.deepEqual(
    result.matched.map((x) => x.id),
    ["t-a"],
  );
  assert.equal(result.matched[0], t);
  assert.deepEqual(result.taskOnly, []);
  assert.deepEqual(
    result.ledgerOnly.map((row) => row.payoutRef),
    ["xfer-2"],
  );
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.unreconciled, []);
});

test("reconcilePayouts: empty tasks still give five empty groups", () => {
  const result = reconcilePayouts([], []);
  assert.deepEqual(result, {
    matched: [],
    taskOnly: [],
    ledgerOnly: [],
    amountMismatch: [],
    unreconciled: [],
  });
});
