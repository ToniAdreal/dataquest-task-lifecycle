import test from "node:test";
import assert from "node:assert/strict";
import {
  isTerminal,
  transitionTable,
  TaskLifecycle,
} from "../src/index.js";
import type { TaskState } from "../src/index.js";

/**
 * `isTerminal` state shape (backlog #1384, mirrors `transition`
 * #1365 and `allowedEvents` #1367).
 *
 * The terminal-state check read `TERMINAL.has(state)` with no state
 * guard, so a `null`, mistyped, or prototype-chain state silently
 * returned `false` — "not terminal" — instead of failing loudly.
 * That is the fail-open hole in the family: a caller passing a
 * misspelled or uninitialised state would have a watchdog or UI
 * gate treat the task as still actionable. Rules under test:
 *  - `null` / `undefined` / a number / an unknown string each throw
 *    the named `invalid isTerminal: unknown state …` error (never a
 *    `TypeError`), with the offending value spelled out
 *  - prototype-chain names such as "toString" are rejected as
 *    unknown states rather than read off `Object.prototype`
 *  - state matching is case-sensitive ("paid" is not "PAID")
 *  - the full 13-state truth table: PAID / ABANDONED / EXPIRED are
 *    terminal, the other ten states are not
 *  - the instance getter agrees with the pure function on every
 *    state a live task can reach
 *  - the terminal set is exactly the set of states with no outgoing
 *    edges in `transitionTable()`, so the two views can never drift
 */

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

const EXPECTED: Record<TaskState, boolean> = {
  DRAFT: false,
  OPEN: false,
  ACCEPTED: false,
  CAPTURING: false,
  SUBMITTED: false,
  IN_REVIEW: false,
  APPROVED: false,
  PAYOUT_PENDING: false,
  PAID: true,
  REJECTED: false,
  DISPUTED: false,
  ABANDONED: true,
  EXPIRED: true,
};

test("null state throws a named error, not a bare TypeError", () => {
  assert.throws(
    () => isTerminal(null as never),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(
        (error as Error).message,
        "invalid isTerminal: unknown state null",
      );
      return true;
    },
  );
});

test("undefined and numeric states throw a named error", () => {
  assert.throws(
    () => isTerminal(undefined as never),
    /invalid isTerminal: unknown state undefined/,
  );
  assert.throws(
    () => isTerminal(42 as never),
    /invalid isTerminal: unknown state 42/,
  );
});

test("unknown string states throw a named error with the value quoted", () => {
  assert.throws(
    () => isTerminal("x" as never),
    /invalid isTerminal: unknown state "x"/,
  );
  assert.throws(
    () => isTerminal("PAIDD" as never),
    /invalid isTerminal: unknown state "PAIDD"/,
  );
});

test("prototype-chain names are rejected as unknown states", () => {
  assert.throws(
    () => isTerminal("toString" as never),
    /invalid isTerminal: unknown state "toString"/,
  );
  assert.throws(
    () => isTerminal("constructor" as never),
    /invalid isTerminal: unknown state "constructor"/,
  );
});

test("state matching is case-sensitive", () => {
  assert.throws(
    () => isTerminal("paid" as never),
    /invalid isTerminal: unknown state "paid"/,
  );
});

test("full thirteen-state truth table", () => {
  for (const state of ALL_STATES) {
    assert.equal(isTerminal(state), EXPECTED[state], state);
  }
});

test("terminal states are exactly PAID, ABANDONED, EXPIRED", () => {
  assert.equal(isTerminal("PAID"), true);
  assert.equal(isTerminal("ABANDONED"), true);
  assert.equal(isTerminal("EXPIRED"), true);
  assert.equal(
    ALL_STATES.filter((state) => isTerminal(state)).length,
    3,
  );
});

test("instance getter agrees with the pure function on every state", () => {
  const check = (task: TaskLifecycle) => {
    assert.equal(task.isTerminal, isTerminal(task.state));
    assert.equal(task.isTerminal, EXPECTED[task.state]);
  };

  // DRAFT -> ... -> PAID (full happy path).
  const happy = new TaskLifecycle("is-terminal-happy");
  check(happy);
  for (const event of [
    "PUBLISH",
    "ACCEPT",
    "START_CAPTURE",
    "SUBMIT",
    "BEGIN_REVIEW",
    "APPROVE",
    "REQUEST_PAYOUT",
    "PAYOUT_COMPLETE",
  ] as const) {
    happy.dispatch(event);
    check(happy);
  }

  // DRAFT -> ... -> DISPUTED via REJECTED.
  const disputed = new TaskLifecycle("is-terminal-disputed");
  for (const event of [
    "PUBLISH",
    "ACCEPT",
    "START_CAPTURE",
    "SUBMIT",
    "BEGIN_REVIEW",
    "REJECT",
    "DISPUTE",
  ] as const) {
    disputed.dispatch(event);
    check(disputed);
  }

  // DRAFT -> OPEN -> ACCEPTED -> ABANDONED.
  const abandoned = new TaskLifecycle("is-terminal-abandoned");
  for (const event of ["PUBLISH", "ACCEPT", "ABANDON"] as const) {
    abandoned.dispatch(event);
    check(abandoned);
  }

  // DRAFT -> OPEN -> EXPIRED.
  const expired = new TaskLifecycle("is-terminal-expired");
  for (const event of ["PUBLISH", "EXPIRE"] as const) {
    expired.dispatch(event);
    check(expired);
  }
});

test("terminal set equals the states with no outgoing edges", () => {
  const withEdges = new Set(
    transitionTable().map((edge) => edge.from),
  );
  const noOutgoing = ALL_STATES.filter((state) => !withEdges.has(state));
  assert.deepEqual(noOutgoing, ["PAID", "ABANDONED", "EXPIRED"]);
  for (const state of ALL_STATES) {
    assert.equal(isTerminal(state), !withEdges.has(state), state);
  }
});
