import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  mismatchedPayouts,
  payoutMismatch,
  toMinorUnits,
  totalPaidOut,
  totalQuoted,
  type TaskHistoryEntry,
} from "../src/index.js";

/**
 * `totalQuoted(tasks)` (backlog #919): the batch owed total, the pair
 * of `totalPaidOut` and the batch form of the owed half that
 * `payoutMismatch` compares per task. Until now a caller doing
 * batch quoted-vs-settled reconciliation had to hand-scan every
 * task's history for its last `ACCEPT` entry a third time (the same
 * derivation already lives in `payoutMismatch` and in the payout
 * webhook builder), and the two existing derivations could drift.
 *
 * Rules under test, mirroring `totalPaidOut` exactly:
 *  - only `PAID` tasks contribute; a quote on an in-flight or
 *    otherwise-terminated task never enters the total
 *  - the quote is read from the LAST `ACCEPT` entry; a `quotedAmount`
 *    recorded on any other event is ignored (the field is generic
 *    dispatch metadata, so the scan must not mistake a stray quote
 *    for the agreed price)
 *  - a `PAID` task whose last `ACCEPT` carries no quote contributes 0
 *  - the total accumulates in integer minor units and returns major
 *    units, so no float error accumulates
 *  - overflow is fail-fast with `total quoted computation overflowed:
 *    inputs too large`, never a silent `Infinity`
 *  - `totalQuoted(tasks) - totalPaidOut(tasks)` equals the sum of
 *    `quoted - paid` over the tasks `mismatchedPayouts` flags
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

/**
 * Rehydrate a PAID task whose `ACCEPT` entry carries a legacy quote
 * `dispatch()` would reject, via the hashless-snapshot path: strip
 * the hash chain (legacy, hashless) and overwrite the quote, then
 * restore through `fromJSON`. The restore itself must succeed — the
 * overflow gate lives in `totalQuoted`, not in the snapshot reader.
 * (Same technique as `totalPaidOutOverflow.test.ts`, for the quote.)
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

/** Same legacy shape, restored through `fromHistory` instead. */
function legacyQuotedViaHistory(id: string, quote: number): TaskLifecycle {
  const live = toPaid(id, { quoted: 100, paid: 100 });
  const history: TaskHistoryEntry[] = live.history.map((entry) => {
    const { prevHash: _prevHash, hash: _hash, ...rest } = entry;
    return rest;
  });
  history.find((e) => e.event === "ACCEPT")!.quotedAmount = quote;
  const revived = TaskLifecycle.fromHistory(id, history);
  assert.equal(revived.state, "PAID");
  return revived;
}

const OVERFLOW = /total quoted computation overflowed: inputs too large/;

test("totalQuoted sums the last ACCEPT quote across PAID tasks", () => {
  const tasks = [
    toPaid("q-a", { quoted: 10098.5, paid: 10098.5 }),
    toPaid("q-b", { quoted: 531.5, paid: 500 }),
    toPaid("q-c", { quoted: 2500, paid: 2500 }),
    toPaid("q-d", { quoted: 3750.5, paid: 3750.5 }),
  ];
  assert.equal(totalQuoted(tasks), 16880.5);
  assert.equal(totalQuoted([tasks[0]]), 10098.5);
});

test("PAID task whose ACCEPT carries no quote contributes 0", () => {
  const noQuote = toPaid("no-quote", { paid: 90 });
  assert.equal(totalQuoted([noQuote]), 0);
  assert.equal(
    totalQuoted([toPaid("with-quote", { quoted: 100, paid: 90 }), noQuote]),
    100,
  );
});

test("non-PAID tasks are excluded even when they carry a quote", () => {
  const inFlight = toOpen("in-flight");
  inFlight.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 100 });
  const abandoned = toOpen("abandoned");
  abandoned.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 200 });
  abandoned.dispatch("ABANDON", { actor: "contributor" });
  const paid = toPaid("paid", { quoted: 50, paid: 50 });
  assert.equal(totalQuoted([inFlight, abandoned, paid]), 50);
  assert.equal(totalQuoted([inFlight, abandoned]), 0);
});

test("empty input returns 0", () => {
  assert.equal(totalQuoted([]), 0);
});

test("a quotedAmount on a non-ACCEPT entry is ignored", () => {
  // quotedAmount is generic dispatch metadata, so it can land on any
  // event; only the ACCEPT entry is the agreed price.
  const t = toOpen("stray-quote");
  t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 100 });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutAmount: 100,
    quotedAmount: 999,
  });
  assert.equal(t.history.find((e) => e.event === "ACCEPT")?.quotedAmount, 100);
  assert.equal(
    t.history.find((e) => e.event === "PAYOUT_COMPLETE")?.quotedAmount,
    999,
  );
  assert.equal(totalQuoted([t]), 100);
});

test("a second ACCEPT is impossible through the live machine, so last-wins is by construction", () => {
  // parseHistory enforces the transition table and the table has no
  // ACCEPT edge out of ACCEPTED, so no valid history can hold two
  // ACCEPT entries. The last-wins scan in totalQuoted therefore
  // always reads the task's single agreed price; this pins the
  // premise instead of leaving it implicit.
  const t = toOpen("one-accept");
  t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 100 });
  assert.throws(
    () =>
      t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 200 }),
    /invalid transition: ACCEPT from ACCEPTED/,
  );
  assert.equal(t.history.filter((e) => e.event === "ACCEPT").length, 1);
  assert.equal(
    totalQuoted([toPaid("one-accept-paid", { quoted: 100, paid: 100 })]),
    100,
  );
});

test("legacy 1e308 quote restores but totalQuoted throws instead of returning Infinity", () => {
  const legacy = legacyQuotedViaSnapshot("legacy-giant", 1e308);
  assert.equal(legacy.state, "PAID");
  assert.throws(() => totalQuoted([legacy]), OVERFLOW);
});

test("legacy 1e308 quote via fromHistory throws the same overflow error", () => {
  const legacy = legacyQuotedViaHistory("legacy-giant-history", 1e308);
  assert.throws(() => totalQuoted([legacy]), OVERFLOW);
});

test("overflow throws regardless of batch position, never a partial total", () => {
  const normal = toPaid("normal-first", { quoted: 100, paid: 100 });
  const giant = legacyQuotedViaSnapshot("giant-second", 1e308);
  assert.throws(() => totalQuoted([normal, giant]), OVERFLOW);
  assert.throws(() => totalQuoted([giant, normal]), OVERFLOW);
  assert.throws(
    () =>
      totalQuoted([normal, giant, toPaid("after", { quoted: 50, paid: 50 })]),
    OVERFLOW,
  );
});

test("accumulation-only overflow throws: individually finite quotes whose sum overflows", () => {
  // Each 1.7e306 converts to a finite 1.7e308 minor units; only their
  // sum (3.4e308) overflows. This pins the per-addition check, not
  // just the single-entry conversion.
  assert.equal(Number.isFinite(toMinorUnits(1.7e306)), true);
  const a = legacyQuotedViaSnapshot("accum-a", 1.7e306);
  const b = legacyQuotedViaSnapshot("accum-b", 1.7e306);
  assert.throws(() => totalQuoted([a, b]), OVERFLOW);
});

test("totalQuoted minus totalPaidOut equals the summed per-task quoted-minus-paid gap", () => {
  // Only tasks carrying BOTH amounts can be compared per task, so
  // the identity is pinned on a batch where every task has both:
  // the batch gap is then exactly the sum of the per-task gaps.
  // (A quoteless or unpaid task still counts in the batch totals —
  // see the 0-contribution tests above — but payoutMismatch cannot
  // see it, so it is outside this identity by construction.)
  const tasks = [
    toPaid("gap-under", { quoted: 100, paid: 80 }),
    toPaid("gap-over", { quoted: 50, paid: 60 }),
    toPaid("gap-exact", { quoted: 70, paid: 70 }),
  ];
  // Quoted side: 100 + 50 + 70 = 220. Paid side: 80 + 60 + 70 = 210.
  assert.equal(totalQuoted(tasks), 220);
  assert.equal(totalPaidOut(tasks), 210);
  assert.equal(totalQuoted(tasks) - totalPaidOut(tasks), 10);
  // The same 10 as the sum of (quoted - paid) over the tasks the
  // mismatch screen flags — each payoutMismatch delta is paid -
  // quoted, so the batch gap is the negated sum of the deltas.
  const flagged = mismatchedPayouts(tasks);
  assert.deepEqual(
    flagged.map((t) => t.id),
    ["gap-under", "gap-over"],
  );
  const gapSum = flagged.reduce(
    (sum, t) => sum + (payoutMismatch(t)!.quoted - payoutMismatch(t)!.paid),
    0,
  );
  assert.equal(gapSum, 10);
  const deltaSum = flagged.reduce(
    (sum, t) => sum + payoutMismatch(t)!.delta,
    0,
  );
  assert.equal(totalQuoted(tasks) - totalPaidOut(tasks), -deltaSum);
});

test("multi-task sums stay exact to the cent", () => {
  const seventies = Array.from({ length: 10 }, (_, i) =>
    toPaid(`cent-${i}`, { quoted: 0.07, paid: 0.07 }),
  );
  assert.equal(totalQuoted(seventies), 0.7);
  const pennies = Array.from({ length: 100 }, (_, i) =>
    toPaid(`penny-${i}`, { quoted: 0.01, paid: 0.01 }),
  );
  assert.equal(totalQuoted(pennies), 1);
  assert.equal(
    totalQuoted([
      toPaid("demo-a", { quoted: 10098.5, paid: 10098.5 }),
      toPaid("demo-b", { quoted: 2500, paid: 2500 }),
      toPaid("demo-c", { quoted: 3750.5, paid: 3750.5 }),
    ]),
    16349,
  );
});

test("totalQuoted is pure and works on rehydrated tasks", () => {
  const t = toPaid("revived", { quoted: 42.25, paid: 42.25 });
  const revived = TaskLifecycle.fromJSON(t.toJSON());
  assert.equal(totalQuoted([revived]), 42.25);
  const before = JSON.stringify(t.toJSON());
  totalQuoted([t]);
  assert.equal(JSON.stringify(t.toJSON()), before);
});

test("large-but-finite quotes still sum legally", () => {
  const legacy = legacyQuotedViaSnapshot("large-finite", 1e15);
  assert.equal(totalQuoted([legacy]), 1e15);
  assert.equal(
    totalQuoted([
      toPaid("big-a", { quoted: 1e15, paid: 1e15 }),
      toPaid("big-b", { quoted: 2e15, paid: 2e15 }),
    ]),
    3e15,
  );
});

test("non-PAID tasks never trigger the overflow gate", () => {
  // An in-flight task carrying a giant quote as generic audit
  // metadata (not a settled quote) must not poison the batch:
  // only PAID tasks contribute, so the gate never sees it.
  const live = toOpen("in-flight-giant");
  live.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 100 });
  const history: TaskHistoryEntry[] = live.history.map((entry) => {
    const { prevHash: _prevHash, hash: _hash, ...rest } = entry;
    return rest;
  });
  history[history.length - 1].quotedAmount = 1e308;
  const inFlight = TaskLifecycle.fromHistory("in-flight-giant", history);
  assert.equal(inFlight.state, "ACCEPTED");
  assert.equal(
    totalQuoted([inFlight, toPaid("normal", { quoted: 42.25, paid: 42.25 })]),
    42.25,
  );
});
