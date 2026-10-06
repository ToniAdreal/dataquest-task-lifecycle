import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  parseHistory,
  type TaskEvent,
} from "../src/index.js";

/**
 * dispatch() accepts an optional `at` timestamp override so audit tests can
 * be deterministic instead of asserting against the wall clock.
 *
 * Rules under test:
 *  - injected `at` lands verbatim in the history entry (canonical ISO-8601)
 *  - non-canonical ISO / non-string values throw before anything mutates
 *  - `at` earlier than the previous entry's `at` throws and leaves no trace
 *    (non-decreasing, same semantics parseHistory() enforces)
 *  - `at` equal to the previous entry's `at` is allowed
 *  - omitting `at` keeps the existing wall-clock behaviour
 *  - the option check is fail-fast: it runs before the transition check
 */

test("dispatch: injected at lands verbatim in the history entry", () => {
  const t = new TaskLifecycle("t1");
  const at = "2026-03-01T10:00:00.000Z";
  t.dispatch("PUBLISH", { actor: "researcher", at });
  assert.equal(t.history[0].at, at);
  // A later injected timestamp on the next dispatch works too.
  const at2 = "2026-03-01T11:30:00.000Z";
  t.dispatch("ACCEPT", { actor: "contributor", at: at2 });
  assert.equal(t.history[1].at, at2);
});

test("dispatch: injected at equal to the previous entry's at is allowed", () => {
  const t = new TaskLifecycle("t2");
  const at = "2026-03-01T10:00:00.000Z";
  t.dispatch("PUBLISH", { at });
  t.dispatch("ACCEPT", { at }); // non-decreasing: equal is fine
  assert.equal(t.history[1].at, at);
});

test("dispatch: non-canonical ISO at values are rejected", () => {
  const bad = [
    "2026-03-01", // date-only, not canonical
    "2026-03-01T10:00:00Z", // canonical requires .000Z millis
    "2026-03-01T10:00:00.000+00:00", // offset form, not canonical
    "not-a-date",
    "2026-13-01T10:00:00.000Z",
  ];
  for (const at of bad) {
    const t = new TaskLifecycle("t3");
    assert.throws(
      () => t.dispatch("PUBLISH", { at }),
      /invalid dispatch options: at must be canonical ISO-8601/,
      `at=${at}`,
    );
    assert.equal(t.state, "DRAFT");
    assert.equal(t.history.length, 0);
  }
});

test("dispatch: non-string at is rejected", () => {
  for (const at of [1719830400000, null, {}, true] as unknown as string[]) {
    const t = new TaskLifecycle("t4");
    assert.throws(
      () => t.dispatch("PUBLISH", { at }),
      /invalid dispatch options: at must be canonical ISO-8601/,
      `at=${String(at)}`,
    );
    assert.equal(t.state, "DRAFT");
    assert.equal(t.history.length, 0);
  }
});

test("dispatch: at earlier than the previous entry throws and leaves no trace", () => {
  const t = new TaskLifecycle("t5");
  t.dispatch("PUBLISH", { at: "2026-03-01T10:00:00.000Z" });
  assert.throws(
    () => t.dispatch("ACCEPT", { at: "2026-03-01T09:59:59.999Z" }),
    /invalid dispatch options: at .* is earlier than the previous entry's at/,
  );
  // Nothing was appended: the failed dispatch left no trace, and the next
  // legal dispatch continues at the next seq with no gap.
  assert.equal(t.state, "OPEN");
  assert.equal(t.history.length, 1);
  t.dispatch("ACCEPT", { at: "2026-03-01T12:00:00.000Z" });
  assert.equal(t.history[1].seq, 2);
  assert.equal(t.history[1].at, "2026-03-01T12:00:00.000Z");
});

test("dispatch: at validation is fail-fast, before the transition check", () => {
  const t = new TaskLifecycle("t6");
  assert.throws(
    () =>
      t.dispatch("NOT_A_REAL_EVENT" as TaskEvent, { at: "not-an-iso-date" }),
    /invalid dispatch options: at must be canonical ISO-8601/,
  );
  assert.equal(t.state, "DRAFT");
  assert.equal(t.history.length, 0);
});

test("dispatch: omitting at keeps the wall-clock behaviour", () => {
  const t = new TaskLifecycle("t7");
  const before = Date.now();
  t.dispatch("PUBLISH");
  const after = Date.now();
  const at = t.history[0].at;
  const ms = Date.parse(at);
  assert.ok(!Number.isNaN(ms), "entry at must parse");
  assert.equal(
    new Date(ms).toISOString(),
    at,
    "entry at must be canonical ISO-8601",
  );
  assert.ok(ms >= before && ms <= after, "entry at must be the wall clock");
});

test("dispatch: injected timestamps stay replay-safe through parseHistory", () => {
  const t = new TaskLifecycle("t8");
  t.dispatch("PUBLISH", { at: "2026-03-01T10:00:00.000Z" });
  t.dispatch("ACCEPT", { at: "2026-03-01T11:00:00.000Z" });
  const restored = TaskLifecycle.fromHistory("t8", t.history);
  assert.equal(restored.state, t.state);
  assert.deepEqual(
    restored.history.map((e) => e.at),
    t.history.map((e) => e.at),
  );
  // The live history already satisfies parseHistory() strictness by itself.
  parseHistory(JSON.parse(JSON.stringify(t.history)));
});
