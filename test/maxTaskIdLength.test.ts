/**
 * `MAX_TASK_ID_LENGTH` (256) enforcement on all three id gates
 * (backlog #1062, mirrors escrow #1061).
 *
 * The task id was only checked for non-emptiness, so a caller could
 * pass a multi-megabyte string straight into the constructor and have
 * it stamped verbatim onto every history entry, snapshot, NDJSON
 * export, and payout-webhook payload (`taskId`) that carries it.
 * All three gates now enforce a 256-character ceiling — an id is a
 * short identifier (the demo uses `DEMO-001`, a UUID is 36
 * characters), so 256 leaves orders of magnitude of headroom — with
 * the same wording (`id must be at most 256 characters, got N`),
 * rejecting oversized ids outright instead of truncating them
 * (truncation would change which task a log belongs to). The
 * constructor gate covers live construction, the snapshot parser
 * covers `fromJSON` (and, through it, every restore path), and
 * `TaskLifecycle.fromHistory` covers bare-history/NDJSON rebuilds,
 * where the id is supplied explicitly because history entries carry
 * no id.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  TaskLifecycle,
  MAX_TASK_ID_LENGTH,
  historyFromNdjson,
  historyToNdjson,
} from "../src/index.js";

function overlongId(): string {
  return "x".repeat(MAX_TASK_ID_LENGTH + 1);
}

function atLimitId(): string {
  return "x".repeat(MAX_TASK_ID_LENGTH);
}

function publishedTask(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH");
  return task;
}

// --- constructor gate ---

test("constructor rejects an id longer than MAX_TASK_ID_LENGTH", () => {
  assert.equal(MAX_TASK_ID_LENGTH, 256);
  assert.throws(
    () => new TaskLifecycle(overlongId()),
    /invalid task: id must be at most 256 characters, got 257/,
  );
});

test("constructor accepts an id of exactly MAX_TASK_ID_LENGTH characters, recorded verbatim", () => {
  const task = new TaskLifecycle(atLimitId());
  assert.equal(task.id, atLimitId());
  assert.equal(task.id.length, MAX_TASK_ID_LENGTH);
  assert.equal(task.state, "DRAFT");
});

test("empty and non-string ids still fail with the old non-empty error, not the length error", () => {
  assert.throws(
    () => new TaskLifecycle(""),
    /invalid task: id must be a non-empty string/,
  );
  assert.throws(
    // @ts-expect-error intentional misuse under test
    () => new TaskLifecycle(42),
    /invalid task: id must be a non-empty string/,
  );
});

// --- snapshot parse gate ---

test("fromJSON rejects a snapshot whose id is overlong", () => {
  const task = publishedTask("id-limit-test");
  const snapshot = task.toJSON() as unknown as Record<string, unknown>;
  snapshot.id = overlongId();
  assert.throws(
    () => TaskLifecycle.fromJSON(snapshot),
    /invalid snapshot: id must be at most 256 characters, got 257/,
  );
});

test("fromJSON rejects an overlong id after a JSON string round-trip", () => {
  const task = publishedTask("id-limit-test");
  const snapshot = JSON.parse(
    JSON.stringify(task.toJSON()),
  ) as Record<string, unknown>;
  snapshot.id = overlongId();
  assert.throws(
    () => TaskLifecycle.fromJSON(snapshot),
    /invalid snapshot: id must be at most 256 characters, got 257/,
  );
});

test("fromJSON round-trips a task whose id is exactly at the limit", () => {
  const task = publishedTask(atLimitId());
  const rebuilt = TaskLifecycle.fromJSON(task.toJSON());
  assert.equal(rebuilt.id, atLimitId());
  assert.equal(rebuilt.state, "OPEN");
  assert.deepEqual(rebuilt.history, task.history);
});

// --- fromHistory / NDJSON gate ---

test("fromHistory rejects an overlong id", () => {
  const task = publishedTask("id-limit-test");
  assert.throws(
    () => TaskLifecycle.fromHistory(overlongId(), task.history),
    /invalid history: id must be at most 256 characters, got 257/,
  );
});

test("fromHistory rebuilds a task whose id is exactly at the limit", () => {
  const task = publishedTask("id-limit-test");
  const rebuilt = TaskLifecycle.fromHistory(atLimitId(), task.history);
  assert.equal(rebuilt.id, atLimitId());
  assert.equal(rebuilt.state, "OPEN");
  // Rebuilt with the at-limit id, it keeps dispatching.
  assert.equal(rebuilt.dispatch("ACCEPT"), "ACCEPTED");
});

test("NDJSON replay rejects an overlong id and accepts one at the limit", () => {
  const task = publishedTask("id-limit-test");
  const ndjson = historyToNdjson(task);
  const entries = historyFromNdjson(ndjson);
  assert.throws(
    () => TaskLifecycle.fromHistory(overlongId(), entries),
    /invalid history: id must be at most 256 characters, got 257/,
  );
  const rebuilt = TaskLifecycle.fromHistory(atLimitId(), entries);
  assert.equal(rebuilt.id, atLimitId());
  assert.equal(rebuilt.state, "OPEN");
});

// --- demo and existing ids unaffected ---

test("the demo's ids are far below the cap and construct unchanged", () => {
  // Representative of every id the CLI demo uses (all `DEMO-0xx` in
  // src/demo.ts); the full demo run is covered by test/demo.test.ts —
  // this pins that the cap does not touch them.
  for (const id of [
    "DEMO-001",
    "DEMO-002",
    "DEMO-003",
    "DEMO-006",
    "DEMO-043",
    "DEMO-085",
  ]) {
    assert.ok(id.length < MAX_TASK_ID_LENGTH);
    const task = new TaskLifecycle(id);
    assert.equal(task.id, id);
  }
});
