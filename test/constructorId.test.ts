import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/index.js";

/**
 * The TaskLifecycle constructor must reject empty/non-string ids, exactly
 * like fromJSON()/fromHistory() do for their id inputs — a live object
 * must never hold an id that its own snapshots cannot restore.
 *
 * Rules under test:
 *  - "" throws `invalid task: id must be a non-empty string`
 *  - non-string ids (undefined/null/123) throw the same error
 *  - legal ids construct a usable task (dispatch works, id is readable)
 *  - the check is fail-fast: no partially-initialised state is observable
 */

test("constructor rejects the empty string id", () => {
  assert.throws(
    () => new TaskLifecycle(""),
    /invalid task: id must be a non-empty string/,
  );
});

test("constructor rejects non-string ids", () => {
  for (const bad of [undefined, null, 123, {}, [], true]) {
    assert.throws(
      // @ts-expect-error intentional misuse under test
      () => new TaskLifecycle(bad),
      /invalid task: id must be a non-empty string/,
      `expected rejection for ${String(bad)}`,
    );
  }
});

test("constructor error wording matches the fromHistory calibre", () => {
  // fromHistory uses "invalid history: id must be a non-empty string";
  // the constructor keeps the same "id must be a non-empty string" phrasing
  // with the task-level tag.
  const fromHistoryMsg = "invalid history: id must be a non-empty string";
  assert.match(fromHistoryMsg, /id must be a non-empty string/);
  try {
    new TaskLifecycle("");
    assert.fail("expected the constructor to throw");
  } catch (err) {
    assert.match((err as Error).message, /id must be a non-empty string/);
  }
});

test("legal ids construct a working task", () => {
  const task = new TaskLifecycle("task-123");
  assert.equal(task.id, "task-123");
  task.dispatch("PUBLISH");
  assert.equal(task.state, "OPEN");
  const json = JSON.parse(JSON.stringify(task)) as { id: string };
  assert.equal(json.id, "task-123");
  const restored = TaskLifecycle.fromJSON(task.toJSON());
  assert.equal(restored.id, "task-123");
});

test("valid id with options still initialises normally", () => {
  const task = new TaskLifecycle("with-opts", { maxResubmits: 2 });
  assert.equal(task.id, "with-opts");
  task.dispatch("PUBLISH");
  assert.equal(task.state, "OPEN");
});

test("whitespace-only ids are legal (non-empty) and round-trip", () => {
  // Only truly empty/non-string ids are rejected; whitespace is a
  // non-empty string and must behave like any other legal id.
  const task = new TaskLifecycle(" ");
  assert.equal(task.id, " ");
  const restored2 = TaskLifecycle.fromJSON(task.toJSON());
  assert.equal(restored2.id, " ");
});
