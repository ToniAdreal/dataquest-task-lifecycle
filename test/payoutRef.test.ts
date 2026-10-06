import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  parseHistory,
  type TaskHistoryEntry,
} from "../src/index.js";

/**
 * `dispatch(event, { payoutRef })` records an external payment reference
 * (payout batch id, transfer id, …) verbatim into the audit entry, for
 * settlement reconciliation without free-text notes.
 *
 * Rules under test:
 *  - payoutRef lands verbatim on REQUEST_PAYOUT / PAYOUT_COMPLETE entries
 *  - empty or non-string payoutRef throws `invalid dispatch options`
 *    before anything mutates (no history residue)
 *  - omitting payoutRef leaves the entry without the key (unchanged shape)
 *  - PAYOUT_COMPLETE without a payoutRef is legal (advisory only)
 *  - payoutRef survives toJSON()/fromJSON() and fromHistory() round-trips
 *  - parseHistory/fromJSON reject empty or non-string payoutRef in
 *    untrusted logs
 *  - the option is accepted on any event (generic audit metadata,
 *    like actor/note)
 */

/** Drive a task from DRAFT to APPROVED (one step before payout). */
function toApproved(id = "payout-1"): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

test("payoutRef lands verbatim on REQUEST_PAYOUT and PAYOUT_COMPLETE entries", () => {
  const t = toApproved();
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", payoutRef: "batch-2026-1006" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutRef: "xfer-88f2" });
  assert.equal(t.state, "PAID");
  const [request, complete] = t.history.slice(-2);
  assert.equal(request.event, "REQUEST_PAYOUT");
  assert.equal(request.payoutRef, "batch-2026-1006");
  assert.equal(complete.event, "PAYOUT_COMPLETE");
  assert.equal(complete.payoutRef, "xfer-88f2");
  // Injected at-timestamps combine freely with payoutRef (all dispatches
  // pin `at` so the sequence stays deterministic).
  const t2 = new TaskLifecycle("payout-1b");
  const pin = (i: number) => `2026-10-06T0${i}:00:00.000Z`;
  const steps = [
    ["PUBLISH", "researcher"],
    ["ACCEPT", "contributor"],
    ["START_CAPTURE", "contributor"],
    ["SUBMIT", "contributor"],
    ["BEGIN_REVIEW", "reviewer"],
    ["APPROVE", "reviewer"],
    ["REQUEST_PAYOUT", "contributor"],
  ] as const;
  steps.forEach(([event, actor], i) => {
    t2.dispatch(event, { actor, payoutRef: `batch-${i}`, at: pin(i) });
  });
  const pinned = t2.history[6];
  assert.equal(pinned.event, "REQUEST_PAYOUT");
  assert.equal(pinned.payoutRef, "batch-6");
  assert.equal(pinned.at, "2026-10-06T06:00:00.000Z");
});

test("empty-string payoutRef throws invalid dispatch options, no history residue", () => {
  const t = toApproved();
  const before = t.history.length;
  assert.throws(
    () => t.dispatch("REQUEST_PAYOUT", { payoutRef: "" }),
    /invalid dispatch options: payoutRef must be a non-empty string/,
  );
  assert.equal(t.history.length, before);
  assert.equal(t.state, "APPROVED");
  // The next legal dispatch continues at the expected seq (no gap).
  t.dispatch("REQUEST_PAYOUT", { payoutRef: "batch-1" });
  assert.equal(t.history[t.history.length - 1].seq, before + 1);
});

test("non-string payoutRef throws and leaves no residue", () => {
  const t = toApproved();
  const bad = [42, null, {}, ["batch-1"]];
  for (const payoutRef of bad) {
    assert.throws(
      () => t.dispatch("REQUEST_PAYOUT", { payoutRef: payoutRef as never }),
      /invalid dispatch options: payoutRef must be a non-empty string/,
      `value ${JSON.stringify(payoutRef)} should throw`,
    );
  }
  assert.equal(t.history.length, 6);
});

test("payoutRef validation is fail-fast, before the transition check", () => {
  const t = toApproved();
  // REQUEST_PAYOUT from APPROVED is legal here; use an illegal event to
  // prove the option check runs before the transition check.
  assert.throws(
    () => t.dispatch("ACCEPT", { payoutRef: "" }),
    /invalid dispatch options: payoutRef/,
  );
  assert.equal(t.history.length, 6);
});

test("omitted payoutRef leaves the entry without the key", () => {
  const t = toApproved();
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  const [request, complete] = t.history.slice(-2);
  assert.equal("payoutRef" in request, false);
  assert.equal("payoutRef" in complete, false);
  // toJSON snapshot has no payoutRef key either (unchanged wire shape).
  const snap = t.toJSON();
  for (const entry of snap.history) {
    assert.equal("payoutRef" in entry, false);
  }
});

test("PAYOUT_COMPLETE without payoutRef is legal (advisory only)", () => {
  const t = toApproved();
  t.dispatch("REQUEST_PAYOUT");
  assert.doesNotThrow(() => t.dispatch("PAYOUT_COMPLETE", { actor: "system" }));
  assert.equal(t.state, "PAID");
});

test("payoutRef survives toJSON()/fromJSON() round-trips", () => {
  const t = toApproved("payout-7");
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", payoutRef: "batch-42" });
  const json = JSON.stringify(t.toJSON());
  const restored = TaskLifecycle.fromJSON(JSON.parse(json));
  const entry = restored.history[restored.history.length - 1];
  assert.equal(entry.event, "REQUEST_PAYOUT");
  assert.equal(entry.payoutRef, "batch-42");
  // Continuing to dispatch after rehydration keeps the ref on history.
  restored.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutRef: "xfer-7" });
  assert.equal(restored.history[restored.history.length - 1].payoutRef, "xfer-7");
  assert.equal(restored.state, "PAID");
});

test("payoutRef survives fromHistory() replay", () => {
  const t = toApproved("payout-8");
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", payoutRef: "batch-42" });
  const log = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  const replayed = TaskLifecycle.fromHistory("payout-8", log);
  assert.equal(replayed.state, "PAYOUT_PENDING");
  assert.equal(replayed.history[replayed.history.length - 1].payoutRef, "batch-42");
});

test("fromJSON rejects snapshots with empty or non-string payoutRef", () => {
  const t = toApproved("payout-9");
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", payoutRef: "batch-1" });
  const base = JSON.parse(JSON.stringify(t.toJSON())) as {
    history: TaskHistoryEntry[];
  };
  const withBad = (ref: unknown) => {
    const copy = JSON.parse(JSON.stringify(base)) as { history: TaskHistoryEntry[] };
    (copy.history[copy.history.length - 1] as unknown as Record<string, unknown>).payoutRef = ref;
    return copy;
  };
  assert.throws(
    () => TaskLifecycle.fromJSON(withBad("")),
    /invalid history: entry\[6\]: payoutRef must be a non-empty string/,
  );
  assert.throws(
    () => TaskLifecycle.fromJSON(withBad(123)),
    /invalid history: entry\[6\]: payoutRef must be a non-empty string/,
  );
  // The untouched snapshot rehydrates fine.
  assert.equal(TaskLifecycle.fromJSON(base).state, "PAYOUT_PENDING");
});

test("parseHistory sanitizes and preserves payoutRef, rejects bad shapes", () => {
  const t = toApproved("payout-10");
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", payoutRef: "batch-5" });
  const raw = JSON.parse(JSON.stringify(t.history));
  const parsed = parseHistory(raw);
  assert.equal(parsed[parsed.length - 1].payoutRef, "batch-5");
  // Sanitization: mutating the raw input afterwards does not affect the
  // parsed entries.
  raw[6].payoutRef = "tampered";
  assert.equal(parsed[6].payoutRef, "batch-5");
  // Bad shapes are rejected with a specific message.
  const bad = (ref: unknown) => {
    const copy = JSON.parse(JSON.stringify(raw));
    copy[6].payoutRef = ref;
    return copy;
  };
  assert.throws(
    () => parseHistory(bad("")),
    /invalid history: entry\[6\]: payoutRef must be a non-empty string/,
  );
  assert.throws(
    () => parseHistory(bad(null)),
    /invalid history: entry\[6\]: payoutRef must be a non-empty string/,
  );
});

test("payoutRef is accepted on non-payout events (generic audit metadata)", () => {
  const t = new TaskLifecycle("payout-11");
  t.dispatch("PUBLISH", { actor: "researcher", payoutRef: "weird-but-recorded" });
  assert.equal(t.history[0].payoutRef, "weird-but-recorded");
});
