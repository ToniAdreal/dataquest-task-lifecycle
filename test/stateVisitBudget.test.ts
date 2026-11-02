import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, transitionTable } from "../src/taskLifecycle.js";

/**
 * Per-state visit budget (TaskLifecycleOptions.maxVisitsByState).
 *
 * The budget caps how many times the task may ENTER each listed state —
 * not how many times it may run an event. A visit is counted as 1 for
 * the task's initial state (the first history entry's `from`, or the
 * current state when the history is still empty) plus 1 per history
 * entry whose `to` is that state, so the count is derived from the
 * append-only history and survives toJSON()/fromJSON() round-trips
 * together with the budget itself. States absent from the map are
 * unlimited; omitting the map disables the check entirely.
 *
 * Note the asymmetry the tests pin down: CAPTURING with budget 1 is
 * already spent by the task's first pass through CAPTURING, so even the
 * first RESUBMIT is blocked — the budget counts total visits, not
 * re-entries on top of the first visit.
 */

const TO_REJECTED: Array<
  "PUBLISH" | "ACCEPT" | "START_CAPTURE" | "SUBMIT" | "BEGIN_REVIEW" | "REJECT"
> = ["PUBLISH", "ACCEPT", "START_CAPTURE", "SUBMIT", "BEGIN_REVIEW", "REJECT"];

/** Drive a fresh task to REJECTED (first time or after a resubmit loop). */
function toRejected(task: TaskLifecycle): void {
  for (const event of TO_REJECTED) task.dispatch(event);
}

const RESUBMIT_BACK_TO_REJECTED: Array<"SUBMIT" | "BEGIN_REVIEW" | "REJECT"> = [
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
];

/** One RESUBMIT round: from REJECTED back to REJECTED. */
function resubmitRound(task: TaskLifecycle): void {
  task.dispatch("RESUBMIT"); // REJECTED -> CAPTURING
  for (const event of RESUBMIT_BACK_TO_REJECTED) task.dispatch(event);
}

describe("state visit budget", () => {
  it("budget 1 for CAPTURING: the first RESUBMIT is already blocked (initial visit spent it)", () => {
    const task = new TaskLifecycle("t1", { maxVisitsByState: { CAPTURING: 1 } });
    toRejected(task); // CAPTURING visited once on the way here
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: CAPTURING already visited 1 of 1 times",
      "re-entering CAPTURING must throw the explicit budget error",
    );
    assert.equal(task.state, "REJECTED");
  });

  it("budget 2 for CAPTURING: first re-entry passes, second re-entry throws", () => {
    const task = new TaskLifecycle("t2", { maxVisitsByState: { CAPTURING: 2 } });
    toRejected(task); // CAPTURING visited 1 of 2
    resubmitRound(task); // second visit, now 2 of 2, back at REJECTED
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: CAPTURING already visited 2 of 2 times",
    );
    assert.equal(task.state, "REJECTED");
  });

  it("initial-state counting: DRAFT budget 1 does not block PUBLISH (no edge re-enters DRAFT)", () => {
    // The transition table has no edge targeting DRAFT, so the initial
    // DRAFT visit can never be "re-entered" — the honest observable
    // content of the initial-count rule is that the DRAFT budget does
    // not leak into other states' counts.
    assert.deepEqual(
      transitionTable().filter((e) => e.to === "DRAFT"),
      [],
      "no transition targets DRAFT in this table",
    );
    const task = new TaskLifecycle("t3", { maxVisitsByState: { DRAFT: 1 } });
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE");
    assert.equal(task.state, "CAPTURING");
  });

  it("unlisted states are unlimited: OPEN budget 1 still allows a full run to PAID", () => {
    const task = new TaskLifecycle("t4", { maxVisitsByState: { OPEN: 1 } });
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE");
    task.dispatch("SUBMIT");
    task.dispatch("BEGIN_REVIEW");
    task.dispatch("APPROVE");
    task.dispatch("REQUEST_PAYOUT");
    task.dispatch("PAYOUT_COMPLETE");
    assert.equal(task.state, "PAID");
  });

  it("default (no opts): unlimited re-entries, pre-budget behavior unchanged", () => {
    const task = new TaskLifecycle("t5");
    toRejected(task);
    for (let i = 0; i < 5; i++) resubmitRound(task);
    assert.equal(task.state, "REJECTED");
    const task2 = new TaskLifecycle("t6", {});
    toRejected(task2);
    for (let i = 0; i < 5; i++) resubmitRound(task2);
    assert.equal(task2.state, "REJECTED");
  });

  it("rejected dispatch leaves no gap: after a failed re-entry, later legal events keep appending", () => {
    const task = new TaskLifecycle("t7", { maxVisitsByState: { CAPTURING: 1 } });
    toRejected(task);
    const before = task.history.length;
    assert.throws(() => task.dispatch("RESUBMIT"));
    assert.equal(task.history.length, before);
    task.dispatch("DISPUTE"); // legal event still appends cleanly
    assert.equal(task.history.length, before + 1);
    assert.equal(task.history[before].seq, before + 1);
  });

  it("transition check runs before the budget check", () => {
    const task = new TaskLifecycle("t8", { maxVisitsByState: { CAPTURING: 1 } });
    // In DRAFT, RESUBMIT is an illegal event: the transition error wins,
    // even though the visit budget is also spent.
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error && err.message === "invalid transition: RESUBMIT from DRAFT",
    );
  });

  it("RBAC check runs before the budget check", () => {
    const task = new TaskLifecycle("t9", {
      maxVisitsByState: { CAPTURING: 1 },
      rolePolicy: { RESUBMIT: ["moderator"] },
    });
    toRejected(task); // CAPTURING budget already spent
    assert.throws(
      () => task.dispatch("RESUBMIT", { actor: "contributor" }),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          'actor not authorized for RESUBMIT: "contributor" is not in [moderator]',
    );
  });

  it("constructor rejects invalid budgets", () => {
    const badMaps: Array<Record<string, unknown>> = [
      { CAPTURING: 0 },
      { CAPTURING: -1 },
      { CAPTURING: 1.5 },
      { CAPTURING: Number.NaN },
      { CAPTURING: Infinity },
      { CAPTURING: "1" },
      { CAPTURING: null },
      { OPENN: 1 },
    ];
    for (const bad of badMaps) {
      assert.throws(
        () => new TaskLifecycle("bad", { maxVisitsByState: bad as never }),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith("invalid option: maxVisitsByState"),
        `maxVisitsByState=${JSON.stringify(bad)} must throw`,
      );
    }
    for (const bad of ["x" as never, [] as never, null as never]) {
      assert.throws(
        () => new TaskLifecycle("bad", { maxVisitsByState: bad }),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith("invalid option: maxVisitsByState"),
      );
    }
  });

  it("snapshot round-trip preserves budget AND used count (no reset)", () => {
    const task = new TaskLifecycle("t10", { maxVisitsByState: { CAPTURING: 2 } });
    toRejected(task);
    resubmitRound(task); // visited CAPTURING 2 of 2
    const json = JSON.parse(JSON.stringify(task)) as {
      maxVisitsByState?: Record<string, number>;
    };
    assert.deepEqual(json.maxVisitsByState, { CAPTURING: 2 });

    const restored = TaskLifecycle.fromJSON(json);
    assert.equal(restored.state, "REJECTED");
    assert.throws(
      () => restored.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith("state visit budget exhausted: CAPTURING already visited 2 of 2"),
      "budget must not reset after a round-trip",
    );
  });

  it("unbudgeted task snapshots carry no maxVisitsByState field and rehydrate unlimited", () => {
    const task = new TaskLifecycle("t11");
    toRejected(task);
    resubmitRound(task);
    const snap = task.toJSON();
    assert.equal("maxVisitsByState" in snap, false);
    const restored = TaskLifecycle.fromJSON(JSON.parse(JSON.stringify(snap)));
    assert.equal(restored.state, "REJECTED");
    resubmitRound(restored);
    resubmitRound(restored); // still unlimited after the round-trip
  });

  it("fromJSON accepts a snapshot whose history already exceeds its budget (policy for the future, not history truth)", () => {
    const task = new TaskLifecycle("t12", { maxVisitsByState: { CAPTURING: 2 } });
    toRejected(task);
    resubmitRound(task); // visited CAPTURING 2 of 2
    const snap = task.toJSON();
    // Hand-edit the envelope down to a stricter budget: a truthful record.
    const strict = TaskLifecycle.fromJSON({ ...snap, maxVisitsByState: { CAPTURING: 1 } });
    assert.equal(strict.state, "REJECTED");
    assert.throws(
      () => strict.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith("state visit budget exhausted: CAPTURING already visited 2 of 1"),
    );
  });

  it("fromHistory re-attaches a budget; used count derives from the replayed log", () => {
    const task = new TaskLifecycle("t13", { maxVisitsByState: { CAPTURING: 2 } });
    toRejected(task);
    resubmitRound(task); // visited CAPTURING 2 of 2
    const log = JSON.parse(JSON.stringify(task.history));

    const revived = TaskLifecycle.fromHistory("t13", log, {
      maxVisitsByState: { CAPTURING: 2 },
    });
    assert.equal(revived.state, "REJECTED");
    assert.throws(
      () => revived.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith("state visit budget exhausted: CAPTURING already visited 2 of 2"),
    );

    // Without opts, the same log rehydrates with no budget.
    const free = TaskLifecycle.fromHistory("t13", log);
    resubmitRound(free);
    assert.equal(free.state, "REJECTED");
  });

  it("fromJSON rejects malformed maxVisitsByState envelopes", () => {
    const base = { id: "t14", state: "DRAFT", history: [], slaDeadlines: {} };
    for (const bad of [
      { CAPTURING: 0 },
      { CAPTURING: 1.5 },
      { OPENN: 1 },
      "x",
      null,
    ]) {
      assert.throws(
        () => TaskLifecycle.fromJSON({ ...base, maxVisitsByState: bad }),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith("invalid snapshot: maxVisitsByState"),
        `maxVisitsByState=${JSON.stringify(bad)} must be rejected`,
      );
    }
  });

  it("budget on REJECTED: second entry via ARBITRATE_REJECT is blocked", () => {
    const task = new TaskLifecycle("t15", { maxVisitsByState: { REJECTED: 1 } });
    toRejected(task); // REJECTED visited 1 of 1
    task.dispatch("DISPUTE"); // REJECTED -> DISPUTED, unbudgeted
    assert.throws(
      () => task.dispatch("ARBITRATE_REJECT"),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: REJECTED already visited 1 of 1 times",
    );
    assert.equal(task.state, "DISPUTED");
  });

  it("budget is state-based, not event-based: second IN_REVIEW entry via BEGIN_REVIEW is blocked", () => {
    const task = new TaskLifecycle("t16", { maxVisitsByState: { IN_REVIEW: 1 } });
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE");
    task.dispatch("SUBMIT");
    task.dispatch("BEGIN_REVIEW"); // IN_REVIEW visited 1 of 1
    task.dispatch("REJECT"); // -> REJECTED
    task.dispatch("RESUBMIT"); // -> CAPTURING, unbudgeted
    task.dispatch("SUBMIT"); // -> SUBMITTED
    assert.throws(
      () => task.dispatch("BEGIN_REVIEW"),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: IN_REVIEW already visited 1 of 1 times",
    );
    assert.equal(task.state, "SUBMITTED");
  });
});
