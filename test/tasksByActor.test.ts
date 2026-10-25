import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, tasksByActor } from "../src/index.js";
import type { TaskEvent } from "../src/index.js";

/** Build a task by dispatching (event, actor?) pairs in order. */
function taskWithHistory(
  id: string,
  steps: [TaskEvent, string?][],
): TaskLifecycle {
  const task = new TaskLifecycle(id);
  for (const [event, actor] of steps) {
    task.dispatch(event, actor === undefined ? {} : { actor });
  }
  return task;
}

test("tasksByActor: picks only tasks the actor touched, in input order", () => {
  const batch = [
    taskWithHistory("t-a", [
      ["PUBLISH", "alice"],
      ["ACCEPT", "bob"],
    ]),
    taskWithHistory("t-b", [["PUBLISH", "bob"]]),
    taskWithHistory("t-c", [["PUBLISH", "alice"]]),
    taskWithHistory("t-d", [
      ["PUBLISH", "alice"],
      ["ACCEPT", "alice"],
      ["START_CAPTURE", "alice"],
    ]),
  ];
  assert.deepEqual(
    tasksByActor(batch, "alice").map((t) => t.id),
    ["t-a", "t-c", "t-d"],
  );
  assert.deepEqual(
    tasksByActor(batch, "bob").map((t) => t.id),
    ["t-a", "t-b"],
  );
});

test("tasksByActor: entries without an actor never match anyone", () => {
  const batch = [
    taskWithHistory("t-anon", [["PUBLISH"], ["ACCEPT"]]),
    taskWithHistory("t-named", [["PUBLISH", "alice"]]),
  ];
  assert.deepEqual(
    tasksByActor(batch, "alice").map((t) => t.id),
    ["t-named"],
  );
  // No actor string can claim anonymous work — not even "system".
  assert.deepEqual(tasksByActor(batch, "system").map((t) => t.id), []);
});

test("tasksByActor: a task with many matching entries appears exactly once", () => {
  const batch = [
    taskWithHistory("t-many", [
      ["PUBLISH", "alice"],
      ["ACCEPT", "alice"],
      ["START_CAPTURE", "alice"],
    ]),
  ];
  const result = tasksByActor(batch, "alice");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "t-many");
});

test("tasksByActor: a fresh task with no history matches nothing", () => {
  const batch = [new TaskLifecycle("t-fresh")];
  assert.deepEqual(tasksByActor(batch, "alice"), []);
});

test("tasksByActor: matching is exact — actor names are case-sensitive", () => {
  const batch = [taskWithHistory("t-a", [["PUBLISH", "alice"]])];
  assert.deepEqual(tasksByActor(batch, "Alice"), []);
  assert.deepEqual(
    tasksByActor(batch, "alice").map((t) => t.id),
    ["t-a"],
  );
});

test("tasksByActor: empty input gives empty output", () => {
  assert.deepEqual(tasksByActor([], "alice"), []);
});

test("tasksByActor: never mutates — input array, states and histories unchanged", () => {
  const batch = [
    taskWithHistory("t-a", [
      ["PUBLISH", "alice"],
      ["ACCEPT", "bob"],
    ]),
    taskWithHistory("t-b", [["PUBLISH"]]),
  ];
  const statesBefore = batch.map((t) => t.state);
  const historiesBefore = batch.map((t) => t.history);
  const arrayBefore = [...batch];
  tasksByActor(batch, "alice");
  assert.deepEqual(batch, arrayBefore);
  assert.deepEqual(
    batch.map((t) => t.state),
    statesBefore,
  );
  assert.deepEqual(
    batch.map((t) => t.history),
    historiesBefore,
  );
});

test("tasksByActor: illegal actor values fail fast", () => {
  const batch = [taskWithHistory("t-a", [["PUBLISH", "alice"]])];
  assert.throws(
    () => tasksByActor(batch, ""),
    /invalid tasksByActor: actor must be a non-empty string/,
  );
  for (const bad of [42, null, undefined, {}, ["alice"]] as unknown[]) {
    assert.throws(
      () => tasksByActor(batch, bad as string),
      /invalid tasksByActor: actor must be a non-empty string/,
    );
  }
});
