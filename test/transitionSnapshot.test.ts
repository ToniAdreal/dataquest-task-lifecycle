import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedEvents,
  isTerminal,
  transitionTable,
  transitionTableJson,
  type TaskEvent,
  type TaskState,
} from "../src/index.js";

const ALL_STATES: TaskState[] = [
  "DRAFT",
  "OPEN",
  "ACCEPTED",
  "CAPTURING",
  "SUBMITTED",
  "IN_REVIEW",
  "APPROVED",
  "PAYOUT_PENDING",
  "PAID",
  "REJECTED",
  "DISPUTED",
  "ABANDONED",
  "EXPIRED",
];

const TERMINAL_STATES: TaskState[] = ["PAID", "ABANDONED", "EXPIRED"];

function snapshotPath(): string {
  // Tests run compiled from dist/test/, so the repo root is two up.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return join(root, "test", "__snapshots__", "transitionTable.snapshot.json");
}

test("transition table matches the committed JSON snapshot (no accidental edits)", () => {
  const snapshot = readFileSync(snapshotPath(), "utf8");
  assert.equal(transitionTableJson(), snapshot);
  // Belt and suspenders: structured comparison, not just string equality.
  assert.deepEqual(JSON.parse(snapshot), transitionTable());
  // The snapshot is machine-generated; guard its shape by hand-count too.
  assert.equal(transitionTable().length, 19);
});

test("allowedEvents(state) covers every event of every state, with no extras", () => {
  const edges = transitionTable();
  assert.equal(ALL_STATES.length, 13);
  for (const state of ALL_STATES) {
    const fromTable: TaskEvent[] = edges
      .filter((e) => e.from === state)
      .map((e) => e.event);
    assert.deepEqual(allowedEvents(state), fromTable, `state ${state}`);
  }
});

test("isTerminal(state) is true only for PAID / ABANDONED / EXPIRED", () => {
  const terminal = new Set<TaskState>(TERMINAL_STATES);
  assert.equal(TERMINAL_STATES.length, 3);
  for (const state of ALL_STATES) {
    assert.equal(isTerminal(state), terminal.has(state), `state ${state}`);
  }
});
