import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  fromMinorUnits,
  toMinorUnits,
  totalPaidOut,
  type TaskHistoryEntry,
} from "../src/index.js";

/**
 * `toMinorUnits` rejects non-finite input (backlog #844).
 *
 * The gap: the converter was `Math.round(amount * 100)` with no
 * finiteness check, so `toMinorUnits(1e308)` silently returned
 * `Infinity` (`Math.round(Infinity)`) and any caller downstream of
 * the conversion — reconciliation, formatting, a caller computing
 * its own total — could carry that `Infinity` onward. Backlog #838
 * only hardened `totalPaidOut`'s own accumulation; this item closes
 * the conversion function itself, the one link the #838 fix left
 * open. `parseHistory`'s legacy acceptance is deliberately NOT
 * tightened: an old log carrying `1e308` still parses; only
 * converting it (here) or summing it (`totalPaidOut`) fails, loudly.
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

const CONVERSION_OVERFLOW = /minor units conversion overflowed/;

test("toMinorUnits rejects a finite input whose minor-unit product overflows", () => {
  assert.throws(() => toMinorUnits(1e308), CONVERSION_OVERFLOW);
  assert.throws(() => toMinorUnits(-1e308), CONVERSION_OVERFLOW);
  // The message names the overflow, not a generic failure.
  assert.throws(
    () => toMinorUnits(1e308),
    /minor units conversion overflowed: 1e\+308 is too large to represent in minor units/,
  );
});

test("toMinorUnits rejects non-finite input", () => {
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => toMinorUnits(bad), CONVERSION_OVERFLOW);
  }
  assert.throws(
    () => toMinorUnits(Number.NaN),
    /minor units conversion overflowed: amount must be a finite number, got NaN/,
  );
  assert.throws(
    () => toMinorUnits(Infinity),
    /minor units conversion overflowed: amount must be a finite number, got Infinity/,
  );
});

test("large-but-finite amounts still convert exactly", () => {
  // 1e15 majors = 1e17 cents, still exactly representable; the
  // #838 accumulation case (1.7e306 -> finite 1.7e308 cents) also
  // still converts, so the per-addition check keeps its job.
  assert.equal(toMinorUnits(1e15), 1e17);
  assert.equal(toMinorUnits(-1e15), -1e17);
  assert.equal(Number.isFinite(toMinorUnits(1.7e306)), true);
});

test("normal and negative amounts round-trip unchanged", () => {
  assert.equal(toMinorUnits(19.99), 1999);
  assert.equal(toMinorUnits(-42.25), -4225);
  assert.equal(toMinorUnits(0), 0);
  assert.equal(toMinorUnits(0.333), 33);
  for (const amount of [10098.5, 2500, 3750.5, 0.07, -19.99]) {
    assert.equal(fromMinorUnits(toMinorUnits(amount)), amount);
  }
});

test("a throwing conversion returns no partial result", () => {
  // The throw is the whole outcome: there is no sentinel value a
  // caller could mistake for a total, and a failed conversion leaves
  // no state behind to inspect.
  let seen: unknown = "not called";
  try {
    seen = toMinorUnits(1e308);
  } catch (error) {
    assert.match((error as Error).message, CONVERSION_OVERFLOW);
  }
  assert.equal(seen, "not called");
});

test("totalPaidOut keeps its own overflow message for a legacy giant entry", () => {
  // Contract translation, not a weakening: #844 makes the converter
  // throw first, so `totalPaidOut` maps that failure back onto its
  // documented #838 message instead of leaking the converter's one.
  const live = toPayoutRequested("legacy-giant-total");
  live.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 100 });
  const history: TaskHistoryEntry[] = live.history.map((entry) => {
    const { prevHash: _prevHash, hash: _hash, ...rest } = entry;
    return rest;
  });
  history[history.length - 1].payoutAmount = 1e308;
  const legacy = TaskLifecycle.fromHistory("legacy-giant-total", history);
  assert.equal(legacy.state, "PAID");
  assert.throws(
    () => totalPaidOut([legacy]),
    /total paid out computation overflowed: inputs too large/,
  );
});
