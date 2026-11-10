import test from "node:test";
import assert from "node:assert/strict";
import { PayoutWebhookOutbox } from "../src/index.js";

/**
 * Payout webhook delivery-failure ledger (backlog #1020).
 *
 * `deliverPayoutWebhook` / `deliverPayoutWebhookToMany` return
 * only one call's outcome and keep no memory, so a caller whose
 * endpoint fails repeatedly had no ready answer to "which
 * (endpoint, eventId) pairs are still undelivered, and which have
 * exhausted their retries". Rules under test:
 *  - a failed attempt lands in `pending()` with attempts 1 and stays
 *    out of `deadLetter()`; the 3rd consecutive failure (default
 *    `maxAttempts: 3`) moves the pair to `deadLetter()` and out of
 *    `pending()`; further failures keep `attempts` capped at 3 while
 *    still refreshing `lastError`/`lastAt`
 *  - a success (`ok: true`, or `acknowledge()`) clears the pair, so a
 *    later failure counts from 1 again; acknowledging an untracked
 *    pair is a no-op
 *  - pairs are keyed by (endpoint, eventId): the same eventId on two
 *    endpoints, and two eventIds on one endpoint, count independently
 *  - illegal configuration (`maxAttempts` not a positive integer,
 *    non-function clock) and malformed attempts (empty/non-string
 *    endpoint/eventId, non-boolean `ok`, non-finite `status`/`at`,
 *    non-string `error`) throw before anything is recorded
 *  - snapshot round-trip (including a JSON stringify/parse hop)
 *    preserves counts and dead-letter status; malformed snapshots
 *    (unknown fields, wrong `v`, bad entries) fail closed at restore
 *  - `size` counts pending + dead-lettered pairs; `clear()` empties
 *    both; `pending()`/`deadLetter()` return detached copies
 *  - the clock is injectable: attempts without an explicit `at` use
 *    it, and an explicit `at` wins
 *  - honest scope, documented on the class: the outbox records only —
 *    it never retries, it is process-local, and its snapshot is
 *    unsigned trusted configuration
 */

const A = "https://payouts.example/hooks/payout";
const B = "https://ledger.example/hooks/payout";
const EVT_1 = "evt-0001";
const EVT_2 = "evt-0002";

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fail(
  outbox: PayoutWebhookOutbox,
  endpoint: string,
  eventId: string,
  error = "server responded with status 500",
  at?: number,
): void {
  outbox.recordAttempt({ endpoint, eventId, ok: false, error, at });
}

test("a single failure lands in pending, not in dead letter", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  fail(outbox, A, EVT_1);

  assert.equal(outbox.size, 1);
  assert.deepEqual(outbox.pending(), [
    {
      endpoint: A,
      eventId: EVT_1,
      attempts: 1,
      lastError: "server responded with status 500",
      lastAt: 1_000_000,
    },
  ]);
  assert.deepEqual(outbox.deadLetter(), []);
});

test("the 3rd consecutive failure moves the pair to dead letter", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  fail(outbox, A, EVT_1);
  clock.advance(1000);
  fail(outbox, A, EVT_1, "server responded with status 503");
  assert.deepEqual(outbox.pending().map((e) => e.attempts), [2]);
  assert.deepEqual(outbox.deadLetter(), []);

  clock.advance(1000);
  fail(outbox, A, EVT_1, "fetch failed");
  assert.deepEqual(outbox.pending(), []);
  assert.deepEqual(outbox.deadLetter(), [
    {
      endpoint: A,
      eventId: EVT_1,
      attempts: 3,
      lastError: "fetch failed",
      lastAt: 1_002_000,
    },
  ]);
});

test("a dead-lettered pair stays capped at maxAttempts but refreshes last failure", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  clock.advance(5000);
  fail(outbox, A, EVT_1, "still down");

  const dead = outbox.deadLetter();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].attempts, 3);
  assert.equal(dead[0].lastError, "still down");
  assert.equal(dead[0].lastAt, 1_005_000);
  assert.equal(outbox.size, 1);
});

test("acknowledge clears the pair so a later failure counts from 1", () => {
  const outbox = new PayoutWebhookOutbox();
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  outbox.acknowledge(A, EVT_1);
  assert.equal(outbox.size, 0);
  assert.deepEqual(outbox.pending(), []);

  fail(outbox, A, EVT_1, "failed again");
  assert.deepEqual(outbox.pending().map((e) => e.attempts), [1]);
});

test("a successful recordAttempt clears the pair like acknowledge", () => {
  const outbox = new PayoutWebhookOutbox();
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  outbox.recordAttempt({ endpoint: A, eventId: EVT_1, ok: true, status: 200 });
  assert.equal(outbox.size, 0);

  fail(outbox, A, EVT_1, "failed again");
  assert.deepEqual(outbox.pending().map((e) => e.attempts), [1]);
});

test("acknowledging an untracked pair is a no-op, not an error", () => {
  const outbox = new PayoutWebhookOutbox();
  outbox.acknowledge(A, EVT_1);
  assert.equal(outbox.size, 0);
});

test("same eventId on two endpoints counts independently", () => {
  const outbox = new PayoutWebhookOutbox();
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_1);
  fail(outbox, B, EVT_1);
  fail(outbox, B, EVT_1);

  assert.deepEqual(
    outbox.pending().map((e) => [e.endpoint, e.attempts]),
    [[A, 2]],
  );
  assert.deepEqual(
    outbox.deadLetter().map((e) => [e.endpoint, e.attempts]),
    [[B, 3]],
  );
  // Clearing A leaves B's dead letter untouched.
  outbox.acknowledge(A, EVT_1);
  assert.equal(outbox.pending().length, 0);
  assert.equal(outbox.deadLetter().length, 1);
});

test("two eventIds on one endpoint count independently", () => {
  const outbox = new PayoutWebhookOutbox();
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_2);
  fail(outbox, A, EVT_2);
  fail(outbox, A, EVT_2);

  assert.deepEqual(
    outbox.pending().map((e) => [e.eventId, e.attempts]),
    [[EVT_1, 1]],
  );
  assert.deepEqual(
    outbox.deadLetter().map((e) => [e.eventId, e.attempts]),
    [[EVT_2, 3]],
  );
});

test("custom maxAttempts: 1 means the first failure is already dead-lettered", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 1 });
  fail(outbox, A, EVT_1);
  assert.deepEqual(outbox.pending(), []);
  assert.equal(outbox.deadLetter().length, 1);
});

test("illegal maxAttempts / clock fail fast at construction", () => {
  for (const maxAttempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new PayoutWebhookOutbox({ maxAttempts }),
      /maxAttempts must be a positive integer/,
    );
  }
  assert.throws(
    () =>
      new PayoutWebhookOutbox({
        now: "not a function" as unknown as () => number,
      }),
    /now must be a function/,
  );
});

test("malformed attempts fail fast and record nothing", () => {
  const outbox = new PayoutWebhookOutbox();
  const bad: Array<Record<string, unknown>> = [
    { endpoint: "", eventId: EVT_1, ok: false },
    { endpoint: 42, eventId: EVT_1, ok: false },
    { endpoint: A, eventId: "", ok: false },
    { endpoint: A, eventId: 7, ok: false },
    { endpoint: A, eventId: EVT_1, ok: "no" },
    { endpoint: A, eventId: EVT_1, ok: false, error: 500 },
    { endpoint: A, eventId: EVT_1, ok: false, status: 1.5 },
    { endpoint: A, eventId: EVT_1, ok: false, status: Number.NaN },
    { endpoint: A, eventId: EVT_1, ok: false, at: Number.NaN },
    { endpoint: A, eventId: EVT_1, ok: false, at: Number.POSITIVE_INFINITY },
  ];
  for (const attempt of bad) {
    assert.throws(
      () =>
        outbox.recordAttempt(
          attempt as unknown as Parameters<
            PayoutWebhookOutbox["recordAttempt"]
          >[0],
        ),
    );
  }
  assert.equal(outbox.size, 0);
  assert.throws(() => outbox.acknowledge("", EVT_1), /endpoint/);
  assert.throws(() => outbox.acknowledge(A, ""), /eventId/);
});

test("snapshot round-trip preserves counts and dead-letter status", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  fail(outbox, A, EVT_1, "first");
  clock.advance(1000);
  fail(outbox, A, EVT_1, "second");
  fail(outbox, B, EVT_2, "once");
  fail(outbox, B, EVT_2, "twice");
  fail(outbox, B, EVT_2, "thrice");

  const snapshot = outbox.exportSnapshot();
  const wire = JSON.parse(JSON.stringify(snapshot)) as unknown;
  const restored = PayoutWebhookOutbox.fromSnapshot(wire, {
    now: clock.now,
  });

  assert.deepEqual(restored.pending(), outbox.pending());
  assert.deepEqual(restored.deadLetter(), outbox.deadLetter());
  assert.equal(restored.size, outbox.size);
  // The restored ledger keeps counting from where the snapshot left off.
  restored.recordAttempt({ endpoint: A, eventId: EVT_1, ok: false, error: "third" });
  assert.deepEqual(restored.pending(), []);
  assert.deepEqual(
    restored.deadLetter().map((e) => [e.endpoint, e.attempts]),
    [
      [A, 3],
      [B, 3],
    ],
  );
});

test("restoring under a different maxAttempts re-derives the boundary", () => {
  const outbox = new PayoutWebhookOutbox();
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  const snapshot = outbox.exportSnapshot();

  const stricter = PayoutWebhookOutbox.restore(snapshot, {
    maxAttempts: 2,
  });
  assert.deepEqual(stricter.pending(), []);
  assert.equal(stricter.deadLetter().length, 1);

  const looser = PayoutWebhookOutbox.restore(snapshot, {
    maxAttempts: 5,
  });
  assert.equal(looser.pending().length, 1);
  assert.deepEqual(looser.deadLetter(), []);
});

test("malformed snapshots fail closed at restore", () => {
  const good = new PayoutWebhookOutbox();
  fail(good, A, EVT_1);
  const snapshot = good.exportSnapshot();

  const bad: unknown[] = [
    null,
    "snapshot",
    [],
    { ...snapshot, v: 2 },
    { ...snapshot, v: "1" },
    { ...snapshot, secret: "smuggled" },
    { v: 1 },
    { v: 1, entries: "nope" },
    { v: 1, entries: [{ endpoint: A, eventId: EVT_1, attempts: 1 }] },
    { v: 1, entries: [{ endpoint: "", eventId: EVT_1, attempts: 1, lastAt: 0 }] },
    { v: 1, entries: [{ endpoint: A, eventId: EVT_1, attempts: 0, lastAt: 0 }] },
    { v: 1, entries: [{ endpoint: A, eventId: EVT_1, attempts: 1.5, lastAt: 0 }] },
    { v: 1, entries: [{ endpoint: A, eventId: EVT_1, attempts: 1, lastAt: "now" }] },
    { v: 1, entries: [{ endpoint: A, eventId: EVT_1, attempts: 1, lastAt: 0, lastError: 7 }] },
    { v: 1, entries: [{ endpoint: A, eventId: EVT_1, attempts: 1, lastAt: 0, extra: 1 }] },
    { v: 1, entries: ["not-an-object"] },
  ];
  for (const candidate of bad) {
    assert.throws(
      () => PayoutWebhookOutbox.restore(candidate),
      /PayoutWebhookOutbox: invalid snapshot/,
    );
  }
  // A duplicate pair in the snapshot collapses to its last occurrence.
  const dup = PayoutWebhookOutbox.restore({
    v: 1,
    entries: [
      { endpoint: A, eventId: EVT_1, attempts: 1, lastAt: 1000 },
      { endpoint: A, eventId: EVT_1, attempts: 2, lastError: "later", lastAt: 2000 },
    ],
  });
  assert.deepEqual(dup.pending(), [
    { endpoint: A, eventId: EVT_1, attempts: 2, lastError: "later", lastAt: 2000 },
  ]);
});

test("size counts pending + dead-lettered; clear empties both", () => {
  const outbox = new PayoutWebhookOutbox();
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);
  fail(outbox, B, EVT_2);
  fail(outbox, B, EVT_2);
  assert.equal(outbox.size, 2);
  outbox.clear();
  assert.equal(outbox.size, 0);
  assert.deepEqual(outbox.pending(), []);
  assert.deepEqual(outbox.deadLetter(), []);
});

test("explicit at wins over the clock; returned entries are detached copies", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  outbox.recordAttempt({
    endpoint: A,
    eventId: EVT_1,
    ok: false,
    error: "boom",
    at: 42,
  });
  assert.equal(outbox.pending()[0].lastAt, 42);

  const listed = outbox.pending();
  listed[0].attempts = 99;
  listed[0].lastError = "tampered";
  assert.equal(outbox.pending()[0].attempts, 1);
  assert.equal(outbox.pending()[0].lastError, "boom");

  const snapshot = outbox.exportSnapshot();
  snapshot.entries[0].attempts = 99;
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("a failure without error or status records with no lastError", () => {
  const outbox = new PayoutWebhookOutbox();
  outbox.recordAttempt({ endpoint: A, eventId: EVT_1, ok: false });
  const [entry] = outbox.pending();
  assert.equal(entry.attempts, 1);
  assert.equal(entry.lastError, undefined);
  assert.equal(typeof entry.lastAt, "number");
});
