import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, replay } from "../src/index.js";
import type { TaskHistoryEntry } from "../src/index.js";

function happyPath(): TaskLifecycle {
  const t = new TaskLifecycle("task-rep-001");
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

function disputePath(): TaskLifecycle {
  const t = new TaskLifecycle("task-rep-002");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  t.dispatch("START_CAPTURE");
  t.dispatch("SUBMIT");
  t.dispatch("BEGIN_REVIEW");
  t.dispatch("REJECT", { actor: "reviewer", note: "blurry" });
  t.dispatch("DISPUTE", { actor: "contributor" });
  t.dispatch("ARBITRATE_APPROVE", { actor: "moderator" });
  t.dispatch("REQUEST_PAYOUT");
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  return t;
}

test("replay: golden history replays to the live task's final state", () => {
  const t = happyPath();
  assert.equal(replay(t.history), "PAID");
  assert.equal(replay(t.history), t.state);
  assert.equal(replay(JSON.parse(JSON.stringify(t.history))), "PAID");
});

test("replay: dispute path replays to PAID", () => {
  const t = disputePath();
  assert.equal(replay(t.history), "PAID");
});

test("replay: empty history replays to DRAFT", () => {
  assert.equal(replay([]), "DRAFT");
  const fresh = TaskLifecycle.fromHistory("task-rep-003", []);
  assert.equal(fresh.state, "DRAFT");
  assert.deepEqual(fresh.history, []);
  assert.equal(fresh.id, "task-rep-003");
});

test("fromHistory: history is the only source of truth", () => {
  const t = happyPath();
  const wire = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  const restored = TaskLifecycle.fromHistory("task-rep-004", wire);
  assert.equal(restored.id, "task-rep-004");
  assert.equal(restored.state, "PAID");
  assert.ok(restored.isTerminal);
  // audit fidelity: original timestamps, actors, notes preserved exactly
  assert.deepEqual(restored.history, t.history);
  assert.equal(restored.history[3].actor, "contributor");
  assert.equal(restored.history[3].note, "100 images");
  assert.equal(restored.history[3].at, t.history[3].at);
});

test("fromHistory: rebuilt task keeps dispatching without seq gaps", () => {
  const t = new TaskLifecycle("task-rep-005");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  const restored = TaskLifecycle.fromHistory(
    "task-rep-005",
    JSON.parse(JSON.stringify(t.history)),
  );
  restored.dispatch("START_CAPTURE", { actor: "contributor" });
  assert.equal(restored.state, "CAPTURING");
  assert.deepEqual(
    restored.history.map((h) => h.seq),
    [1, 2, 3],
  );
});

test("fromHistory: does not retain a reference to the input history", () => {
  const t = happyPath();
  const wire = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  const restored = TaskLifecycle.fromHistory("task-rep-006", wire);
  wire[0].at = "2000-01-01T00:00:00.000Z";
  wire.pop();
  assert.equal(restored.history.length, 8);
  assert.equal(restored.history[0].at, t.history[0].at);
});

test("fromHistory: dispute path restores mid-chain state", () => {
  const t = disputePath();
  const partial = t.history.slice(0, 7); // …→DISPUTED
  const restored = TaskLifecycle.fromHistory("task-rep-007", partial);
  assert.equal(restored.state, "DISPUTED");
  assert.ok(!restored.isTerminal);
});

test("replay: broken from/to chain throws a specific error", () => {
  const t = happyPath();
  const broken = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  // skip one state: entry[2].from no longer continues entry[1].to
  broken[2] = { ...broken[2], from: "OPEN" };
  assert.throws(() => replay(broken), /does not continue/);
});

test("replay: seq gap throws", () => {
  const t = happyPath();
  const bad = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  bad[1] = { ...bad[1], seq: 99 };
  assert.throws(() => replay(bad), /seq must be 2/);
});

test("replay: chain must start at DRAFT", () => {
  const t = happyPath();
  const bad = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  bad[0] = { ...bad[0], from: "OPEN" };
  assert.throws(() => replay(bad), /must start at DRAFT/);
});

test("replay: illegal edge (to inconsistent with the machine) throws", () => {
  const t = happyPath();
  const bad = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  bad[1] = { ...bad[1], to: "CAPTURING" }; // ACCEPT from OPEN only leads to ACCEPTED
  assert.throws(() => replay(bad), /cannot lead to/);
});

test("replay: missing fields throw specific errors", () => {
  const t = happyPath();
  const noAt = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  delete (noAt[0] as Partial<TaskHistoryEntry>).at;
  assert.throws(() => replay(noAt), /canonical ISO-8601/);

  const noEvent = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  delete (noEvent[0] as Partial<TaskHistoryEntry>).event;
  assert.throws(() => replay(noEvent), /unknown event/);
});

test("replay: non-array history and non-object entries throw", () => {
  assert.throws(() => replay("nope"), /must be an array/);
  assert.throws(() => replay([42]), /entry must be an object/);
});

test("replay: unknown event throws", () => {
  const t = happyPath();
  const bad = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  (bad[0] as unknown as Record<string, unknown>).event = "TELEPORT";
  assert.throws(() => replay(bad), /unknown event TELEPORT/);
});

test("replay: decreasing timestamps throw", () => {
  const t = happyPath();
  const bad = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];
  // Build the violation on a hashless (legacy) history: rewriting `at` on
  // a chained entry without recomputing the chain would conflate this
  // rule with hash-chain tamper evidence. Stripped of prevHash/hash, the
  // entries are legacy-valid, so the non-decreasing check is the only
  // rule that can reject this history.
  for (const entry of bad) {
    delete entry.prevHash;
    delete entry.hash;
  }
  bad[1] = { ...bad[1], at: "2000-01-01T00:00:00.000Z" };
  assert.throws(() => replay(bad), /non-decreasing/);
});

test("fromHistory: empty id throws", () => {
  assert.throws(() => TaskLifecycle.fromHistory("", []), /id must be a non-empty string/);
});

test("replay: equal consecutive timestamps are allowed (same-millisecond events)", () => {
  // Build the equal timestamps through dispatch's `at` injection so the
  // entries are chained consistently from birth. The previous version of
  // this test rewrote an already-chained entry's `at` to match its
  // predecessor without recomputing the hash chain — and `at` is part of
  // the canonical hash input, so the rewrite broke the chain and the
  // test only passed when the first two wall-clock dispatches happened
  // to land in the same millisecond (the rewrite was then a no-op).
  const at = "2026-03-01T10:00:00.000Z";
  const later = (min: number) =>
    `2026-03-01T10:${String(min).padStart(2, "0")}:00.000Z`;
  const t = new TaskLifecycle("task-rep-eq-ts");
  t.dispatch("PUBLISH", { actor: "researcher", at });
  t.dispatch("ACCEPT", { actor: "contributor", at }); // same instant: allowed
  t.dispatch("START_CAPTURE", { actor: "contributor", at: later(2) });
  t.dispatch("SUBMIT", { actor: "contributor", note: "100 images", at: later(3) });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: later(4) });
  t.dispatch("APPROVE", { actor: "reviewer", at: later(5) });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", at: later(6) });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", at: later(7) });
  assert.equal(t.history[0].at, at);
  assert.equal(t.history[1].at, at);
  assert.equal(replay(t.history), "PAID");
  const restored = TaskLifecycle.fromHistory(
    "task-rep-eq-ts",
    JSON.parse(JSON.stringify(t.history)),
  );
  assert.equal(restored.state, "PAID");
  assert.deepEqual(restored.history, t.history);
});
