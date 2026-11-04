import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, payoutAging } from "../src/index.js";

/**
 * `payoutAging(tasks, now)` — unreconciled-payout aging (backlog #870).
 *
 * `unreconciledPayouts()` flags PAID tasks with no payoutRef on their
 * PAYOUT_COMPLETE entry, but says nothing about how long each
 * settlement has sat unevidenced. This helper buckets exactly that
 * population by whole days since the completion entry, so finance ops
 * can chase the oldest first instead of hand-computing a time
 * difference per task with an ad-hoc origin.
 *
 * Rules under test:
 *  - only the unreconciledPayouts population is aged: a PAID task WITH
 *    a payoutRef and a non-PAID task appear in no bucket
 *  - age origin is the PAYOUT_COMPLETE entry's `at`, buckets are on
 *    whole days (floor): exactly 7 days lands in days7To30, exactly 30
 *    days lands in over30Days, 6 days stays under7Days, 29 days stays
 *    in days7To30
 *  - a PAID task with no PAYOUT_COMPLETE entry at all goes to unknown,
 *    never silently dropped (defensive branch, unreachable through
 *    dispatch/fromJSON/fromHistory — built here as a shape stand-in,
 *    mirroring the screen's own defensive comment)
 *  - when a history carries more than one PAYOUT_COMPLETE entry, the
 *    last one sets the age (mirroring the entry the screen reads)
 *  - a future-dated completion (clock skew) counts as 0 days, never
 *    negative, and still lands in under7Days
 *  - pure: input tasks (state + history) unchanged, repeated calls
 *    agree, empty input gives four empty buckets
 *  - an invalid `now` fails fast instead of returning an empty result
 */

const NOW = new Date("2026-04-01T00:00:00.000Z");

/** Drive a task DRAFT → … → PAID, completion at `completeAt`. */
function toPaid(
  id: string,
  completeAt: string,
  completionRef?: string,
): TaskLifecycle {
  const t = new TaskLifecycle(id);
  const completeMs = Date.parse(completeAt);
  // dispatch() rejects an `at` earlier than the previous entry's, so
  // every step carries its own timestamp, one minute apart, ending
  // exactly at the completion time under test.
  const at = (minutesBefore: number): string =>
    new Date(completeMs - minutesBefore * 60_000).toISOString();
  t.dispatch("PUBLISH", { actor: "researcher", at: at(7) });
  t.dispatch("ACCEPT", { actor: "contributor", at: at(6) });
  t.dispatch("START_CAPTURE", { actor: "contributor", at: at(5) });
  t.dispatch("SUBMIT", { actor: "contributor", at: at(4) });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: at(3) });
  t.dispatch("APPROVE", { actor: "reviewer", at: at(2) });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", at: at(1) });
  if (completionRef === undefined) {
    t.dispatch("PAYOUT_COMPLETE", { actor: "system", at: completeAt });
  } else {
    t.dispatch("PAYOUT_COMPLETE", {
      actor: "system",
      at: completeAt,
      payoutRef: completionRef,
    });
  }
  assert.equal(t.state, "PAID");
  return t;
}

test("buckets, endpoints, and exclusions over a mixed batch", () => {
  const tasks = [
    toPaid("age-fresh", "2026-03-30T00:00:00.000Z"),
    toPaid("age-6", "2026-03-26T00:00:00.000Z"),
    toPaid("age-7", "2026-03-25T00:00:00.000Z"),
    toPaid("age-22", "2026-03-10T00:00:00.000Z"),
    toPaid("age-29", "2026-03-03T00:00:00.000Z"),
    toPaid("age-30", "2026-03-02T00:00:00.000Z"),
    toPaid("age-59", "2026-02-01T00:00:00.000Z"),
    toPaid("age-reconciled", "2026-01-01T00:00:00.000Z", "xfer-aged-1"),
    // Non-PAID: in payout flight, never aged even though old.
    (() => {
      const t = new TaskLifecycle("age-pending");
      t.dispatch("PUBLISH", { actor: "researcher" });
      t.dispatch("ACCEPT", { actor: "contributor" });
      t.dispatch("START_CAPTURE", { actor: "contributor" });
      t.dispatch("SUBMIT", { actor: "contributor" });
      t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
      t.dispatch("APPROVE", { actor: "reviewer" });
      t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
      return t;
    })(),
    // Defensive stand-in: PAID with no PAYOUT_COMPLETE entry at all.
    {
      id: "age-unknown",
      state: "PAID",
      history: [],
    } as unknown as TaskLifecycle,
  ];

  assert.deepEqual(payoutAging(tasks, NOW), {
    under7Days: [
      { id: "age-fresh", ageDays: 2 },
      { id: "age-6", ageDays: 6 },
    ],
    days7To30: [
      { id: "age-7", ageDays: 7 },
      { id: "age-22", ageDays: 22 },
      { id: "age-29", ageDays: 29 },
    ],
    over30Days: [
      { id: "age-30", ageDays: 30 },
      { id: "age-59", ageDays: 59 },
    ],
    unknown: [{ id: "age-unknown" }],
  });
});

test("whole-day floor: sub-day remainders never push a task up a bucket", () => {
  const tasks = [
    toPaid("age-6-half", "2026-03-25T12:00:00.000Z"),
    toPaid("age-29-half", "2026-03-02T12:00:00.000Z"),
  ];
  const out = payoutAging(tasks, NOW);
  assert.deepEqual(out.under7Days, [{ id: "age-6-half", ageDays: 6 }]);
  assert.deepEqual(out.days7To30, [{ id: "age-29-half", ageDays: 29 }]);
  assert.deepEqual(out.over30Days, []);
  assert.deepEqual(out.unknown, []);
});

test("future-dated completion counts as 0 days, still under7Days", () => {
  const task = toPaid("age-future", "2026-04-05T00:00:00.000Z");
  assert.deepEqual(payoutAging([task], NOW).under7Days, [
    { id: "age-future", ageDays: 0 },
  ]);
});

test("last PAYOUT_COMPLETE entry sets the age", () => {
  const standIn = {
    id: "age-two-completions",
    state: "PAID",
    history: [
      {
        seq: 1,
        event: "PAYOUT_COMPLETE",
        from: "PAYOUT_PENDING",
        to: "PAID",
        at: "2026-03-01T00:00:00.000Z",
      },
      {
        seq: 2,
        event: "PAYOUT_COMPLETE",
        from: "PAID",
        to: "PAID",
        at: "2026-03-10T00:00:00.000Z",
      },
    ],
  } as unknown as TaskLifecycle;
  assert.deepEqual(payoutAging([standIn], NOW).days7To30, [
    { id: "age-two-completions", ageDays: 22 },
  ]);
});

test("pure, repeatable, and empty-input safe", () => {
  const task = toPaid("age-pure", "2026-03-20T00:00:00.000Z");
  const beforeState = task.state;
  const beforeHistory = task.history;
  const first = payoutAging([task], NOW);
  assert.equal(task.state, beforeState);
  assert.deepEqual(task.history, beforeHistory);
  assert.deepEqual(payoutAging([task], NOW), first);
  assert.deepEqual(payoutAging([], NOW), {
    under7Days: [],
    days7To30: [],
    over30Days: [],
    unknown: [],
  });
});

test("invalid now fails fast", () => {
  const task = toPaid("age-bad-now", "2026-03-20T00:00:00.000Z");
  assert.throws(
    () => payoutAging([task], new Date("not-a-date")),
    /invalid now: expected a valid Date/,
  );
});
