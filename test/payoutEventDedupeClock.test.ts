import test from "node:test";
import assert from "node:assert/strict";
import { PayoutEventDedupe } from "../src/index.js";

/**
 * `PayoutEventDedupe` clock validation (backlog #1290, same
 * contract as the sibling escrow `SettlementEventDedupe` #1289
 * and the rfc9421 `ReplayCache` #1288).
 *
 * The dedupe's TTL comparisons are `t - prev < ttlMs`. When the
 * clock returns `NaN`, that comparison is false for every recorded
 * id, so a recorded `eventId` looks expired and a retried payout
 * webhook is re-admitted as a first sighting — the replay
 * protection is silently switched off. The same failure mode
 * applied to the `has` probe (a duplicate would be reported
 * unseen), to `size` (every entry would look expired, so 0), and
 * to `exportSnapshot` (an empty snapshot, silently discarding live
 * ids). Rules under test:
 *  - `checkAndRecord`/`has` throw a configuration `Error` (plain
 *    `Error`, not `TypeError`) when the explicit `now` or the
 *    injected clock returns a non-finite number (`NaN`, `Infinity`,
 *    or a non-number); the message names the clock and the value
 *  - a failed clock call leaves the store and the observability
 *    counters untouched, and a good clock afterwards still sees
 *    the recorded id as a duplicate (no `NaN` residue)
 *  - `size`/`exportSnapshot` throw on a bad clock instead of
 *    reporting 0 / exporting an empty snapshot
 *  - `restore` throws when the new dedupe's clock is bad, before
 *    any entry is installed; with a good clock, restore still
 *    drops entries already past their TTL (regression)
 *  - legitimate-clock behaviour is unchanged: a repeat within the
 *    TTL is a duplicate, an id past the TTL is unseen again
 */

const TTL = 60_000;

function mutableClock(start = 1_000_000) {
  let t: unknown = start;
  return {
    now: () => t as number,
    set: (value: unknown) => {
      t = value;
    },
  };
}

/** Assert the throw is a plain configuration Error, not a TypeError. */
function assertConfigError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
    assert.equal(
      err.constructor,
      Error,
      `expected a plain Error, got ${err.constructor.name}`,
    );
    assert.match(err.message, pattern);
    return true;
  });
}

test("checkAndRecord throws when the injected clock returns NaN", () => {
  const dedupe = new PayoutEventDedupe({
    ttlMs: TTL,
    now: () => Number.NaN,
  });
  assertConfigError(
    () => dedupe.checkAndRecord("evt-1"),
    /PayoutEventDedupe: clock must return a finite number of milliseconds since the epoch, got NaN/,
  );
});

test("checkAndRecord throws when the injected clock returns Infinity", () => {
  const dedupe = new PayoutEventDedupe({
    ttlMs: TTL,
    now: () => Number.POSITIVE_INFINITY,
  });
  assertConfigError(
    () => dedupe.checkAndRecord("evt-1"),
    /PayoutEventDedupe: clock must return a finite number of milliseconds since the epoch, got Infinity/,
  );
});

test("has throws on a non-finite explicit now (NaN / Infinity / non-number)", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "x"]) {
    assertConfigError(
      () => dedupe.has("evt-1", bad as unknown as number),
      /PayoutEventDedupe: now must be a finite number of milliseconds since the epoch, got /,
    );
  }
  // The explicit-now failures did not disturb the recorded id.
  assert.equal(dedupe.has("evt-1"), true);
});

test("has throws when the injected clock returns NaN", () => {
  const dedupe = new PayoutEventDedupe({
    ttlMs: TTL,
    now: () => Number.NaN,
  });
  assertConfigError(
    () => dedupe.has("evt-1"),
    /PayoutEventDedupe: clock must return a finite number of milliseconds since the epoch, got NaN/,
  );
});

test("a failed clock call leaves store and counters untouched", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 0,
    misses: 1,
    evictions: 0,
  });

  clock.set(Number.NaN);
  assertConfigError(
    () => dedupe.checkAndRecord("evt-1"),
    /clock must return a finite number/,
  );
  assertConfigError(() => dedupe.has("evt-1"), /clock must return a finite number/);
  assertConfigError(() => dedupe.size, /clock must return a finite number/);
  assertConfigError(
    () => dedupe.exportSnapshot(),
    /clock must return a finite number/,
  );
  // No residue: the failed calls recorded nothing and counted nothing.
  clock.set(1_000_000);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("size throws on a bad clock instead of reporting 0", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.size, 1);
  clock.set(Number.NaN);
  assertConfigError(
    () => dedupe.size,
    /PayoutEventDedupe: clock must return a finite number of milliseconds since the epoch, got NaN/,
  );
});

test("exportSnapshot throws on a bad clock instead of exporting empty", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.deepEqual(dedupe.exportSnapshot(), {
    v: 1,
    entries: [["evt-1", 1_000_000]],
  });
  clock.set(Number.POSITIVE_INFINITY);
  assertConfigError(
    () => dedupe.exportSnapshot(),
    /PayoutEventDedupe: clock must return a finite number of milliseconds since the epoch, got Infinity/,
  );
});

test("restore throws when the new dedupe's clock returns NaN", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  const snapshot = dedupe.exportSnapshot();
  assertConfigError(
    () =>
      PayoutEventDedupe.restore(snapshot, {
        ttlMs: TTL,
        now: () => Number.NaN,
      }),
    /PayoutEventDedupe: clock must return a finite number of milliseconds since the epoch, got NaN/,
  );
});

test("restore with a good clock still drops entries past their TTL", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  const snapshot = dedupe.exportSnapshot();
  clock.set(1_000_000 + TTL);
  const restored = PayoutEventDedupe.restore(snapshot, {
    ttlMs: TTL,
    now: clock.now,
  });
  assert.equal(restored.size, 0);
  assert.equal(restored.checkAndRecord("evt-1"), false);
});

test("legitimate-clock behaviour is unchanged", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  assert.equal(dedupe.has("evt-1"), true);
  assert.equal(dedupe.has("evt-1", 1_000_000 + TTL - 1), true);
  // Exactly at the TTL the record is expired.
  assert.equal(dedupe.has("evt-1", 1_000_000 + TTL), false);
  clock.set(1_000_000 + TTL);
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.size, 1);
});
