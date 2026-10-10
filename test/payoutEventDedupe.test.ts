import test from "node:test";
import assert from "node:assert/strict";
import { PayoutEventDedupe } from "../src/index.js";

/**
 * Payout webhook receiver-side `eventId` deduplication (backlog #157).
 *
 * `verifyPayoutWebhook`'s docs require receivers to deduplicate on
 * `eventId`, but the library shipped no dedupe tool — receivers
 * hand-rolled a Map with ad-hoc TTL/capacity/clock choices. Rules
 * under test (the rfc9421-signing-demo `ReplayCache` paradigm):
 *  - `checkAndRecord(id)` returns false on first sighting and true for
 *    a repeat within the TTL ("true = is a replay", the `NonceStore`
 *    contract); different ids are independent
 *  - an id whose record is older than `ttlMs` counts as unseen again
 *    (boundary: age exactly `ttlMs` is expired); a duplicate hit does
 *    NOT extend the window (first-seen timestamp is kept)
 *  - at capacity, expired entries are reclaimed before LRU eviction,
 *    and a hit refreshes recency; an evicted id counts as unseen again
 *  - the clock is injectable, so the same scripted sequence on two
 *    stores gives identical results (deterministic double-run)
 *  - illegal configuration (ttlMs <= 0 / non-finite, maxEntries not a
 *    positive integer, non-function clock) throws at construction
 *  - an empty or non-string eventId throws instead of silently passing
 *  - `size` counts only live entries; `stats()` reports
 *    hits/misses/evictions and returns a detached snapshot; `clear()`
 *    resets both the store and the counters
 *  - honest scope, documented on the class: single-process in-memory
 *    only — two instances never see each other's records
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

test("first sighting returns false, a repeat within the TTL returns true", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  // Different ids are independent.
  assert.equal(dedupe.checkAndRecord("evt-2"), false);
  assert.equal(dedupe.checkAndRecord("evt-2"), true);
  assert.equal(dedupe.size, 2);
});

test("an id counts as unseen again once its record reaches the TTL", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  clock.advance(TTL - 1);
  assert.equal(dedupe.checkAndRecord("evt-1"), true); // still inside
  clock.advance(1); // age is now exactly ttlMs: expired (boundary)
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  // The re-record starts a fresh window.
  clock.advance(TTL - 1);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
});

test("a duplicate hit does not extend the deduplication window", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  clock.advance(TTL - 1);
  assert.equal(dedupe.checkAndRecord("evt-1"), true); // hit near expiry
  clock.advance(2); // past the ORIGINAL first-seen + ttlMs
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
});

test("capacity eviction drops the least recently seen id, which then counts as unseen", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({
    ttlMs: TTL,
    maxEntries: 3,
    now: clock.now,
  });
  assert.equal(dedupe.checkAndRecord("a"), false);
  assert.equal(dedupe.checkAndRecord("b"), false);
  assert.equal(dedupe.checkAndRecord("c"), false);
  assert.equal(dedupe.checkAndRecord("d"), false); // evicts "a" (LRU)
  assert.equal(dedupe.size, 3);
  assert.equal(dedupe.checkAndRecord("b"), true); // survivors still dedupe
  assert.equal(dedupe.checkAndRecord("c"), true);
  assert.equal(dedupe.checkAndRecord("a"), false); // evicted: unseen again
});

test("a duplicate hit refreshes LRU recency, protecting that id from eviction", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({
    ttlMs: TTL,
    maxEntries: 3,
    now: clock.now,
  });
  dedupe.checkAndRecord("a");
  dedupe.checkAndRecord("b");
  dedupe.checkAndRecord("c");
  assert.equal(dedupe.checkAndRecord("a"), true); // "a" is now most-recent
  assert.equal(dedupe.checkAndRecord("d"), false); // evicts "b", not "a"
  assert.equal(dedupe.checkAndRecord("a"), true);
  assert.equal(dedupe.checkAndRecord("b"), false); // evicted: unseen again
});

test("expired entries are reclaimed before any live entry is LRU-evicted", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({
    ttlMs: TTL,
    maxEntries: 2,
    now: clock.now,
  });
  dedupe.checkAndRecord("old");
  clock.advance(TTL); // "old" is expired but still occupies a slot
  dedupe.checkAndRecord("live");
  // Store is at capacity (expired "old" + live "live"): recording a
  // third id must reclaim the expired slot, not evict "live".
  assert.equal(dedupe.checkAndRecord("new"), false);
  assert.equal(dedupe.checkAndRecord("live"), true);
  assert.equal(dedupe.stats().evictions, 1);
});

test("injected clock makes a scripted sequence deterministic across two stores", () => {
  const script: Array<{ advanceMs: number; id: string }> = [
    { advanceMs: 0, id: "evt-1" },
    { advanceMs: 1_000, id: "evt-2" },
    { advanceMs: 1_000, id: "evt-1" },
    { advanceMs: TTL, id: "evt-1" }, // expired by now: unseen again
    { advanceMs: 0, id: "evt-3" },
    { advanceMs: 0, id: "evt-4" }, // capacity 3: evicts evt-2 (LRU)
    { advanceMs: 0, id: "evt-2" }, // evicted: unseen again
  ];
  const run = (): boolean[] => {
    const clock = fakeClock();
    const dedupe = new PayoutEventDedupe({
      ttlMs: TTL,
      maxEntries: 3,
      now: clock.now,
    });
    return script.map(({ advanceMs, id }) => {
      clock.advance(advanceMs);
      return dedupe.checkAndRecord(id);
    });
  };
  const expected = [false, false, true, false, false, false, false];
  assert.deepEqual(run(), expected);
  assert.deepEqual(run(), run());
});

test("illegal configuration throws at construction", () => {
  for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "60" as unknown as number]) {
    assert.throws(
      () => new PayoutEventDedupe({ ttlMs }),
      /PayoutEventDedupe: ttlMs must be a positive finite number/,
    );
  }
  for (const maxEntries of [0, -3, 1.5, Number.NaN, "3" as unknown as number]) {
    assert.throws(
      () => new PayoutEventDedupe({ maxEntries }),
      /PayoutEventDedupe: maxEntries must be a positive integer/,
    );
  }
  assert.throws(
    () =>
      new PayoutEventDedupe({
        now: 42 as unknown as () => number,
      }),
    /PayoutEventDedupe: now must be a function/,
  );
  // Defaults and boundary-valid values construct fine.
  assert.equal(new PayoutEventDedupe().size, 0);
  assert.equal(
    new PayoutEventDedupe({ ttlMs: 1, maxEntries: 1 }).size,
    0,
  );
});

test("empty or non-string eventId throws and records nothing", () => {
  const dedupe = new PayoutEventDedupe({ now: fakeClock().now });
  for (const bad of ["", 42, null, undefined, {}, ["evt"]]) {
    assert.throws(
      () => dedupe.checkAndRecord(bad as unknown as string),
      /PayoutEventDedupe: eventId must be a non-empty string/,
    );
  }
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
});

test("stats counts hits, misses and evictions; size counts only live entries", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({
    ttlMs: TTL,
    maxEntries: 2,
    now: clock.now,
  });
  dedupe.checkAndRecord("a"); // miss
  dedupe.checkAndRecord("a"); // hit
  dedupe.checkAndRecord("b"); // miss
  dedupe.checkAndRecord("c"); // miss, evicts "a" (LRU)
  assert.deepEqual(dedupe.stats(), {
    size: 2,
    hits: 1,
    misses: 3,
    evictions: 1,
  });
  // The stats snapshot is detached: mutating it changes nothing.
  const snapshot = dedupe.stats();
  snapshot.hits = 999;
  assert.equal(dedupe.stats().hits, 1);
  // After the TTL passes, `size` reports no live entries even though
  // nothing has been pruned yet.
  clock.advance(TTL);
  assert.equal(dedupe.size, 0);
  assert.equal(dedupe.stats().size, 0);
  // An expired re-record is a miss, not an eviction.
  assert.equal(dedupe.checkAndRecord("b"), false);
  assert.equal(dedupe.stats().misses, 4);
  assert.equal(dedupe.stats().evictions, 1);
});

test("clear drops every recorded id and resets the counters", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("evt-1");
  dedupe.checkAndRecord("evt-1");
  dedupe.clear();
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  assert.equal(dedupe.checkAndRecord("evt-1"), false); // forgotten
});

test("stores are per-instance: one store never sees another's records", () => {
  const clock = fakeClock();
  const one = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  const two = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(one.checkAndRecord("evt-1"), false);
  // Single-process scope, honestly: a second instance (like a second
  // receiver process) has its own store and reports a first sighting.
  assert.equal(two.checkAndRecord("evt-1"), false);
  assert.equal(one.checkAndRecord("evt-1"), true);
});
