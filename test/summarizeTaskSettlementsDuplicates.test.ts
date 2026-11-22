import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  summarizeTaskSettlements,
  type TaskHistoryEntry,
  type TaskSettlementsSummary,
} from "../src/index.js";

/**
 * `summarizeTaskSettlements` duplicate-task guard (backlog #1324):
 * a task id appearing twice in the batch throws
 * `invalid summarizeTaskSettlements: duplicate task "<id>"` and
 * returns no summary — the same task counted twice would double its
 * quote and its settled amount in the totals, and a non-`PAID`
 * duplicate would still inflate the `tasks` count.
 *
 * Rules under test (decided this round, aligned with the escrow-side
 * `summarizeSettlementReports` rule, backlog #1268, and this repo's
 * own `reconcilePayouts` duplicate-task pre-scan, backlog #1253):
 *  - the check covers every task regardless of state — a duplicated
 *    non-`PAID` task is rejected too, because every task in the
 *    batch enters the `tasks` count
 *  - the check runs before any figure is summed, so a batch carrying
 *    both a duplicate and an overflowing amount reports the
 *    duplicate, not the overflow
 *  - distinct tasks summarize exactly as before (regression)
 *  - an empty batch and a single task are unchanged
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

/**
 * Rehydrate a PAID task whose `ACCEPT` entry carries a legacy quote
 * `dispatch()` would reject, via the hashless-snapshot path (same
 * technique as `summarizeTaskSettlements.test.ts`, for the quote).
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

test("the same PAID task object passed twice throws, naming the id", () => {
  const t = toPaid("dup-a", { quoted: 100, paid: 100 });
  assert.throws(
    () => summarizeTaskSettlements([t, t]),
    /invalid summarizeTaskSettlements: duplicate task "dup-a"/,
  );
});

test("two distinct PAID objects sharing one task id throw", () => {
  const a = toPaid("dup-a", { quoted: 100, paid: 100 });
  const b = toPaid("dup-a", { quoted: 100, paid: 100 });
  assert.notEqual(a, b);
  assert.throws(
    () => summarizeTaskSettlements([a, b]),
    /invalid summarizeTaskSettlements: duplicate task "dup-a"/,
  );
});

test("duplicate non-PAID tasks throw too: the tasks count would inflate", () => {
  // Neither task is PAID, so neither contributes money — but each
  // would still add 1 to `tasks`, so the duplicate is rejected the
  // same way a PAID duplicate is.
  const a = toOpen("dup-open");
  const b = toOpen("dup-open");
  assert.throws(
    () => summarizeTaskSettlements([a, b]),
    /invalid summarizeTaskSettlements: duplicate task "dup-open"/,
  );
  const expiredA = toExpired("dup-expired");
  const expiredB = toExpired("dup-expired");
  assert.throws(
    () => summarizeTaskSettlements([expiredA, expiredB]),
    /invalid summarizeTaskSettlements: duplicate task "dup-expired"/,
  );
});

test("a duplicated PAID task is rejected even beside distinct tasks", () => {
  const tasks = [
    toPaid("ok-a", { quoted: 100, paid: 100 }),
    toPaid("dup-a", { quoted: 50, paid: 50 }),
    toPaid("ok-b", { quoted: 200, paid: 200 }),
    toPaid("dup-a", { quoted: 50, paid: 50 }),
  ];
  assert.throws(
    () => summarizeTaskSettlements(tasks),
    /invalid summarizeTaskSettlements: duplicate task "dup-a"/,
  );
});

test("with two duplicated ids the first repeated id is named", () => {
  const tasks = [
    toPaid("dup-a", { quoted: 100, paid: 100 }),
    toPaid("dup-b", { quoted: 100, paid: 100 }),
    toPaid("dup-a", { quoted: 100, paid: 100 }),
    toPaid("dup-b", { quoted: 100, paid: 100 }),
  ];
  assert.throws(
    () => summarizeTaskSettlements(tasks),
    /invalid summarizeTaskSettlements: duplicate task "dup-a"/,
  );
});

test("distinct tasks summarize exactly as before (regression)", () => {
  const tasks = [
    toPaid("m-a", { quoted: 300, paid: 280 }),
    toPaid("m-b", { quoted: 250, paid: 260 }),
    toPaid("m-c", { quoted: 175, paid: 175 }),
  ];
  const expected: TaskSettlementsSummary = {
    tasks: 3,
    paid: 3,
    quotedTotal: 72500,
    paidTotal: 71500,
    gap: 1000,
    mismatched: 2,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  };
  assert.deepEqual(summarizeTaskSettlements(tasks), expected);
});

test("empty batch and single task are unchanged", () => {
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
  assert.deepEqual(
    summarizeTaskSettlements([toPaid("solo", { quoted: 100, paid: 90 })]),
    {
      tasks: 1,
      paid: 1,
      quotedTotal: 10000,
      paidTotal: 9000,
      gap: 1000,
      mismatched: 1,
      unquotedPaid: 0,
      unquotedPaidTotal: 0,
    },
  );
});

test("the duplicate check fires before the overflow check", () => {
  // A duplicated PAID task whose quote overflows minor-unit
  // conversion (1e308) would throw the overflow error on its own —
  // but the duplicate pre-scan runs first, so the caller sees the
  // duplicate-task error instead.
  const giant = legacyQuotedViaSnapshot("dup-giant", 1e308);
  assert.throws(
    () => summarizeTaskSettlements([giant]),
    /task settlements summary computation overflowed: inputs too large/,
  );
  assert.throws(
    () => summarizeTaskSettlements([giant, giant]),
    /invalid summarizeTaskSettlements: duplicate task "dup-giant"/,
  );
});
