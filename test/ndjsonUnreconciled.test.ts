import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
  unreconciledPayouts,
} from "../src/index.js";

/**
 * NDJSON history export x unreconciled-payout screening (backlog #687).
 *
 * NDJSON round-trips (`test/ndjson.test.ts`, `test/ndjsonPayout.test.ts`)
 * and unreconciled screening (`test/unreconciledPayouts.test.ts`) each
 * have coverage, but their combination did not: a mixed batch exported
 * to NDJSON per task and replayed via `fromHistory` must screen exactly
 * the same unreconciled set as before the hop — no task gained or lost
 * a payout reference in serialization, and no non-PAID task became
 * (or stopped being) a screening candidate.
 *
 * Rules under test:
 *  - mixed batch (ref PAID, no-ref PAID, request-only-ref PAID,
 *    PAYOUT_PENDING, EXPIRED) screens identically before and after
 *    the per-task NDJSON -> fromHistory round-trip, in input order
 *  - rebuilt tasks keep their state and full history deep-equal
 *    (entry key order may differ after re-chaining, values may not)
 *  - a ref on REQUEST_PAYOUT alone still leaves the task
 *    unreconciled after the hop: the screen reads the
 *    PAYOUT_COMPLETE entry, and NDJSON must not promote the request
 *    ref onto the completion entry
 *  - a second NDJSON hop keeps the screening identical again
 *  - a damaged payout line fails closed with the NDJSON line-number
 *    error (`invalid ndjson: line N: …`), not a silent drop of the
 *    money fields: negative payoutAmount and empty payoutRef on
 *    the PAYOUT_COMPLETE (8th) line
 */

/** Drive a task from DRAFT to APPROVED (one step before payout). */
function toApproved(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

/** Drive a task all the way to PAID with the given payout fields. */
function toPaid(
  id: string,
  payout: { requestRef?: string; completionRef?: string; payoutAmount?: number } = {},
): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    ...(payout.requestRef !== undefined
      ? { payoutRef: payout.requestRef }
      : {}),
  });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    ...(payout.completionRef !== undefined
      ? { payoutRef: payout.completionRef }
      : {}),
    ...(payout.payoutAmount !== undefined
      ? { payoutAmount: payout.payoutAmount }
      : {}),
  });
  assert.equal(t.state, "PAID");
  return t;
}

/** Export each task to NDJSON and rebuild it via fromHistory. */
function roundTrip(tasks: readonly TaskLifecycle[]): TaskLifecycle[] {
  return tasks.map((t) =>
    TaskLifecycle.fromHistory(t.id, historyFromNdjson(historyToNdjson(t))),
  );
}

/** Replace the PAYOUT_COMPLETE (last) NDJSON line with a mutated copy. */
function withMutatedLastLine(
  text: string,
  mutate: (entry: Record<string, unknown>) => void,
): string {
  const lines = text.trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  mutate(last);
  lines[lines.length - 1] = JSON.stringify(last);
  return lines.join("\n") + "\n";
}

/** The mixed batch this file screens, in screening order. */
function mixedBatch(): TaskLifecycle[] {
  const paidWithRef = toPaid("mix-with-ref", {
    completionRef: "xfer-mix-1",
    payoutAmount: 4200,
  });
  const paidNoRef = toPaid("mix-no-ref", { payoutAmount: 1500 });
  const requestOnlyRef = toPaid("mix-request-only-ref", {
    requestRef: "batch-mix-9",
    payoutAmount: 900,
  });
  const payoutPending = toApproved("mix-pending");
  payoutPending.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const expired = new TaskLifecycle("mix-expired");
  expired.dispatch("PUBLISH", { actor: "researcher" });
  expired.dispatch("EXPIRE", { actor: "system" });
  return [paidWithRef, paidNoRef, requestOnlyRef, payoutPending, expired];
}

describe("NDJSON x unreconciled payouts", () => {
  it("mixed batch screens identically before and after the NDJSON hop", () => {
    const tasks = mixedBatch();
    const before = unreconciledPayouts(tasks).map((t) => t.id);
    assert.deepEqual(before, ["mix-no-ref", "mix-request-only-ref"]);

    const rebuilt = roundTrip(tasks);
    assert.deepEqual(
      rebuilt.map((t) => t.state),
      tasks.map((t) => t.state),
    );
    // deepEqual, not JSON strings: re-chaining reorders entry keys,
    // so byte order differs while every field value is identical.
    assert.deepEqual(
      rebuilt.map((t) => [...t.history]),
      tasks.map((t) => [...t.history]),
    );
    assert.deepEqual(
      unreconciledPayouts(rebuilt).map((t) => t.id),
      before,
    );
  });

  it("a request-only ref stays unreconciled after the NDJSON hop", () => {
    const task = toPaid("ndjson-unrec-request-only", {
      requestRef: "batch-2026-1028",
      payoutAmount: 750,
    });
    assert.deepEqual(unreconciledPayouts([task]).map((t) => t.id), [
      "ndjson-unrec-request-only",
    ]);
    const rebuilt = roundTrip([task])[0];
    const last = rebuilt.history[rebuilt.history.length - 1];
    assert.equal(last.event, "PAYOUT_COMPLETE");
    assert.equal(last.payoutRef, undefined);
    assert.equal(last.payoutAmount, 750);
    assert.deepEqual(unreconciledPayouts([rebuilt]).map((t) => t.id), [
      "ndjson-unrec-request-only",
    ]);
  });

  it("a second NDJSON hop keeps the screening identical", () => {
    const tasks = mixedBatch();
    const expected = unreconciledPayouts(tasks).map((t) => t.id);
    const twice = roundTrip(roundTrip(tasks));
    assert.deepEqual(
      unreconciledPayouts(twice).map((t) => t.id),
      expected,
    );
    assert.deepEqual(
      twice.map((t) => [...t.history]),
      tasks.map((t) => [...t.history]),
    );
  });

  it("negative payoutAmount on the last line fails with its line number", () => {
    const task = toPaid("ndjson-unrec-bad-amount", {
      completionRef: "xfer-unrec-8",
      payoutAmount: 100,
    });
    const bad = withMutatedLastLine(historyToNdjson(task), (entry) => {
      entry.payoutAmount = -5;
    });
    assert.throws(
      () => historyFromNdjson(bad),
      /invalid ndjson: line 8: payoutAmount must be a non-negative finite number, got -5/,
    );
  });

  it("empty payoutRef on the last line fails with its line number", () => {
    const task = toPaid("ndjson-unrec-bad-ref", {
      completionRef: "xfer-unrec-9",
      payoutAmount: 100,
    });
    const bad = withMutatedLastLine(historyToNdjson(task), (entry) => {
      entry.payoutRef = "";
    });
    assert.throws(
      () => historyFromNdjson(bad),
      /invalid ndjson: line 8: payoutRef must be a non-empty string, got ""/,
    );
  });
});
