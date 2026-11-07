import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  payoutMismatch,
  summarizeTaskSettlements,
  type TaskHistoryEntry,
  type TaskSettlementsSummary,
} from "../src/index.js";

/**
 * `summarizeTaskSettlements(tasks)` (backlog #966): the one-call
 * batch settlement summary — the `totalQuoted` / `totalPaidOut`
 * pair plus the mismatch and quoteless splits a caller otherwise
 * has to hand-scan for. All money figures are integer minor units,
 * so no binary-float error can leak into a reconciliation total.
 *
 * Rules under test:
 *  - `tasks` counts every task in the batch, of every state; only
 *    `PAID` tasks contribute money, `paid`, `mismatched`, or the
 *    `unquotedPaid*` counts
 *  - `quotedTotal` reads the last `ACCEPT` quote and `paidTotal`
 *    the `PAYOUT_COMPLETE` amount, per PAID task, in minor units
 *  - `gap` is `quotedTotal - paidTotal` in minor units
 *  - `mismatched` counts exactly the `payoutMismatch` population
 *  - `unquotedPaid` / `unquotedPaidTotal` split the quoteless
 *    settled money out of the gap, so `gap + unquotedPaidTotal`
 *    is the negated sum of the per-task deltas for every batch
 *  - a `PAID` task with a quote but no recorded payout amount
 *    contributes its quote, 0 paid, and is neither mismatched
 *    nor unquoted
 *  - overflow is fail-fast with
 *    `task settlements summary computation overflowed: inputs too
 *    large`, never a silent `Infinity`
 *  - the summary is pure: the input tasks are untouched
 *  - an empty batch is an all-zero summary
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

/** PUBLISH → EXPIRE: a non-PAID terminal task. */
function toExpired(id: string): TaskLifecycle {
  const t = toOpen(id);
  t.dispatch("EXPIRE", { actor: "system" });
  return t;
}

/** Drive a task to REJECTED, optionally quoting on ACCEPT. */
function toRejected(id: string, quoted?: number): TaskLifecycle {
  const t = toOpen(id);
  t.dispatch("ACCEPT", {
    actor: "contributor",
    ...(quoted !== undefined ? { quotedAmount: quoted } : {}),
  });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("REJECT", { actor: "reviewer" });
  return t;
}

/**
 * Rehydrate a PAID task whose `ACCEPT` entry carries a legacy quote
 * `dispatch()` would reject, via the hashless-snapshot path: strip
 * the hash chain (legacy, hashless) and overwrite the quote, then
 * restore through `fromJSON`. The restore itself must succeed — the
 * overflow gate lives in `summarizeTaskSettlements`, not in the
 * snapshot reader. (Same technique as `totalQuoted.test.ts`, for
 * the quote.)
 */
function legacyQuotedViaSnapshot(id: string, quote: number): TaskLifecycle {
  const live = toPaid(id, { quoted: 100, paid: 100 });
  const snapshot = live.toJSON();
  for (const entry of snapshot.history) {
    delete (entry as Partial<TaskHistoryEntry>).prevHash;
    delete (entry as Partial<TaskHistoryEntry>).hash;
  }
  snapshot.history.find((e) => e.event === "ACCEPT")!.quotedAmount = quote;
  const revived = TaskLifecycle.fromJSON(snapshot);
  assert.equal(revived.state, "PAID");
  return revived;
}

/**
 * The demo batch, rebuilt with the same shapes as `src/demo.ts`:
 * DEMO-001 settles 10098.5 with no recorded quote, DEMO-004
 * settles exactly its 2500 quote, DEMO-005 settles 3750.5 against
 * a 4000 quote (delta -249.5), DEMO-002 is EXPIRED, DEMO-003 is
 * REJECTED, and DEMO-085 is REJECTED carrying a 9999 quote.
 */
function demoBatch(): TaskLifecycle[] {
  return [
    toPaid("DEMO-001", { paid: 10098.5 }),
    toExpired("DEMO-002"),
    toRejected("DEMO-003"),
    toPaid("DEMO-004", { quoted: 2500, paid: 2500 }),
    toPaid("DEMO-005", { quoted: 4000, paid: 3750.5 }),
    toRejected("DEMO-085", 9999),
  ];
}

const EXPECTED_DEMO: TaskSettlementsSummary = {
  tasks: 6,
  paid: 3,
  quotedTotal: 650000,
  paidTotal: 1634900,
  gap: -984900,
  mismatched: 1,
  unquotedPaid: 1,
  unquotedPaidTotal: 1009850,
};

test("demo batch numbers are pinned, in integer minor units", () => {
  const summary = summarizeTaskSettlements(demoBatch());
  assert.deepEqual(summary, EXPECTED_DEMO);
  // The demo's major-unit gap (-9849) is the same gap in cents.
  assert.equal(summary.gap, -984900);
});

test("demo batch gap identity: gap + unquotedPaidTotal is the negated delta sum", () => {
  const batch = demoBatch();
  const summary = summarizeTaskSettlements(batch);
  // DEMO-005 is the only mismatch: delta -249.5 major = -24950
  // minor, so the negated delta sum is +24950 minor units.
  const deltaSumMinor = batch
    .map((t) => payoutMismatch(t))
    .filter((m) => m !== undefined)
    .reduce((sum, m) => sum + Math.round(m.delta * 100), 0);
  assert.equal(deltaSumMinor, -24950);
  assert.equal(summary.gap + summary.unquotedPaidTotal, -deltaSumMinor);
});

test("empty batch is an all-zero summary", () => {
  assert.deepEqual(summarizeTaskSettlements([]), {
    tasks: 0,
    paid: 0,
    quotedTotal: 0,
    paidTotal: 0,
    gap: 0,
    mismatched: 0,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  });
});

test("two unquoted PAID tasks split their settled money out of the gap", () => {
  const tasks = [
    toPaid("u-a", { paid: 90 }),
    toPaid("u-b", { paid: 60 }),
    toPaid("q-a", { quoted: 100, paid: 100 }),
  ];
  const summary = summarizeTaskSettlements(tasks);
  assert.deepEqual(summary, {
    tasks: 3,
    paid: 3,
    quotedTotal: 10000,
    paidTotal: 25000,
    gap: -15000,
    mismatched: 0,
    unquotedPaid: 2,
    unquotedPaidTotal: 15000,
  });
  // No mismatch anywhere, so the gap is exactly the negated
  // unquoted settled total.
  assert.equal(summary.gap, -summary.unquotedPaidTotal);
});

test("all-quoted batch: gap is exactly the negated delta sum", () => {
  const tasks = [
    toPaid("m-a", { quoted: 300, paid: 280 }),
    toPaid("m-b", { quoted: 250, paid: 260 }),
    toPaid("m-c", { quoted: 175, paid: 175 }),
  ];
  const summary = summarizeTaskSettlements(tasks);
  assert.deepEqual(summary, {
    tasks: 3,
    paid: 3,
    quotedTotal: 72500,
    paidTotal: 71500,
    gap: 1000,
    mismatched: 2,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  });
  const deltaSumMinor = tasks
    .map((t) => payoutMismatch(t))
    .filter((m) => m !== undefined)
    .reduce((sum, m) => sum + Math.round(m.delta * 100), 0);
  assert.equal(deltaSumMinor, -1000);
  assert.equal(summary.gap, -deltaSumMinor);
});

test("rejected and in-flight tasks never enter the money figures", () => {
  const inFlight = toOpen("in-flight");
  inFlight.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 888 });
  const rejected = toRejected("rejected", 9999);
  const paid = toPaid("paid", { quoted: 50, paid: 50 });
  const summary = summarizeTaskSettlements([inFlight, rejected, paid]);
  assert.deepEqual(summary, {
    tasks: 3,
    paid: 1,
    quotedTotal: 5000,
    paidTotal: 5000,
    gap: 0,
    mismatched: 0,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  });
});

test("minor units stay integers: 0.1 + 0.2 never leaks a float", () => {
  // 0.1 + 0.2 is 0.30000000000000004 in binary floats; the summary
  // must report exactly 30 minor units, never a fractional cent.
  const tasks = [
    toPaid("f-a", { quoted: 0.1, paid: 0.1 }),
    toPaid("f-b", { quoted: 0.2, paid: 0.2 }),
    toPaid("f-c", { quoted: 0.1, paid: 0.2 }),
  ];
  const summary = summarizeTaskSettlements(tasks);
  assert.deepEqual(summary, {
    tasks: 3,
    paid: 3,
    quotedTotal: 40,
    paidTotal: 50,
    gap: -10,
    mismatched: 1,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  });
  for (const value of [
    summary.quotedTotal,
    summary.paidTotal,
    summary.gap,
    summary.unquotedPaidTotal,
  ]) {
    assert.equal(Number.isInteger(value), true);
  }
});

test("PAID task with a quote but no recorded payout is neither mismatched nor unquoted", () => {
  const tasks = [
    toPaid("no-payout", { quoted: 100 }),
    toPaid("settled", { quoted: 100, paid: 100 }),
  ];
  const summary = summarizeTaskSettlements(tasks);
  assert.deepEqual(summary, {
    tasks: 2,
    paid: 2,
    quotedTotal: 20000,
    paidTotal: 10000,
    gap: 10000,
    mismatched: 0,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  });
});

test("PAID task settled exactly as quoted is not mismatched", () => {
  const tasks = [toPaid("exact", { quoted: 2500, paid: 2500 })];
  const summary = summarizeTaskSettlements(tasks);
  assert.equal(summary.mismatched, 0);
  assert.equal(summary.gap, 0);
});

test("legacy 1e308 quote restores but the summary throws instead of returning Infinity", () => {
  const legacy = legacyQuotedViaSnapshot("legacy-giant", 1e308);
  assert.equal(legacy.state, "PAID");
  assert.throws(
    () => summarizeTaskSettlements([legacy]),
    /task settlements summary computation overflowed: inputs too large/,
  );
});

test("overflow throws regardless of batch position, never a partial summary", () => {
  const normal = toPaid("normal-first", { quoted: 100, paid: 100 });
  const giant = legacyQuotedViaSnapshot("giant-second", 1e308);
  assert.throws(
    () => summarizeTaskSettlements([normal, giant]),
    /task settlements summary computation overflowed: inputs too large/,
  );
  assert.throws(
    () => summarizeTaskSettlements([giant, normal]),
    /task settlements summary computation overflowed: inputs too large/,
  );
});

test("the summary is pure: input tasks are untouched", () => {
  const batch = demoBatch();
  const before = batch.map((t) => JSON.stringify(t.toJSON()));
  summarizeTaskSettlements(batch);
  const after = batch.map((t) => JSON.stringify(t.toJSON()));
  assert.deepEqual(after, before);
});
