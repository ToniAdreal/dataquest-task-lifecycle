import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  isOverdue,
} from "../src/index.js";
import type { TaskSnapshot } from "../src/index.js";

function happyPath(): TaskLifecycle {
  const t = new TaskLifecycle("task-ser-001");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor", note: "100 images" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  return t;
}

test("serialization: full DRAFT->PAID round-trip through JSON", () => {
  const t = happyPath();
  const snapshot = t.toJSON();
  // survives a JSON.stringify/parse boundary exactly
  const wire = JSON.parse(JSON.stringify(snapshot)) as TaskSnapshot;
  assert.deepEqual(wire, snapshot);

  const restored = TaskLifecycle.fromJSON(wire);
  assert.equal(restored.id, "task-ser-001");
  assert.equal(restored.state, "PAID");
  assert.ok(restored.isTerminal);
  assert.deepEqual(restored.toJSON(), snapshot);
});

test("serialization: JSON.stringify(task) uses toJSON()", () => {
  const t = happyPath();
  assert.equal(JSON.stringify(t), JSON.stringify(t.toJSON()));
  const restored = TaskLifecycle.fromJSON(JSON.parse(JSON.stringify(t)));
  assert.equal(restored.state, "PAID");
  assert.deepEqual(restored.history, t.history);
});

test("serialization: fresh task (empty history) round-trips", () => {
  const t = new TaskLifecycle("task-ser-002");
  const restored = TaskLifecycle.fromJSON(t.toJSON());
  assert.equal(restored.id, "task-ser-002");
  assert.equal(restored.state, "DRAFT");
  assert.deepEqual(restored.history, []);
});

test("serialization: SLA deadlines survive and isOverdue behaves the same", () => {
  const t = new TaskLifecycle("task-ser-003");
  t.dispatch("PUBLISH");
  t.setSlaDeadline("2000-01-01T00:00:00.000Z"); // long overdue
  t.dispatch("ACCEPT");
  t.setSlaDeadline("2100-06-01T00:00:00.000Z"); // far future

  const restored = TaskLifecycle.fromJSON(t.toJSON());
  assert.equal(restored.getSlaDeadline("OPEN"), "2000-01-01T00:00:00.000Z");
  assert.equal(restored.getSlaDeadline("ACCEPTED"), "2100-06-01T00:00:00.000Z");
  assert.equal(restored.state, "ACCEPTED");
  // ACCEPTED deadline is in the future -> not overdue
  assert.equal(isOverdue(restored), false);
  assert.equal(restored.getSlaDeadline("OPEN"), t.getSlaDeadline("OPEN"));
});

test("serialization: restored task keeps dispatching without seq gaps", () => {
  const t = new TaskLifecycle("task-ser-004");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT");

  const restored = TaskLifecycle.fromJSON(t.toJSON());
  restored.dispatch("START_CAPTURE", { actor: "contributor" });
  assert.equal(restored.state, "CAPTURING");
  assert.deepEqual(
    restored.history.map((h) => h.seq),
    [1, 2, 3],
  );
  assert.equal(restored.history[2].from, "ACCEPTED");
  assert.equal(restored.history[2].to, "CAPTURING");
});

test("serialization: toJSON returns a detached copy", () => {
  const t = happyPath();
  const snapshot = t.toJSON();
  snapshot.id = "mutated";
  snapshot.state = "DRAFT";
  snapshot.history[0].to = "ABANDONED";
  snapshot.slaDeadlines["OPEN"] = "x";
  assert.equal(t.id, "task-ser-001");
  assert.equal(t.state, "PAID");
  assert.equal(t.history[0].to, "OPEN");
  assert.equal(t.getSlaDeadline("OPEN"), undefined);
});

test("serialization: mutating the input after fromJSON does not affect the task", () => {
  const t = happyPath();
  const wire = JSON.parse(JSON.stringify(t.toJSON())) as TaskSnapshot;
  const restored = TaskLifecycle.fromJSON(wire);
  wire.history[0].actor = "intruder";
  wire.history.length = 0;
  assert.equal(restored.history.length, 8);
  assert.equal(restored.history[0].actor, "researcher");
});

test("serialization: fromJSON rejects malformed snapshots", () => {
  const good = happyPath().toJSON();
  const cases: Array<[string, unknown, RegExp]> = [
    ["null", null, /expected a JSON object/],
    ["string", "nope", /expected a JSON object/],
    ["array", [], /expected a JSON object/],
    ["empty id", { ...good, id: "" }, /id must be a non-empty string/],
    ["unknown state", { ...good, state: "GONE" }, /unknown state/],
    ["history not array", { ...good, history: {} }, /history must be an array/],
    ["seq gap", { ...good, history: good.history.slice(1) }, /seq must be 1/],
    [
      "broken chain",
      {
        ...good,
        history: good.history.map((e, i) =>
          i === 3 ? { ...e, from: "DRAFT" } : e,
        ),
      },
      /does not continue previous to/,
    ],
    [
      "chain must start at DRAFT",
      {
        ...good,
        history: good.history.map((e, i) =>
          i === 0 ? { ...e, from: "OPEN" } : e,
        ),
      },
      /must start at DRAFT/,
    ],
    [
      "illegal edge",
      {
        ...good,
        history: [
          { seq: 1, event: "APPROVE", from: "DRAFT", to: "APPROVED", at: good.history[0].at },
        ],
      },
      /cannot lead to/,
    ],
    [
      "unknown event",
      {
        ...good,
        history: [{ ...good.history[0], event: "TELEPORT" }],
      },
      /unknown event/,
    ],
    [
      "unparseable timestamp",
      {
        ...good,
        history: [{ ...good.history[0], at: "not-a-date" }],
      },
      /canonical ISO-8601/,
    ],
    [
      "non-canonical timestamp",
      {
        ...good,
        history: [{ ...good.history[0], at: "2026-10-05T16:00:00Z" }],
      },
      /canonical ISO-8601/,
    ],
    [
      "decreasing timestamps",
      {
        ...good,
        history: good.history.map((e, i) =>
          i === 1 ? { ...e, at: "2000-01-01T00:00:00.000Z" } : e,
        ),
      },
      /non-decreasing/,
    ],
    [
      "history ends at wrong state",
      { ...good, state: "OPEN" },
      /history ends at PAID but state is OPEN/,
    ],
    [
      "empty history with non-DRAFT state",
      { id: "x", state: "OPEN", history: [], slaDeadlines: {} },
      /empty history but state is OPEN/,
    ],
    [
      "bad SLA state",
      { ...good, slaDeadlines: { GONE: "2026-01-01T00:00:00.000Z" } },
      /unknown SLA state/,
    ],
    [
      "unparseable SLA deadline",
      { ...good, slaDeadlines: { OPEN: "whenever" } },
      /unparseable SLA deadline/,
    ],
  ];
  for (const [name, input, pattern] of cases) {
    assert.throws(() => TaskLifecycle.fromJSON(input), pattern, name);
  }
});

test("serialization: fromJSON normalizes SLA deadline strings like setSlaDeadline", () => {
  const t = new TaskLifecycle("task-ser-005");
  const restored = TaskLifecycle.fromJSON({
    ...t.toJSON(),
    slaDeadlines: { OPEN: "2026-12-01" },
  });
  assert.equal(restored.getSlaDeadline("OPEN"), "2026-12-01T00:00:00.000Z");
});
