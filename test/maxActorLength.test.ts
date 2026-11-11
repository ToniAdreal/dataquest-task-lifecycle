import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  MAX_ACTOR_LENGTH,
  MAX_NOTE_LENGTH,
  historyFromNdjson,
  historyToNdjson,
  parseHistory,
} from "../src/index.js";
import type { TaskHistoryEntry } from "../src/index.js";

/**
 * `actor` length cap (backlog #1057, mirrors escrow #1056): an actor is a
 * short person/service identifier, but dispatch() used to accept any
 * length and write it verbatim into the append-only audit history, from
 * where it fans out into snapshots, NDJSON exports, and payout-webhook
 * payloads.
 *
 * Rules under test:
 *  - the cap is MAX_ACTOR_LENGTH = 256, exported from the index
 *  - dispatch() rejects an actor longer than the cap (never truncates:
 *    truncating would change who the audit trail says performed the
 *    dispatch), before anything mutates, before the idempotency dedupe,
 *    and before the RBAC check — so an overlong actor reports the
 *    length error even on a policy-listed event and consumes no key
 *  - an actor of exactly the cap passes verbatim, through dispatch,
 *    toJSON()/fromJSON(), parseHistory(), fromHistory(), and NDJSON
 *    round-trips
 *  - parseHistory()/fromJSON()/fromHistory()/historyFromNdjson() reject
 *    an overlong actor in an untrusted log (the parse side shares
 *    dispatch's cap, so a corrupted snapshot cannot smuggle an
 *    unbounded actor back in)
 *  - rolePolicy actor names are deliberately NOT capped: a policy is
 *    task configuration, never audit data, and an overlong policy name
 *    can never match a legal dispatch (dispatch rejects first), so it
 *    is only dead configuration — constructible, never matching
 *  - the cap is independent of the note cap: a max-length actor and a
 *    max-length note coexist, and each overlong field still reports
 *    its own error (actor first, since its check runs first)
 */

function toApproved(id = "actorcap-1"): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

const overlongActor = "x".repeat(MAX_ACTOR_LENGTH + 1);
const atCapActor = "y".repeat(MAX_ACTOR_LENGTH);
const overlongNote = "n".repeat(MAX_NOTE_LENGTH + 1);
const atCapNote = "n".repeat(MAX_NOTE_LENGTH);

/** Deep-clone a history with one entry's actor replaced. */
function historyWithActor(
  task: TaskLifecycle,
  index: number,
  actor: string,
): TaskHistoryEntry[] {
  const entries = JSON.parse(JSON.stringify(task.history)) as TaskHistoryEntry[];
  entries[index].actor = actor;
  return entries;
}

test("MAX_ACTOR_LENGTH is 256", () => {
  assert.equal(MAX_ACTOR_LENGTH, 256);
});

test("dispatch rejects an overlong actor, no history residue", () => {
  const t = toApproved();
  const before = t.history.length;
  assert.throws(
    () => t.dispatch("REQUEST_PAYOUT", { actor: overlongActor }),
    /invalid dispatch options: actor must be at most 256 characters, got 257/,
  );
  assert.equal(t.state, "APPROVED");
  assert.equal(t.history.length, before);
});

test("an actor of exactly 256 characters passes verbatim", () => {
  const t = toApproved();
  t.dispatch("REQUEST_PAYOUT", { actor: atCapActor });
  assert.equal(t.state, "PAYOUT_PENDING");
  assert.equal(t.history[t.history.length - 1].actor, atCapActor);
});

test("an actor of 257 characters is rejected", () => {
  const t = toApproved();
  assert.throws(
    () => t.dispatch("REQUEST_PAYOUT", { actor: overlongActor }),
    /got 257/,
  );
  // A short actor is unaffected by the cap.
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.equal(t.state, "PAYOUT_PENDING");
});

test("a non-string actor still reports the old shape error", () => {
  const t = toApproved();
  assert.throws(
    () => t.dispatch("REQUEST_PAYOUT", { actor: 42 as never }),
    /invalid dispatch options: actor must be a non-empty string, got 42/,
  );
});

test("an empty actor still reports the old shape error", () => {
  const t = toApproved();
  assert.throws(
    () => t.dispatch("REQUEST_PAYOUT", { actor: "" }),
    /invalid dispatch options: actor must be a non-empty string, got ""/,
  );
});

test("a rejected overlong actor does not consume an idempotency key", () => {
  const t = toApproved();
  assert.throws(
    () =>
      t.dispatch("REQUEST_PAYOUT", {
        actor: overlongActor,
        idempotencyKey: "cap-key-1",
      }),
    /actor must be at most 256 characters/,
  );
  // Same key with a legal actor still dispatches (the key was not
  // consumed by the rejection), and a repeat then dedupes.
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    idempotencyKey: "cap-key-1",
  });
  assert.equal(t.state, "PAYOUT_PENDING");
  const historyAfterFirst = t.history.length;
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    idempotencyKey: "cap-key-1",
  });
  assert.equal(t.history.length, historyAfterFirst);
});

test("an overlong actor reports the length error before RBAC", () => {
  const t = new TaskLifecycle("actorcap-rbac", {
    rolePolicy: { PUBLISH: ["researcher"] },
  });
  assert.throws(
    () => t.dispatch("PUBLISH", { actor: overlongActor }),
    /invalid dispatch options: actor must be at most 256 characters, got 257/,
  );
  // A short, non-allowlisted actor still reports the RBAC error.
  assert.throws(
    () => t.dispatch("PUBLISH", { actor: "contributor" }),
    /actor not authorized for PUBLISH/,
  );
});

test("an overlong rolePolicy name is constructible but never matches", () => {
  const t = new TaskLifecycle("actorcap-policy", {
    rolePolicy: { PUBLISH: [overlongActor] },
  });
  // The policy name itself can never be used: dispatch rejects it
  // first as an overlong actor, before the RBAC check.
  assert.throws(
    () => t.dispatch("PUBLISH", { actor: overlongActor }),
    /actor must be at most 256 characters/,
  );
  // And no short actor can match it either — it is dead config.
  assert.throws(
    () => t.dispatch("PUBLISH", { actor: "researcher" }),
    /actor not authorized for PUBLISH/,
  );
});

test("a max-length actor and a max-length note coexist", () => {
  const t = toApproved();
  t.dispatch("REQUEST_PAYOUT", { actor: atCapActor, note: atCapNote });
  const entry = t.history[t.history.length - 1];
  assert.equal(entry.actor, atCapActor);
  assert.equal(entry.note, atCapNote);
});

test("an overlong note with a legal actor still reports the note error", () => {
  const t = toApproved();
  assert.throws(
    () =>
      t.dispatch("REQUEST_PAYOUT", {
        actor: "contributor",
        note: overlongNote,
      }),
    /invalid dispatch options: note must be at most 32768 characters/,
  );
  assert.equal(t.history.length, 6);
});

test("an overlong actor with an overlong note reports the actor error first", () => {
  const t = toApproved();
  assert.throws(
    () =>
      t.dispatch("REQUEST_PAYOUT", {
        actor: overlongActor,
        note: overlongNote,
      }),
    /invalid dispatch options: actor must be at most 256 characters, got 257/,
  );
  assert.equal(t.history.length, 6);
});

test("parseHistory rejects an overlong actor in a history entry", () => {
  const t = toApproved();
  const entries = historyWithActor(t, 0, overlongActor);
  assert.throws(
    () => parseHistory(entries),
    /invalid history: entry\[0\]: actor must be at most 256 characters, got 257/,
  );
});

test("fromJSON rejects a snapshot carrying an overlong actor", () => {
  const t = toApproved();
  const snapshot = JSON.parse(JSON.stringify(t.toJSON())) as {
    history: TaskHistoryEntry[];
  };
  snapshot.history[0].actor = overlongActor;
  assert.throws(
    () => TaskLifecycle.fromJSON(snapshot),
    /invalid history: entry\[0\]: actor must be at most 256 characters, got 257/,
  );
});

test("fromHistory rejects a history with an overlong actor", () => {
  const t = toApproved();
  const entries = historyWithActor(t, 2, overlongActor);
  assert.throws(
    () => TaskLifecycle.fromHistory("actorcap-1", entries),
    /invalid history: entry\[2\]: actor must be at most 256 characters, got 257/,
  );
});

test("historyFromNdjson rejects NDJSON carrying an overlong actor", () => {
  const t = toApproved();
  const ndjson = historyToNdjson(t).replace(
    '"actor":"researcher"',
    `"actor":"${overlongActor}"`,
  );
  assert.notEqual(ndjson, historyToNdjson(t));
  assert.throws(
    () => historyFromNdjson(ndjson),
    /invalid ndjson: line 1: actor must be at most 256 characters, got 257/,
  );
});

test("an actor of exactly 256 characters restores on all four routes", () => {
  const t = toApproved("actorcap-restore");
  t.dispatch("REQUEST_PAYOUT", { actor: atCapActor });
  const history = JSON.parse(JSON.stringify(t.history)) as TaskHistoryEntry[];

  const fromSnapshot = TaskLifecycle.fromJSON(t.toJSON());
  assert.equal(fromSnapshot.history[6].actor, atCapActor);

  const fromParsed = parseHistory(history);
  assert.equal(fromParsed[6].actor, atCapActor);

  const fromReplayed = TaskLifecycle.fromHistory("actorcap-restore", history);
  assert.equal(fromReplayed.history[6].actor, atCapActor);
  assert.equal(fromReplayed.state, "PAYOUT_PENDING");

  const ndjson = historyToNdjson(t);
  const fromNdjson = historyFromNdjson(ndjson);
  assert.equal(fromNdjson[6].actor, atCapActor);
});
