import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  tasksByActor,
  tasksByEvent,
  tasksByFilters,
  tasksByPayoutRef,
  tasksByState,
} from "../src/index.js";
import type { DispatchOptions } from "../src/index.js";

/** Drive a task from DRAFT to IN_REVIEW. */
function toInReview(id: string, reviewActor = "reviewer"): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: reviewActor });
  assert.equal(t.state, "IN_REVIEW");
  return t;
}

/** Drive a task from DRAFT to DISPUTED, disputed by the given actor. */
function toDisputed(id: string, disputeActor = "moderator"): TaskLifecycle {
  const t = toInReview(id);
  t.dispatch("REJECT", { actor: "reviewer" });
  t.dispatch("DISPUTE", { actor: disputeActor });
  assert.equal(t.state, "DISPUTED");
  return t;
}

/**
 * Drive a task through a full dispute round and back to IN_REVIEW:
 * IN_REVIEW -> REJECTED -> DISPUTED -> REJECTED -> CAPTURING ->
 * SUBMITTED -> IN_REVIEW. Its history carries a DISPUTE entry while
 * its current state is IN_REVIEW again.
 */
function toInReviewAfterDispute(
  id: string,
  disputeActor = "moderator",
): TaskLifecycle {
  const t = toDisputed(id, disputeActor);
  t.dispatch("ARBITRATE_REJECT", { actor: "moderator" });
  t.dispatch("RESUBMIT", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  assert.equal(t.state, "IN_REVIEW");
  return t;
}

/** Drive a task from DRAFT to PAID, with the given completion options. */
function toPaid(
  id: string,
  completeOpts: DispatchOptions = {},
): TaskLifecycle {
  const t = toInReview(id);
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", ...completeOpts });
  assert.equal(t.state, "PAID");
  return t;
}

/** One mixed batch shared by the intersection tests. */
function mixedBatch(): TaskLifecycle[] {
  return [
    toInReview("t-review-a"),
    toDisputed("t-disputed", "moderator"),
    toInReviewAfterDispute("t-review-disputed", "moderator"),
    toPaid("t-paid-a", { payoutRef: "xfer-88f2" }),
    toPaid("t-paid-b", { payoutRef: "xfer-99g3" }),
    new TaskLifecycle("t-draft"),
  ];
}

test("tasksByFilters: a single state condition matches tasksByState", () => {
  const batch = mixedBatch();
  assert.deepEqual(
    tasksByFilters(batch, { state: "IN_REVIEW" }).map((t) => t.id),
    tasksByState(batch, "IN_REVIEW").map((t) => t.id),
  );
  assert.deepEqual(
    tasksByFilters(batch, { state: "IN_REVIEW" }).map((t) => t.id),
    ["t-review-a", "t-review-disputed"],
  );
});

test("tasksByFilters: a single actor condition matches tasksByActor", () => {
  const batch = mixedBatch();
  assert.deepEqual(
    tasksByFilters(batch, { actor: "moderator" }).map((t) => t.id),
    tasksByActor(batch, "moderator").map((t) => t.id),
  );
  assert.deepEqual(
    tasksByFilters(batch, { actor: "moderator" }).map((t) => t.id),
    ["t-disputed", "t-review-disputed"],
  );
});

test("tasksByFilters: a single event condition matches tasksByEvent", () => {
  const batch = mixedBatch();
  assert.deepEqual(
    tasksByFilters(batch, { event: "DISPUTE" }).map((t) => t.id),
    tasksByEvent(batch, "DISPUTE").map((t) => t.id),
  );
  assert.deepEqual(
    tasksByFilters(batch, { event: "DISPUTE" }).map((t) => t.id),
    ["t-disputed", "t-review-disputed"],
  );
});

test("tasksByFilters: a single payoutRef condition matches tasksByPayoutRef", () => {
  const batch = mixedBatch();
  assert.deepEqual(
    tasksByFilters(batch, { payoutRef: "xfer-88f2" }).map((t) => t.id),
    tasksByPayoutRef(batch, "xfer-88f2").map((t) => t.id),
  );
  assert.deepEqual(
    tasksByFilters(batch, { payoutRef: "xfer-88f2" }).map((t) => t.id),
    ["t-paid-a"],
  );
});

test("tasksByFilters: two conditions intersect (state + event)", () => {
  const batch = mixedBatch();
  // Both IN_REVIEW tasks carry BEGIN_REVIEW; only the post-dispute
  // one carries DISPUTE.
  assert.deepEqual(
    tasksByFilters(batch, { state: "IN_REVIEW", event: "DISPUTE" }).map(
      (t) => t.id,
    ),
    ["t-review-disputed"],
  );
  assert.deepEqual(
    tasksByFilters(batch, { state: "IN_REVIEW", event: "BEGIN_REVIEW" }).map(
      (t) => t.id,
    ),
    ["t-review-a", "t-review-disputed"],
  );
});

test("tasksByFilters: three conditions intersect (state + actor + event)", () => {
  const batch = mixedBatch();
  // The board query from the backlog: IN_REVIEW tasks the moderator
  // disputed.
  assert.deepEqual(
    tasksByFilters(batch, {
      state: "IN_REVIEW",
      actor: "moderator",
      event: "DISPUTE",
    }).map((t) => t.id),
    ["t-review-disputed"],
  );
  // Same state and event, but no actor named "auditor" ever touched
  // any task in the batch — the actor condition is presence anywhere
  // in the history, so a reviewer (who did reject and re-review the
  // task) would still match; only a never-present actor excludes it.
  assert.deepEqual(
    tasksByFilters(batch, {
      state: "IN_REVIEW",
      actor: "auditor",
      event: "DISPUTE",
    }),
    [],
  );
});

test("tasksByFilters: four conditions intersect (state + actor + event + payoutRef)", () => {
  const batch = mixedBatch();
  assert.deepEqual(
    tasksByFilters(batch, {
      state: "PAID",
      actor: "system",
      event: "PAYOUT_COMPLETE",
      payoutRef: "xfer-88f2",
    }).map((t) => t.id),
    ["t-paid-a"],
  );
  // Same slice under the other transfer finds the other task.
  assert.deepEqual(
    tasksByFilters(batch, {
      state: "PAID",
      actor: "system",
      event: "PAYOUT_COMPLETE",
      payoutRef: "xfer-99g3",
    }).map((t) => t.id),
    ["t-paid-b"],
  );
  // A request-only ref is not settlement evidence, even combined.
  assert.deepEqual(
    tasksByFilters(batch, {
      state: "PAID",
      event: "PAYOUT_COMPLETE",
      payoutRef: "xfer-nope",
    }),
    [],
  );
});

test("tasksByFilters: an empty condition object returns every task, in input order", () => {
  const batch = mixedBatch();
  const found = tasksByFilters(batch, {});
  assert.deepEqual(
    found.map((t) => t.id),
    [
      "t-review-a",
      "t-disputed",
      "t-review-disputed",
      "t-paid-a",
      "t-paid-b",
      "t-draft",
    ],
  );
  // Same task objects, not copies.
  assert.equal(found[0], batch[0]);
  assert.equal(found[5], batch[5]);
});

test("tasksByFilters: an unknown state fails fast", () => {
  const batch = mixedBatch();
  for (const bad of ["BOGUS", "in_review", "", "OPENN"]) {
    assert.throws(
      () => tasksByFilters(batch, { state: bad as never }),
      /invalid tasksByFilters: unknown state/,
    );
  }
});

test("tasksByFilters: an unknown event fails fast", () => {
  const batch = mixedBatch();
  for (const bad of ["DISPUT", "DISPUTED", "", "begin_review"]) {
    assert.throws(
      () => tasksByFilters(batch, { event: bad as never }),
      /invalid tasksByFilters: unknown event/,
    );
  }
});

test("tasksByFilters: an empty or non-string actor/payoutRef fails fast", () => {
  const batch = mixedBatch();
  for (const bad of ["", 42, null, undefined]) {
    // undefined means "condition absent", so it must NOT throw.
    if (bad === undefined) continue;
    assert.throws(
      () => tasksByFilters(batch, { actor: bad as never }),
      /invalid tasksByFilters: actor must be a non-empty string/,
    );
    assert.throws(
      () => tasksByFilters(batch, { payoutRef: bad as never }),
      /invalid tasksByFilters: payoutRef must be a non-empty string/,
    );
  }
  // Explicit undefined is the same as omitting the condition.
  assert.equal(tasksByFilters(batch, { actor: undefined }).length, 6);
  assert.equal(tasksByFilters(batch, { payoutRef: undefined }).length, 6);
});

test("tasksByFilters: pure — input order, task states and histories are untouched", () => {
  const batch = mixedBatch();
  const beforeIds = batch.map((t) => t.id);
  const beforeStates = batch.map((t) => t.state);
  const beforeHistories = batch.map((t) => t.history);
  const found = tasksByFilters(batch, {
    state: "IN_REVIEW",
    event: "DISPUTE",
  });
  assert.equal(found.length, 1);
  assert.deepEqual(
    batch.map((t) => t.id),
    beforeIds,
  );
  assert.deepEqual(
    batch.map((t) => t.state),
    beforeStates,
  );
  assert.deepEqual(
    batch.map((t) => t.history),
    beforeHistories,
  );
  // The result is a fresh array: mutating it must not touch the input.
  found.push(new TaskLifecycle("t-extra"));
  assert.equal(batch.length, 6);
});

test("tasksByFilters: empty input returns an empty array", () => {
  assert.deepEqual(tasksByFilters([], { state: "IN_REVIEW" }), []);
  assert.deepEqual(tasksByFilters([], {}), []);
});

test("tasksByFilters: an unknown filter key fails fast, naming the key (backlog #1013)", () => {
  const batch = mixedBatch();
  // The classic typo: `state` misspelled as `states` used to be
  // silently ignored and return the unfiltered batch.
  assert.throws(
    () => tasksByFilters(batch, { states: "IN_REVIEW" } as never),
    /invalid tasksByFilters: unknown filter "states"/,
  );
  // Case variants of a legal axis are not legal axes.
  assert.throws(
    () => tasksByFilters(batch, { State: "IN_REVIEW" } as never),
    /invalid tasksByFilters: unknown filter "State"/,
  );
  // A plausible-but-nonexistent axis is rejected the same way.
  assert.throws(
    () => tasksByFilters(batch, { status: "IN_REVIEW" } as never),
    /invalid tasksByFilters: unknown filter "status"/,
  );
  // The payoutRef axis is case-sensitive too.
  assert.throws(
    () => tasksByFilters(batch, { payoutref: "xfer-88f2" } as never),
    /invalid tasksByFilters: unknown filter "payoutref"/,
  );
  // The whitelist scan runs before any filtering, even on an
  // empty batch.
  assert.throws(
    () => tasksByFilters([], { states: "IN_REVIEW" } as never),
    /invalid tasksByFilters: unknown filter "states"/,
  );
});

test("tasksByFilters: a legal condition plus an unknown key throws instead of returning a partial slice", () => {
  const batch = mixedBatch();
  // The legal half alone would select [t-review-a,
  // t-review-disputed]; the unknown half must not be dropped and
  // the call must not return that slice as if the extra condition
  // never existed.
  assert.throws(
    () =>
      tasksByFilters(batch, {
        state: "IN_REVIEW",
        states: "IN_REVIEW",
      } as never),
    /invalid tasksByFilters: unknown filter "states"/,
  );
  assert.throws(
    () =>
      tasksByFilters(batch, {
        actor: "moderator",
        status: "IN_REVIEW",
      } as never),
    /invalid tasksByFilters: unknown filter "status"/,
  );
});

test("tasksByFilters: a non-object filters argument throws a configuration error, not a TypeError", () => {
  const batch = mixedBatch();
  assert.throws(
    () => tasksByFilters(batch, null as never),
    /invalid tasksByFilters: filters must be an object, got null/,
  );
  assert.throws(
    () => tasksByFilters(batch, undefined as never),
    /invalid tasksByFilters: filters must be an object, got undefined/,
  );
  assert.throws(
    () => tasksByFilters(batch, 42 as never),
    /invalid tasksByFilters: filters must be an object, got number/,
  );
  assert.throws(
    () => tasksByFilters(batch, "IN_REVIEW" as never),
    /invalid tasksByFilters: filters must be an object, got string/,
  );
  assert.throws(
    () => tasksByFilters(batch, [] as never),
    /invalid tasksByFilters: filters must be an object, got array/,
  );
});

test("tasksByFilters: the key whitelist is checked before value validation", () => {
  const batch = mixedBatch();
  // Both the key and the value are wrong here: the unknown-key
  // error wins, because the whitelist scan runs at the entry.
  assert.throws(
    () =>
      tasksByFilters(batch, {
        state: "IN_REVIEWW",
        states: "IN_REVIEW",
      } as never),
    /invalid tasksByFilters: unknown filter "states"/,
  );
  assert.throws(
    () =>
      tasksByFilters(batch, {
        actor: "",
        payoutref: "xfer-88f2",
      } as never),
    /invalid tasksByFilters: unknown filter "payoutref"/,
  );
});

test("tasksByFilters: all four legal keys still combine after the guard (backlog #1013)", () => {
  const batch = mixedBatch();
  // The four-axis slice from the existing intersection test must
  // be unchanged by the whitelist: the guard only rejects keys
  // outside the four.
  assert.deepEqual(
    tasksByFilters(batch, {
      state: "PAID",
      actor: "system",
      event: "PAYOUT_COMPLETE",
      payoutRef: "xfer-88f2",
    }).map((t) => t.id),
    ["t-paid-a"],
  );
  // And the empty filter still selects the whole batch.
  assert.deepEqual(
    tasksByFilters(batch, {}).map((t) => t.id),
    [
      "t-review-a",
      "t-disputed",
      "t-review-disputed",
      "t-paid-a",
      "t-paid-b",
      "t-draft",
    ],
  );
});

test("tasksByFilters: an explicitly-undefined legal key is still not a condition", () => {
  const batch = mixedBatch();
  // undefined values are the "condition absent" spelling, so they
  // must survive the whitelist scan (the key itself is legal) and
  // not throw.
  assert.equal(
    tasksByFilters(batch, {
      state: undefined,
      actor: undefined,
      event: undefined,
      payoutRef: undefined,
    }).length,
    6,
  );
});
