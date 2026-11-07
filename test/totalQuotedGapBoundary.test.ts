import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  mismatchedPayouts,
  payoutMismatch,
  totalPaidOut,
  totalQuoted,
} from "../src/index.js";

/**
 * `totalQuoted(tasks) - totalPaidOut(tasks)` — the batch gap (backlog
 * #954): where the quoted-vs-settled identity holds, and where it
 * breaks. The `totalQuoted` JSDoc used to state the gap unconditionally
 * as "the sum of `quoted - paid` over the tasks `mismatchedPayouts`
 * flags". That reading is only true when every `PAID` task in the
 * batch carries a recorded quote. The demo batch (#946) already
 * falsifies the unconditional reading: gap -9849 against a per-task
 * delta sum of -249.5 — the -10098.5 difference is exactly DEMO-001's
 * quoteless settlement. A `PAID` task with no quote contributes 0 to
 * `totalQuoted` but its settled amount to `totalPaidOut`, so the gap
 * additionally absorbs that settled amount:
 *
 *   gap = -(sum of flagged deltas) - (settled amounts of quoteless PAID tasks)
 *
 * Rules pinned here:
 *  - all-quoted batch: the identity holds exactly
 *  - one quoteless PAID task: the deviation from the identity is
 *    exactly that task's settled amount (demo-batch numbers)
 *  - several quoteless PAID tasks: the deviation is the sum of their
 *    settled amounts
 *  - all-quoteless PAID batch: the gap is the negated settled total
 *    and the mismatch screen flags nothing
 *  - quoteless PAID task with no recorded payout amount contributes
 *    to neither side, so the identity still holds
 *  - empty batch: gap is 0
 *  - non-PAID tasks (quoted-and-rejected, in-flight) never enter the
 *    gap at all
 */

/** Drive a task to OPEN (one step before ACCEPT). */
function toOpen(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  return t;
}

interface PaidOpts {
  quoted?: number;
  paid?: number;
}

/** DRAFT → … → PAID, quoting on ACCEPT and settling on PAYOUT_COMPLETE. */
function toPaid(id: string, opts: PaidOpts): TaskLifecycle {
  const t = toOpen(id);
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
    ...(opts.paid !== undefined ? { payoutAmount: opts.paid } : {}),
  });
  return t;
}

/** ACCEPT a quote, then REJECT in review — the DEMO-085 shape. */
function toRejectedQuoted(id: string, quoted: number): TaskLifecycle {
  const t = toOpen(id);
  t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: quoted });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("REJECT", { actor: "reviewer" });
  return t;
}

/** Negated sum of the flagged per-task deltas for a batch. */
function negatedDeltaSum(tasks: readonly TaskLifecycle[]): number {
  const sum = mismatchedPayouts(tasks).reduce(
    (total, t) => total + payoutMismatch(t)!.delta,
    0,
  );
  // Negating an empty sum yields -0; normalize so strict equality
  // against 0 holds in the all-quoteless and empty-batch cases.
  return sum === 0 ? 0 : -sum;
}

test("quoteless PAID task: the gap absorbs its settled amount (demo-batch numbers)", () => {
  // The #946 demo batch, rebuilt as plain tasks: DEMO-001 settles
  // 10098.5 with no recorded quote; one task settles exactly as
  // quoted (2500/2500, unflagged); one settles short (4000 quoted,
  // 3750.5 paid, delta -249.5).
  const tasks = [
    toPaid("qless", { paid: 10098.5 }),
    toPaid("exact", { quoted: 2500, paid: 2500 }),
    toPaid("under", { quoted: 4000, paid: 3750.5 }),
  ];
  assert.equal(totalQuoted(tasks), 6500);
  assert.equal(totalPaidOut(tasks), 16349);
  const gap = totalQuoted(tasks) - totalPaidOut(tasks);
  assert.equal(gap, -9849);
  // Only the short task is flagged; its delta is -249.5.
  assert.deepEqual(
    mismatchedPayouts(tasks).map((t) => t.id),
    ["under"],
  );
  assert.equal(payoutMismatch(tasks[2])!.delta, -249.5);
  assert.equal(negatedDeltaSum(tasks), 249.5);
  // The gap is NOT the negated delta sum: the deviation is exactly
  // the quoteless task's settled amount, on the negative side.
  assert.equal(gap - negatedDeltaSum(tasks), -10098.5);
  assert.equal(gap, negatedDeltaSum(tasks) - 10098.5);
});

test("all-quoted batch: the gap identity holds exactly", () => {
  const tasks = [
    toPaid("gap-under", { quoted: 100, paid: 80 }),
    toPaid("gap-over", { quoted: 50, paid: 60 }),
    toPaid("gap-exact", { quoted: 70, paid: 70 }),
  ];
  assert.equal(totalQuoted(tasks), 220);
  assert.equal(totalPaidOut(tasks), 210);
  const gap = totalQuoted(tasks) - totalPaidOut(tasks);
  assert.equal(gap, 10);
  assert.equal(negatedDeltaSum(tasks), 10);
  assert.equal(gap, negatedDeltaSum(tasks));
});

test("two quoteless PAID tasks: the deviation is the sum of their settled amounts", () => {
  const tasks = [
    toPaid("under", { quoted: 4000, paid: 3750.5 }),
    toPaid("qless-a", { paid: 10098.5 }),
    toPaid("qless-b", { paid: 500 }),
  ];
  assert.equal(totalQuoted(tasks), 4000);
  assert.equal(totalPaidOut(tasks), 14349);
  const gap = totalQuoted(tasks) - totalPaidOut(tasks);
  assert.equal(gap, -10349);
  assert.equal(negatedDeltaSum(tasks), 249.5);
  assert.equal(gap - negatedDeltaSum(tasks), -(10098.5 + 500));
  assert.equal(gap, negatedDeltaSum(tasks) - 10098.5 - 500);
});

test("all-quoteless PAID batch: the gap is the negated settled total", () => {
  const tasks = [
    toPaid("qless-a", { paid: 100 }),
    toPaid("qless-b", { paid: 200 }),
  ];
  assert.equal(totalQuoted(tasks), 0);
  assert.equal(totalPaidOut(tasks), 300);
  assert.equal(totalQuoted(tasks) - totalPaidOut(tasks), -300);
  // No task carries both amounts, so the mismatch screen sees nothing.
  assert.deepEqual(mismatchedPayouts(tasks), []);
  assert.equal(negatedDeltaSum(tasks), 0);
});

test("quoteless PAID task with no recorded payout amount contributes to neither side", () => {
  // A PAYOUT_COMPLETE entry with no payoutAmount: the task is PAID
  // but settled nothing observable, so it enters neither total and
  // the identity still holds.
  const tasks = [
    toPaid("under", { quoted: 100, paid: 80 }),
    toPaid("qless-nopay", {}),
  ];
  assert.equal(totalQuoted(tasks), 100);
  assert.equal(totalPaidOut(tasks), 80);
  const gap = totalQuoted(tasks) - totalPaidOut(tasks);
  assert.equal(gap, 20);
  assert.equal(negatedDeltaSum(tasks), 20);
  assert.equal(gap, negatedDeltaSum(tasks));
  assert.deepEqual(
    mismatchedPayouts(tasks).map((t) => t.id),
    ["under"],
  );
});

test("empty batch: the gap is 0", () => {
  assert.equal(totalQuoted([]), 0);
  assert.equal(totalPaidOut([]), 0);
  assert.equal(totalQuoted([]) - totalPaidOut([]), 0);
  assert.deepEqual(mismatchedPayouts([]), []);
});

test("non-PAID tasks never enter the gap, quoted or not", () => {
  const tasks = [
    toPaid("under", { quoted: 100, paid: 80 }),
    toRejectedQuoted("rejected", 9999),
    toOpen("in-flight"),
  ];
  assert.equal(totalQuoted(tasks), 100);
  assert.equal(totalPaidOut(tasks), 80);
  const gap = totalQuoted(tasks) - totalPaidOut(tasks);
  assert.equal(gap, 20);
  assert.equal(negatedDeltaSum(tasks), 20);
  assert.equal(gap, negatedDeltaSum(tasks));
});
