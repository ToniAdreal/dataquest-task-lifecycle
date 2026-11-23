import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, verifyHistoryChain } from "../src/index.js";
import type { TaskHistoryEntry } from "../src/index.js";

const SECRET = "audit-secret-1";
const WRONG_SECRET = "audit-secret-2";

/** Drive a task PUBLISH -> ACCEPT -> START_CAPTURE -> SUBMIT on fixed timestamps. */
function chainedTask(id = "chain-1"): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-11-23T00:00:00.000Z",
  });
  task.dispatch("ACCEPT", {
    actor: "contributor-7",
    at: "2026-11-23T00:01:00.000Z",
  });
  task.dispatch("START_CAPTURE", {
    actor: "contributor-7",
    at: "2026-11-23T00:02:00.000Z",
  });
  task.dispatch("SUBMIT", {
    actor: "contributor-7",
    at: "2026-11-23T00:03:00.000Z",
  });
  return task;
}

/** A keyed task driven the same way. */
function keyedTask(id = "keyed-1"): TaskLifecycle {
  const task = new TaskLifecycle(id, { auditSecret: SECRET });
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-11-23T00:00:00.000Z",
  });
  task.dispatch("ACCEPT", {
    actor: "contributor-7",
    at: "2026-11-23T00:01:00.000Z",
  });
  task.dispatch("START_CAPTURE", {
    actor: "contributor-7",
    at: "2026-11-23T00:02:00.000Z",
  });
  task.dispatch("SUBMIT", {
    actor: "contributor-7",
    at: "2026-11-23T00:03:00.000Z",
  });
  return task;
}

/** Detached deep copy, so tampering never touches the task's own history. */
function wireClone(
  entries: readonly TaskHistoryEntry[],
): TaskHistoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as TaskHistoryEntry[];
}

test("verifyHistoryChain: a null history throws, naming the array", () => {
  assert.throws(
    () => verifyHistoryChain(null as never),
    /invalid history: history must be an array/,
  );
});

test("verifyHistoryChain: an undefined history throws, naming the array", () => {
  assert.throws(
    () => verifyHistoryChain(undefined as never),
    /invalid history: history must be an array/,
  );
});

test("verifyHistoryChain: a number, string, or plain-object history throws", () => {
  for (const bad of [42, "x", {}]) {
    assert.throws(
      () => verifyHistoryChain(bad as never),
      /invalid history: history must be an array/,
    );
  }
});

test("verifyHistoryChain: a null entry throws, naming its index", () => {
  assert.throws(
    () => verifyHistoryChain([null as never]),
    /invalid history: entry\[0\]: entry must be an object/,
  );
});

test("verifyHistoryChain: a string entry throws instead of passing as legacy", () => {
  // Before the guard, a string entry carried no hash fields, so the
  // walk read it as a fully hashless legacy history and returned
  // true — a silent wrong answer, not just a TypeError.
  assert.throws(
    () => verifyHistoryChain(["x" as never]),
    /invalid history: entry\[0\]: entry must be an object/,
  );
});

test("verifyHistoryChain: a numeric entry throws, naming its index", () => {
  assert.throws(
    () => verifyHistoryChain([42 as never]),
    /invalid history: entry\[0\]: entry must be an object/,
  );
});

test("verifyHistoryChain: an array entry is not an object entry", () => {
  assert.throws(
    () => verifyHistoryChain([[] as never]),
    /invalid history: entry\[0\]: entry must be an object/,
  );
});

test("verifyHistoryChain: the shape error names the first bad index, not 0", () => {
  const history = wireClone(chainedTask().history);
  assert.throws(
    () => verifyHistoryChain([...history, null as never]),
    /invalid history: entry\[4\]: entry must be an object/,
  );
});

test("verifyHistoryChain: an intact chained history still verifies true", () => {
  assert.equal(verifyHistoryChain(chainedTask().history), true);
});

test("verifyHistoryChain: a tampered entry still returns false, not a throw", () => {
  const history = wireClone(chainedTask().history);
  history[1] = { ...history[1], note: "rewritten after the fact" };
  assert.equal(verifyHistoryChain(history), false);
});

test("verifyHistoryChain: a mixed chained/hashless history still returns false", () => {
  const history = wireClone(chainedTask().history);
  const { hash: _hash, prevHash: _prevHash, ...hashless } = history[2];
  void _hash;
  void _prevHash;
  history[2] = hashless;
  assert.equal(verifyHistoryChain(history), false);
});

test("verifyHistoryChain: a fully hashless legacy history still verifies true", () => {
  const history = wireClone(chainedTask().history).map((entry) => {
    const { hash: _hash, prevHash: _prevHash, ...hashless } = entry;
    void _hash;
    void _prevHash;
    return hashless;
  });
  assert.equal(verifyHistoryChain(history), true);
});

test("verifyHistoryChain: an empty history still verifies true", () => {
  assert.equal(verifyHistoryChain([]), true);
});

test("verifyHistoryChain: a bad audit secret still throws its config error", () => {
  assert.throws(
    () => verifyHistoryChain(chainedTask().history, { auditSecret: "" }),
    /invalid audit secret: auditSecret must not be empty/,
  );
});

test("verifyHistoryChain: the secret error beats a malformed history", () => {
  // Same order as parseHistory: the auditSecret configuration error
  // is checked first, so it is the error the caller sees even when
  // the history is also malformed.
  assert.throws(
    () => verifyHistoryChain(null as never, { auditSecret: "" }),
    /invalid audit secret: auditSecret must not be empty/,
  );
});

test("verifyHistoryChain: a valid secret plus a malformed history throws the array error", () => {
  assert.throws(
    () => verifyHistoryChain(null as never, { auditSecret: SECRET }),
    /invalid history: history must be an array/,
  );
});

test("verifyHistoryChain: the keyed path still verifies and still fails closed", () => {
  const history = keyedTask().history;
  assert.equal(verifyHistoryChain(history, { auditSecret: SECRET }), true);
  assert.equal(
    verifyHistoryChain(history, { auditSecret: WRONG_SECRET }),
    false,
  );
  assert.equal(verifyHistoryChain(history), false);
});
