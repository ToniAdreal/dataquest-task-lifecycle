import test from "node:test";
import assert from "node:assert/strict";
import {
  SNAPSHOT_VERSION,
  TaskLifecycle,
  verifyHistoryChain,
} from "../src/index.js";
import type { TaskSnapshot } from "../src/index.js";

function progressedTask(): TaskLifecycle {
  const t = new TaskLifecycle("task-ver-001");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.setSlaDeadline("2100-06-01T00:00:00.000Z"); // for OPEN
  t.dispatch("ACCEPT", { actor: "contributor" });
  return t;
}

test("snapshot version: SNAPSHOT_VERSION is 1 and toJSON always writes v: 1", () => {
  assert.equal(SNAPSHOT_VERSION, 1);
  const t = progressedTask();
  const snapshot = t.toJSON();
  assert.equal(snapshot.v, 1);
  assert.equal(Object.keys(snapshot)[0], "v");
  // even a fresh, empty task carries the version
  assert.equal(new TaskLifecycle("task-ver-fresh").toJSON().v, 1);
});

test("snapshot version: v: 1 snapshot round-trips byte-for-byte", () => {
  const t = progressedTask();
  const snapshot = t.toJSON();
  const restored = TaskLifecycle.fromJSON(snapshot);
  assert.deepEqual(restored.toJSON(), snapshot);
  assert.equal(restored.state, "ACCEPTED");
});

test("snapshot version: legacy snapshot without v still loads fully", () => {
  const t = progressedTask();
  const legacy = { ...t.toJSON() } as Record<string, unknown>;
  delete legacy.v;
  assert.equal("v" in legacy, false);

  const restored = TaskLifecycle.fromJSON(legacy);
  assert.equal(restored.id, "task-ver-001");
  assert.equal(restored.state, "ACCEPTED");
  assert.deepEqual(restored.history, t.history);
  assert.equal(restored.getSlaDeadline("OPEN"), "2100-06-01T00:00:00.000Z");
  // and re-exporting a legacy-restored task stamps the current version
  assert.equal(restored.toJSON().v, SNAPSHOT_VERSION);
});

test("snapshot version: unsupported v values are rejected with a version error", () => {
  const good = progressedTask().toJSON();
  const cases: Array<[string, unknown]> = [
    ["future version 2", 2],
    ["string \"1\"", "1"],
    ["null", null],
    ["zero", 0],
    ["fractional 1.5", 1.5],
  ];
  for (const [name, v] of cases) {
    assert.throws(
      () => TaskLifecycle.fromJSON({ ...good, v }),
      /invalid snapshot: unsupported snapshot version/,
      name,
    );
  }
  // the error names the offending value
  assert.throws(
    () => TaskLifecycle.fromJSON({ ...good, v: 2 }),
    /unsupported snapshot version 2/,
  );
  assert.throws(
    () => TaskLifecycle.fromJSON({ ...good, v: "1" }),
    /unsupported snapshot version 1/,
  );
});

test("snapshot version: version gate runs before structural/history checks", () => {
  const good = progressedTask().toJSON();
  // v: 2 AND a broken history: the version problem must be reported,
  // not a misleading chain/structural error.
  assert.throws(
    () =>
      TaskLifecycle.fromJSON({
        ...good,
        v: 2,
        history: [{ seq: 99, event: "NOPE" }],
      }),
    /unsupported snapshot version 2/,
  );
});

test("snapshot version: JSON.stringify(task) carries v through the wire", () => {
  const t = progressedTask();
  const wire = JSON.parse(JSON.stringify(t)) as TaskSnapshot;
  assert.equal(wire.v, 1);
  const restored = TaskLifecycle.fromJSON(wire);
  assert.equal(restored.state, "ACCEPTED");
  assert.deepEqual(restored.toJSON(), t.toJSON());
});

test("snapshot version: restored task keeps dispatching with an intact chain", () => {
  const t = progressedTask();
  const restored = TaskLifecycle.fromJSON(t.toJSON());
  restored.dispatch("START_CAPTURE", { actor: "contributor" });
  assert.deepEqual(
    restored.history.map((h) => h.seq),
    [1, 2, 3],
  );
  assert.equal(verifyHistoryChain(restored.history), true);
});

test("snapshot version: legacy-restored task keeps dispatching with an intact chain", () => {
  const t = progressedTask();
  const legacy = { ...t.toJSON() } as Record<string, unknown>;
  delete legacy.v;
  const restored = TaskLifecycle.fromJSON(legacy);
  restored.dispatch("START_CAPTURE", { actor: "contributor" });
  assert.deepEqual(
    restored.history.map((h) => h.seq),
    [1, 2, 3],
  );
  assert.equal(verifyHistoryChain(restored.history), true);
});

test("snapshot version: fromHistory is unaffected (it takes a history, not a snapshot)", () => {
  const t = progressedTask();
  const restored = TaskLifecycle.fromHistory("task-ver-001", t.history);
  assert.equal(restored.state, "ACCEPTED");
  assert.equal(restored.toJSON().v, SNAPSHOT_VERSION);
});
