import test from "node:test";
import assert from "node:assert/strict";
import { allowedEvents, transition } from "../src/index.js";

/**
 * `allowedEvents` state shape (backlog #1367, mirrors escrow #1366
 * and `transition` #1365).
 *
 * The UI-gating helper read `Object.keys(TRANSITIONS[state])` with no
 * state guard, so a `null` or mistyped state escaped as a bare
 * `TypeError` (`Cannot convert undefined or null to object`) instead of
 * a named error. Rules under test:
 *  - `null` / `undefined` / a number / an unknown string each throw
 *    the named `invalid allowedEvents: unknown state …` error (never a
 *    `TypeError`), with the offending value spelled out
 *  - prototype-chain names such as "toString" are rejected as
 *    unknown states rather than read off `Object.prototype`
 *  - state matching is case-sensitive ("draft" is not "DRAFT")
 *  - every legal state still returns the same event list as before
 *    the guard (13 states, terminal states return an empty array)
 *  - every event listed is a legal edge `transition(state, event)`
 *    accepts, so the listing can never advertise an impossible move
 */

test("null state throws a named error, not a bare TypeError", () => {
  assert.throws(
    () => allowedEvents(null as never),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(
        (error as Error).message,
        "invalid allowedEvents: unknown state null",
      );
      return true;
    },
  );
});

test("undefined and numeric states throw a named error", () => {
  assert.throws(
    () => allowedEvents(undefined as never),
    /invalid allowedEvents: unknown state undefined/,
  );
  assert.throws(
    () => allowedEvents(42 as never),
    /invalid allowedEvents: unknown state 42/,
  );
});

test("unknown string states throw a named error with the value quoted", () => {
  assert.throws(
    () => allowedEvents("x" as never),
    /invalid allowedEvents: unknown state "x"/,
  );
  assert.throws(
    () => allowedEvents("PAIDD" as never),
    /invalid allowedEvents: unknown state "PAIDD"/,
  );
});

test("prototype-chain names are rejected as unknown states", () => {
  assert.throws(
    () => allowedEvents("toString" as never),
    /invalid allowedEvents: unknown state "toString"/,
  );
  assert.throws(
    () => allowedEvents("constructor" as never),
    /invalid allowedEvents: unknown state "constructor"/,
  );
});

test("state matching is case-sensitive", () => {
  assert.throws(
    () => allowedEvents("draft" as never),
    /invalid allowedEvents: unknown state "draft"/,
  );
});

test("all thirteen states return their pre-guard event lists", () => {
  assert.deepEqual(allowedEvents("DRAFT"), ["PUBLISH"]);
  assert.deepEqual(allowedEvents("OPEN"), ["ACCEPT", "EXPIRE"]);
  assert.deepEqual(allowedEvents("ACCEPTED"), [
    "START_CAPTURE",
    "ABANDON",
    "EXPIRE",
  ]);
  assert.deepEqual(allowedEvents("CAPTURING"), [
    "SUBMIT",
    "ABANDON",
    "EXPIRE",
  ]);
  assert.deepEqual(allowedEvents("SUBMITTED"), ["BEGIN_REVIEW", "EXPIRE"]);
  assert.deepEqual(allowedEvents("IN_REVIEW"), ["APPROVE", "REJECT"]);
  assert.deepEqual(allowedEvents("APPROVED"), ["REQUEST_PAYOUT"]);
  assert.deepEqual(allowedEvents("PAYOUT_PENDING"), ["PAYOUT_COMPLETE"]);
  assert.deepEqual(allowedEvents("REJECTED"), ["DISPUTE", "RESUBMIT"]);
  assert.deepEqual(allowedEvents("DISPUTED"), [
    "ARBITRATE_APPROVE",
    "ARBITRATE_REJECT",
  ]);
});

test("terminal states return an empty array", () => {
  assert.deepEqual(allowedEvents("PAID"), []);
  assert.deepEqual(allowedEvents("ABANDONED"), []);
  assert.deepEqual(allowedEvents("EXPIRED"), []);
});

test("every listed event is a legal edge from that state", () => {
  const states = [
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
  ] as const;
  for (const state of states) {
    for (const event of allowedEvents(state)) {
      assert.doesNotThrow(() => transition(state, event));
    }
  }
});

test("returned arrays are fresh per call", () => {
  const first = allowedEvents("OPEN");
  first.push("ACCEPT");
  assert.deepEqual(allowedEvents("OPEN"), ["ACCEPT", "EXPIRE"]);
});
