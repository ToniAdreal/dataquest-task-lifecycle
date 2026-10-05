import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  type TaskEvent,
  type TaskHistoryEntry,
  type TaskState,
} from "../src/index.js";

/**
 * The history getter must expose a runtime-frozen audit trail: callers
 * could previously push/splice the live array (only the type was
 * readonly). The getter now returns frozen copies; dispatch() stays the
 * only append path.
 */

function driveToAccepted(): TaskLifecycle {
  const t = new TaskLifecycle("freeze-1");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  return t;
}

/** Cast away the readonly type — exactly what a hostile/careless caller does. */
function writable(t: TaskLifecycle): TaskHistoryEntry[] {
  return t.history as unknown as TaskHistoryEntry[];
}

test("history array and entries are frozen", () => {
  const t = driveToAccepted();
  const h = writable(t);
  assert.ok(Object.isFrozen(h), "history array must be frozen");
  for (const entry of h) {
    assert.ok(Object.isFrozen(entry), `entry seq=${entry.seq} must be frozen`);
  }
});

test("push/splice on the returned history throw and leave the task unchanged", () => {
  const t = driveToAccepted();
  const h = writable(t);
  const fake: TaskHistoryEntry = {
    seq: 99,
    event: "PUBLISH" as TaskEvent,
    from: "DRAFT" as TaskState,
    to: "OPEN" as TaskState,
    at: new Date().toISOString(),
  };
  assert.throws(() => h.push(fake), TypeError);
  assert.throws(() => h.splice(0, 1), TypeError);
  assert.throws(() => h.pop(), TypeError);
  assert.equal(t.history.length, 2);
  assert.deepEqual(
    t.history.map((e) => e.seq),
    [1, 2],
  );
  assert.equal(t.state, "ACCEPTED");
});

test("rewriting an entry field throws and has no effect", () => {
  const t = driveToAccepted();
  const h = writable(t);
  assert.throws(() => {
    h[0].to = "PAID";
  }, TypeError);
  assert.throws(() => {
    h[0].note = "forged";
  }, TypeError);
  assert.equal(t.history[0].to, "OPEN");
  assert.equal(t.history[0].note, undefined);
});

test("each getter call returns a fresh detached copy", () => {
  const t = driveToAccepted();
  const a = t.history;
  const b = t.history;
  assert.notEqual(a, b, "getter must not hand out the same array twice");
  assert.deepEqual(a, b);
});

test("dispatch still appends and the frozen view follows the live task", () => {
  const t = driveToAccepted();
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  const h = writable(t);
  assert.equal(h.length, 3);
  assert.deepEqual(
    h.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.ok(Object.isFrozen(h));
  assert.ok(Object.isFrozen(h[2]));
  assert.equal(h[2].actor, "contributor");
  assert.equal(t.state, "CAPTURING");
  // older snapshot must not be mutated by the later dispatch
  const before = t.history;
  t.dispatch("SUBMIT");
  assert.equal(before.length, 3);
  assert.equal(t.history.length, 4);
});

test("frozen history still round-trips through replay and fromHistory", () => {
  const t = driveToAccepted();
  t.dispatch("START_CAPTURE");
  t.dispatch("SUBMIT");
  const restored = TaskLifecycle.fromHistory("replay-1", t.history);
  assert.equal(restored.state, t.state);
  assert.deepEqual(
    restored.history.map((e) => e.seq),
    t.history.map((e) => e.seq),
  );
});

test("frozen history serializes to JSON unchanged", () => {
  const t = driveToAccepted();
  t.dispatch("START_CAPTURE", { actor: "contributor", note: "batch 7" });
  const json = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  assert.equal(json.length, 3);
  assert.equal(json[2].actor, "contributor");
  assert.equal(json[2].note, "batch 7");
});
