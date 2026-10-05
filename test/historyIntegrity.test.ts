import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/index.js";

/**
 * Shared audit-log invariant checker:
 *  - seq strictly increments by 1 starting at 1 (no gaps, no reordering)
 *  - from/to chain is continuous: entry[i].from === entry[i-1].to
 *  - the chain starts at DRAFT and the last entry lands on the live state
 *  - every timestamp is a canonical ISO-8601 string, non-decreasing
 *    (same-millisecond dispatches are possible, so >= not >)
 */
function assertHistoryIntegrity(t: TaskLifecycle): void {
  const h = t.history;
  assert.ok(h.length > 0, "history must not be empty after dispatch");
  h.forEach((e, i) => {
    assert.equal(e.seq, i + 1, `seq[${i}] strictly increments by 1`);
    if (i === 0) {
      assert.equal(e.from, "DRAFT", "chain starts at DRAFT");
    } else {
      assert.equal(e.from, h[i - 1].to, `from[${i}] continues to[${i - 1}]`);
    }
    assert.ok(
      !Number.isNaN(Date.parse(e.at)),
      `at[${i}] is parseable: ${e.at}`,
    );
    assert.equal(
      new Date(e.at).toISOString(),
      e.at,
      `at[${i}] is canonical ISO-8601: ${e.at}`,
    );
    if (i > 0) {
      assert.ok(
        Date.parse(e.at) >= Date.parse(h[i - 1].at),
        `at[${i}] non-decreasing`,
      );
    }
  });
  assert.equal(
    h[h.length - 1].to,
    t.state,
    "last entry lands on the live state",
  );
}

function happyPath(): TaskLifecycle {
  const t = new TaskLifecycle("task-hist-001");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  return t;
}

test("history: seq/from-to/ISO integrity on the happy path DRAFT->PAID", () => {
  const t = happyPath();
  assert.equal(t.history.length, 8);
  assertHistoryIntegrity(t);
});

test("history: integrity on the dispute->arbitrate-reject->resubmit path", () => {
  const t = new TaskLifecycle("task-hist-002");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  t.dispatch("START_CAPTURE");
  t.dispatch("SUBMIT");
  t.dispatch("BEGIN_REVIEW");
  t.dispatch("REJECT", { actor: "reviewer", note: "poor framing" });
  t.dispatch("DISPUTE", { actor: "contributor" });
  t.dispatch("ARBITRATE_REJECT", { actor: "moderator" });
  assert.equal(t.state, "REJECTED");
  assertHistoryIntegrity(t);
  t.dispatch("RESUBMIT", { actor: "contributor" });
  assert.equal(t.state, "CAPTURING");
  assertHistoryIntegrity(t); // chain stays continuous across the resubmit
});

test("history: integrity on the abandon and expire short paths", () => {
  const abandoned = new TaskLifecycle("task-hist-003");
  abandoned.dispatch("PUBLISH");
  abandoned.dispatch("ACCEPT");
  abandoned.dispatch("START_CAPTURE");
  abandoned.dispatch("ABANDON", { actor: "contributor" });
  assert.equal(abandoned.state, "ABANDONED");
  assertHistoryIntegrity(abandoned);

  const expired = new TaskLifecycle("task-hist-004");
  expired.dispatch("PUBLISH");
  expired.dispatch("EXPIRE", { actor: "system" });
  assert.equal(expired.state, "EXPIRED");
  assertHistoryIntegrity(expired);
});

test("history: failed dispatch appends nothing (no seq gap)", () => {
  const t = new TaskLifecycle("task-hist-005");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  // APPROVE is illegal from ACCEPTED; transition() throws before any push.
  assert.throws(() => t.dispatch("APPROVE"), /invalid transition/);
  assert.equal(t.history.length, 2, "no partial entry on failure");
  t.dispatch("START_CAPTURE");
  assert.deepEqual(
    t.history.map((h) => h.seq),
    [1, 2, 3],
    "seq resumes with no gap after a failed dispatch",
  );
  assertHistoryIntegrity(t);
});

test("history: entries record the dispatched event, actor and note", () => {
  const t = new TaskLifecycle("task-hist-006");
  t.dispatch("PUBLISH", { actor: "researcher", note: "seed task" });
  t.dispatch("ACCEPT");
  const [e1, e2] = t.history;
  assert.equal(e1.event, "PUBLISH");
  assert.equal(e1.actor, "researcher");
  assert.equal(e1.note, "seed task");
  assert.equal(e2.event, "ACCEPT");
  assert.equal(e2.actor, undefined);
  assert.equal(e2.note, undefined);
  assertHistoryIntegrity(t);
});
