import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  diffTaskSnapshots,
  type TaskLifecycleOptions,
} from "../src/index.js";

/**
 * `requirePayoutRef` / `requirePayoutAmount` / `requireActor` in
 * snapshots (backlog #1257). Before this item the three gates were
 * task configuration that never entered `toJSON()`: a restored task
 * silently lost them and accepted a reference-free, amount-free, or
 * anonymous `PAYOUT_COMPLETE` it would previously have rejected.
 * The gates now follow the sibling escrow-state-machine-ts
 * precedent (`requireSettlementRef` / `requireRefundRef`, backlog
 * #1256) — persisted as optional `requirePayoutRef: true` /
 * `requirePayoutAmount: true` / `requireActor: true` fields,
 * restored by `fromJSON` unless an explicit option overrides them,
 * and reported by `diffTaskSnapshots` as `payoutRefGateChanged` /
 * `payoutAmountGateChanged` / `actorGateChanged`.
 *
 * Rules under test:
 *  - `toJSON()` writes each gate `true` only when it is on; a
 *    gate-off task's snapshot keeps its exact legacy shape
 *  - `fromJSON()` restores all three gates: a restored task rejects
 *    a reference-free / amount-free `PAYOUT_COMPLETE` and an
 *    actor-less dispatch, and keeps dispatching with the evidence
 *  - an explicit `opts.requirePayoutRef` / `opts.requirePayoutAmount`
 *    / `opts.requireActor` overrides the snapshot's value in both
 *    directions (on -> off and off -> on)
 *  - a legacy snapshot without the fields restores with the gates off
 *  - a non-boolean `requirePayoutRef` / `requirePayoutAmount` /
 *    `requireActor` field is rejected as
 *    `invalid snapshot: … must be a boolean, …`
 *  - `diffTaskSnapshots` reports `payoutRefGateChanged` /
 *    `payoutAmountGateChanged` / `actorGateChanged` on a true
 *    off->on or on->off flip, and reports nothing when both sides
 *    are gate-off (absent field and explicit `false` are the same
 *    state)
 *  - a signed snapshot round-trips all three gates, and flipping any
 *    gate inside a signed envelope fails the MAC check
 *  - the gates survive a JSON wire round-trip and stay on across
 *    further dispatches
 */

const SECRET = "snapshot-require-guards-test-secret";

/** Drive a task from DRAFT to APPROVED (one step before payout). */
function toApproved(id: string, opts?: TaskLifecycleOptions): TaskLifecycle {
  const t = new TaskLifecycle(id, opts);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

/** Drive a task from DRAFT to PAYOUT_PENDING, always carrying an actor. */
function toPayoutPending(
  id: string,
  opts?: TaskLifecycleOptions,
): TaskLifecycle {
  const t = toApproved(id, opts);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  return t;
}

test("toJSON() writes all three gates true only when they are on", () => {
  const gated = toApproved("srg-1", {
    requirePayoutRef: true,
    requirePayoutAmount: true,
    requireActor: true,
  }).toJSON();
  assert.equal(gated.requirePayoutRef, true);
  assert.equal(gated.requirePayoutAmount, true);
  assert.equal(gated.requireActor, true);
  const open = toApproved("srg-1b");
  assert.equal("requirePayoutRef" in open.toJSON(), false);
  assert.equal("requirePayoutAmount" in open.toJSON(), false);
  assert.equal("requireActor" in open.toJSON(), false);
  const explicitOff = toApproved("srg-1c", {
    requirePayoutRef: false,
    requirePayoutAmount: false,
    requireActor: false,
  });
  assert.equal("requirePayoutRef" in explicitOff.toJSON(), false);
  assert.equal("requirePayoutAmount" in explicitOff.toJSON(), false);
  assert.equal("requireActor" in explicitOff.toJSON(), false);
});

test("toJSON() writes each gate independently", () => {
  const refOnly = toApproved("srg-1d", { requirePayoutRef: true }).toJSON();
  assert.equal(refOnly.requirePayoutRef, true);
  assert.equal("requirePayoutAmount" in refOnly, false);
  assert.equal("requireActor" in refOnly, false);
  const amountOnly = toApproved("srg-1e", {
    requirePayoutAmount: true,
  }).toJSON();
  assert.equal(amountOnly.requirePayoutAmount, true);
  assert.equal("requirePayoutRef" in amountOnly, false);
  assert.equal("requireActor" in amountOnly, false);
  const actorOnly = toApproved("srg-1f", { requireActor: true }).toJSON();
  assert.equal(actorOnly.requireActor, true);
  assert.equal("requirePayoutRef" in actorOnly, false);
  assert.equal("requirePayoutAmount" in actorOnly, false);
});

test("fromJSON() round-trip retains the payout-reference gate", () => {
  const t = toPayoutPending("srg-2", { requirePayoutRef: true });
  const restored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(t.toJSON())),
  );
  assert.throws(
    () =>
      restored.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutAmount: 100,
      }),
    /payout reference required/,
  );
  restored.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(restored.state, "PAID");
  // The gate is still on in the re-exported snapshot.
  assert.equal(restored.toJSON().requirePayoutRef, true);
});

test("fromJSON() round-trip retains the payout-amount gate", () => {
  const t = toPayoutPending("srg-3", { requirePayoutAmount: true });
  const restored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(t.toJSON())),
  );
  assert.throws(
    () =>
      restored.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
      }),
    /payout amount required/,
  );
  restored.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(restored.state, "PAID");
  // The gate is still on in the re-exported snapshot.
  assert.equal(restored.toJSON().requirePayoutAmount, true);
});

test("fromJSON() round-trip retains the actor gate", () => {
  const t = toPayoutPending("srg-4", { requireActor: true });
  const restored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(t.toJSON())),
  );
  assert.throws(
    () =>
      restored.dispatch("PAYOUT_COMPLETE", {
        payoutRef: "xfer-1",
        payoutAmount: 100,
      }),
    /actor required/,
  );
  restored.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(restored.state, "PAID");
  // The gate is still on in the re-exported snapshot.
  assert.equal(restored.toJSON().requireActor, true);
});

test("fromJSON() opts override turns all three gates off", () => {
  const t = toPayoutPending("srg-5", {
    requirePayoutRef: true,
    requirePayoutAmount: true,
    requireActor: true,
  });
  const restored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(t.toJSON())),
    {
      requirePayoutRef: false,
      requirePayoutAmount: false,
      requireActor: false,
    },
  );
  restored.dispatch("PAYOUT_COMPLETE");
  assert.equal(restored.state, "PAID");
  assert.equal("requirePayoutRef" in restored.toJSON(), false);
  assert.equal("requirePayoutAmount" in restored.toJSON(), false);
  assert.equal("requireActor" in restored.toJSON(), false);
});

test("fromJSON() opts override turns each gate on for a gate-off snapshot", () => {
  const refRestored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(toPayoutPending("srg-6a").toJSON())),
    { requirePayoutRef: true },
  );
  assert.throws(
    () =>
      refRestored.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutAmount: 100,
      }),
    /payout reference required/,
  );
  refRestored.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(refRestored.state, "PAID");
  assert.equal(refRestored.toJSON().requirePayoutRef, true);

  const amountRestored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(toPayoutPending("srg-6b").toJSON())),
    { requirePayoutAmount: true },
  );
  assert.throws(
    () =>
      amountRestored.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
      }),
    /payout amount required/,
  );
  amountRestored.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(amountRestored.state, "PAID");
  assert.equal(amountRestored.toJSON().requirePayoutAmount, true);

  const actorRestored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(toPayoutPending("srg-6c").toJSON())),
    { requireActor: true },
  );
  assert.throws(
    () =>
      actorRestored.dispatch("PAYOUT_COMPLETE", {
        payoutRef: "xfer-1",
        payoutAmount: 100,
      }),
    /actor required/,
  );
  actorRestored.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(actorRestored.state, "PAID");
  assert.equal(actorRestored.toJSON().requireActor, true);
});

test("legacy snapshot without the fields restores with the gates off", () => {
  const t = toPayoutPending("srg-7", {
    requirePayoutRef: true,
    requirePayoutAmount: true,
    requireActor: true,
  });
  const legacy = JSON.parse(JSON.stringify(t.toJSON()));
  delete legacy.requirePayoutRef;
  delete legacy.requirePayoutAmount;
  delete legacy.requireActor;
  const restored = TaskLifecycle.fromJSON(legacy);
  restored.dispatch("PAYOUT_COMPLETE");
  assert.equal(restored.state, "PAID");
});

test("explicit false in a snapshot restores gate-off and re-export drops the field", () => {
  const t = toPayoutPending("srg-8", {
    requirePayoutRef: true,
    requirePayoutAmount: true,
    requireActor: true,
  });
  const snapshot = JSON.parse(JSON.stringify(t.toJSON()));
  snapshot.requirePayoutRef = false;
  snapshot.requirePayoutAmount = false;
  snapshot.requireActor = false;
  const restored = TaskLifecycle.fromJSON(snapshot);
  restored.dispatch("PAYOUT_COMPLETE");
  assert.equal(restored.state, "PAID");
  assert.equal("requirePayoutRef" in restored.toJSON(), false);
  assert.equal("requirePayoutAmount" in restored.toJSON(), false);
  assert.equal("requireActor" in restored.toJSON(), false);
});

test("non-boolean requirePayoutRef / requirePayoutAmount / requireActor in a snapshot is rejected", () => {
  const base = toApproved("srg-9", {
    requirePayoutRef: true,
    requirePayoutAmount: true,
    requireActor: true,
  }).toJSON();
  for (const bad of ["yes", 1, 0, null, {}, []]) {
    const refSnapshot = { ...base, requirePayoutRef: bad };
    assert.throws(
      () => TaskLifecycle.fromJSON(refSnapshot),
      /invalid snapshot: requirePayoutRef must be a boolean/,
    );
    const amountSnapshot = { ...base, requirePayoutAmount: bad };
    assert.throws(
      () => TaskLifecycle.fromJSON(amountSnapshot),
      /invalid snapshot: requirePayoutAmount must be a boolean/,
    );
    const actorSnapshot = { ...base, requireActor: bad };
    assert.throws(
      () => TaskLifecycle.fromJSON(actorSnapshot),
      /invalid snapshot: requireActor must be a boolean/,
    );
  }
});

test("diffTaskSnapshots reports payoutRefGateChanged off -> on and on -> off", () => {
  const gated = toApproved("srg-10", { requirePayoutRef: true }).toJSON();
  const off = { ...gated };
  delete off.requirePayoutRef;
  assert.deepEqual(diffTaskSnapshots(off, gated), {
    payoutRefGateChanged: { from: false, to: true },
  });
  assert.deepEqual(diffTaskSnapshots(gated, off), {
    payoutRefGateChanged: { from: true, to: false },
  });
});

test("diffTaskSnapshots reports payoutAmountGateChanged and actorGateChanged", () => {
  const gated = toApproved("srg-11", {
    requirePayoutAmount: true,
    requireActor: true,
  }).toJSON();
  const off = { ...gated };
  delete off.requirePayoutAmount;
  delete off.requireActor;
  assert.deepEqual(diffTaskSnapshots(off, gated), {
    payoutAmountGateChanged: { from: false, to: true },
    actorGateChanged: { from: false, to: true },
  });
  assert.deepEqual(diffTaskSnapshots(gated, off), {
    payoutAmountGateChanged: { from: true, to: false },
    actorGateChanged: { from: true, to: false },
  });
});

test("diffTaskSnapshots: absent field and explicit false are the same gate-off state", () => {
  const gated = toApproved("srg-12", {
    requirePayoutRef: true,
    requirePayoutAmount: true,
    requireActor: true,
  }).toJSON();
  const off = { ...gated };
  delete off.requirePayoutRef;
  delete off.requirePayoutAmount;
  delete off.requireActor;
  const explicitOff = {
    ...off,
    requirePayoutRef: false,
    requirePayoutAmount: false,
    requireActor: false,
  };
  assert.deepEqual(diffTaskSnapshots(off, explicitOff), {});
  assert.deepEqual(diffTaskSnapshots(explicitOff, off), {});
});

test("signed snapshot round-trip retains all three gates", () => {
  const t = toPayoutPending("srg-13", {
    requirePayoutRef: true,
    requirePayoutAmount: true,
    requireActor: true,
  });
  const envelope = t.exportSignedSnapshot(SECRET);
  assert.equal(envelope.snapshot.requirePayoutRef, true);
  assert.equal(envelope.snapshot.requirePayoutAmount, true);
  assert.equal(envelope.snapshot.requireActor, true);
  const restored = TaskLifecycle.restoreSignedSnapshot(
    JSON.parse(JSON.stringify(envelope)),
    SECRET,
  );
  assert.throws(
    () =>
      restored.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutAmount: 100,
      }),
    /payout reference required/,
  );
  assert.throws(
    () =>
      restored.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutRef: "xfer-1",
      }),
    /payout amount required/,
  );
  assert.throws(
    () =>
      restored.dispatch("PAYOUT_COMPLETE", {
        payoutRef: "xfer-1",
        payoutAmount: 100,
      }),
    /actor required/,
  );
  restored.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(restored.state, "PAID");
});

test("flipping any gate inside a signed envelope fails the MAC check", () => {
  const t = toPayoutPending("srg-14", {
    requirePayoutRef: true,
    requirePayoutAmount: true,
    requireActor: true,
  });
  const envelope = t.exportSignedSnapshot(SECRET);
  for (const field of [
    "requirePayoutRef",
    "requirePayoutAmount",
    "requireActor",
  ] as const) {
    const tampered = JSON.parse(JSON.stringify(envelope));
    delete tampered.snapshot[field];
    assert.throws(
      () => TaskLifecycle.restoreSignedSnapshot(tampered, SECRET),
      /signed snapshot MAC mismatch/,
    );
  }
});

test("gates survive a JSON wire round-trip and stay on across further dispatches", () => {
  const t = toPayoutPending("srg-15", {
    requirePayoutRef: true,
    requirePayoutAmount: true,
    requireActor: true,
  });
  const wire = JSON.stringify(t.toJSON());
  const restored = TaskLifecycle.fromJSON(JSON.parse(wire));
  restored.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  assert.equal(restored.state, "PAID");
  assert.equal(restored.toJSON().requirePayoutRef, true);
  assert.equal(restored.toJSON().requirePayoutAmount, true);
  assert.equal(restored.toJSON().requireActor, true);
  assert.equal(
    JSON.parse(JSON.stringify(restored.toJSON())).requirePayoutRef,
    true,
  );
  assert.equal(
    JSON.parse(JSON.stringify(restored.toJSON())).requirePayoutAmount,
    true,
  );
  assert.equal(
    JSON.parse(JSON.stringify(restored.toJSON())).requireActor,
    true,
  );
});
