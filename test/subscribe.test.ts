import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  type TaskEvent,
  type TaskHistoryEntry,
  type TaskState,
} from "../src/index.js";

function newTask(id = "t-sub"): TaskLifecycle {
  return new TaskLifecycle(id);
}

function driveToOpen(t: TaskLifecycle): void {
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
}

test("subscribe: listener receives (event, from, to, entry) across dispatches", () => {
  const t = newTask();
  const calls: Array<[TaskEvent, TaskState, TaskState, TaskHistoryEntry]> = [];
  const unsub = t.subscribe((event, from, to, entry) => {
    calls.push([event, from, to, entry]);
  });

  driveToOpen(t);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 3), ["PUBLISH", "DRAFT", "OPEN"]);
  assert.deepEqual(calls[1].slice(0, 3), ["ACCEPT", "OPEN", "ACCEPTED"]);
  for (const [, , , entry] of calls) {
    assert.equal(typeof entry.seq, "number");
    assert.equal(typeof entry.at, "string");
  }
  // Entry fields match the appended audit entries.
  assert.equal(calls[0][3].seq, 1);
  assert.equal(calls[1][3].seq, 2);
  assert.equal(calls[0][3].actor, "researcher");
  assert.equal(calls[1][3].actor, "contributor");
  assert.equal(t.listenerCount, 1);
  unsub();
  assert.equal(t.listenerCount, 0);
});

test("subscribe: multiple listeners are called in subscription order", () => {
  const t = newTask();
  const order: string[] = [];
  t.subscribe(() => order.push("first"));
  t.subscribe(() => order.push("second"));
  t.subscribe(() => order.push("third"));
  t.dispatch("PUBLISH");
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("subscribe: unsubscribe stops delivery and is idempotent", () => {
  const t = newTask();
  let count = 0;
  const unsub = t.subscribe(() => count++);
  t.dispatch("PUBLISH");
  assert.equal(count, 1);

  unsub();
  t.dispatch("ACCEPT");
  assert.equal(count, 1); // no more deliveries

  unsub(); // second call is a no-op, must not throw
  assert.equal(t.listenerCount, 0);
});

test("subscribe: a throwing listener never breaks dispatch, history, or peers", () => {
  const t = newTask();
  const seen: string[] = [];
  t.subscribe(() => {
    throw new Error("boom: bad fan-out consumer");
  });
  t.subscribe(() => seen.push("peer"));

  const to = t.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(to, "OPEN"); // dispatch returned normally
  assert.equal(t.state, "OPEN");
  assert.equal(t.history.length, 1);
  assert.equal(t.history[0].event, "PUBLISH");
  assert.deepEqual(seen, ["peer"]); // the throwing listener did not starve its peer

  // The task keeps working after the listener failure.
  assert.equal(t.dispatch("ACCEPT"), "ACCEPTED");
  assert.equal(t.history.length, 2);
  assert.deepEqual(seen, ["peer", "peer"]);
});

test("subscribe: delivered entry equals the last history entry, frozen and detached", () => {
  const t = newTask();
  let received: TaskHistoryEntry | undefined;
  t.subscribe((_event, _from, _to, entry) => {
    received = entry;
  });
  t.dispatch("PUBLISH", { actor: "researcher", note: "hello" });
  assert.ok(received);
  const last = t.history[t.history.length - 1];

  // Same data as the appended audit entry.
  assert.deepEqual({ ...received }, { ...last });

  // Frozen: a listener cannot rewrite the audit trail.
  assert.throws(
    () => {
      (received as { event: TaskEvent }).event = "EXPIRE";
    },
    /Cannot assign to read only property/,
  );
  assert.equal(t.history[0].event, "PUBLISH");

  // Detached: later dispatches do not retroactively mutate the delivered entry.
  const first = received;
  t.dispatch("ACCEPT");
  assert.equal(first.seq, 1);
  assert.equal(first.event, "PUBLISH");
});

test("subscribe: non-function listener throws a clear error", () => {
  const t = newTask();
  assert.throws(
    () => (t.subscribe as (l: unknown) => void)("not-a-function"),
    /invalid subscribe: listener must be a function, got string/,
  );
  assert.throws(
    () => (t.subscribe as (l: unknown) => void)(undefined),
    /invalid subscribe: listener must be a function, got undefined/,
  );
  assert.equal(t.listenerCount, 0);
});

test("subscribe: subscriptions are in-memory only — rehydrated tasks start empty", () => {
  const t = newTask();
  let count = 0;
  t.subscribe(() => count++);
  t.dispatch("PUBLISH");

  const snap = t.toJSON();
  assert.equal(count, 1);

  const restored = TaskLifecycle.fromJSON(JSON.parse(JSON.stringify(snap)));
  assert.equal(restored.listenerCount, 0);
  restored.dispatch("ACCEPT");
  assert.equal(count, 1); // no listener survived the round-trip

  const replayed = TaskLifecycle.fromHistory("t-replay", snap.history);
  assert.equal(replayed.listenerCount, 0);
  replayed.dispatch("ACCEPT");
  assert.equal(count, 1);
});

test("subscribe: failed dispatches notify nobody", () => {
  const t = newTask();
  let count = 0;
  t.subscribe(() => count++);
  assert.throws(() => t.dispatch("ACCEPT"), /invalid transition/); // from DRAFT
  assert.equal(count, 0);
  assert.equal(t.history.length, 0);

  const rb = new TaskLifecycle("t-rb2", {
    rolePolicy: { PUBLISH: ["researcher"] },
  });
  rb.subscribe(() => count++);
  assert.throws(
    () => rb.dispatch("PUBLISH", { actor: "imposter" }),
    /actor not authorized/,
  );
  assert.equal(count, 0);
});
