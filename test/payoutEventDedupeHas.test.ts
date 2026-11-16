import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EVENT_ID_LENGTH,
  PayoutEventDedupe,
} from "../src/index.js";

/**
 * Read-only `PayoutEventDedupe.has(eventId)` probe (backlog #1180).
 *
 * `checkAndRecord` is consume-on-probe: asking "have I seen this
 * `eventId`?" records it, so a receiver that probes before verifying
 * the signature turns a forged delivery into a recorded id and the
 * later genuine delivery looks like a duplicate. `has()` is the
 * read-only answer, with the sibling rfc9421 `ReplayCache.has()`
 * semantics and mirroring escrow's `SettlementEventDedupe.has`
 * (backlog #1176):
 *  - unseen id -> false, recorded id within the TTL -> true
 *  - probing never records: a later `checkAndRecord` still sees the
 *    id as first-seen, and a seen id's LRU recency is not refreshed
 *  - the observability counters (`hits`/`misses`/`evictions`) do not
 *    move, and `exportSnapshot()` is unchanged by a probe
 *  - an expired id reads false and is not resurrected (the entry is
 *    left in place for the next recording call to reclaim); the TTL
 *    boundary matches `checkAndRecord` (age exactly `ttlMs` is
 *    expired)
 *  - an empty, non-string, or overlong `eventId` throws, the same
 *    fail-fast caliber as `checkAndRecord`
 *  - an explicit `now` (milliseconds since the epoch) overrides the
 *    injected clock for that one probe
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

test("an unseen eventId reads false", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.has("evt-1"), false);
  assert.equal(dedupe.size, 0);
});

test("a recorded eventId reads true within the TTL", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.has("evt-1"), true);
  assert.equal(dedupe.has("evt-2"), false);
});

test("has does not consume: a probed id is still first-seen afterwards", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.has("evt-1"), false);
  // The probe recorded nothing: this is still the first sighting.
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.has("evt-1"), true);
  // Probing a seen id does not change the duplicate verdict either.
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
});

test("has leaves the observability counters untouched", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("evt-1");
  dedupe.checkAndRecord("evt-1"); // one hit, one miss
  const before = dedupe.stats();
  assert.deepEqual(before, { size: 1, hits: 1, misses: 1, evictions: 0 });
  assert.equal(dedupe.has("evt-1"), true);
  assert.equal(dedupe.has("evt-2"), false);
  assert.equal(dedupe.has("evt-1"), true);
  assert.deepEqual(dedupe.stats(), before);
});

test("an expired entry reads false and is not resurrected by the probe", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("evt-1");
  clock.advance(TTL); // age is now exactly ttlMs: expired (boundary)
  assert.equal(dedupe.has("evt-1"), false);
  // The probe neither re-recorded nor reclaimed the entry: the next
  // recording call still sees a first sighting, and no eviction was
  // counted for the probe.
  assert.deepEqual(dedupe.stats(), {
    size: 0,
    hits: 0,
    misses: 1,
    evictions: 0,
  });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
});

test("the TTL boundary matches checkAndRecord: one millisecond inside still reads true", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("evt-1");
  clock.advance(TTL - 1);
  assert.equal(dedupe.has("evt-1"), true);
  clock.advance(1);
  assert.equal(dedupe.has("evt-1"), false);
});

test("clear makes every id read false again", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("evt-1");
  assert.equal(dedupe.has("evt-1"), true);
  dedupe.clear();
  assert.equal(dedupe.has("evt-1"), false);
});

test("an invalid eventId throws instead of silently answering", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.throws(() => dedupe.has(""), /non-empty string/);
  assert.throws(() => dedupe.has(42 as unknown as string), /non-empty string/);
  assert.throws(() => dedupe.has(null as unknown as string), /non-empty string/);
  assert.throws(
    () => dedupe.has(undefined as unknown as string),
    /non-empty string/,
  );
  assert.throws(
    () => dedupe.has("e".repeat(MAX_EVENT_ID_LENGTH + 1)),
    new RegExp(`at most ${MAX_EVENT_ID_LENGTH} characters`),
  );
  // The boundary itself is fine.
  assert.equal(dedupe.has("e".repeat(MAX_EVENT_ID_LENGTH)), false);
});

test("has leaves the exported snapshot byte-identical", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("evt-1");
  dedupe.checkAndRecord("evt-2");
  const before = dedupe.exportSnapshot();
  assert.equal(dedupe.has("evt-1"), true);
  assert.equal(dedupe.has("evt-3"), false);
  assert.deepEqual(dedupe.exportSnapshot(), before);
});

test("has does not refresh LRU recency", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({
    ttlMs: TTL,
    maxEntries: 3,
    now: clock.now,
  });
  dedupe.checkAndRecord("a");
  dedupe.checkAndRecord("b");
  dedupe.checkAndRecord("c");
  // A duplicate hit would refresh "a" to most-recent; a probe must not.
  assert.equal(dedupe.has("a"), true);
  assert.equal(dedupe.checkAndRecord("d"), false); // evicts "a", not "b"
  // Read-only probes confirm the victim without mutating further.
  assert.equal(dedupe.has("a"), false); // evicted: unseen again
  assert.equal(dedupe.has("b"), true); // survivors still dedupe
  assert.equal(dedupe.has("c"), true);
});

test("an explicit now overrides the injected clock for that one probe", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  dedupe.checkAndRecord("evt-1"); // seen at t = 1_000_000
  assert.equal(dedupe.has("evt-1", 1_000_000 + TTL - 1), true);
  assert.equal(dedupe.has("evt-1", 1_000_000 + TTL), false);
  // The explicit now did not move the injected clock or record anything.
  assert.equal(dedupe.has("evt-1"), true);
  assert.equal(dedupe.stats().misses, 1);
});
