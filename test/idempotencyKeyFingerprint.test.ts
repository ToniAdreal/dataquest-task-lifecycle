import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, diffTaskSnapshots } from "../src/index.js";

/**
 * Backlog #1424 — dispatch idempotency keys are bound to the dispatch
 * they first executed, not just to the key string.
 *
 * Previously `_idempotencyKeys` was a bare `Set<string>`: a key
 * consumed by `PUBLISH` would silently no-op a later `PAYOUT_COMPLETE`
 * replayed under the same key, and the caller would believe the payout
 * dispatch had happened. Now each consumed key carries a fingerprint
 * (event + actor + payoutRef + payoutAmount + quotedAmount; `at`,
 * `expectedSeq`, and `note` are deliberately excluded — a legitimate
 * retry may carry a fresh timestamp or seq, and a note is annotation,
 * not payment identity):
 *  - same key + same fingerprint: still a full no-op (no append, no
 *    listener, no transition validation)
 *  - same key + different fingerprint: `dispatch conflict:
 *    idempotency key "<key>" was already used for <event>, got <event>`
 *    — a loud rejection, no mutation, no key re-consumed
 *  - the fingerprint survives `toJSON()`/`fromJSON()` in the
 *    `idempotencyKeyFingerprints` record (the bare `idempotencyKeys`
 *    list stays for backward compatibility), and `fromHistory()` can
 *    re-attach it via `TaskLifecycleOptions.idempotencyKeyFingerprints`
 *  - legacy bare keys (seeded, or restored from a pre-fingerprint
 *    snapshot) keep the old any-event no-op — the binding is recorded
 *    where the dispatch happened, never invented afterwards
 */

test("same key, same event, same payload is still a no-op (no append, no listener)", () => {
  const t = new TaskLifecycle("fp-1");
  const seen: string[] = [];
  t.subscribe((event) => {
    seen.push(event);
  });
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" });
  const returned = t.dispatch("PUBLISH", {
    actor: "researcher",
    idempotencyKey: "k",
  });
  assert.equal(returned, "OPEN");
  assert.equal(t.history.length, 1);
  assert.deepEqual(seen, ["PUBLISH"]);
});

test("same key, different event throws a dispatch conflict and changes nothing", () => {
  const t = new TaskLifecycle("fp-2");
  const seen: string[] = [];
  t.subscribe((event) => {
    seen.push(event);
  });
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" });
  assert.throws(
    () => t.dispatch("ACCEPT", { actor: "contributor", idempotencyKey: "k" }),
    /dispatch conflict: idempotency key "k" was already used for PUBLISH, got ACCEPT/,
  );
  assert.equal(t.state, "OPEN");
  assert.equal(t.history.length, 1);
  assert.deepEqual(seen, ["PUBLISH"]);
  // The conflict consumed nothing: the original replay still no-ops,
  // and a fresh key still executes.
  assert.equal(
    t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" }),
    "OPEN",
  );
  t.dispatch("ACCEPT", { actor: "contributor", idempotencyKey: "k2" });
  assert.equal(t.state, "ACCEPTED");
  assert.equal(t.history.length, 2);
});

test("same key, same event, different payoutAmount throws", () => {
  const t = new TaskLifecycle("fp-3");
  t.dispatch("PUBLISH", { idempotencyKey: "pay" });
  t.dispatch("ACCEPT", { quotedAmount: 100, idempotencyKey: "accept" });
  t.dispatch("START_CAPTURE", { idempotencyKey: "cap" });
  t.dispatch("SUBMIT", { idempotencyKey: "sub" });
  t.dispatch("BEGIN_REVIEW", { idempotencyKey: "rev" });
  t.dispatch("APPROVE", { idempotencyKey: "app" });
  t.dispatch("REQUEST_PAYOUT", { idempotencyKey: "req" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "treasurer",
    payoutRef: "ref-1",
    payoutAmount: 100,
    idempotencyKey: "settle",
  });
  assert.equal(t.state, "PAID");
  // The exact retry is still a no-op.
  assert.equal(
    t.dispatch("PAYOUT_COMPLETE", {
      actor: "treasurer",
      payoutRef: "ref-1",
      payoutAmount: 100,
      idempotencyKey: "settle",
    }),
    "PAID",
  );
  assert.equal(t.history.length, 8);
  // A different amount under the same key is a different payout.
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        actor: "treasurer",
        payoutRef: "ref-1",
        payoutAmount: 101,
        idempotencyKey: "settle",
      }),
    /dispatch conflict: idempotency key "settle" was already used for PAYOUT_COMPLETE, got PAYOUT_COMPLETE/,
  );
  assert.equal(t.history.length, 8);
});

test("same key, same event, different actor throws", () => {
  const t = new TaskLifecycle("fp-4");
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" });
  assert.throws(
    () =>
      t.dispatch("PUBLISH", { actor: "contributor", idempotencyKey: "k" }),
    /dispatch conflict: idempotency key "k" was already used for PUBLISH, got PUBLISH/,
  );
  assert.equal(t.history.length, 1);
});

test("same key, same event, different payoutRef or quotedAmount throws", () => {
  const t = new TaskLifecycle("fp-5");
  t.dispatch("PUBLISH", { idempotencyKey: "k" });
  t.dispatch("ACCEPT", { quotedAmount: 100, idempotencyKey: "accept" });
  t.dispatch("START_CAPTURE", { idempotencyKey: "cap" });
  t.dispatch("SUBMIT", { idempotencyKey: "sub" });
  t.dispatch("BEGIN_REVIEW", { idempotencyKey: "rev" });
  t.dispatch("APPROVE", { idempotencyKey: "app" });
  t.dispatch("REQUEST_PAYOUT", { idempotencyKey: "req" });
  t.dispatch("PAYOUT_COMPLETE", {
    payoutRef: "ref-1",
    payoutAmount: 100,
    idempotencyKey: "settle",
  });
  // Same event, different reference: a different transfer.
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        payoutRef: "ref-2",
        payoutAmount: 100,
        idempotencyKey: "settle",
      }),
    /dispatch conflict: idempotency key "settle" was already used for PAYOUT_COMPLETE, got PAYOUT_COMPLETE/,
  );
  // Adding a field the first call omitted is a different dispatch too.
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        payoutRef: "ref-1",
        payoutAmount: 100,
        quotedAmount: 100,
        idempotencyKey: "settle",
      }),
    /dispatch conflict: idempotency key "settle" was already used for PAYOUT_COMPLETE, got PAYOUT_COMPLETE/,
  );
  assert.equal(t.history.length, 8);
});

test("same key, same event, different at or note still no-ops (excluded from the fingerprint)", () => {
  const t = new TaskLifecycle("fp-6");
  t.dispatch("PUBLISH", {
    actor: "researcher",
    note: "first attempt",
    at: "2026-04-02T09:00:00.000Z",
    idempotencyKey: "k",
  });
  // A retry may carry a fresh timestamp and a different annotation:
  // those are not payment identity, so the replay still dedupes.
  const returned = t.dispatch("PUBLISH", {
    actor: "researcher",
    note: "redelivery after timeout",
    at: "2026-04-02T09:05:00.000Z",
    idempotencyKey: "k",
  });
  assert.equal(returned, "OPEN");
  assert.equal(t.history.length, 1);
  assert.equal(t.history[0].note, "first attempt");
});

test("the conflict is checked before transition and RBAC, so it reports itself, not them", () => {
  const t = new TaskLifecycle("fp-7", {
    rolePolicy: { ACCEPT: ["contributor"], START_CAPTURE: ["lead"] },
  });
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" });
  t.dispatch("ACCEPT", { actor: "contributor", idempotencyKey: "k2" });
  // START_CAPTURE under the old key: actor "researcher" is not in the
  // START_CAPTURE allowlist, so RBAC would reject — but the key
  // conflict reports first, before RBAC is consulted.
  assert.throws(
    () =>
      t.dispatch("START_CAPTURE", {
        actor: "researcher",
        idempotencyKey: "k",
      }),
    /dispatch conflict: idempotency key "k" was already used for PUBLISH, got START_CAPTURE/,
  );
  // And a replay of the stale original event reports the conflict,
  // not the invalid transition it would otherwise be.
  assert.throws(
    () => t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k2" }),
    /dispatch conflict: idempotency key "k2" was already used for ACCEPT, got PUBLISH/,
  );
  assert.equal(t.history.length, 2);
});

test("a failed dispatch consumes no key, so the corrected retry records its own fingerprint", () => {
  const t = new TaskLifecycle("fp-8");
  assert.throws(
    () => t.dispatch("ACCEPT", { actor: "contributor", idempotencyKey: "k" }),
    /invalid transition/,
  );
  // The corrected dispatch under the same key executes — and binds the
  // key to PUBLISH with actor "researcher", not to the failed ACCEPT.
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" });
  assert.throws(
    () =>
      t.dispatch("PUBLISH", { actor: "contributor", idempotencyKey: "k" }),
    /dispatch conflict: idempotency key "k" was already used for PUBLISH, got PUBLISH/,
  );
  assert.equal(
    t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" }),
    "OPEN",
  );
  assert.equal(t.history.length, 1);
});

test("snapshot round-trip preserves the binding; a legacy snapshot restores bare keys", () => {
  const t = new TaskLifecycle("fp-9");
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" });
  const snap = t.toJSON();
  assert.deepEqual(snap.idempotencyKeys, ["k"]);
  assert.deepEqual(snap.idempotencyKeyFingerprints, {
    k: { event: "PUBLISH", actor: "researcher" },
  });
  const restored = TaskLifecycle.fromJSON(snap);
  assert.equal(
    restored.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" }),
    "OPEN",
  );
  assert.throws(
    () => restored.dispatch("ACCEPT", { idempotencyKey: "k" }),
    /dispatch conflict: idempotency key "k" was already used for PUBLISH, got ACCEPT/,
  );
  assert.equal(restored.history.length, 1);
  // A snapshot from before fingerprints existed carries no record:
  // its keys restore as legacy bare keys and dedupe any event.
  const legacy = t.toJSON();
  delete legacy.idempotencyKeyFingerprints;
  const legacyRestored = TaskLifecycle.fromJSON(legacy);
  assert.equal(
    legacyRestored.dispatch("ACCEPT", { idempotencyKey: "k" }),
    "OPEN",
  );
  assert.equal(legacyRestored.history.length, 1);
});

test("snapshot fingerprint validation is fail-closed", () => {
  const t = new TaskLifecycle("fp-10");
  t.dispatch("PUBLISH", { idempotencyKey: "k" });
  const base = t.toJSON();
  // Unknown event in a fingerprint.
  assert.throws(
    () =>
      TaskLifecycle.fromJSON({
        ...base,
        idempotencyKeyFingerprints: { k: { event: "NOPE" } },
      }),
    /invalid snapshot: idempotencyKeyFingerprints\["k"\] has unknown event NOPE/,
  );
  // Fingerprint for a key the task never consumed.
  assert.throws(
    () =>
      TaskLifecycle.fromJSON({
        ...base,
        idempotencyKeyFingerprints: { ghost: { event: "PUBLISH" } },
      }),
    /invalid snapshot: idempotencyKeyFingerprints key "ghost" has no matching idempotencyKeys entry/,
  );
  // Non-record fingerprints value.
  for (const bad of ["k", 42, ["k"]] as unknown[]) {
    assert.throws(
      () =>
        TaskLifecycle.fromJSON({
          ...base,
          idempotencyKeyFingerprints: bad,
        }),
      /invalid snapshot: idempotencyKeyFingerprints must be an object mapping idempotency keys to fingerprints/,
    );
  }
  // Unknown field inside a fingerprint.
  assert.throws(
    () =>
      TaskLifecycle.fromJSON({
        ...base,
        idempotencyKeyFingerprints: { k: { event: "PUBLISH", at: "2026-04-02T09:00:00.000Z" } },
      }),
    /invalid snapshot: idempotencyKeyFingerprints\["k"\] has unknown field "at"/,
  );
  // Bad payload field inside a fingerprint.
  assert.throws(
    () =>
      TaskLifecycle.fromJSON({
        ...base,
        idempotencyKeyFingerprints: { k: { event: "PUBLISH", payoutAmount: -1 } },
      }),
    /invalid snapshot: idempotencyKeyFingerprints\["k"\] payoutAmount must be a non-negative finite number/,
  );
  // A snapshot with fingerprints but no key list cannot name a key.
  assert.throws(
    () =>
      TaskLifecycle.fromJSON({
        ...base,
        idempotencyKeys: undefined,
        idempotencyKeyFingerprints: { k: { event: "PUBLISH" } },
      }),
    /invalid snapshot: idempotencyKeyFingerprints key "k" has no matching idempotencyKeys entry/,
  );
});

test("fromHistory re-attaches bare keys as legacy, and fingerprints when given", () => {
  const t = new TaskLifecycle("fp-11");
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" });
  // Bare re-attachment: the legacy any-event no-op is preserved.
  const legacy = TaskLifecycle.fromHistory(t.id, t.history, {
    idempotencyKeys: ["k"],
  });
  assert.equal(legacy.dispatch("ACCEPT", { idempotencyKey: "k" }), "OPEN");
  assert.equal(legacy.history.length, 1);
  // Fingerprinted re-attachment: the binding is restored.
  const bound = TaskLifecycle.fromHistory(t.id, t.history, {
    idempotencyKeys: ["k"],
    idempotencyKeyFingerprints: {
      k: { event: "PUBLISH", actor: "researcher" },
    },
  });
  assert.equal(
    bound.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" }),
    "OPEN",
  );
  assert.throws(
    () => bound.dispatch("ACCEPT", { idempotencyKey: "k" }),
    /dispatch conflict: idempotency key "k" was already used for PUBLISH, got ACCEPT/,
  );
  // A fingerprint for a key that was not seeded is a construction error.
  assert.throws(
    () =>
      TaskLifecycle.fromHistory(t.id, t.history, {
        idempotencyKeys: ["k"],
        idempotencyKeyFingerprints: {
          ghost: { event: "PUBLISH" },
        },
      }),
    /invalid option: idempotencyKeyFingerprints key "ghost" has no matching idempotencyKeys entry/,
  );
  assert.throws(
    () =>
      new TaskLifecycle("fp-11b", {
        idempotencyKeys: ["k"],
        idempotencyKeyFingerprints: {
          k: { event: "NOPE" as never },
        },
      }),
    /invalid option: idempotencyKeyFingerprints\["k"\] has unknown event NOPE/,
  );
});

test("constructor-seeded keys are legacy bare keys and dedupe any event", () => {
  const t = new TaskLifecycle("fp-12", { idempotencyKeys: ["seed-1"] });
  // The seed was never consumed by a dispatch, so no binding exists:
  // the key dedupes whatever event it is replayed under.
  assert.equal(t.dispatch("ACCEPT", { idempotencyKey: "seed-1" }), "DRAFT");
  assert.equal(t.history.length, 0);
  // A task seeded with a fingerprint binds that key instead.
  const bound = new TaskLifecycle("fp-12b", {
    idempotencyKeys: ["seed-1"],
    idempotencyKeyFingerprints: { "seed-1": { event: "PUBLISH" } },
  });
  assert.equal(bound.dispatch("PUBLISH", { idempotencyKey: "seed-1" }), "DRAFT");
  assert.throws(
    () => bound.dispatch("ACCEPT", { idempotencyKey: "seed-1" }),
    /dispatch conflict: idempotency key "seed-1" was already used for PUBLISH, got ACCEPT/,
  );
});

test("diffTaskSnapshots reports a fingerprint change even when the key set is identical", () => {
  const t = new TaskLifecycle("fp-13");
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" });
  const a = t.toJSON();
  const restored = TaskLifecycle.fromJSON(a);
  // Same key set, same binding: no change.
  assert.deepEqual(diffTaskSnapshots(a, restored.toJSON()), {});
  // Same key set, binding dropped (a legacy restore): the binding moved.
  const legacy = restored.toJSON();
  delete legacy.idempotencyKeyFingerprints;
  assert.deepEqual(diffTaskSnapshots(a, legacy), {
    idempotencyKeysChanged: true,
  });
  // Same key set, binding changed (a different actor recorded): also
  // a change, even though the key list is byte-identical.
  const rebound = restored.toJSON();
  rebound.idempotencyKeyFingerprints = {
    k: { event: "PUBLISH", actor: "contributor" },
  };
  assert.deepEqual(diffTaskSnapshots(a, rebound), {
    idempotencyKeysChanged: true,
  });
});

test("a stale expectedSeq still reports its conflict before the idempotency dedupe", () => {
  const t = new TaskLifecycle("fp-14");
  t.dispatch("PUBLISH", { idempotencyKey: "k" });
  // Same key, same dispatch, but a stale seq: the seq conflict wins,
  // exactly as before fingerprints existed.
  assert.throws(
    () =>
      t.dispatch("PUBLISH", { idempotencyKey: "k", expectedSeq: 0 }),
    /dispatch conflict: expected seq 0 but task is at seq 1/,
  );
  assert.equal(t.history.length, 1);
});
