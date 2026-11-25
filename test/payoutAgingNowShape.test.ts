import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, payoutAging } from "../src/index.js";

/**
 * `payoutAging(tasks, now)` — front `now` guard (backlog #1393).
 *
 * `payoutAging` used to read `now.getTime()` before any guard, so a
 * `null` or non-Date `now` died as a bare TypeError
 * (`Cannot read properties of null (reading 'getTime')` /
 * `now.getTime is not a function`) — the same failure mode backlog
 * #1390 fixed in the scheduler/watchdog `now` readers, and which
 * #1342's inheritance claim did not cover: the batch guard is
 * inherited from `unreconciledPayouts`, but `payoutAging` reads
 * `now` before it calls `unreconciledPayouts(tasks)`, so the `now`
 * leg needs its own guard, placed first.
 *
 * Rules under test:
 *  - `null` / string / number / plain-object `now` throws the named
 *    error `invalid now: expected a valid Date` — a plain Error,
 *    never a TypeError
 *  - an invalid Date throws the same named error (pre-existing
 *    behaviour, unchanged)
 *  - guard order: a bad `now` is reported before a bad batch, so a
 *    broken clock is never masked by a malformed batch
 *  - a valid `now` still buckets exactly as before (one task in
 *    each of the four buckets, same fixture idiom as
 *    `payoutAging.test.ts`), and an empty batch still returns four
 *    empty buckets
 */

const NOW = new Date("2026-04-01T00:00:00.000Z");

/** Drive a task DRAFT → … → PAID, completion at `completeAt`. */
function toPaid(id: string, completeAt: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  const completeMs = Date.parse(completeAt);
  const at = (minutesBefore: number): string =>
    new Date(completeMs - minutesBefore * 60_000).toISOString();
  t.dispatch("PUBLISH", { actor: "researcher", at: at(7) });
  t.dispatch("ACCEPT", { actor: "contributor", at: at(6) });
  t.dispatch("START_CAPTURE", { actor: "contributor", at: at(5) });
  t.dispatch("SUBMIT", { actor: "contributor", at: at(4) });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: at(3) });
  t.dispatch("APPROVE", { actor: "reviewer", at: at(2) });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", at: at(1) });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", at: completeAt });
  assert.equal(t.state, "PAID");
  return t;
}

/** Assert a call throws the named error as a plain Error, not a TypeError. */
function assertInvalidNow(fn: () => unknown): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(error.message, "invalid now: expected a valid Date");
      return true;
    },
  );
}

test("null now throws the named error, not a TypeError", () => {
  assertInvalidNow(() => payoutAging([toPaid("age-null", "2026-03-30T00:00:00.000Z")], null as unknown as Date));
});

test("string now throws the named error, not a TypeError", () => {
  assertInvalidNow(() => payoutAging([toPaid("age-str", "2026-03-30T00:00:00.000Z")], "bad" as unknown as Date));
});

test("number now throws the named error, not a TypeError", () => {
  assertInvalidNow(() => payoutAging([toPaid("age-num", "2026-03-30T00:00:00.000Z")], 42 as unknown as Date));
});

test("plain-object now throws the named error, not a TypeError", () => {
  assertInvalidNow(() => payoutAging([toPaid("age-obj", "2026-03-30T00:00:00.000Z")], {} as unknown as Date));
});

test("invalid Date still throws the same named error", () => {
  assertInvalidNow(() => payoutAging([toPaid("age-nan", "2026-03-30T00:00:00.000Z")], new Date(NaN)));
});

test("bad now is reported before a bad batch (guard order)", () => {
  // A non-array batch on its own throws the inherited
  // `invalid unreconciledPayouts: …` error; paired with a bad `now`
  // the clock error must win, because the guard runs first.
  assertInvalidNow(() => payoutAging("bad" as unknown as TaskLifecycle[], null as unknown as Date));
  assertInvalidNow(() => payoutAging("bad" as unknown as TaskLifecycle[], "bad" as unknown as Date));
});

test("valid now still buckets one task per bucket", () => {
  const tasks = [
    toPaid("age-fresh", "2026-03-30T00:00:00.000Z"),
    toPaid("age-22", "2026-03-10T00:00:00.000Z"),
    toPaid("age-30", "2026-03-02T00:00:00.000Z"),
    {
      id: "age-unknown",
      state: "PAID",
      history: [],
    } as unknown as TaskLifecycle,
  ];
  assert.deepEqual(payoutAging(tasks, NOW), {
    under7Days: [{ id: "age-fresh", ageDays: 2 }],
    days7To30: [{ id: "age-22", ageDays: 22 }],
    over30Days: [{ id: "age-30", ageDays: 30 }],
    unknown: [{ id: "age-unknown" }],
  });
});

test("empty batch with a valid now returns four empty buckets", () => {
  assert.deepEqual(payoutAging([], NOW), {
    under7Days: [],
    days7To30: [],
    over30Days: [],
    unknown: [],
  });
});
