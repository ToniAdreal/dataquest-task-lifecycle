import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";

/**
 * Payout webhook freshness window x `PayoutEventDedupe` verify-then-record
 * order (backlog #819).
 *
 * `verifyPayoutWebhook`'s `maxAgeMs` / `maxFutureSkewMs` each had single
 * tests, and the dedupe's verify-first order was pinned by #726 (a
 * tampered body records nothing) — but freshness failures and dedupe
 * never met. The gap matters: a legitimately-signed payload that is
 * too old, or stamped too far in the future, verifies false only
 * because of its timestamp. If a receiver recorded its `eventId`
 * before (or regardless of) that freshness verdict, the poisoned
 * entry would turn the sender's later, fresh re-delivery of the same
 * event into a false "duplicate" — a payout event silently dropped
 * for being on time the second time.
 *
 * Rules pinned here, via the documented receiver order collapsed into
 * a local `receive()` helper (verify with the freshness window first;
 * `checkAndRecord` only after a `true` verification):
 *  - a stale payload (`now - at > maxAgeMs`) verifies false and
 *    records nothing, so the same eventId re-signed with a fresh
 *    `at` is still a first sighting (not a duplicate poisoned by
 *    the stale attempt)
 *  - an over-future-window payload (`at - now > maxFutureSkewMs`)
 *    behaves the same way: rejected, unrecorded, fresh re-sign
 *    first-seen
 *  - an in-window payload verifies, is recorded as a first sighting,
 *    and its re-delivery reports duplicate, with hits/misses counting
 *    the flow
 *  - freshness failures leave the dedupe counters untouched — both
 *    before any success (stats stay all-zero) and after a success
 *    (a stale replay of an already-seen eventId changes neither the
 *    stats nor the duplicate verdict of the true re-delivery)
 *  - the boundaries are inclusive for recording too: a payload aged
 *    exactly `maxAgeMs`, and one skewed exactly `maxFutureSkewMs`
 *    into the future, both verify and are recorded as first sightings
 */

const SECRET = "whsec_test_payout_freshness_dedupe_20261102";
const NOW = new Date("2026-11-02T10:00:00.000Z");
const ONE_HOUR = 3_600_000;

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(t.state, "PAID");
  return t;
}

type ReceiveOutcome = "accepted" | "duplicate" | "rejected";

/**
 * The documented receiver order, with the freshness window applied at
 * verify time: verify the raw wire body first (signature, then
 * freshness); only a verified delivery reaches `checkAndRecord`.
 * A rejected delivery never touches the dedupe store.
 */
function receive(
  raw: string,
  signature: string,
  dedupe: PayoutEventDedupe,
): ReceiveOutcome {
  const verified = verifyPayoutWebhook(raw, signature, SECRET, {
    maxAgeMs: ONE_HOUR,
    maxFutureSkewMs: ONE_HOUR,
    now: NOW,
  });
  if (!verified) return "rejected";
  const payload = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(payload.eventId) ? "duplicate" : "accepted";
}

function emptyStats() {
  return { size: 0, hits: 0, misses: 0, evictions: 0 };
}

test("stale payload is rejected and unrecorded, so its fresh re-sign is first-seen", () => {
  const task = toPaid("task-fresh-dedupe-stale");
  const stale = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh-dedupe-stale",
    now: new Date(NOW.getTime() - 2 * ONE_HOUR),
  });
  const staleRaw = JSON.stringify(stale.payload);
  const dedupe = new PayoutEventDedupe({ now: () => NOW.getTime() });
  // The signature alone is valid — only the age gate rejects it.
  assert.equal(
    verifyPayoutWebhook(staleRaw, stale.signature, SECRET),
    true,
    "signature without a freshness window still verifies",
  );
  assert.equal(
    verifyPayoutWebhook(staleRaw, stale.signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
  assert.equal(receive(staleRaw, stale.signature, dedupe), "rejected");
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), emptyStats());
  // Same eventId, freshly stamped and re-signed: a first sighting,
  // not a duplicate poisoned by the stale attempt.
  const fresh = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh-dedupe-stale",
    now: NOW,
  });
  const freshRaw = JSON.stringify(fresh.payload);
  assert.equal(receive(freshRaw, fresh.signature, dedupe), "accepted");
  assert.equal(receive(freshRaw, fresh.signature, dedupe), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("over-future-window payload is rejected and unrecorded, so its fresh re-sign is first-seen", () => {
  const task = toPaid("task-fresh-dedupe-future");
  const future = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh-dedupe-future",
    now: new Date(NOW.getTime() + 2 * ONE_HOUR),
  });
  const futureRaw = JSON.stringify(future.payload);
  const dedupe = new PayoutEventDedupe({ now: () => NOW.getTime() });
  assert.equal(
    verifyPayoutWebhook(futureRaw, future.signature, SECRET),
    true,
    "signature without a future window still verifies",
  );
  assert.equal(
    verifyPayoutWebhook(futureRaw, future.signature, SECRET, {
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
  assert.equal(receive(futureRaw, future.signature, dedupe), "rejected");
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), emptyStats());
  const fresh = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh-dedupe-future",
    now: NOW,
  });
  const freshRaw = JSON.stringify(fresh.payload);
  assert.equal(receive(freshRaw, fresh.signature, dedupe), "accepted");
  assert.equal(receive(freshRaw, fresh.signature, dedupe), "duplicate");
});

test("in-window payload is accepted once, then reported duplicate", () => {
  const task = toPaid("task-fresh-dedupe-window");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh-dedupe-window",
    now: new Date(NOW.getTime() - 5 * 60_000),
  });
  const raw = JSON.stringify(payload);
  const dedupe = new PayoutEventDedupe({ now: () => NOW.getTime() });
  assert.equal(receive(raw, signature, dedupe), "accepted");
  assert.equal(dedupe.size, 1);
  // The re-delivery still verifies true — only the dedupe verdict flips.
  assert.equal(
    verifyPayoutWebhook(raw, signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  assert.equal(receive(raw, signature, dedupe), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("freshness failures pollute neither counters nor an already-seen verdict", () => {
  const task = toPaid("task-fresh-dedupe-pollution");
  const dedupe = new PayoutEventDedupe({ now: () => NOW.getTime() });
  // Two failed freshness attempts, different eventIds, zero counters.
  for (const [label, at] of [
    ["stale", new Date(NOW.getTime() - 2 * ONE_HOUR)],
    ["future", new Date(NOW.getTime() + 2 * ONE_HOUR)],
  ] as const) {
    const { payload, signature } = buildPayoutWebhook(task, SECRET, {
      eventId: `evt-fresh-dedupe-pollution-${label}`,
      now: at,
    });
    assert.equal(
      receive(JSON.stringify(payload), signature, dedupe),
      "rejected",
      `${label} attempt must be rejected`,
    );
  }
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), emptyStats());
  // A genuine in-window delivery records normally after the failures.
  const good = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh-dedupe-pollution-good",
    now: NOW,
  });
  const goodRaw = JSON.stringify(good.payload);
  assert.equal(receive(goodRaw, good.signature, dedupe), "accepted");
  const afterAccept = dedupe.stats();
  // A stale replay carrying the same eventId: rejected, stats untouched.
  const staleReplay = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh-dedupe-pollution-good",
    now: new Date(NOW.getTime() - 2 * ONE_HOUR),
  });
  assert.equal(
    receive(JSON.stringify(staleReplay.payload), staleReplay.signature, dedupe),
    "rejected",
  );
  assert.deepEqual(dedupe.stats(), afterAccept);
  // The true re-delivery still reports duplicate — the stale replay
  // changed nothing.
  assert.equal(receive(goodRaw, good.signature, dedupe), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("boundary payloads verify and are recorded: exactly maxAgeMs old, exactly maxFutureSkewMs ahead", () => {
  const task = toPaid("task-fresh-dedupe-boundary");
  const dedupe = new PayoutEventDedupe({ now: () => NOW.getTime() });
  const aged = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh-dedupe-boundary-old",
    now: new Date(NOW.getTime() - ONE_HOUR),
  });
  assert.equal(
    receive(JSON.stringify(aged.payload), aged.signature, dedupe),
    "accepted",
    "age exactly maxAgeMs still passes and records",
  );
  const skewed = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh-dedupe-boundary-future",
    now: new Date(NOW.getTime() + ONE_HOUR),
  });
  assert.equal(
    receive(JSON.stringify(skewed.payload), skewed.signature, dedupe),
    "accepted",
    "skew exactly maxFutureSkewMs still passes and records",
  );
  assert.equal(dedupe.size, 2);
  assert.deepEqual(dedupe.stats(), {
    size: 2,
    hits: 0,
    misses: 2,
    evictions: 0,
  });
});
