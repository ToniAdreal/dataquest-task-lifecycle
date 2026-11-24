import test from "node:test";
import assert from "node:assert/strict";
import { transition } from "../src/index.js";

/**
 * `transition` state shape (backlog #1365, mirrors escrow #1365).
 *
 * The pure transition function is the state machine's core (diagram,
 * CLI and demo all route through it), and until this change it read
 * `TRANSITIONS[state][event]` with no state guard, so a `null` or
 * mistyped state escaped as a bare `TypeError` (`Cannot read
 * properties of undefined (reading 'CREATE')`) instead of a named
 * error. Rules under test:
 *  - `null` / `undefined` / a number / an unknown string each throw
 *    the named `invalid transition: unknown state …` error (never a
 *    `TypeError`), with the offending value spelled out
 *  - prototype-chain names such as "toString" are rejected as
 *    unknown states rather than read off `Object.prototype`
 *  - state matching is case-sensitive ("draft" is not "DRAFT")
 *  - a valid state with an illegal event keeps the existing
 *    `invalid transition: <event> from <state>` error, including
 *    terminal states (which have no outgoing edges) and a null event
 *  - every legal edge still returns the same next state
 */

test("null state throws a named error, not a bare TypeError", () => {
  assert.throws(
    () => transition(null as never, "PUBLISH"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(
        (error as Error).message,
        "invalid transition: unknown state null",
      );
      return true;
    },
  );
});

test("undefined and numeric states throw a named error", () => {
  assert.throws(
    () => transition(undefined as never, "PUBLISH"),
    /invalid transition: unknown state undefined/,
  );
  assert.throws(
    () => transition(42 as never, "PUBLISH"),
    /invalid transition: unknown state 42/,
  );
});

test("unknown string states throw a named error with the value quoted", () => {
  assert.throws(
    () => transition("x" as never, "PUBLISH"),
    /invalid transition: unknown state "x"/,
  );
  assert.throws(
    () => transition("PAIDD" as never, "PUBLISH"),
    /invalid transition: unknown state "PAIDD"/,
  );
});

test("prototype-chain names are rejected as unknown states", () => {
  assert.throws(
    () => transition("toString" as never, "PUBLISH"),
    /invalid transition: unknown state "toString"/,
  );
  assert.throws(
    () => transition("constructor" as never, "PUBLISH"),
    /invalid transition: unknown state "constructor"/,
  );
});

test("state matching is case-sensitive", () => {
  assert.throws(
    () => transition("draft" as never, "PUBLISH"),
    /invalid transition: unknown state "draft"/,
  );
});

test("terminal states keep the existing invalid-transition error", () => {
  for (const terminal of ["PAID", "ABANDONED", "EXPIRED"] as const) {
    assert.throws(
      () => transition(terminal, "PUBLISH"),
      /invalid transition: PUBLISH from (PAID|ABANDONED|EXPIRED)/,
    );
  }
});

test("illegal events on valid states keep the existing error", () => {
  assert.throws(
    () => transition("DRAFT", "ACCEPT"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(
        (error as Error).message,
        "invalid transition: ACCEPT from DRAFT",
      );
      return true;
    },
  );
});

test("null event on a valid state keeps the existing error", () => {
  assert.throws(
    () => transition("DRAFT", null as never),
    /invalid transition: null from DRAFT/,
  );
});

test("legal edges still return the same next state", () => {
  assert.equal(transition("DRAFT", "PUBLISH"), "OPEN");
  assert.equal(transition("OPEN", "ACCEPT"), "ACCEPTED");
  assert.equal(transition("ACCEPTED", "START_CAPTURE"), "CAPTURING");
  assert.equal(transition("CAPTURING", "SUBMIT"), "SUBMITTED");
  assert.equal(transition("SUBMITTED", "BEGIN_REVIEW"), "IN_REVIEW");
  assert.equal(transition("IN_REVIEW", "APPROVE"), "APPROVED");
  assert.equal(transition("APPROVED", "REQUEST_PAYOUT"), "PAYOUT_PENDING");
  assert.equal(transition("PAYOUT_PENDING", "PAYOUT_COMPLETE"), "PAID");
  assert.equal(transition("REJECTED", "RESUBMIT"), "CAPTURING");
  assert.equal(transition("DISPUTED", "ARBITRATE_APPROVE"), "APPROVED");
});
