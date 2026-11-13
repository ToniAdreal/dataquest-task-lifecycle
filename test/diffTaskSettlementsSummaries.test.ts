import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  diffTaskSettlementsSummaries,
  summarizeTaskSettlements,
  type TaskSettlementsSummary,
} from "../src/index.js";

/**
 * `diffTaskSettlementsSummaries(a, b)` (backlog #1094): the
 * field-level difference between two task settlements summaries —
 * the dataquest-side mirror of escrow's `diffSettlementReports`
 * (backlog #1092), with the same diff shape (`{ <field>Changed:
 * { from, to } }` per moved field, `{}` when nothing moved) and
 * the same contract: a comparison, not a validation.
 *
 * Rules under test:
 *  - only moved fields are present; two identical summaries diff
 *    to `{}`
 *  - every field compares as an exact integer — no float tolerance
 *    (all eight fields are integer minor units or counts)
 *  - `gap` is its own entry, reported separately from
 *    `quotedTotal` / `paidTotal`: a move in both totals that leaves
 *    the gap unchanged reports no `gapChanged`, and a gap-only move
 *    is still visible even though the diff never enforces the gap
 *    identity
 *  - `unquotedPaid` and `unquotedPaidTotal` move together when the
 *    quoteless population changes, and each is reported on its own
 *    when only one moves
 *  - an empty batch diffed against itself is `{}`; an empty batch
 *    against a settled batch reports all eight fields
 *  - non-object inputs fail fast with
 *    `invalid task settlements summary diff: …`
 *  - the diff is pure: neither input is mutated, and the returned
 *    diff is a fresh object
 *  - end to end: two real `summarizeTaskSettlements` outputs over
 *    batches that differ by one settled task diff exactly the
 *    fields that moved
 */

/** The demo-shaped golden summary the README pins. */
function golden(): TaskSettlementsSummary {
  return {
    tasks: 6,
    paid: 3,
    quotedTotal: 650000,
    paidTotal: 1634900,
    gap: -984900,
    mismatched: 1,
    unquotedPaid: 1,
    unquotedPaidTotal: 1009850,
  };
}

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

test("identical summaries diff to {}", () => {
  assert.deepEqual(diffTaskSettlementsSummaries(golden(), golden()), {});
  // Same values, different object identities — identity never matters.
  const a = golden();
  const b = golden();
  assert.notEqual(a, b);
  assert.deepEqual(diffTaskSettlementsSummaries(a, b), {});
});

test("a single quotedTotal move reports only quotedTotalChanged", () => {
  // quoted 650000 -> 700000, gap recomputed the same way a caller
  // would recompute it (650000 -> 700000 moves the gap by +50000).
  const before = golden();
  const after = { ...before, quotedTotal: 700000, gap: -934900 };
  assert.deepEqual(diffTaskSettlementsSummaries(before, after), {
    quotedTotalChanged: { from: 650000, to: 700000 },
    gapChanged: { from: -984900, to: -934900 },
  });
});

test("a single paidTotal move reports paidTotalChanged and gapChanged", () => {
  const before = golden();
  const after = { ...before, paidTotal: 1635000, gap: -985000 };
  assert.deepEqual(diffTaskSettlementsSummaries(before, after), {
    paidTotalChanged: { from: 1634900, to: 1635000 },
    gapChanged: { from: -984900, to: -985000 },
  });
});

test("gap is its own entry: equal moves in both totals leave no gapChanged", () => {
  // Both totals move by +100000; the gap (quoted - paid) does not move.
  const before = golden();
  const after = {
    ...before,
    quotedTotal: 750000,
    paidTotal: 1734900,
    gap: -984900,
  };
  assert.deepEqual(diffTaskSettlementsSummaries(before, after), {
    quotedTotalChanged: { from: 650000, to: 750000 },
    paidTotalChanged: { from: 1634900, to: 1734900 },
  });
});

test("a gap-only move is still visible (the diff never enforces the gap identity)", () => {
  // Totals untouched, gap alone disagrees: a comparison, not a
  // validation — the diff reports the move instead of refusing it.
  const before = golden();
  const after = { ...before, gap: -984901 };
  assert.deepEqual(diffTaskSettlementsSummaries(before, after), {
    gapChanged: { from: -984900, to: -984901 },
  });
});

test("mismatched move reports only mismatchedChanged", () => {
  const before = golden();
  const after = { ...before, mismatched: 2 };
  assert.deepEqual(diffTaskSettlementsSummaries(before, after), {
    mismatchedChanged: { from: 1, to: 2 },
  });
});

test("unquotedPaid and unquotedPaidTotal move together, and each alone", () => {
  const before = golden();
  // One more quoteless PAID task settles 500000: both fields move.
  const together = {
    ...before,
    paid: 4,
    paidTotal: 2134900,
    gap: -1484900,
    unquotedPaid: 2,
    unquotedPaidTotal: 1509850,
  };
  assert.deepEqual(diffTaskSettlementsSummaries(before, together), {
    paidChanged: { from: 3, to: 4 },
    paidTotalChanged: { from: 1634900, to: 2134900 },
    gapChanged: { from: -984900, to: -1484900 },
    unquotedPaidChanged: { from: 1, to: 2 },
    unquotedPaidTotalChanged: { from: 1009850, to: 1509850 },
  });
  // Only the count moves (a quoteless task with no recorded amount):
  // the total entry stays silent.
  const countOnly = { ...before, unquotedPaid: 2 };
  assert.deepEqual(diffTaskSettlementsSummaries(before, countOnly), {
    unquotedPaidChanged: { from: 1, to: 2 },
  });
});

test("tasks/paid count moves report on their own", () => {
  const before = golden();
  const after = { ...before, tasks: 7, paid: 4 };
  assert.deepEqual(diffTaskSettlementsSummaries(before, after), {
    tasksChanged: { from: 6, to: 7 },
    paidChanged: { from: 3, to: 4 },
  });
});

test("empty batch against itself is {}, against a settled batch reports all eight fields", () => {
  const empty: TaskSettlementsSummary = {
    tasks: 0,
    paid: 0,
    quotedTotal: 0,
    paidTotal: 0,
    gap: 0,
    mismatched: 0,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  };
  assert.deepEqual(diffTaskSettlementsSummaries(empty, empty), {});
  assert.deepEqual(diffTaskSettlementsSummaries(empty, golden()), {
    tasksChanged: { from: 0, to: 6 },
    paidChanged: { from: 0, to: 3 },
    quotedTotalChanged: { from: 0, to: 650000 },
    paidTotalChanged: { from: 0, to: 1634900 },
    gapChanged: { from: 0, to: -984900 },
    mismatchedChanged: { from: 0, to: 1 },
    unquotedPaidChanged: { from: 0, to: 1 },
    unquotedPaidTotalChanged: { from: 0, to: 1009850 },
  });
});

test("non-object inputs fail fast", () => {
  const goldenSummary = golden();
  for (const bad of [null, undefined, 42, "summary", [goldenSummary]]) {
    assert.throws(
      () =>
        diffTaskSettlementsSummaries(
          bad as unknown as TaskSettlementsSummary,
          goldenSummary,
        ),
      /invalid task settlements summary diff: both summaries must be objects/,
    );
    assert.throws(
      () =>
        diffTaskSettlementsSummaries(
          goldenSummary,
          bad as unknown as TaskSettlementsSummary,
        ),
      /invalid task settlements summary diff: both summaries must be objects/,
    );
  }
});

test("the diff is pure: inputs untouched, diff is a fresh object", () => {
  const before = golden();
  const after = { ...before, paidTotal: 1635000, gap: -985000 };
  const beforeCopy = { ...before };
  const afterCopy = { ...after };
  const diff = diffTaskSettlementsSummaries(before, after);
  assert.deepEqual(before, beforeCopy);
  assert.deepEqual(after, afterCopy);
  // Mutating the diff never reaches the inputs (numbers are values,
  // but the diff object itself must be fresh per call).
  diff.paidTotalChanged!.to = 0;
  assert.equal(after.paidTotal, 1635000);
  assert.notDeepEqual(
    diffTaskSettlementsSummaries(before, after),
    diff,
  );
});

test("end to end: real summaries over batches differing by one settled task", () => {
  const first = toPaid("T-1", { quoted: 100, paid: 100 });
  const before = summarizeTaskSettlements([first, toOpen("T-2")]);
  assert.deepEqual(before, {
    tasks: 2,
    paid: 1,
    quotedTotal: 10000,
    paidTotal: 10000,
    gap: 0,
    mismatched: 0,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  });
  const second = toPaid("T-2", { quoted: 50, paid: 75 });
  const after = summarizeTaskSettlements([first, second]);
  assert.deepEqual(after, {
    tasks: 2,
    paid: 2,
    quotedTotal: 15000,
    paidTotal: 17500,
    gap: -2500,
    mismatched: 1,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  });
  assert.deepEqual(diffTaskSettlementsSummaries(before, after), {
    paidChanged: { from: 1, to: 2 },
    quotedTotalChanged: { from: 10000, to: 15000 },
    paidTotalChanged: { from: 10000, to: 17500 },
    gapChanged: { from: 0, to: -2500 },
    mismatchedChanged: { from: 0, to: 1 },
  });
});
