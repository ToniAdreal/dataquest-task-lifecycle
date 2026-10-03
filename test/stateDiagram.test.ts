import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedEvents,
  stateDiagram,
  transition,
  transitionTable,
} from "../src/index.js";

test("transition table agrees with transition() edge by edge", () => {
  for (const { from, event, to } of transitionTable()) {
    assert.equal(transition(from, event), to, `${event} from ${from}`);
  }
});

test("transition table covers every allowed event of every state", () => {
  const edges = transitionTable();
  // 19 edges, counted by hand from the TRANSITIONS literal. If the machine
  // gains/loses an edge, this number must change too — that is the point.
  assert.equal(edges.length, 19);
  for (const state of [
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
  ] as const) {
    assert.deepEqual(
      edges.filter((e) => e.from === state).map((e) => e.event),
      allowedEvents(state),
    );
  }
});

test("README embeds the exact generated mermaid diagram (no drift)", () => {
  // Test files run compiled from dist/test/, so the repo root is two up.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(
    readme.includes(stateDiagram()),
    "README state diagram drifted from code — regenerate via stateDiagram()",
  );
});
