import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  diffTaskSnapshots,
  isSettlementComplete,
  remainingOwed,
  type TaskLifecycleOptions,
} from "../src/index.js";

/**
 * `requireExactPayout` — opt-in up-front enforcement that a
 * `PAYOUT_COMPLETE` settles exactly the quoted amount (backlog #1425).
 *
 * The advisory `payoutMismatch()` helper only reports a difference
 * after the fact: a task quoted 10000 could settle 0.01 or 999999 and
 * still land in `PAID`, and `isSettlementComplete()` counted any
 * recorded amount as complete. Flipping this switch makes a
 * mismatched settlement a dispatch-time error instead of a
 * reconciliation-time finding, for payout flows where the settled
 * amount must equal the agreed quote to the cent.
 *
 * Rules under test:
 *  - enabled: PAYOUT_COMPLETE whose payoutAmount differs from the
 *    quote on the last ACCEPT entry throws `payout amount mismatch: …`
 *    and leaves no history residue (overpay and underpay alike)
 *  - enabled: an exact settlement passes and is complete under both
 *    the default and the `{ exact: true }` readings
 *  - enabled: a task whose last ACCEPT carries no quote passes — no
 *    quote, nothing to compare against (the same rule payoutMismatch
 *    returns `undefined` under)
 *  - enabled: a missing payoutAmount is the requirePayoutAmount
 *    gate's job, not this one's — with that gate off, a bare
 *    PAYOUT_COMPLETE still lands in PAID
 *  - disabled (default): over- and underpayments still land in PAID,
 *    exactly as before; only the `{ exact: true }` reading flags them
 *  - a rejected dispatch consumes no idempotency key and leaves no
 *    seq gap: the same key retries with the exact amount and succeeds
 *  - the quote is read from the audit history, never from the
 *    dispatch options: smuggling a matching quotedAmount alongside
 *    the payment does not fool the gate
 *  - `remainingOwed(task)` reports `{ quoted, paid, remaining }` in
 *    integer minor units (positive = still owed, 0 = exact,
 *    negative = overpaid), and `undefined` when either amount was
 *    never recorded
 *  - `isSettlementComplete(task, { exact: true })` additionally
 *    requires paid === quoted in minor units; a task with no quote
 *    can never be exactly complete
 *  - non-boolean option values throw `invalid option` at construction
 *  - the switch is task configuration, not audit data, but it IS
 *    written into the toJSON() snapshot when enabled: a gate-off
 *    task's snapshot keeps its legacy shape; fromJSON() restores it
 *    (an explicit opts value overrides the stored value); a legacy
 *    snapshot without the field restores gate-off; fromHistory(id,
 *    history, { requireExactPayout: true }) re-attaches it on a
 *    history-only rebuild; diffTaskSnapshots reports the flip as
 *    `exactPayoutGateChanged`
 */

/** Drive a task from DRAFT to APPROVED, with optional ctor options and quote. */
function toApproved(
  id: string,
  opts?: TaskLifecycleOptions,
  quote?: number,
): TaskLifecycle {
  const t = new TaskLifecycle(id, opts);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", {
    actor: "contributor",
    ...(quote !== undefined ? { quotedAmount: quote } : {}),
  });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

/** DRAFT → … → PAYOUT_PENDING, with optional ctor options and quote. */
function toPayoutPending(
  id: string,
  opts?: TaskLifecycleOptions,
  quote?: number,
): TaskLifecycle {
  const t = toApproved(id, opts, quote);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.equal(t.state, "PAYOUT_PENDING");
  return t;
}

test("enabled: overpayment throws and leaves no trace", () => {
  const t = toPayoutPending(
    "ep-overpay",
    { requireExactPayout: true },
    10000,
  );
  const before = t.history.length;
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
        payoutAmount: 999999,
      }),
    /payout amount mismatch/,
  );
  assert.equal(t.history.length, before);
  assert.equal(t.state, "PAYOUT_PENDING");
});

test("enabled: underpayment throws, including a cent against a large quote and zero", () => {
  const t = toPayoutPending(
    "ep-underpay",
    { requireExactPayout: true },
    10000,
  );
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
        payoutAmount: 0.01,
      }),
    /payout amount mismatch/,
  );
  assert.equal(t.state, "PAYOUT_PENDING");
  assert.equal(t.history.length, 7);

  const zero = toPayoutPending("ep-zero", { requireExactPayout: true }, 100);
  assert.throws(
    () =>
      zero.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-2",
        payoutAmount: 0,
      }),
    /payout amount mismatch/,
  );
  assert.equal(zero.state, "PAYOUT_PENDING");
});

test("enabled: exact settlement passes and is complete under both readings", () => {
  const t = toPayoutPending("ep-exact", { requireExactPayout: true }, 100);
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(t.state, "PAID");
  assert.equal(isSettlementComplete(t), true);
  assert.equal(isSettlementComplete(t, { exact: true }), true);
  assert.deepEqual(remainingOwed(t), {
    quoted: 10000,
    paid: 10000,
    remaining: 0,
  });
});

test("enabled: a task whose last ACCEPT carries no quote passes", () => {
  const t = toPayoutPending("ep-noquote", { requireExactPayout: true });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 123.45,
  });
  assert.equal(t.state, "PAID");
  // Default reading is presence-only, so this still counts as
  // complete; the exact reading can never confirm what was never
  // quoted.
  assert.equal(isSettlementComplete(t), true);
  assert.equal(isSettlementComplete(t, { exact: true }), false);
  assert.equal(remainingOwed(t), undefined);
});

test("enabled: a missing payoutAmount is the requirePayoutAmount gate's job", () => {
  const t = toPayoutPending("ep-noamount", { requireExactPayout: true }, 100);
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutRef: "xfer-1" });
  assert.equal(t.state, "PAID");
});

test("disabled (default): over- and underpayments still land in PAID", () => {
  const over = toPayoutPending("ep-off-over", undefined, 100);
  over.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 999,
  });
  assert.equal(over.state, "PAID");
  assert.equal(isSettlementComplete(over), true);
  assert.equal(isSettlementComplete(over, { exact: true }), false);
  assert.deepEqual(remainingOwed(over), {
    quoted: 10000,
    paid: 99900,
    remaining: -89900,
  });

  const under = toPayoutPending("ep-off-under", undefined, 10000);
  under.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-2",
    payoutAmount: 0.01,
  });
  assert.equal(under.state, "PAID");
  assert.equal(isSettlementComplete(under), true);
  assert.equal(isSettlementComplete(under, { exact: true }), false);
  assert.deepEqual(remainingOwed(under), {
    quoted: 1000000,
    paid: 1,
    remaining: 999999,
  });
});

test("enabled: a rejected dispatch consumes no idempotency key and leaves no seq gap", () => {
  const t = toPayoutPending("ep-key", { requireExactPayout: true }, 100);
  const before = t.history.length;
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
        payoutAmount: 90,
        idempotencyKey: "pay-1",
      }),
    /payout amount mismatch/,
  );
  assert.equal(t.history.length, before);
  // Same key retries with the exact amount and succeeds: the failed
  // attempt consumed nothing.
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
    idempotencyKey: "pay-1",
  });
  assert.equal(t.state, "PAID");
  assert.equal(t.history.length, before + 1);
});

test("enabled: a quotedAmount smuggled alongside the payment does not fool the gate", () => {
  const t = toPayoutPending("ep-smuggle", { requireExactPayout: true }, 100);
  // The payment matches the smuggled quote (90) but not the quote on
  // the ACCEPT entry (100): the gate reads history, not options.
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
        payoutAmount: 90,
        quotedAmount: 90,
      }),
    /payout amount mismatch/,
  );
  assert.equal(t.state, "PAYOUT_PENDING");
});

test("remainingOwed: undefined when either amount was never recorded", () => {
  // No payment yet: the quote exists but nothing settled.
  const pending = toPayoutPending("ep-owed-pending", undefined, 100);
  assert.equal(remainingOwed(pending), undefined);
  // No quote: the payment exists but there is nothing to compare it to.
  const noQuote = toPayoutPending("ep-owed-noquote");
  noQuote.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 50,
  });
  assert.equal(remainingOwed(noQuote), undefined);
  // Neither recorded.
  assert.equal(remainingOwed(new TaskLifecycle("ep-owed-fresh")), undefined);
});

test("isSettlementComplete exact: non-PAID tasks are never complete", () => {
  const t = toPayoutPending("ep-exact-pending", undefined, 100);
  assert.equal(isSettlementComplete(t), false);
  assert.equal(isSettlementComplete(t, { exact: true }), false);
});

test("invalid option values throw at construction", () => {
  for (const bad of ["yes", 1, 0, null, {}]) {
    assert.throws(
      () =>
        new TaskLifecycle("ep-badopt", {
          requireExactPayout: bad as never,
        }),
      /invalid option: requireExactPayout must be a boolean/,
    );
  }
});

test("snapshot round-trip: restored gate rejects a mismatch, gate-off snapshot keeps legacy shape", () => {
  const t = toPayoutPending("ep-snap2", { requireExactPayout: true }, 100);
  assert.equal(t.toJSON().requireExactPayout, true);
  const restored = TaskLifecycle.fromJSON(t.toJSON());
  assert.throws(
    () =>
      restored.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
        payoutAmount: 90,
      }),
    /payout amount mismatch/,
  );

  const plain = toPayoutPending("ep-snap3", undefined, 100);
  assert.equal("requireExactPayout" in plain.toJSON(), false);
  const plainRestored = TaskLifecycle.fromJSON(plain.toJSON());
  plainRestored.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 90,
  });
  assert.equal(plainRestored.state, "PAID");

  // Explicit opts override the stored value in both directions.
  const overriddenOff = TaskLifecycle.fromJSON(t.toJSON(), {
    requireExactPayout: false,
  });
  overriddenOff.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 90,
  });
  assert.equal(overriddenOff.state, "PAID");
  const overriddenOn = TaskLifecycle.fromJSON(plain.toJSON(), {
    requireExactPayout: true,
  });
  assert.throws(
    () =>
      overriddenOn.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
        payoutAmount: 90,
      }),
    /payout amount mismatch/,
  );
});

test("fromHistory re-enables the gate on a history-only rebuild", () => {
  const t = toPayoutPending("ep-hist", undefined, 100);
  const rebuilt = TaskLifecycle.fromHistory(t.id, t.history, {
    requireExactPayout: true,
  });
  assert.throws(
    () =>
      rebuilt.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
        payoutAmount: 90,
      }),
    /payout amount mismatch/,
  );
  rebuilt.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(rebuilt.state, "PAID");
});

test("diffTaskSnapshots reports the exact-payout gate flip", () => {
  const on = new TaskLifecycle("ep-diff", { requireExactPayout: true });
  const off = new TaskLifecycle("ep-diff");
  assert.deepEqual(diffTaskSnapshots(on.toJSON(), off.toJSON()), {
    exactPayoutGateChanged: { from: true, to: false },
  });
  assert.deepEqual(diffTaskSnapshots(off.toJSON(), on.toJSON()), {
    exactPayoutGateChanged: { from: false, to: true },
  });
  assert.deepEqual(diffTaskSnapshots(on.toJSON(), on.toJSON()), {});
});

test("remainingOwed and isSettlementComplete fail fast on a non-task", () => {
  assert.throws(
    () => remainingOwed({} as never),
    /invalid remainingOwed: task must be a TaskLifecycle/,
  );
  assert.throws(
    () => isSettlementComplete({} as never, { exact: true }),
    /invalid isSettlementComplete: task must be a TaskLifecycle/,
  );
  assert.throws(
    () => isSettlementComplete(new TaskLifecycle("ep-shape"), "yes" as never),
    /invalid isSettlementComplete: opts must be an object/,
  );
  assert.throws(
    () =>
      isSettlementComplete(new TaskLifecycle("ep-shape2"), {
        exact: "yes",
      } as never),
    /invalid isSettlementComplete: exact must be a boolean/,
  );
});
