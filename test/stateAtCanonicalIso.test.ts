import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  stateAtFromHistory,
} from "../src/index.js";

/**
 * `stateAt(time)` / `stateAtFromHistory(history, time)` canonical-ISO
 * bar (backlog #1408): a string query time must already be canonical
 * ISO-8601 — the `toISOString()` form, `YYYY-MM-DDTHH:mm:ss.sssZ` —
 * the same bar `parseHistory` applies to stored entry timestamps and
 * `resolveWatchdogAt` applies to a watchdog pin. `Date.parse` accepts
 * far more spellings than that; every one of them is now a caller
 * error, not a guess.
 *
 * Rules under test:
 *  - a `Date` and the same moment as a canonical string still agree
 *  - canonical strings at/around entry boundaries answer unchanged
 *  - every non-canonical spelling throws `invalid stateAt time: …`
 *    naming the canonical bar, on both entry points, before any
 *    history is read
 *  - the same instant in a different spelling is rejected, not
 *    normalized (spelling is part of the contract)
 *  - a query 1 ms after an entry boundary is canonical and answers
 *    with that entry's effect
 */

const T10 = "2026-03-01T10:00:00.000Z";
const T11 = "2026-03-01T11:00:00.000Z";
const T12 = "2026-03-01T12:00:00.000Z";
const T13 = "2026-03-01T13:00:00.000Z";

/** Every entry parses under `Date.parse` in this runtime — each one
 *  answered a query before this fix, so each is a behavior change,
 *  not a spelling that was already rejected. */
const NON_CANONICAL: readonly string[] = [
  "2026-03-01", // date-only
  "2026-03-01T10:00:00Z", // no milliseconds
  "2026-03-01T10:00:00.00Z", // two-digit fraction
  "2026-03-01T10:00:00+00:00", // offset form, same instant as T10
  "2026-03-01T10:00:00.000+00:00", // offset form with milliseconds
  "March 1, 2026", // locale spelling
  "2026/03/01 10:00:00", // slash spelling
  "2026-03-01 10:00:00.000Z", // space separator
  "2026-03-01T10:00:00.000", // no timezone
  "2026-03-01t10:00:00.000z", // lowercase separators
];

/** PUBLISH @10:00, ACCEPT @11:00, START_CAPTURE @12:00, SUBMIT @13:00. */
function buildTask(): TaskLifecycle {
  const task = new TaskLifecycle("task-042");
  task.dispatch("PUBLISH", { at: T10 });
  task.dispatch("ACCEPT", { at: T11 });
  task.dispatch("START_CAPTURE", { at: T12 });
  task.dispatch("SUBMIT", { at: T13 });
  return task;
}

test("stateAt: non-canonical date spellings throw on the instance method", () => {
  const task = buildTask();
  for (const time of NON_CANONICAL) {
    assert.throws(
      () => task.stateAt(time),
      /invalid stateAt time: expected a canonical ISO-8601 string or a valid Date/,
      `time=${time}`,
    );
  }
  // Nothing was read or moved: the query failed before any history
  // was touched, and the task is untouched afterwards.
  assert.equal(task.state, "SUBMITTED");
  assert.equal(task.history.length, 4);
});

test("stateAtFromHistory: the same spellings throw on the pure function", () => {
  const task = buildTask();
  for (const time of NON_CANONICAL) {
    assert.throws(
      () => stateAtFromHistory(task.history, time),
      /invalid stateAt time: expected a canonical ISO-8601 string or a valid Date/,
      `time=${time}`,
    );
  }
});

test("stateAt: the same instant in a different spelling is rejected, not normalized", () => {
  const task = buildTask();
  // Both name the exact PUBLISH instant, and both answered "OPEN"
  // before this fix. Spelling is part of the contract: a caller that
  // means 10:00 UTC must write it canonically.
  for (const time of [
    "2026-03-01T10:00:00Z",
    "2026-03-01T10:00:00+00:00",
  ]) {
    assert.equal(Date.parse(time), Date.parse(T10));
    assert.throws(
      () => task.stateAt(time),
      /invalid stateAt time: expected a canonical ISO-8601 string or a valid Date/,
      `time=${time}`,
    );
  }
});

test("stateAt: the error names the rejected value", () => {
  const task = buildTask();
  assert.throws(
    () => task.stateAt("2026-03-01"),
    {
      message:
        "invalid stateAt time: expected a canonical ISO-8601 string or a valid Date, got 2026-03-01",
    },
  );
  assert.throws(
    () => stateAtFromHistory(task.history, "2026-03-01T10:00:00Z"),
    {
      message:
        "invalid stateAt time: expected a canonical ISO-8601 string or a valid Date, got 2026-03-01T10:00:00Z",
    },
  );
});

test("stateAt: canonical strings answer unchanged at and around boundaries", () => {
  const task = buildTask();
  // Exactly on an entry: inclusive boundary, that entry's effect.
  assert.equal(task.stateAt(T10), "OPEN");
  assert.equal(task.stateAt(T13), "SUBMITTED");
  // 1 ms after an entry is still canonical and sees the entry.
  assert.equal(task.stateAt("2026-03-01T10:00:00.001Z"), "OPEN");
  assert.equal(task.stateAt("2026-03-01T12:59:59.999Z"), "CAPTURING");
  // Between entries, and before the first entry: unchanged.
  assert.equal(task.stateAt("2026-03-01T10:30:00.000Z"), "OPEN");
  assert.equal(task.stateAt("2026-03-01T11:30:00.000Z"), "ACCEPTED");
  assert.equal(task.stateAt("2026-03-01T09:59:59.999Z"), "DRAFT");
  assert.equal(task.stateAt("2026-03-02T00:00:00.000Z"), "SUBMITTED");
  // The pure function agrees on every probe.
  for (const probe of [
    T10,
    "2026-03-01T10:00:00.001Z",
    "2026-03-01T11:30:00.000Z",
    T13,
    "2026-03-01T09:59:59.999Z",
  ]) {
    assert.equal(
      stateAtFromHistory(task.history, probe),
      task.stateAt(probe),
      `probe ${probe}`,
    );
  }
});

test("stateAt: a Date and the same moment as a canonical string still agree", () => {
  const task = buildTask();
  for (const probe of [T10, T11, T12, T13, "2026-03-01T11:30:00.000Z"]) {
    assert.equal(
      task.stateAt(new Date(probe)),
      task.stateAt(probe),
      `probe ${probe}`,
    );
  }
  // A Date carrying non-zero milliseconds agrees with its canonical
  // spelling, and an invalid Date still throws with the new wording.
  assert.equal(
    task.stateAt(new Date("2026-03-01T10:00:00.001Z")),
    "OPEN",
  );
  assert.throws(
    () => task.stateAt(new Date(Number.NaN)),
    /invalid stateAt time: expected a canonical ISO-8601 string or a valid Date/,
  );
});

test("stateAt: a canonical query never guesses — junk around a valid time still throws", () => {
  const task = buildTask();
  // Leading/trailing whitespace never parsed, and a trailing "Z "
  // is not the canonical form either; both stay rejected.
  for (const time of [
    " 2026-03-01T10:00:00.000Z",
    "2026-03-01T10:00:00.000Z ",
  ]) {
    assert.throws(
      () => task.stateAt(time),
      /invalid stateAt time: expected a canonical ISO-8601 string or a valid Date/,
      `time=${JSON.stringify(time)}`,
    );
  }
});
