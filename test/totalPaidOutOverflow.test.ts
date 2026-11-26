import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  totalPaidOut,
  type TaskHistoryEntry,
} from "../src/index.js";

/**
 * `totalPaidOut` overflow fail-fast (backlog #838, the read-side
 * mirror of escrow #837's `settleRelease` overflow fix).
 *
 * The gap: `dispatch()` cannot write a giant amount — its minor-unit
 * round-trip gate rejects `1e308` — but a legacy snapshot only checks
 * that `payoutAmount` is finite and ≥ 0. A legacy `1e308` entry
 * therefore rehydrates fine, and `totalPaidOut` summed it through
 * `toMinorUnits` (`Math.round(1e308 * 100)` = `Infinity`) and
 * returned `Infinity`, silently poisoning a reconciliation total.
 *
 * The fix is read-side only: `totalPaidOut` throws
 * `total paid out computation overflowed: inputs too large` instead
 * of returning `Infinity`. Legacy acceptance is deliberately NOT
 * tightened — old audit logs stay readable; only summing them fails,
 * loudly (the same scope split as #558's legacy-acceptance note).
 */

/** Drive a task from DRAFT to the payout request step. */
function toPayoutRequested(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  return t;
}

function paidTask(id: string, amount: number): TaskLifecycle {
  const t = toPayoutRequested(id);
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: amount });
  return t;
}

/**
 * Rehydrate a PAID task whose `PAYOUT_COMPLETE` entry carries a
 * legacy amount `dispatch()` would reject, via the hashless-snapshot
 * path: strip the hash chain (legacy, hashless) and overwrite the
 * amount, then restore through `fromJSON`. The restore itself must
 * succeed — the overflow gate lives in `totalPaidOut`, not in the
 * snapshot reader.
 */
function legacyPaidViaSnapshot(id: string, amount: number): TaskLifecycle {
  const live = paidTask(id, 100);
  const snapshot = live.toJSON();
  for (const entry of snapshot.history) {
    delete (entry as Partial<TaskHistoryEntry>).prevHash;
    delete (entry as Partial<TaskHistoryEntry>).hash;
  }
  snapshot.history[snapshot.history.length - 1].payoutAmount = amount;
  const revived = TaskLifecycle.fromJSON(snapshot);
  assert.equal(revived.state, "PAID");
  return revived;
}

/** Same legacy shape, restored through `fromHistory` instead. */
function legacyPaidViaHistory(id: string, amount: number): TaskLifecycle {
  const live = paidTask(id, 100);
  const history: TaskHistoryEntry[] = live.history.map((entry) => {
    const { prevHash: _prevHash, hash: _hash, ...rest } = entry;
    return rest;
  });
  history[history.length - 1].payoutAmount = amount;
  const revived = TaskLifecycle.fromHistory(id, history);
  assert.equal(revived.state, "PAID");
  return revived;
}

const OVERFLOW = /total paid out computation overflowed: inputs too large/;

test("legacy 1e308 snapshot restores but totalPaidOut throws instead of returning Infinity", () => {
  const legacy = legacyPaidViaSnapshot("legacy-giant", 1e308);
  assert.equal(legacy.state, "PAID");
  assert.throws(() => totalPaidOut([legacy]), OVERFLOW);
});

test("legacy 1e308 via fromHistory throws the same overflow error", () => {
  const legacy = legacyPaidViaHistory("legacy-giant-history", 1e308);
  assert.throws(() => totalPaidOut([legacy]), OVERFLOW);
});

test("overflow throws regardless of batch position, never a partial total", () => {
  const normal = paidTask("normal-first", 100);
  const giant = legacyPaidViaSnapshot("giant-second", 1e308);
  // Giant first or last: the batch throws either way — the caller
  // never sees the normal task's 100 as a "partial total".
  assert.throws(() => totalPaidOut([normal, giant]), OVERFLOW);
  assert.throws(() => totalPaidOut([giant, normal]), OVERFLOW);
  assert.throws(() => totalPaidOut([normal, giant, paidTask("after", 50)]), OVERFLOW);
});

test("accumulation-only overflow throws: individually safe amounts whose sum overflows", () => {
  // Each 90071992547409.91 converts to a safe 9007199254740990 minor
  // units; only their sum (18014398509481980) passes
  // MAX_SAFE_INTEGER. This pins the per-addition safe-integer check,
  // not just the single-entry conversion. Since backlog #1423 the
  // accumulation boundary is the safe range, not the finite range —
  // the old 1.7e306 pinning belonged to the finite-only contract and
  // now throws at the conversion itself instead.
  const a = paidTask("accum-a", 90071992547409.91);
  const b = paidTask("accum-b", 90071992547409.91);
  assert.throws(() => totalPaidOut([a, b]), OVERFLOW);
});

test("normal batch totals are unchanged", () => {
  const tasks = [
    paidTask("n-a", 10098.5),
    paidTask("n-b", 531.5),
    paidTask("n-c", 0.1),
    paidTask("n-d", 0.2),
  ];
  assert.equal(totalPaidOut(tasks), 10630.3);
});

test("empty and unrecorded batches still return 0", () => {
  assert.equal(totalPaidOut([]), 0);
  const noAmount = toPayoutRequested("no-amount");
  noAmount.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(totalPaidOut([noAmount]), 0);
});

test("multi-task sums stay exact to the cent", () => {
  const seventies = Array.from({ length: 10 }, (_, i) =>
    paidTask(`cent-${i}`, 0.07),
  );
  assert.equal(totalPaidOut(seventies), 0.7);
  const pennies = Array.from({ length: 100 }, (_, i) =>
    paidTask(`penny-${i}`, 0.01),
  );
  assert.equal(totalPaidOut(pennies), 1);
  assert.equal(
    totalPaidOut([
      paidTask("demo-a", 10098.5),
      paidTask("demo-b", 2500),
      paidTask("demo-c", 3750.5),
    ]),
    16349,
  );
});

test("large-but-safe amounts still sum legally", () => {
  // 1e13 majors is 1e15 cents, inside the safe range; the old 1e15
  // pinning belonged to the finite-only contract, which backlog
  // #1423 supersedes (1e15 majors would be 1e17 cents, past
  // MAX_SAFE_INTEGER, so it now throws at the conversion).
  const legacy = legacyPaidViaSnapshot("large-finite", 1e13);
  assert.equal(totalPaidOut([legacy]), 1e13);
  assert.equal(
    totalPaidOut([paidTask("big-a", 1e13), paidTask("big-b", 2e13)]),
    3e13,
  );
});

test("non-PAID tasks never trigger the overflow gate", () => {
  // An in-flight task carrying a giant amount as generic audit
  // metadata (not a settled payout) must not poison the batch:
  // only PAID tasks contribute, so the gate never sees it.
  const live = toPayoutRequested("in-flight-giant");
  const history: TaskHistoryEntry[] = live.history.map((entry) => {
    const { prevHash: _prevHash, hash: _hash, ...rest } = entry;
    return rest;
  });
  history[history.length - 1].payoutAmount = 1e308;
  const inFlight = TaskLifecycle.fromHistory("in-flight-giant", history);
  assert.equal(inFlight.state, "PAYOUT_PENDING");
  assert.equal(totalPaidOut([inFlight, paidTask("normal", 42.25)]), 42.25);
});
