import test from "node:test";
import assert from "node:assert/strict";
import { PayoutEventDedupe } from "../src/index.js";

/**
 * `PayoutEventDedupe` clock-skew behaviour (backlog #1453).
 *
 * Both this dedupe and the sibling rfc9421 `ReplayCache.check`
 * measure liveness as `t - prev < ttl` against the entry's
 * original first-seen timestamp, which a duplicate hit refreshes
 * in LRU recency only — never in time. The two implementations
 * agree on the skew expectation, verified by reading both
 * (`src/settlementWebhook.ts` `checkAndRecord`/`has`/`prune` here,
 * `src/replay.ts` `check`/`has` in rfc9421-signing-demo):
 *  - a backwards clock jump makes `t - prev` negative, which is
 *    still `< ttl`, so a seen `eventId` stays a duplicate — the
 *    skew can only *extend* the window, never reopen it early
 *    (fail-closed direction: a retried payout webhook is still
 *    refused while the clock is behind)
 *  - the extension is bounded: once the wall clock passes
 *    `prev + ttl` the id expires exactly as before, so a skew
 *    never retains an id permanently
 *  - a duplicate seen under a skewed clock keeps the original
 *    first-seen timestamp, so repeated replays cannot push the
 *    deadline out either
 *  - a new id recorded while the clock is skewed back gets its
 *    own first-seen timestamp and its own `prev + ttl` deadline
 *
 * No `src/` change: these tests pin the existing behaviour. If
 * any of them had failed, the fix would have followed the
 * rfc9421 #1443 pattern for `ReplayCache`.
 */

const TTL = 60_000;

function mutableClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    set: (value: number) => {
      t = value;
    },
  };
}

test("a seen eventId stays a duplicate after the clock moves backwards within the window", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);

  // 30s backwards, still inside the 60s window.
  clock.set(1_000_000 - 30_000);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  assert.equal(dedupe.has("evt-1"), true);
  // The read-only probe agrees, including with an explicit
  // skewed `now` — 100s behind the first sighting.
  assert.equal(dedupe.has("evt-1", 1_000_000 - 100_000), true);
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("a new eventId recorded while the clock is skewed back is tracked normally", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);

  clock.set(1_000_000 - 30_000);
  assert.equal(dedupe.checkAndRecord("evt-2"), false);
  assert.equal(dedupe.checkAndRecord("evt-2"), true);
  // Its deadline is measured from its own first-seen time
  // (970,000), not from evt-1's.
  assert.equal(dedupe.has("evt-2", 970_000 + TTL - 1), true);
  assert.equal(dedupe.has("evt-2", 970_000 + TTL), false);
  // evt-1 is still live at the same probe time: its own
  // deadline (1,060,000) has not passed yet.
  assert.equal(dedupe.has("evt-1", 970_000 + TTL), true);
});

test("repeated duplicates under a skewed clock do not extend the window", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);

  // Skew 100s back and replay twice: both are duplicates, and
  // neither refreshes the first-seen timestamp.
  clock.set(1_000_000 - 100_000);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);

  // 1ms before the original deadline the id is still live…
  clock.set(1_000_000 + TTL - 1);
  assert.equal(dedupe.has("evt-1"), true);
  // …and exactly at it the id is expired, despite the replays.
  clock.set(1_000_000 + TTL);
  assert.equal(dedupe.has("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
});

test("a skewed-back clock never retains an id permanently: it expires once the wall clock passes its original deadline", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);

  // Skew back further than the whole TTL: the age is negative,
  // so the id is still a duplicate (fail-closed), not forgotten.
  clock.set(1_000_000 - 200_000);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);

  // The clock then runs forward past the original deadline.
  clock.set(1_000_000 + TTL);
  assert.equal(dedupe.has("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.size, 1);
});

test("size and exportSnapshot still see a skewed entry, and drop it after the original deadline", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);

  clock.set(1_000_000 - 100_000);
  assert.equal(dedupe.size, 1);
  assert.deepEqual(dedupe.exportSnapshot(), {
    v: 1,
    entries: [["evt-1", 1_000_000]],
  });

  clock.set(1_000_000 + TTL);
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.exportSnapshot(), { v: 1, entries: [] });
});

test("prune under a skewed clock still evicts by LRU when the store is full", () => {
  const clock = mutableClock();
  const dedupe = new PayoutEventDedupe({
    ttlMs: TTL,
    maxEntries: 2,
    now: clock.now,
  });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-2"), false);

  // Skew back: neither entry is expired (negative ages), so
  // making room for evt-3 must evict the LRU entry, evt-1.
  clock.set(1_000_000 - 30_000);
  assert.equal(dedupe.checkAndRecord("evt-3"), false);
  assert.equal(dedupe.stats().evictions, 1);

  assert.equal(dedupe.checkAndRecord("evt-2"), true); // still tracked
  assert.equal(dedupe.checkAndRecord("evt-3"), true); // still tracked
  // evt-1 was evicted, so it is fresh again (this re-record in
  // turn evicts the then-oldest entry, evt-2 — check it last).
  assert.equal(dedupe.checkAndRecord("evt-1"), false); // evicted: fresh
});
