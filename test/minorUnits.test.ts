import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  fromMinorUnits,
  toMinorUnits,
  totalPaidOut,
  verifyPayoutWebhook,
} from "../src/index.js";
import type { TaskHistoryEntry } from "../src/index.js";

/**
 * Integer minor-unit denomination (backlog #558).
 *
 * The write entry is the gate: `dispatch()` now rejects payout/quoted
 * amounts with more than 2 decimal places — sub-cent precision cannot
 * be stored as integer cents, and silently keeping it is how
 * binary-float drift accumulates in batch totals. `totalPaidOut()`
 * accumulates integer minor units instead of summing floats. The read
 * side is deliberately untouched: a legacy history (or webhook payload)
 * carrying a float amount still parses, builds, and verifies — only new
 * writes are gated.
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

/** Drive a task all the way to PAID with the given settled amount. */
function paidTask(id: string, payoutAmount: number): TaskLifecycle {
  const t = toPayoutRequested(id);
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount });
  return t;
}

test("toMinorUnits converts major units to integer cents", () => {
  assert.equal(toMinorUnits(10098.5), 1009850);
  assert.equal(toMinorUnits(0.1), 10);
  assert.equal(toMinorUnits(19.99), 1999);
  assert.equal(toMinorUnits(0), 0);
  assert.equal(toMinorUnits(2500), 250000);
  // Legacy sub-cent input rounds to the nearest cent, never throws:
  // the converter is for reading old data, the gate lives in dispatch.
  assert.equal(toMinorUnits(0.333), 33);
  // The double nearest 10.005 sits just above the half-cent boundary,
  // so it rounds up to 1001 — the converter follows Math.round, and
  // dispatch still rejects 10.005 (1001 cents back is 10.01, not 10.005).
  assert.equal(toMinorUnits(10.005), 1001);
});

test("fromMinorUnits converts integer cents back and rejects fractions", () => {
  assert.equal(fromMinorUnits(1009850), 10098.5);
  assert.equal(fromMinorUnits(0), 0);
  assert.equal(fromMinorUnits(250000), 2500);
  assert.equal(fromMinorUnits(toMinorUnits(3750.5)), 3750.5);
  assert.throws(
    () => fromMinorUnits(10.5),
    /minor units must be an integer, got 10\.5/,
  );
  assert.throws(
    () => fromMinorUnits(Number.NaN),
    /minor units must be an integer, got NaN/,
  );
});

test("dispatch rejects sub-cent payoutAmount and leaves no trace", () => {
  for (const amount of [3750.555, 10.005, 0.001, 1234.567]) {
    const t = toPayoutRequested(`sub-cent-${amount}`);
    const before = t.history.length;
    assert.throws(
      () =>
        t.dispatch("PAYOUT_COMPLETE", {
          actor: "system",
          payoutAmount: amount,
        }),
      /invalid dispatch options: payoutAmount must be a minor-unit amount \(at most 2 decimal places\), got /,
      `expected ${amount} to be rejected`,
    );
    assert.equal(t.history.length, before);
    assert.equal(t.state, "PAYOUT_PENDING");
    // A corrected retry with a minor-unit amount still succeeds.
    t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 1 });
    assert.equal(t.state, "PAID");
  }
});

test("dispatch rejects sub-cent quotedAmount and leaves no trace", () => {
  for (const amount of [100.999, 0.001]) {
    const t = new TaskLifecycle(`sub-cent-quote-${amount}`);
    t.dispatch("PUBLISH", { actor: "researcher" });
    assert.throws(
      () =>
        t.dispatch("ACCEPT", {
          actor: "contributor",
          quotedAmount: amount,
        }),
      /invalid dispatch options: quotedAmount must be a minor-unit amount \(at most 2 decimal places\), got /,
      `expected ${amount} to be rejected`,
    );
    assert.equal(t.history.length, 1);
    assert.equal(t.state, "OPEN");
  }
});

test("dispatch still accepts 2-decimal amounts verbatim", () => {
  const t = toPayoutRequested("two-decimals");
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 19.99 });
  assert.equal(t.history[t.history.length - 1].payoutAmount, 19.99);
  const q = new TaskLifecycle("two-decimal-quote");
  q.dispatch("PUBLISH", { actor: "researcher" });
  q.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 0.29 });
  assert.equal(q.history[q.history.length - 1].quotedAmount, 0.29);
});

test("totalPaidOut accumulates integer minor units (demo 16349 scenario)", () => {
  // The demo's three PAID tasks: 10098.5 + 2500 + 3750.5 = 16349.
  // Summed as integer cents (1009850 + 250000 + 375050) the result is
  // exact by construction — no float addition is involved at all.
  const tasks = [
    paidTask("demo-a", 10098.5),
    paidTask("demo-b", 2500),
    paidTask("demo-c", 3750.5),
  ];
  assert.equal(totalPaidOut(tasks), 16349);
  assert.equal(
    toMinorUnits(10098.5) + toMinorUnits(2500) + toMinorUnits(3750.5),
    1634900,
  );
});

test("totalPaidOut sums many small amounts without float drift", () => {
  // Ten 0.07 payouts: float addition gives 0.7000000000000001, and a
  // hundred 0.01 payouts give 1.0000000000000002 — integer cents give
  // exactly 0.70 and 1.00.
  const seventies = Array.from({ length: 10 }, (_, i) =>
    paidTask(`cent-${i}`, 0.07),
  );
  assert.equal(totalPaidOut(seventies), 0.7);
  const pennies = Array.from({ length: 100 }, (_, i) =>
    paidTask(`penny-${i}`, 0.01),
  );
  assert.equal(totalPaidOut(pennies), 1);
});

test("legacy float history still parses and its webhook still verifies", () => {
  // A pre-gate audit log: strip the hash chain (legacy, hashless) and
  // carry a sub-cent amount dispatch() would now reject. The read side
  // must not break: fromHistory accepts it, totalPaidOut rounds the
  // entry to the nearest cent, and the webhook built from it carries
  // the verbatim float amount and verifies under the same secret.
  const live = paidTask("legacy-float", 100);
  const history: TaskHistoryEntry[] = live.history.map((entry) => {
    const { prevHash: _prevHash, hash: _hash, ...rest } = entry;
    return rest;
  });
  const last = history[history.length - 1];
  last.payoutAmount = 1234.567;
  const legacy = TaskLifecycle.fromHistory("legacy-float", history);
  assert.equal(legacy.state, "PAID");
  assert.equal(totalPaidOut([legacy]), 1234.57);
  const secret = "legacy-webhook-secret";
  const webhook = buildPayoutWebhook(legacy, secret, {
    now: "2026-10-24T10:00:00.000Z",
    eventId: "evt-legacy-1",
  });
  assert.equal(webhook.payload.payoutAmount, 1234.567);
  assert.equal(
    verifyPayoutWebhook(
      JSON.stringify(webhook.payload),
      webhook.signature,
      secret,
    ),
    true,
  );
});
