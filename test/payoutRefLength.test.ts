import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  MAX_PAYOUT_REF_LENGTH,
  historyFromNdjson,
  historyToNdjson,
  parseHistory,
  reconcilePayouts,
  tasksByFilters,
  tasksByPayoutRef,
} from "../src/index.js";
import type {
  DispatchOptions,
  LedgerPayout,
  TaskHistoryEntry,
} from "../src/index.js";

/**
 * `payoutRef` length cap (backlog #1053): an external payment reference
 * is a short identifier, but dispatch() used to accept any length and
 * write it verbatim into the append-only audit history, from where it
 * fans out into snapshots, payout-webhook payloads, and NDJSON exports.
 *
 * Rules under test:
 *  - the cap is MAX_PAYOUT_REF_LENGTH = 256, exported from the index
 *  - dispatch() rejects a ref longer than the cap (never truncates:
 *    truncating would change which transfer the ref names), before
 *    anything mutates and before the transition check
 *  - a ref of exactly the cap passes verbatim, through dispatch,
 *    toJSON()/fromJSON(), parseHistory(), and NDJSON round-trips
 *  - parseHistory()/fromJSON()/fromHistory() reject an overlong ref in
 *    an untrusted log (the parse side shares dispatch's cap, so a
 *    corrupted snapshot cannot smuggle an unbounded ref back in)
 *  - reconcilePayouts() rejects an overlong ledger payoutRef fail-fast,
 *    and pairs an exactly-at-cap ref normally
 *  - read-only lookups (tasksByPayoutRef/tasksByFilters) deliberately
 *    impose no cap: they only read a ref, never persist it, so an
 *    overlong query simply matches nothing instead of throwing
 */

/** Drive a task from DRAFT to APPROVED (one step before payout). */
function toApproved(id = "refcap-1"): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

/** Drive a task from DRAFT to PAID, with the given completion options. */
function toPaid(
  id: string,
  completeOpts: DispatchOptions = {},
): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", ...completeOpts });
  assert.equal(t.state, "PAID");
  return t;
}

const overlongRef = "x".repeat(MAX_PAYOUT_REF_LENGTH + 1);
const atCapRef = "y".repeat(MAX_PAYOUT_REF_LENGTH);

test("MAX_PAYOUT_REF_LENGTH is 256", () => {
  assert.equal(MAX_PAYOUT_REF_LENGTH, 256);
});

test("dispatch rejects an overlong payoutRef, no history residue", () => {
  const t = toApproved();
  const before = t.history.length;
  assert.throws(
    () =>
      t.dispatch("REQUEST_PAYOUT", {
        actor: "contributor",
        payoutRef: overlongRef,
      }),
    /invalid dispatch options: payoutRef must be at most 256 characters, got 257/,
  );
  assert.equal(t.history.length, before);
  assert.equal(t.state, "APPROVED");
  // The next legal dispatch continues at the expected seq (no gap).
  t.dispatch("REQUEST_PAYOUT", { payoutRef: "batch-1" });
  assert.equal(t.history[t.history.length - 1].seq, before + 1);
});

test("overlong payoutRef is rejected before the transition check", () => {
  const t = toApproved();
  // ACCEPT from APPROVED is an illegal transition; the length error
  // must still win, proving option validation runs first.
  assert.throws(
    () => t.dispatch("ACCEPT", { payoutRef: overlongRef }),
    /invalid dispatch options: payoutRef must be at most 256 characters/,
  );
  assert.equal(t.history.length, 6);
});

test("a payoutRef of exactly the cap passes verbatim to PAID and round-trips", () => {
  const t = toPaid("refcap-4", { payoutRef: atCapRef, payoutAmount: 100 });
  assert.equal(t.history[t.history.length - 1].payoutRef, atCapRef);
  const json = JSON.stringify(t.toJSON());
  const restored = TaskLifecycle.fromJSON(JSON.parse(json));
  assert.equal(restored.state, "PAID");
  assert.equal(
    restored.history[restored.history.length - 1].payoutRef,
    atCapRef,
  );
  // Continuing to dispatch after rehydration keeps the at-cap ref.
  const replayed = TaskLifecycle.fromHistory(
    "refcap-4",
    JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[],
  );
  assert.equal(replayed.state, "PAID");
  assert.equal(
    replayed.history[replayed.history.length - 1].payoutRef,
    atCapRef,
  );
});

test("short demo refs are unaffected by the cap", () => {
  const t = toPaid("refcap-5", { payoutRef: "xfer-88f2", payoutAmount: 42 });
  assert.equal(t.history[t.history.length - 1].payoutRef, "xfer-88f2");
  const t2 = toApproved("refcap-5b");
  t2.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "batch-2026-1006",
  });
  assert.equal(
    t2.history[t2.history.length - 1].payoutRef,
    "batch-2026-1006",
  );
});

test("parseHistory/fromJSON/fromHistory reject an overlong payoutRef in untrusted logs", () => {
  const t = toApproved("refcap-6");
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", payoutRef: "batch-1" });
  const raw = JSON.parse(JSON.stringify(t.history));
  const bad = (ref: unknown) => {
    const copy = JSON.parse(JSON.stringify(raw));
    copy[6].payoutRef = ref;
    return copy;
  };
  assert.throws(
    () => parseHistory(bad(overlongRef)),
    /invalid history: entry\[6\]: payoutRef must be at most 256 characters, got 257/,
  );
  const snapshot = JSON.parse(JSON.stringify(t.toJSON())) as {
    history: TaskHistoryEntry[];
  };
  const badSnapshot = JSON.parse(JSON.stringify(snapshot)) as {
    history: TaskHistoryEntry[];
  };
  badSnapshot.history[6].payoutRef = overlongRef;
  assert.throws(
    () => TaskLifecycle.fromJSON(badSnapshot),
    /invalid history: entry\[6\]: payoutRef must be at most 256 characters, got 257/,
  );
  assert.throws(
    () => TaskLifecycle.fromHistory("refcap-6", bad(overlongRef)),
    /invalid history: entry\[6\]: payoutRef must be at most 256 characters, got 257/,
  );
  // The untouched log and snapshot still parse fine.
  assert.equal(parseHistory(raw)[6].payoutRef, "batch-1");
  assert.equal(TaskLifecycle.fromJSON(snapshot).state, "PAYOUT_PENDING");
});

test("NDJSON export/import shares the cap", () => {
  const t = toPaid("refcap-7", { payoutRef: atCapRef, payoutAmount: 10 });
  const text = historyToNdjson(t.history);
  const restored = historyFromNdjson(text);
  assert.equal(restored[restored.length - 1].payoutRef, atCapRef);
  // Tampering the exported ref past the cap makes the import fail.
  const tampered = text.replace(atCapRef, overlongRef);
  assert.throws(
    () => historyFromNdjson(tampered),
    /payoutRef must be at most 256 characters, got 257/,
  );
});

test("reconcilePayouts rejects an overlong ledger payoutRef fail-fast", () => {
  const paid = toPaid("refcap-8", { payoutRef: "xfer-1", payoutAmount: 100 });
  const ledger: LedgerPayout[] = [{ payoutRef: overlongRef, payoutAmount: 1 }];
  assert.throws(
    () => reconcilePayouts([paid], ledger),
    /invalid reconcilePayouts: ledger payoutRef must be at most 256 characters, got 257/,
  );
  // The throw happens before any pairing, even with no task to pair.
  assert.throws(
    () => reconcilePayouts([], ledger),
    /invalid reconcilePayouts: ledger payoutRef must be at most 256 characters, got 257/,
  );
});

test("reconcilePayouts pairs an exactly-at-cap payoutRef normally", () => {
  const paid = toPaid("refcap-9", { payoutRef: atCapRef, payoutAmount: 100 });
  const ledger: LedgerPayout[] = [
    { payoutRef: atCapRef, payoutAmount: 100 },
  ];
  const result = reconcilePayouts([paid], ledger);
  assert.deepEqual(
    result.matched.map((task) => task.id),
    ["refcap-9"],
  );
  assert.deepEqual(result.taskOnly, []);
  assert.deepEqual(result.ledgerOnly, []);
});

test("read-only lookups impose no cap: an overlong ref simply matches nothing", () => {
  const paid = toPaid("refcap-10", { payoutRef: "xfer-1", payoutAmount: 5 });
  assert.doesNotThrow(() => tasksByPayoutRef([paid], overlongRef));
  assert.deepEqual(tasksByPayoutRef([paid], overlongRef), []);
  assert.doesNotThrow(() =>
    tasksByFilters([paid], { payoutRef: overlongRef }),
  );
  assert.deepEqual(tasksByFilters([paid], { payoutRef: overlongRef }), []);
});
