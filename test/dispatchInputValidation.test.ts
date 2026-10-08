import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/index.js";

/**
 * dispatch() must reject non-string actor/note options with an explicit
 * error before mutating anything — live-path validation matching the
 * strict checks fromJSON()/fromHistory() apply to untrusted snapshots.
 */
test("dispatch: non-string actor throws and leaves state/history untouched", () => {
  const t = new TaskLifecycle("t1");
  assert.throws(
    () => t.dispatch("PUBLISH", { actor: 42 as unknown as string }),
    /invalid dispatch options: actor must be a non-empty string/,
  );
  assert.equal(t.state, "DRAFT");
  assert.equal(t.history.length, 0);
});

test("dispatch: every non-string actor shape is rejected", () => {
  for (const bad of [0, false, null, {}, ["researcher"], Symbol("x")] as unknown as string[]) {
    const t = new TaskLifecycle("t2");
    assert.throws(
      () => t.dispatch("PUBLISH", { actor: bad }),
      /invalid dispatch options: actor must be a non-empty string, got /,
      `actor=${String(bad)}`,
    );
    assert.equal(t.state, "DRAFT");
    assert.equal(t.history.length, 0);
  }
});

test("dispatch: non-string note throws and leaves state/history untouched", () => {
  const t = new TaskLifecycle("t3");
  assert.throws(
    () =>
      t.dispatch("PUBLISH", {
        actor: "researcher",
        note: { text: "hi" } as unknown as string,
      }),
    /invalid dispatch options: note must be a string, got object/,
  );
  assert.equal(t.state, "DRAFT");
  assert.equal(t.history.length, 0);
});

test("dispatch: options validation runs before the transition check", () => {
  const t = new TaskLifecycle("t4");
  // ABANDON is invalid from DRAFT, but the bad actor must win (fail fast).
  assert.throws(
    () => t.dispatch("ABANDON", { actor: 7 as unknown as string }),
    /invalid dispatch options: actor must be a non-empty string/,
  );
  assert.equal(t.state, "DRAFT");
});

test("dispatch: valid actor/note still recorded, normal path unaffected", () => {
  const t = new TaskLifecycle("t5");
  t.dispatch("PUBLISH", { actor: "researcher", note: "meets rubric" });
  assert.equal(t.state, "OPEN");
  const entry = t.history[0];
  assert.equal(entry.actor, "researcher");
  assert.equal(entry.note, "meets rubric");
  // empty actor is rejected (zero audit value), but an empty note is
  // still legal; omitting options / passing undefined is legal
  assert.throws(() => t.dispatch("ACCEPT", { actor: "" }), /actor must be a non-empty string/);
  t.dispatch("ACCEPT", { actor: "contributor", note: "" });
  assert.equal(t.history[1].actor, "contributor");
  assert.equal(t.history[1].note, "");
  t.dispatch("START_CAPTURE");
  t.dispatch("SUBMIT", { actor: undefined, note: undefined });
  assert.equal(t.history[3].actor, undefined);
  assert.equal(t.history[3].note, undefined);
});

test("dispatch: rejection on a mid-chain task does not corrupt the trail", () => {
  const t = new TaskLifecycle("t6");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  assert.throws(
    () => t.dispatch("START_CAPTURE", { note: 99 as unknown as string }),
    /invalid dispatch options: note must be a string, got number/,
  );
  assert.equal(t.state, "ACCEPTED");
  assert.equal(t.history.length, 2);
  assert.equal(t.history[1].to, "ACCEPTED");
  // the same event with valid options goes through at the next seq
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  assert.equal(t.history[2].seq, 3);
  assert.equal(t.state, "CAPTURING");
});
