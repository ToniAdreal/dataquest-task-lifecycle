import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NOTE_LENGTH,
  parseHistory,
  TaskLifecycle,
} from "../src/index.js";

/**
 * Fail-fast hardening of audit metadata: an empty actor has zero audit
 * value, and an oversized note permanently inflates the append-only
 * audit history (and every toJSON()/historyToNdjson() export of it).
 * dispatch() and parseHistory() apply the same bar — rejected inputs
 * leave no trace.
 */

test("dispatch: empty-string actor is rejected with no history residue", () => {
  const t = new TaskLifecycle("h1");
  assert.throws(
    () => t.dispatch("PUBLISH", { actor: "" }),
    /invalid dispatch options: actor must be a non-empty string, got ""/,
  );
  assert.equal(t.state, "DRAFT");
  assert.equal(t.history.length, 0);
});

test("dispatch: whitespace-only actor is legal (non-empty), undefined stays anonymous", () => {
  const t = new TaskLifecycle("h2");
  t.dispatch("PUBLISH", { actor: " " });
  assert.equal(t.history[0].actor, " ");
  t.dispatch("ACCEPT", { actor: undefined });
  assert.equal(t.history[1].actor, undefined);
});

test("dispatch: oversized note is rejected with no history residue", () => {
  const t = new TaskLifecycle("h3");
  const big = "x".repeat(MAX_NOTE_LENGTH + 1);
  assert.throws(
    () => t.dispatch("PUBLISH", { note: big }),
    new RegExp(
      `invalid dispatch options: note must be at most ${MAX_NOTE_LENGTH} characters, got ${MAX_NOTE_LENGTH + 1}`,
    ),
  );
  assert.equal(t.state, "DRAFT");
  assert.equal(t.history.length, 0);
  // the same event with a valid note goes through at seq 1 (no gap)
  t.dispatch("PUBLISH", { note: "fine" });
  assert.equal(t.history[0].seq, 1);
});

test("dispatch: note at exactly the limit passes, empty note still legal", () => {
  const t = new TaskLifecycle("h4");
  t.dispatch("PUBLISH", { note: "x".repeat(MAX_NOTE_LENGTH) });
  assert.equal(t.history[0].note?.length, MAX_NOTE_LENGTH);
  t.dispatch("ACCEPT", { actor: "contributor", note: "" });
  assert.equal(t.history[1].note, "");
});

test("parseHistory: empty actor in an untrusted log is malformed", () => {
  assert.throws(
    () =>
      parseHistory([
        { seq: 1, event: "PUBLISH", from: "DRAFT", to: "OPEN", at: "2026-10-01T00:00:00.000Z", actor: "" },
      ]),
    /invalid history: entry\[0\]: actor must be a non-empty string, got ""/,
  );
  // undefined actor still parses (anonymous dispatch)
  const entries = parseHistory([
    { seq: 1, event: "PUBLISH", from: "DRAFT", to: "OPEN", at: "2026-10-01T00:00:00.000Z" },
  ]);
  assert.equal(entries[0].actor, undefined);
});

test("parseHistory: oversized note in an untrusted log is malformed, boundary passes", () => {
  const make = (len: number) => [
    {
      seq: 1,
      event: "PUBLISH",
      from: "DRAFT",
      to: "OPEN",
      at: "2026-10-01T00:00:00.000Z",
      note: "x".repeat(len),
    },
  ];
  assert.throws(
    () => parseHistory(make(MAX_NOTE_LENGTH + 1)),
    new RegExp(
      `invalid history: entry\\[0\\]: note must be at most ${MAX_NOTE_LENGTH} characters, got ${MAX_NOTE_LENGTH + 1}`,
    ),
  );
  const ok = parseHistory(make(MAX_NOTE_LENGTH));
  assert.equal(ok[0].note?.length, MAX_NOTE_LENGTH);
});

test("round-trip: a hardened dispatch survives toJSON/fromJSON intact", () => {
  const t = new TaskLifecycle("h5");
  t.dispatch("PUBLISH", { actor: "researcher", note: "x".repeat(MAX_NOTE_LENGTH) });
  const snap = t.toJSON();
  const t2 = TaskLifecycle.fromJSON(snap);
  assert.equal(t2.history[0].actor, "researcher");
  assert.equal(t2.history[0].note?.length, MAX_NOTE_LENGTH);
});
