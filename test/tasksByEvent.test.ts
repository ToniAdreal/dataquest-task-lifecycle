import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, tasksByEvent } from "../src/index.js";
import type { TaskEvent } from "../src/index.js";

/** Build a task by dispatching events in order. */
function taskWithHistory(id: string, steps: TaskEvent[]): TaskLifecycle {
  const task = new TaskLifecycle(id);
  for (const event of steps) {
    task.dispatch(event);
  }
  return task;
}

const TO_DISPUTED: TaskEvent[] = [
  "PUBLISH",
  "ACCEPT",
  "START_CAPTURE",
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
  "DISPUTE",
];
const TO_RESUBMITTED_TWICE: TaskEvent[] = [
  "PUBLISH",
  "ACCEPT",
  "START_CAPTURE",
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
  "RESUBMIT",
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
  "RESUBMIT",
];
const TO_EXPIRED: TaskEvent[] = ["PUBLISH", "EXPIRE"];

test("tasksByEvent: DISPUTE picks only disputed tasks, in input order", () => {
  const batch = [
    taskWithHistory("t-a", TO_DISPUTED),
    taskWithHistory("t-b", ["PUBLISH"]),
    taskWithHistory("t-c", TO_DISPUTED),
    taskWithHistory("t-d", TO_EXPIRED),
  ];
  assert.deepEqual(
    tasksByEvent(batch, "DISPUTE").map((t) => t.id),
    ["t-a", "t-c"],
  );
});

test("tasksByEvent: RESUBMIT picks tasks that went through a resubmit round", () => {
  const batch = [
    taskWithHistory("t-a", TO_RESUBMITTED_TWICE),
    taskWithHistory("t-b", ["PUBLISH"]),
    taskWithHistory("t-c", TO_DISPUTED),
  ];
  assert.deepEqual(
    tasksByEvent(batch, "RESUBMIT").map((t) => t.id),
    ["t-a"],
  );
});

test("tasksByEvent: EXPIRE picks expired tasks", () => {
  const batch = [
    taskWithHistory("t-a", TO_EXPIRED),
    taskWithHistory("t-b", ["PUBLISH", "ACCEPT"]),
    taskWithHistory("t-c", TO_EXPIRED),
  ];
  assert.deepEqual(
    tasksByEvent(batch, "EXPIRE").map((t) => t.id),
    ["t-a", "t-c"],
  );
});

test("tasksByEvent: a task with two matching entries appears exactly once", () => {
  const batch = [taskWithHistory("t-many", TO_RESUBMITTED_TWICE)];
  const result = tasksByEvent(batch, "RESUBMIT");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "t-many");
  // Same task object, not a copy.
  assert.equal(result[0], batch[0]);
});

test("tasksByEvent: an empty batch returns an empty list", () => {
  assert.deepEqual(tasksByEvent([], "DISPUTE"), []);
});

test("tasksByEvent: no hits returns an empty list, not an error", () => {
  const batch = [
    taskWithHistory("t-a", ["PUBLISH"]),
    taskWithHistory("t-b", TO_EXPIRED),
  ];
  assert.deepEqual(tasksByEvent(batch, "DISPUTE"), []);
});

test("tasksByEvent: unknown event fails fast with the tasksByState-style wording", () => {
  const batch = [taskWithHistory("t-a", ["PUBLISH"])];
  assert.throws(
    () => tasksByEvent(batch, "DISPUT" as TaskEvent),
    /invalid tasksByEvent: unknown event "DISPUT"/,
  );
  // A state name is not an event.
  assert.throws(
    () => tasksByEvent(batch, "DISPUTED" as TaskEvent),
    /invalid tasksByEvent: unknown event "DISPUTED"/,
  );
  // A non-string is not an event either.
  assert.throws(
    () => tasksByEvent(batch, 42 as unknown as TaskEvent),
    /invalid tasksByEvent: unknown event "42"/,
  );
});

test("tasksByEvent: input order is preserved across interleaved hits", () => {
  const batch = [
    taskWithHistory("t-1", TO_EXPIRED),
    taskWithHistory("t-2", ["PUBLISH"]),
    taskWithHistory("t-3", TO_DISPUTED),
    taskWithHistory("t-4", TO_EXPIRED),
    taskWithHistory("t-5", TO_DISPUTED),
  ];
  assert.deepEqual(
    tasksByEvent(batch, "DISPUTE").map((t) => t.id),
    ["t-3", "t-5"],
  );
  assert.deepEqual(
    tasksByEvent(batch, "EXPIRE").map((t) => t.id),
    ["t-1", "t-4"],
  );
});

test("tasksByEvent: the input array is not mutated", () => {
  const batch = [
    taskWithHistory("t-a", TO_DISPUTED),
    taskWithHistory("t-b", ["PUBLISH"]),
    taskWithHistory("t-c", TO_DISPUTED),
  ];
  const before = batch.map((t) => t.id);
  const result = tasksByEvent(batch, "DISPUTE");
  assert.deepEqual(
    result.map((t) => t.id),
    ["t-a", "t-c"],
  );
  assert.deepEqual(
    batch.map((t) => t.id),
    before,
  );
  // The returned slice is a new array; pushing to it cannot leak back.
  result.push(batch[1]);
  assert.equal(batch.length, 3);
});

test("tasksByEvent: a fresh task with no history matches nothing", () => {
  const batch = [new TaskLifecycle("t-fresh")];
  assert.deepEqual(tasksByEvent(batch, "PUBLISH"), []);
  assert.deepEqual(tasksByEvent(batch, "DISPUTE"), []);
});

test("tasksByEvent: terminal tasks still match on their history", () => {
  const batch = [
    taskWithHistory("t-disputed", TO_DISPUTED),
    taskWithHistory("t-expired", TO_EXPIRED),
  ];
  // DISPUTED and EXPIRED are terminal states; the question is about
  // history, not current state, so both still match their own event.
  assert.deepEqual(
    tasksByEvent(batch, "DISPUTE").map((t) => t.id),
    ["t-disputed"],
  );
  assert.deepEqual(
    tasksByEvent(batch, "EXPIRE").map((t) => t.id),
    ["t-expired"],
  );
});
