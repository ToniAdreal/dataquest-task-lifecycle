import test from "node:test";
import assert from "node:assert/strict";
import { PayoutEventDedupe } from "../src/index.js";
import type { PayoutEventDedupeSnapshot } from "../src/index.js";

/**
 * Snapshot export/restore for `PayoutEventDedupe` (backlog #172).
 *
 * The dedupe (#157) was memory-only: a receiver restart forgot every
 * id inside its TTL, reopening exactly the double-payout window
 * the store exists to close — at deploy/scale-out time. Rules under
 * test (the sibling escrow `SettlementEventDedupe` #168 paradigm,
 * itself the rfc9421 `ReplayCache` #146 paradigm):
 *  - `exportSnapshot()` returns `{ v: 1, entries: [eventId, seenAtMs][] }`
 *    with only the entries still live against the store's own clock,
 *    as a detached copy
 *  - `restore()` (alias `fromSnapshot()`) rebuilds a store whose ids
 *    still dedupe, with TTLs counting from the original `seenAtMs` —
 *    restoring never restarts an id's window
 *  - malformed snapshots (wrong version, non-array entries, bad entry
 *    types, unknown fields, non-object input) throw a clear error
 *  - restoring more than `maxEntries` evicts the oldest `seenAtMs`
 *    first; expired entries are dropped at load, not carried
 *  - observability counters do not travel with the snapshot: a
 *    restored store starts them at zero, and load-time drops are not
 *    counted as evictions
 *  - honest scope stays single-process: a snapshot bridges one
 *    process across its own restart, it is not shared storage
 */

const TTL = 60_000;

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("ids seen before export still count as duplicates after restore", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-2"), false);

  const snapshot = dedupe.exportSnapshot();
  assert.equal(snapshot.v, 1);
  assert.deepEqual(snapshot.entries, [
    ["evt-1", 1_000_000],
    ["evt-2", 1_000_000],
  ]);

  // Round-trip through JSON, as a persisted snapshot would be.
  const revived = PayoutEventDedupe.restore(
    JSON.parse(JSON.stringify(snapshot)) as unknown,
    { ttlMs: TTL, now: clock.now },
  );
  assert.equal(revived.checkAndRecord("evt-1"), true);
  assert.equal(revived.checkAndRecord("evt-2"), true);
  assert.equal(revived.checkAndRecord("evt-3"), false); // genuinely new
  assert.equal(revived.size, 3);
});

test("entries already expired at export time are not in the snapshot", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("old");
  clock.advance(TTL); // "old" reaches its boundary: expired
  dedupe.checkAndRecord("live");
  const snapshot = dedupe.exportSnapshot();
  assert.deepEqual(snapshot.entries, [["live", 1_000_000 + TTL]]);
});

test("a restored id keeps counting down its original TTL, not a fresh one", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("evt-1");
  clock.advance(TTL - 1_000); // restore happens 1s before expiry
  const revived = PayoutEventDedupe.restore(dedupe.exportSnapshot(), {
    ttlMs: TTL,
    now: clock.now,
  });
  assert.equal(revived.checkAndRecord("evt-1"), true); // still inside
  clock.advance(1_000); // original first-seen + TTL is now reached
  // If restore had restarted the window this would still be true.
  assert.equal(revived.checkAndRecord("evt-1"), false);
});

test("malformed snapshots throw a clear error", () => {
  const bad: Array<[unknown, RegExp]> = [
    [null, /invalid snapshot: expected an object/],
    ["snapshot", /invalid snapshot: expected an object/],
    [[], /invalid snapshot: expected an object/],
    [{ entries: [] }, /invalid snapshot: unsupported snapshot version/],
    [{ v: 2, entries: [] }, /invalid snapshot: unsupported snapshot version 2/],
    [{ v: 1 }, /invalid snapshot: entries must be an array/],
    [{ v: 1, entries: "evt-1" }, /invalid snapshot: entries must be an array/],
    [
      { v: 1, entries: [], extra: true },
      /invalid snapshot: unknown field "extra"/,
    ],
    [
      { v: 1, entries: ["evt-1"] },
      /invalid snapshot: entries\[0\] must be a \[eventId, seenAtMs\] pair/,
    ],
    [
      { v: 1, entries: [["evt-1"]] },
      /invalid snapshot: entries\[0\] must be a \[eventId, seenAtMs\] pair/,
    ],
    [
      { v: 1, entries: [[42, 1_000]] },
      /invalid snapshot: entries\[0\]: eventId must be a non-empty string/,
    ],
    [
      { v: 1, entries: [["", 1_000]] },
      /invalid snapshot: entries\[0\]: eventId must be a non-empty string/,
    ],
    [
      { v: 1, entries: [["evt-1", "1000"]] },
      /invalid snapshot: entries\[0\]: seenAtMs must be a finite non-negative number/,
    ],
    [
      { v: 1, entries: [["evt-1", -1]] },
      /invalid snapshot: entries\[0\]: seenAtMs must be a finite non-negative number/,
    ],
    [
      { v: 1, entries: [["evt-1", Number.NaN]] },
      /invalid snapshot: entries\[0\]: seenAtMs must be a finite non-negative number/,
    ],
  ];
  for (const [snapshot, pattern] of bad) {
    assert.throws(
      () => PayoutEventDedupe.restore(snapshot),
      pattern,
      `expected a throw for ${JSON.stringify(snapshot)}`,
    );
  }
});

test("restoring over capacity evicts the oldest seenAtMs first", () => {
  const clock = fakeClock(10_000);
  const snapshot: PayoutEventDedupeSnapshot = {
    v: 1,
    entries: [
      ["oldest", 1_000],
      ["middle", 2_000],
      ["newest", 3_000],
    ],
  };
  const revived = PayoutEventDedupe.restore(snapshot, {
    ttlMs: TTL,
    maxEntries: 2,
    now: clock.now,
  });
  assert.equal(revived.size, 2);
  // Load-time eviction is not counted in the observability counters.
  assert.equal(revived.stats().evictions, 0);
  assert.equal(revived.checkAndRecord("newest"), true);
  assert.equal(revived.checkAndRecord("middle"), true);
  assert.equal(revived.checkAndRecord("oldest"), false); // evicted at load
});

test("entries already expired at restore time are dropped, not carried", () => {
  const clock = fakeClock(1_000_000);
  const revived = PayoutEventDedupe.restore(
    {
      v: 1,
      entries: [
        ["stale", 1_000_000 - TTL], // age exactly TTL: expired
        ["live", 1_000_000 - 1],
      ],
    },
    { ttlMs: TTL, now: clock.now },
  );
  assert.equal(revived.size, 1);
  assert.equal(revived.checkAndRecord("live"), true);
  assert.equal(revived.checkAndRecord("stale"), false);
});

test("an empty dedupe round-trips to an empty dedupe", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.deepEqual(dedupe.exportSnapshot(), { v: 1, entries: [] });
  const revived = PayoutEventDedupe.fromSnapshot(dedupe.exportSnapshot(), {
    ttlMs: TTL,
    now: clock.now,
  });
  assert.equal(revived.size, 0);
  assert.equal(revived.checkAndRecord("evt-1"), false);
});

test("the exported snapshot is detached and counters start at zero after restore", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("evt-1");
  dedupe.checkAndRecord("evt-1"); // a hit on the original store
  const snapshot = dedupe.exportSnapshot();
  // Mutating the export must not reach back into the original store.
  snapshot.entries[0][1] = 0;
  snapshot.entries.push(["injected", clock.now()]);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  assert.equal(dedupe.checkAndRecord("injected"), false);

  const revived = PayoutEventDedupe.restore(
    { v: 1, entries: [["evt-9", clock.now()]] },
    { ttlMs: TTL, now: clock.now },
  );
  // Counters are not carried across a snapshot: they start at zero.
  assert.deepEqual(revived.stats(), {
    size: 1,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
});
