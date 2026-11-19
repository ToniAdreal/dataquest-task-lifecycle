/**
 * `payoutMismatch()` minor-unit comparison (backlog #1263).
 *
 * The helper used to compare the raw floats — `quoted === paid` for
 * equality and `Math.round((paid - quoted) * 100) / 100` for the
 * delta — which broke on legacy sub-cent pairs: quoted 100.005 /
 * paid 100.004 parsed fine (legacy logs keep sub-cent precision) but
 * reported `{ quoted: 100.005, paid: 100.004, delta: 0 }`, a mismatch
 * with a zero delta that also broke the `summarizeTaskSettlements`
 * gap identity (`gap + unquotedPaidTotal` is the negated sum of the
 * per-task deltas in minor units). The comparison now runs in integer
 * minor units via `toMinorUnits`: same cent means no mismatch, a
 * one-cent difference reports an exact ±0.01 delta.
 *
 * Rules under test:
 *  - legacy pair 100.005 / 100.004 reports delta -0.01, never 0
 *  - legacy pair 100.004 / 100.005 reports delta +0.01
 *  - legacy same-cent pairs (100.001 / 100.002, either direction)
 *    report no mismatch at all
 *  - ordinary minor-unit pairs behave exactly as before (underpay /
 *    overpay / equal)
 *  - missing quote, missing settled amount, and non-PAID tasks still
 *    report no mismatch
 *  - a legacy pair inside `summarizeTaskSettlements()` keeps the gap
 *    identity exact (gap 1 minor unit = negated delta sum)
 *  - `mismatchedPayouts()` includes the -0.01 pair and excludes the
 *    same-cent pair
 *  - a legacy amount whose minor-unit conversion overflows (1e308)
 *    fails fast instead of returning a poisoned delta
 *  - pure: the task is unchanged by the comparison
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  mismatchedPayouts,
  payoutMismatch,
  summarizeTaskSettlements,
} from "../src/index.js";
import type { TaskEvent, TaskHistoryEntry, TaskState } from "../src/index.js";

type Step = [TaskEvent, TaskState, TaskState, string];

/** Full DRAFT → PAID path; legacy amounts ride on hand-built history. */
const STEPS: Step[] = [
  ["PUBLISH", "DRAFT", "OPEN", "2026-03-01T00:00:00.000Z"],
  ["ACCEPT", "OPEN", "ACCEPTED", "2026-03-01T00:01:00.000Z"],
  ["START_CAPTURE", "ACCEPTED", "CAPTURING", "2026-03-01T00:02:00.000Z"],
  ["SUBMIT", "CAPTURING", "SUBMITTED", "2026-03-01T00:03:00.000Z"],
  ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW", "2026-03-01T00:04:00.000Z"],
  ["APPROVE", "IN_REVIEW", "APPROVED", "2026-03-01T00:05:00.000Z"],
  ["REQUEST_PAYOUT", "APPROVED", "PAYOUT_PENDING", "2026-03-01T00:06:00.000Z"],
  ["PAYOUT_COMPLETE", "PAYOUT_PENDING", "PAID", "2026-03-01T00:07:00.000Z"],
];

/**
 * A PAID task whose ACCEPT quote / PAYOUT_COMPLETE amount may carry
 * sub-cent precision — built from hand-written history, the way a
 * legacy snapshot rehydrates, because `dispatch()` rejects sub-cent
 * amounts and could never write these entries.
 */
function legacyPaidTask(
  id: string,
  quoted?: number,
  paid?: number,
): TaskLifecycle {
  const history: TaskHistoryEntry[] = STEPS.map(
    ([event, from, to, at], i) => ({
      seq: i + 1,
      event,
      from,
      to,
      at,
      actor: "system",
      ...(event === "ACCEPT" && quoted !== undefined
        ? { quotedAmount: quoted }
        : {}),
      ...(event === "PAYOUT_COMPLETE" && paid !== undefined
        ? { payoutAmount: paid }
        : {}),
    }),
  );
  const task = TaskLifecycle.fromHistory(id, history);
  assert.equal(task.state, "PAID");
  return task;
}

/** Ordinary minor-unit PAID task, built the normal way via dispatch. */
function paidTask(id: string, quoted: number, paid: number): TaskLifecycle {
  const t = new TaskLifecycle(id);
  const at = (minutesBefore: number): string =>
    new Date(
      Date.parse("2026-03-01T00:07:00.000Z") - minutesBefore * 60_000,
    ).toISOString();
  t.dispatch("PUBLISH", { actor: "researcher", at: at(7) });
  t.dispatch("ACCEPT", {
    actor: "contributor",
    at: at(6),
    quotedAmount: quoted,
  });
  t.dispatch("START_CAPTURE", { actor: "contributor", at: at(5) });
  t.dispatch("SUBMIT", { actor: "contributor", at: at(4) });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: at(3) });
  t.dispatch("APPROVE", { actor: "reviewer", at: at(2) });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", at: at(1) });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    at: "2026-03-01T00:07:00.000Z",
    payoutAmount: paid,
  });
  assert.equal(t.state, "PAID");
  return t;
}

test("legacy pair 100.005 / 100.004 reports delta -0.01, never a delta-0 mismatch", () => {
  const task = legacyPaidTask("legacy-under", 100.005, 100.004);
  // Regression: the old float path reported delta -0, normalized to 0.
  assert.deepEqual(payoutMismatch(task), {
    quoted: 100.005,
    paid: 100.004,
    delta: -0.01,
  });
});

test("legacy pair 100.004 / 100.005 reports delta +0.01", () => {
  const task = legacyPaidTask("legacy-over", 100.004, 100.005);
  assert.deepEqual(payoutMismatch(task), {
    quoted: 100.004,
    paid: 100.005,
    delta: 0.01,
  });
});

test("legacy same-cent pair 100.001 / 100.002 is no mismatch", () => {
  const task = legacyPaidTask("legacy-same-cent", 100.001, 100.002);
  assert.equal(payoutMismatch(task), undefined);
});

test("legacy same-cent pair reversed 100.002 / 100.001 is no mismatch", () => {
  const task = legacyPaidTask("legacy-same-cent-rev", 100.002, 100.001);
  assert.equal(payoutMismatch(task), undefined);
});

test("ordinary minor-unit underpay and overpay are unchanged", () => {
  assert.deepEqual(payoutMismatch(paidTask("ord-under", 100, 90)), {
    quoted: 100,
    paid: 90,
    delta: -10,
  });
  assert.deepEqual(payoutMismatch(paidTask("ord-over", 100, 110)), {
    quoted: 100,
    paid: 110,
    delta: 10,
  });
});

test("ordinary equal amounts are no mismatch", () => {
  assert.equal(payoutMismatch(paidTask("ord-equal", 100, 100)), undefined);
});

test("missing quote, missing settled amount, and non-PAID tasks are no mismatch", () => {
  assert.equal(
    payoutMismatch(legacyPaidTask("legacy-no-quote", undefined, 100.004)),
    undefined,
  );
  assert.equal(
    payoutMismatch(legacyPaidTask("legacy-no-paid", 100.005, undefined)),
    undefined,
  );
  const open = new TaskLifecycle("not-paid");
  open.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(payoutMismatch(open), undefined);
});

test("legacy pair keeps the summarizeTaskSettlements gap identity exact", () => {
  const tasks = [
    legacyPaidTask("gap-under", 100.005, 100.004),
    legacyPaidTask("gap-same-cent", 100.001, 100.002),
    paidTask("gap-equal", 50, 50),
  ];
  const summary = summarizeTaskSettlements(tasks);
  // Minor units: quoted 10001 + 10000 + 5000 = 25001, paid
  // 10000 + 10000 + 5000 = 25000, gap 1; only the -0.01 pair counts.
  assert.equal(summary.quotedTotal, 25001);
  assert.equal(summary.paidTotal, 25000);
  assert.equal(summary.gap, 1);
  assert.equal(summary.mismatched, 1);
  assert.equal(summary.unquotedPaidTotal, 0);
  // Gap identity: gap + unquotedPaidTotal is the negated sum of the
  // per-task deltas in minor units — 1 = -(-1). Under the old float
  // path the delta sum was 0 and the identity read 1 = 0.
  const deltaMinorUnits = tasks
    .map((t) => payoutMismatch(t))
    .filter((m) => m !== undefined)
    .reduce((sum, m) => sum + Math.round(m.delta * 100), 0);
  assert.equal(summary.gap + summary.unquotedPaidTotal, -deltaMinorUnits);
});

test("mismatchedPayouts includes the -0.01 pair and excludes the same-cent pair", () => {
  const tasks = [
    legacyPaidTask("screen-under", 100.005, 100.004),
    legacyPaidTask("screen-same-cent", 100.001, 100.002),
    paidTask("screen-equal", 50, 50),
  ];
  assert.deepEqual(
    mismatchedPayouts(tasks).map((t) => t.id),
    ["screen-under"],
  );
});

test("legacy amount whose minor-unit conversion overflows fails fast", () => {
  const task = legacyPaidTask("legacy-giant", 1e308, 100);
  assert.throws(
    () => payoutMismatch(task),
    /minor units conversion overflowed/,
  );
});

test("payoutMismatch is pure: the task is unchanged by the comparison", () => {
  const task = legacyPaidTask("legacy-pure", 100.005, 100.004);
  const before = task.toJSON();
  payoutMismatch(task);
  assert.deepEqual(task.toJSON(), before);
});
