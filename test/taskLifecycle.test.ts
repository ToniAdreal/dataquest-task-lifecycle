import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  allowedEvents,
  isTerminal,
  transition,
} from "../src/index.js";

function happyPath(): TaskLifecycle {
  const t = new TaskLifecycle("task-001");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer", note: "meets rubric" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  return t;
}

test("happy path: draft -> paid", () => {
  const t = happyPath();
  assert.equal(t.state, "PAID");
  assert.equal(t.isTerminal, true);
  assert.deepEqual(
    t.history.map((h) => h.to),
    [
      "OPEN",
      "ACCEPTED",
      "CAPTURING",
      "SUBMITTED",
      "IN_REVIEW",
      "APPROVED",
      "PAYOUT_PENDING",
      "PAID",
    ],
  );
  assert.deepEqual(
    t.history.map((h) => h.seq),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test("rejection -> resubmit -> approve -> paid", () => {
  const t = new TaskLifecycle("task-002");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  t.dispatch("START_CAPTURE");
  t.dispatch("SUBMIT");
  t.dispatch("BEGIN_REVIEW");
  t.dispatch("REJECT", { actor: "reviewer", note: "poor framing, see feedback" });
  assert.equal(t.state, "REJECTED");
  assert.equal(t.isTerminal, false);
  t.dispatch("RESUBMIT", { actor: "contributor" });
  assert.equal(t.state, "CAPTURING");
  t.dispatch("SUBMIT");
  t.dispatch("BEGIN_REVIEW");
  t.dispatch("APPROVE");
  t.dispatch("REQUEST_PAYOUT");
  t.dispatch("PAYOUT_COMPLETE");
  assert.equal(t.state, "PAID");
});

test("dispute -> senior moderator arbitration (approve)", () => {
  const t = new TaskLifecycle("task-003");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  t.dispatch("START_CAPTURE");
  t.dispatch("SUBMIT");
  t.dispatch("BEGIN_REVIEW");
  t.dispatch("REJECT");
  t.dispatch("DISPUTE", { actor: "contributor", note: "contests rejection" });
  assert.equal(t.state, "DISPUTED");
  t.dispatch("ARBITRATE_APPROVE", { actor: "moderator" });
  assert.equal(t.state, "APPROVED");
});

test("dispute -> arbitration upholds rejection", () => {
  const t = new TaskLifecycle("task-004");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  t.dispatch("START_CAPTURE");
  t.dispatch("SUBMIT");
  t.dispatch("BEGIN_REVIEW");
  t.dispatch("REJECT");
  t.dispatch("DISPUTE");
  t.dispatch("ARBITRATE_REJECT", { actor: "moderator" });
  assert.equal(t.state, "REJECTED");
});

test("abandonment mid-capture", () => {
  const t = new TaskLifecycle("task-005");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  t.dispatch("START_CAPTURE");
  t.dispatch("ABANDON", { actor: "contributor" });
  assert.equal(t.state, "ABANDONED");
  assert.equal(t.isTerminal, true);
});

test("expiration while open", () => {
  const t = new TaskLifecycle("task-006");
  t.dispatch("PUBLISH");
  t.dispatch("EXPIRE", { actor: "system", note: "acceptance window elapsed" });
  assert.equal(t.state, "EXPIRED");
  assert.equal(t.isTerminal, true);
});

test("invalid transitions throw", () => {
  const t = new TaskLifecycle("task-007");
  assert.throws(() => t.dispatch("APPROVE"), /invalid transition/);
  t.dispatch("PUBLISH");
  assert.throws(() => t.dispatch("SUBMIT"), /invalid transition/);
  assert.throws(() => t.dispatch("PUBLISH"), /invalid transition/);
});

test("terminal states accept no further events", () => {
  const t = happyPath(); // PAID
  for (const evt of ["DISPUTE", "EXPIRE", "PUBLISH"] as const) {
    assert.throws(() => t.dispatch(evt), /invalid transition/);
  }
});

test("pure helpers", () => {
  assert.equal(transition("OPEN", "ACCEPT"), "ACCEPTED");
  assert.deepEqual(allowedEvents("IN_REVIEW"), ["APPROVE", "REJECT"]);
  assert.deepEqual(allowedEvents("PAID"), []);
  assert.equal(isTerminal("PAID"), true);
  assert.equal(isTerminal("ABANDONED"), true);
  assert.equal(isTerminal("EXPIRED"), true);
  assert.equal(isTerminal("DISPUTED"), false);
});
