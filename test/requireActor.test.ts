import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, type TaskLifecycleOptions } from "../src/index.js";

/**
 * `requireActor` — opt-in up-front enforcement of audit attribution on
 * every dispatch. The default stays advisory-only (an anonymous dispatch
 * is legal and the entry simply omits the actor); flipping the switch
 * makes "no actor" a dispatch-time error instead of a silent gap in
 * the audit trail. It complements `rolePolicy`, which only constrains
 * the events it lists: `requireActor` covers all of them, and a listed
 * event still needs a matching actor, not just any actor.
 *
 * Rules under test:
 *  - enabled: dispatch without an actor throws `actor required: …`
 *    and leaves no history residue, no state change, no listener call
 *  - enabled: dispatch with an actor passes and records it
 *  - disabled (default) and explicit false: anonymous dispatch legal
 *  - non-boolean option values throw `invalid option` at construction
 *  - RBAC interplay: a listed event with a wrong actor reports the
 *    RBAC error (not actor-required); a listed event with no actor
 *    reports the RBAC error first; an unlisted event with no actor
 *    reports actor-required
 *  - a rejected dispatch consumes no idempotency key and leaves no seq gap
 *  - the switch is task configuration, not audit data: it is never
 *    written into the toJSON() snapshot
 *  - fromJSON() does not restore the switch (advisory again after restore);
 *    fromHistory(id, history, { requireActor: true }) re-attaches it
 *  - with requirePayoutRef also on, a PAYOUT_COMPLETE with an actor but
 *    no payoutRef reports the payout error; without either, the actor
 *    error reports first (check order pinned)
 */

/** Drive a task from DRAFT to APPROVED, always carrying an actor. */
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

test("enabled: dispatch without an actor throws and leaves no trace", () => {
  const t = new TaskLifecycle("ra-1", { requireActor: true });
  let notified = 0;
  t.subscribe(() => {
    notified += 1;
  });
  const before = t.history.length;
  assert.throws(
    () => t.dispatch("PUBLISH"),
    /actor required: dispatch must carry a non-empty actor when requireActor is enabled/,
  );
  assert.equal(t.history.length, before);
  assert.equal(t.state, "DRAFT");
  assert.equal(notified, 0);
});

test("enabled: dispatch with an actor passes and records it", () => {
  const t = new TaskLifecycle("ra-2", { requireActor: true });
  t.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(t.state, "OPEN");
  assert.equal(t.history[0].actor, "researcher");
});

test("disabled by default: anonymous dispatch stays legal", () => {
  const t = new TaskLifecycle("ra-3");
  t.dispatch("PUBLISH");
  assert.equal(t.state, "OPEN");
  assert.equal(t.history[0].actor, undefined);
});

test("explicit false: anonymous dispatch stays legal", () => {
  const t = new TaskLifecycle("ra-4", { requireActor: false });
  t.dispatch("PUBLISH");
  assert.equal(t.state, "OPEN");
});

test("non-boolean requireActor values throw at construction", () => {
  for (const bad of ["yes", 1, 0, null, {}, []] as const) {
    assert.throws(
      () => new TaskLifecycle("ra-5", { requireActor: bad as never }),
      /invalid option: requireActor must be a boolean/,
    );
  }
});

test("RBAC interplay: policy errors win on listed events, requireActor covers the rest", () => {
  const t = new TaskLifecycle("ra-6", {
    requireActor: true,
    rolePolicy: { PUBLISH: ["researcher"] },
  });
  // Listed event, wrong actor: the RBAC error reports (checked before
  // the actor-required gate).
  assert.throws(
    () => t.dispatch("PUBLISH", { actor: "contributor" }),
    /actor not authorized for PUBLISH/,
  );
  // Listed event, no actor at all: the RBAC error reports first —
  // the policy requires an actor in its list, not just any actor.
  assert.throws(
    () => t.dispatch("PUBLISH"),
    /actor not authorized for PUBLISH: policy requires an actor/,
  );
  // Listed event, matching actor: passes.
  t.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(t.state, "OPEN");
  // Unlisted event, no actor: the policy is silent, requireActor speaks.
  assert.throws(
    () => t.dispatch("ACCEPT"),
    /actor required: dispatch must carry a non-empty actor/,
  );
  t.dispatch("ACCEPT", { actor: "contributor" });
  assert.equal(t.state, "ACCEPTED");
});

test("rejected dispatch consumes no idempotency key and leaves no seq gap", () => {
  const t = new TaskLifecycle("ra-7", { requireActor: true });
  const before = t.history.length;
  assert.throws(
    () => t.dispatch("PUBLISH", { idempotencyKey: "k-actor-1" }),
    /actor required/,
  );
  assert.equal(t.history.length, before);
  // The failed dispatch consumed nothing: the corrected retry with the
  // same key still executes.
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k-actor-1" });
  assert.equal(t.state, "OPEN");
  assert.equal(t.history.length, before + 1);
  assert.equal(t.history[t.history.length - 1].seq, before + 1);
});

test("the switch is not written into the toJSON() snapshot", () => {
  const t = toApproved("ra-8", { requireActor: true });
  const snapshot = t.toJSON();
  assert.equal("requireActor" in snapshot, false);
});

test("fromJSON() does not restore the switch: advisory again after restore", () => {
  const t = toApproved("ra-9", { requireActor: true });
  const restored = TaskLifecycle.fromJSON(JSON.parse(JSON.stringify(t)));
  restored.dispatch("REQUEST_PAYOUT");
  assert.equal(restored.state, "PAYOUT_PENDING");
  assert.equal(restored.history[restored.history.length - 1].actor, undefined);
});

test("fromHistory() re-attaches the switch via options", () => {
  const t = toApproved("ra-10");
  const history = JSON.parse(JSON.stringify(t.history));
  const rehydrated = TaskLifecycle.fromHistory("ra-10", history, {
    requireActor: true,
  });
  assert.throws(
    () => rehydrated.dispatch("REQUEST_PAYOUT"),
    /actor required/,
  );
  rehydrated.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.equal(rehydrated.state, "PAYOUT_PENDING");
  // ...and without the option the rehydrated task stays advisory.
  const relaxed = TaskLifecycle.fromHistory("ra-10", history);
  relaxed.dispatch("REQUEST_PAYOUT");
  assert.equal(relaxed.state, "PAYOUT_PENDING");
});

test("with requirePayoutRef also on: actor error reports before payout error", () => {
  const t = toApproved("ra-11", {
    requireActor: true,
    requirePayoutRef: true,
  });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  // Actor present but no payoutRef: the payout gate reports.
  assert.throws(
    () => t.dispatch("PAYOUT_COMPLETE", { actor: "system" }),
    /payout reference required/,
  );
  // Neither actor nor payoutRef: the actor gate reports first.
  assert.throws(
    () => t.dispatch("PAYOUT_COMPLETE"),
    /actor required: dispatch must carry a non-empty actor/,
  );
  // Both present: passes.
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-11",
  });
  assert.equal(t.state, "PAID");
});
