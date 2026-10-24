import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, tasksByState } from "../src/index.js";
import type { TaskEvent, TaskState } from "../src/index.js";

/** Build a task in the given state by dispatching the legal event chain. */
function taskInState(id: string, state: TaskState): TaskLifecycle {
  const chains: Record<TaskState, TaskEvent[]> = {
    DRAFT: [],
    OPEN: ["PUBLISH"],
    ACCEPTED: ["PUBLISH", "ACCEPT"],
    CAPTURING: ["PUBLISH", "ACCEPT", "START_CAPTURE"],
    SUBMITTED: ["PUBLISH", "ACCEPT", "START_CAPTURE", "SUBMIT"],
    IN_REVIEW: ["PUBLISH", "ACCEPT", "START_CAPTURE", "SUBMIT", "BEGIN_REVIEW"],
    APPROVED: [
      "PUBLISH",
      "ACCEPT",
      "START_CAPTURE",
      "SUBMIT",
      "BEGIN_REVIEW",
      "APPROVE",
    ],
    PAYOUT_PENDING: [
      "PUBLISH",
      "ACCEPT",
      "START_CAPTURE",
      "SUBMIT",
      "BEGIN_REVIEW",
      "APPROVE",
      "REQUEST_PAYOUT",
    ],
    PAID: [
      "PUBLISH",
      "ACCEPT",
      "START_CAPTURE",
      "SUBMIT",
      "BEGIN_REVIEW",
      "APPROVE",
      "REQUEST_PAYOUT",
      "PAYOUT_COMPLETE",
    ],
    REJECTED: [
      "PUBLISH",
      "ACCEPT",
      "START_CAPTURE",
      "SUBMIT",
      "BEGIN_REVIEW",
      "REJECT",
    ],
    DISPUTED: [
      "PUBLISH",
      "ACCEPT",
      "START_CAPTURE",
      "SUBMIT",
      "BEGIN_REVIEW",
      "REJECT",
      "DISPUTE",
    ],
    ABANDONED: ["PUBLISH", "ACCEPT", "ABANDON"],
    EXPIRED: ["PUBLISH", "EXPIRE"],
  };
  const task = new TaskLifecycle(id);
  for (const event of chains[state]) {
    task.dispatch(event, { actor: "system" });
  }
  assert.equal(task.state, state);
  return task;
}

test("tasksByState: picks only the target state from a mixed batch, in input order", () => {
  const batch = [
    taskInState("t-open", "OPEN"),
    taskInState("t-review-a", "IN_REVIEW"),
    taskInState("t-paid", "PAID"),
    taskInState("t-review-b", "IN_REVIEW"),
    taskInState("t-draft", "DRAFT"),
  ];
  assert.deepEqual(
    tasksByState(batch, "IN_REVIEW").map((t) => t.id),
    ["t-review-a", "t-review-b"],
  );
});

test("tasksByState: terminal states filter exactly like non-terminal ones", () => {
  const batch = [
    taskInState("t-paid", "PAID"),
    taskInState("t-open", "OPEN"),
    taskInState("t-abandoned", "ABANDONED"),
    taskInState("t-expired", "EXPIRED"),
    taskInState("t-review", "IN_REVIEW"),
  ];
  assert.deepEqual(
    tasksByState(batch, "PAID").map((t) => t.id),
    ["t-paid"],
  );
  assert.deepEqual(
    tasksByState(batch, "ABANDONED").map((t) => t.id),
    ["t-abandoned"],
  );
  assert.deepEqual(
    tasksByState(batch, "EXPIRED").map((t) => t.id),
    ["t-expired"],
  );
  assert.deepEqual(
    tasksByState(batch, "OPEN").map((t) => t.id),
    ["t-open"],
  );
});

test("tasksByState: empty input returns an empty array", () => {
  assert.deepEqual(tasksByState([], "IN_REVIEW"), []);
});

test("tasksByState: no task in the target state returns an empty array, not an error", () => {
  const batch = [
    taskInState("t-open", "OPEN"),
    taskInState("t-draft", "DRAFT"),
  ];
  assert.deepEqual(tasksByState(batch, "PAID"), []);
});

test("tasksByState: pure — input order, task states and histories are untouched", () => {
  const batch = [
    taskInState("t-review", "IN_REVIEW"),
    taskInState("t-open", "OPEN"),
    taskInState("t-review-2", "IN_REVIEW"),
  ];
  const beforeIds = batch.map((t) => t.id);
  const beforeStates = batch.map((t) => t.state);
  const beforeHistories = batch.map((t) => t.history);
  const found = tasksByState(batch, "IN_REVIEW");
  assert.equal(found.length, 2);
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
  found.push(taskInState("t-extra", "IN_REVIEW"));
  assert.equal(batch.length, 3);
});

test("tasksByState: returns the same task objects, not copies", () => {
  const review = taskInState("t-review", "IN_REVIEW");
  const open = taskInState("t-open", "OPEN");
  const found = tasksByState([open, review], "IN_REVIEW");
  assert.equal(found.length, 1);
  assert.equal(found[0], review);
});

test("tasksByState: unknown state fails fast instead of returning an empty list", () => {
  const batch = [taskInState("t-open", "OPEN")];
  for (const bad of ["BOGUS", "in_review", "", "OPENN"]) {
    assert.throws(
      () => tasksByState(batch, bad as TaskState),
      /invalid tasksByState: unknown state/,
    );
  }
});

test("tasksByState: filters on the current state, so a moved task changes buckets", () => {
  const task = taskInState("t-moving", "IN_REVIEW");
  assert.deepEqual(
    tasksByState([task], "IN_REVIEW").map((t) => t.id),
    ["t-moving"],
  );
  task.dispatch("APPROVE", { actor: "system" });
  assert.deepEqual(tasksByState([task], "IN_REVIEW"), []);
  assert.deepEqual(
    tasksByState([task], "APPROVED").map((t) => t.id),
    ["t-moving"],
  );
});
