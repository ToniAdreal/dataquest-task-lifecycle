/**
 * Settlement read-helper shape guards (backlog #1341).
 *
 * `totalPaidOut()` / `totalQuoted()` / `payoutMismatch()` used to
 * dereference their input with no shape guard at all: a `null` batch
 * died as a bare `TypeError` (`tasks is not iterable` / `reading
 * 'state'`), a string batch iterated its characters and silently
 * answered 0 ("zero paid out" / "zero quoted"), and a plain `{}`
 * handed to `payoutMismatch()` silently answered `undefined` — the
 * same answer a genuinely un-mismatched task gives. The guards
 * follow `reconcilePayouts` (backlog #1337): a shape check, not
 * `instanceof TaskLifecycle`, so a defensive stand-in shaped like a
 * task (backlog #893) still passes.
 *
 * Rules under test:
 *  - a non-array batch throws `tasks must be an array`, naming the
 *    function, before any figure is read
 *  - a non-task entry throws naming its index
 *  - `totalPaidOut("x")` no longer silently returns 0
 *  - `payoutMismatch({})` no longer silently returns `undefined`
 *  - a defensive stand-in shaped like a task still reads
 *  - legal batches keep exactly their old figures, and an empty
 *    batch still returns 0 / `undefined`
 *  - `mismatchedPayouts()`, the batch form of `payoutMismatch()`,
 *    carries the same guard (same-family sibling covered in this
 *    round, after #1340's precedent of covering a same-defect
 *    sibling)
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  mismatchedPayouts,
  payoutMismatch,
  totalPaidOut,
  totalQuoted,
} from "../src/index.js";

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
 * The demo-shaped mixed batch: one quoteless settled task (paid
 * 10098.5), one mismatched (quoted 4300, settled 4050.5), one
 * settled exactly as quoted (2200), plus one OPEN task that
 * contributes nothing to either total.
 */
function mixedBatch(): TaskLifecycle[] {
  return [
    toPaid("DEMO-001", { paid: 10098.5 }),
    toPaid("DEMO-005", { quoted: 4300, paid: 4050.5 }),
    toPaid("DEMO-003", { quoted: 2200, paid: 2200 }),
    toOpen("DEMO-OPEN"),
  ];
}

test("totalPaidOut: a non-array batch throws, naming the function", () => {
  for (const bad of [null, "x", 42, {}]) {
    assert.throws(
      () => totalPaidOut(bad as never),
      /invalid totalPaidOut: tasks must be an array/,
    );
  }
});

test("totalPaidOut: a string batch no longer silently returns 0", () => {
  // The probe that motivated this item: "x" iterated its characters,
  // each character's state read as undefined, and the caller got a
  // confident "zero paid out".
  assert.throws(
    () => totalPaidOut("x" as never),
    /invalid totalPaidOut: tasks must be an array/,
  );
});

test("totalPaidOut: a non-task entry throws, naming its index", () => {
  for (const bad of [null, "x", 42]) {
    assert.throws(
      () => totalPaidOut([bad as never]),
      /invalid totalPaidOut: tasks\[0\] must be a task object with a string id, string state, and array history, got /,
    );
  }
});

test("totalPaidOut: an id-only entry throws too", () => {
  // The entry carries a string id but is missing the state and
  // history legs the summing loop reads — without them it would
  // either die as a bare TypeError or slip through as a
  // non-PAID-looking entry that contributes nothing.
  assert.throws(
    () => totalPaidOut([{ id: "t-a" } as never]),
    /invalid totalPaidOut: tasks\[0\] must be a task object with a string id, string state, and array history, got \{"id":"t-a"\}/,
  );
});

test("totalPaidOut: a mixed batch throws and sums nothing", () => {
  const good = toPaid("t-a", { paid: 10 });
  assert.throws(
    () => totalPaidOut([good, null as never]),
    /invalid totalPaidOut: tasks\[1\] must be a task object with a string id, string state, and array history, got null/,
  );
});

test("totalPaidOut: a defensive stand-in shaped like a task still passes", () => {
  // Backlog #893 deliberately passes a plain object shaped like a
  // task, so the guard checks the shape the function reads, not the
  // class. A PAID stand-in with a PAYOUT_COMPLETE entry settles
  // exactly like a real task; a stand-in with no completion entry
  // contributes 0.
  const settled = {
    id: "stand-in-paid",
    state: "PAID",
    history: [{ event: "PAYOUT_COMPLETE", payoutAmount: 25 }],
  } as unknown as TaskLifecycle;
  const unsettled = {
    id: "stand-in-open",
    state: "PAID",
    history: [],
  } as unknown as TaskLifecycle;
  assert.equal(totalPaidOut([settled, unsettled]), 25);
});

test("totalPaidOut: legal batch figures are unchanged, empty is 0", () => {
  assert.equal(totalPaidOut(mixedBatch()), 16349);
  assert.equal(totalPaidOut([]), 0);
});

test("totalQuoted: a non-array batch throws, naming the function", () => {
  for (const bad of [null, "x", 42, {}]) {
    assert.throws(
      () => totalQuoted(bad as never),
      /invalid totalQuoted: tasks must be an array/,
    );
  }
});

test("totalQuoted: a string batch no longer silently returns 0", () => {
  assert.throws(
    () => totalQuoted("x" as never),
    /invalid totalQuoted: tasks must be an array/,
  );
});

test("totalQuoted: a non-task entry throws, naming its index", () => {
  for (const bad of [null, "x", 42]) {
    assert.throws(
      () => totalQuoted([bad as never]),
      /invalid totalQuoted: tasks\[0\] must be a task object with a string id, string state, and array history, got /,
    );
  }
});

test("totalQuoted: an id-only entry throws too", () => {
  assert.throws(
    () => totalQuoted([{ id: "t-a" } as never]),
    /invalid totalQuoted: tasks\[0\] must be a task object with a string id, string state, and array history, got \{"id":"t-a"\}/,
  );
});

test("totalQuoted: legal batch figures are unchanged, empty is 0", () => {
  // Only the two quoted PAID tasks contribute: 4300 + 2200. The
  // quoteless settled task contributes 0, exactly as before.
  assert.equal(totalQuoted(mixedBatch()), 6500);
  assert.equal(totalQuoted([]), 0);
});

test("payoutMismatch: a non-task input throws, naming the function", () => {
  for (const bad of [null, "x", 42]) {
    assert.throws(
      () => payoutMismatch(bad as never),
      /invalid payoutMismatch: task must be a TaskLifecycle/,
    );
  }
});

test("payoutMismatch: a plain {} no longer silently returns undefined", () => {
  // The probe that motivated this item: {} has no state, so it read
  // as "not PAID" and answered undefined — the same answer a
  // genuinely un-mismatched task gives.
  assert.throws(
    () => payoutMismatch({} as never),
    /invalid payoutMismatch: task must be a TaskLifecycle/,
  );
});

test("payoutMismatch: an id-only object throws too", () => {
  assert.throws(
    () => payoutMismatch({ id: "t-a" } as never),
    /invalid payoutMismatch: task must be a TaskLifecycle/,
  );
});

test("payoutMismatch: a defensive stand-in shaped like a task still passes", () => {
  const standIn = {
    id: "stand-in-paid",
    state: "PAID",
    history: [
      { event: "ACCEPT", quotedAmount: 100 },
      { event: "PAYOUT_COMPLETE", payoutAmount: 90 },
    ],
  } as unknown as TaskLifecycle;
  assert.deepEqual(payoutMismatch(standIn), {
    quoted: 100,
    paid: 90,
    delta: -10,
  });
});

test("payoutMismatch: legal tasks keep their old answers", () => {
  assert.deepEqual(
    payoutMismatch(toPaid("t-a", { quoted: 4300, paid: 4050.5 })),
    { quoted: 4300, paid: 4050.5, delta: -249.5 },
  );
  assert.equal(
    payoutMismatch(toPaid("t-b", { quoted: 2200, paid: 2200 })),
    undefined,
  );
  assert.equal(payoutMismatch(toOpen("t-c")), undefined);
  assert.equal(
    payoutMismatch(toPaid("t-d", { paid: 10098.5 })),
    undefined,
  );
});

test("mismatchedPayouts: a non-array batch throws, naming the function", () => {
  for (const bad of [null, "x", 42]) {
    assert.throws(
      () => mismatchedPayouts(bad as never),
      /invalid mismatchedPayouts: tasks must be an array/,
    );
  }
});

test("mismatchedPayouts: a non-task entry throws, naming its index", () => {
  assert.throws(
    () => mismatchedPayouts([null as never]),
    /invalid mismatchedPayouts: tasks\[0\] must be a task object with a string id, string state, and array history, got null/,
  );
});

test("mismatchedPayouts: legal batch selection is unchanged", () => {
  assert.deepEqual(
    mismatchedPayouts(mixedBatch()).map((t) => t.id),
    ["DEMO-005"],
  );
  assert.deepEqual(mismatchedPayouts([]), []);
});
