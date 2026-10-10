import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
  parseHistory,
} from "../src/index.js";

/**
 * Snapshot / history unknown-field rejection (fail-closed).
 *
 * The escrow sibling repo rejects unknown fields in its snapshot parser;
 * this repo's parser used to read only the fields it knew and silently
 * ignore the rest, so a typo like `deadlline` or `payoutAmout` quietly
 * dropped SLA / amount configuration instead of failing. These tests pin
 * the tightened behavior: unknown fields are rejected at both levels
 * (snapshot top level and history entries), while everything `toJSON()`
 * itself produces — and every legacy shape that was legal before — still
 * parses.
 */

/** A task exercising every optional snapshot and history-entry field. */
function fullyLoadedTask(): TaskLifecycle {
  const t = new TaskLifecycle("task-uf-001", {
    maxResubmits: 3,
    maxDisputes: 2,
    rolePolicy: { PUBLISH: ["researcher"], ACCEPT: ["contributor"] },
  });
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "uf-key-1" });
  t.setSlaDeadline("2100-06-01T00:00:00.000Z"); // for OPEN
  t.dispatch("ACCEPT", {
    actor: "contributor",
    note: "agreed",
    quotedAmount: 125.5,
  });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "batch-uf-1",
  });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "batch-uf-1",
    payoutAmount: 125.5,
  });
  return t;
}

function wireSnapshot(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fullyLoadedTask().toJSON())) as Record<
    string,
    unknown
  >;
}

test("unknown fields: toJSON self-produced snapshot round-trips with every optional field present", () => {
  const t = fullyLoadedTask();
  const snapshot = t.toJSON();
  // The fixture really does carry every optional field, so the whitelist
  // is pinned against the full toJSON output, not a minimal subset.
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "history",
    "id",
    "idempotencyKeys",
    "maxDisputes",
    "maxResubmits",
    "rolePolicy",
    "slaDeadlines",
    "state",
    "v",
  ]);
  const entryKeys = new Set<string>();
  for (const e of snapshot.history) {
    for (const k of Object.keys(e)) entryKeys.add(k);
  }
  assert.deepEqual([...entryKeys].sort(), [
    "actor",
    "at",
    "event",
    "from",
    "hash",
    "note",
    "payoutAmount",
    "payoutRef",
    "prevHash",
    "quotedAmount",
    "seq",
    "to",
  ]);
  const restored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(snapshot)),
  );
  assert.deepEqual(restored.toJSON(), snapshot);
  assert.equal(restored.state, "PAID");
});

test("unknown fields: top-level unknown field is rejected and named", () => {
  const snap = wireSnapshot();
  snap.extraField = true;
  assert.throws(
    () => TaskLifecycle.fromJSON(snap),
    /invalid snapshot: unknown field "extraField"/,
  );
});

test("unknown fields: typo'd top-level field (deadlline) is rejected instead of silently dropping SLA config", () => {
  const snap = wireSnapshot();
  snap.deadlline = snap.slaDeadlines;
  delete snap.slaDeadlines;
  assert.throws(
    () => TaskLifecycle.fromJSON(snap),
    /invalid snapshot: unknown field "deadlline"/,
  );
});

test("unknown fields: history entry unknown field is rejected with its index and name", () => {
  const snap = wireSnapshot();
  const history = snap.history as Array<Record<string, unknown>>;
  history[1].payoutAmout = 125.5; // typo of payoutAmount
  assert.throws(
    () => TaskLifecycle.fromJSON(snap),
    /invalid history: entry\[1\]: unknown field "payoutAmout"/,
  );
});

test("unknown fields: parseHistory rejects an unknown entry field directly", () => {
  const history = JSON.parse(
    JSON.stringify(fullyLoadedTask().history),
  ) as Array<Record<string, unknown>>;
  history[0].bogus = 1;
  assert.throws(
    () => parseHistory(history),
    /invalid history: entry\[0\]: unknown field "bogus"/,
  );
  // fromHistory goes through the same parser and rejects it too
  assert.throws(
    () => TaskLifecycle.fromHistory("task-uf-001", history),
    /invalid history: entry\[0\]: unknown field "bogus"/,
  );
});

test("unknown fields: NDJSON import rejects an unknown entry field, attributed to its line", () => {
  const text = historyToNdjson(fullyLoadedTask());
  const lines = text.trimEnd().split("\n");
  const first = JSON.parse(lines[0]) as Record<string, unknown>;
  first.amout = 10;
  lines[0] = JSON.stringify(first);
  assert.throws(
    () => historyFromNdjson(lines.join("\n") + "\n"),
    /invalid ndjson: line 1: unknown field "amout"/,
  );
});

test("unknown fields: legacy snapshot without v still loads", () => {
  const snap = wireSnapshot();
  delete snap.v;
  const restored = TaskLifecycle.fromJSON(snap);
  assert.equal(restored.id, "task-uf-001");
  assert.equal(restored.state, "PAID");
  assert.equal(restored.getSlaDeadline("OPEN"), "2100-06-01T00:00:00.000Z");
});

test("unknown fields: snapshot with only required fields (all optionals absent) still loads", () => {
  const restored = TaskLifecycle.fromJSON({
    id: "task-uf-min",
    state: "DRAFT",
    history: [],
    slaDeadlines: {},
  });
  assert.equal(restored.id, "task-uf-min");
  assert.equal(restored.state, "DRAFT");
  assert.deepEqual(restored.history, []);
});

test("unknown fields: check runs before fields are consumed, but after the version gate", () => {
  const snap = wireSnapshot();
  snap.mystery = 1;
  snap.id = ""; // would fail on its own — the unknown field must win
  assert.throws(
    () => TaskLifecycle.fromJSON(snap),
    /invalid snapshot: unknown field "mystery"/,
  );
  // …while an unsupported version still reports as a version problem
  const future = wireSnapshot();
  future.v = 2;
  future.mystery = 1;
  assert.throws(
    () => TaskLifecycle.fromJSON(future),
    /invalid snapshot: unsupported snapshot version 2/,
  );
});
