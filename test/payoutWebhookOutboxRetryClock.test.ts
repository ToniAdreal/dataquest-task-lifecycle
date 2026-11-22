import test from "node:test";
import assert from "node:assert/strict";
import {
  PayoutWebhookOutbox,
  retryPayoutWebhookOutbox,
} from "../src/index.js";

/**
 * Payout webhook outbox retry runner clock (backlog #1333, mirror
 * of the sibling escrow `retrySettlementWebhookOutbox` #1332).
 *
 * The runner used to check `opts.now` only as "is a function" and
 * never inspect what it returned, so both failure paths called
 * `clock()` inside `recordAttempt({ …, at: clock() })` and a
 * `NaN`/`Infinity` clock threw "at must be a finite number" out
 * of the per-pair worker, rejecting the runner's `Promise.all`
 * and killing the whole multi-pair run with no summary — while
 * the pair stayed pending and unrecorded, exactly the deliveries
 * that most need the ledger. The clock is now resolved once per
 * round, before any pair in that round is delivered: a
 * non-finite reading throws a configuration error there, and the
 * resolved value stamps every attempt the round records. Rules
 * under test:
 *  - a non-finite runner clock (`NaN`, `Infinity`, a non-number)
 *    throws `retryPayoutWebhookOutbox: now must return a finite
 *    number …` before any pair is delivered — `deliverOne` is
 *    never called, whatever it would have returned or thrown
 *  - with several pending pairs a bad clock makes zero
 *    deliveries and leaves every pair untouched
 *  - a clock that goes bad mid-run fails at the next round's
 *    boundary, with the earlier round's attempts kept in the
 *    ledger (and stamped with the round's resolved value)
 *  - a good clock keeps the normal summary, and the recorded
 *    `at` is the value resolved at the round's start — a clock
 *    that advances while a delivery is in flight does not move
 *    that round's stamp
 *  - a dry run never reads the clock, and an empty pending list
 *    returns an empty summary without reading it
 */

const A = "https://payouts.example/hooks/payout";
const B = "https://ledger.example/hooks/payout";
const C = "https://audit.example/hooks/payout";
const EVT_1 = "evt-0001";
const EVT_2 = "evt-0002";
const EVT_3 = "evt-0003";

function fail(
  outbox: PayoutWebhookOutbox,
  endpoint: string,
  eventId: string,
  error = "server responded with status 500",
  at = 1000,
): void {
  outbox.recordAttempt({ endpoint, eventId, ok: false, error, at });
}

test("NaN clock throws the config error before any delivery (throwing deliverOne)", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  let calls = 0;
  await assert.rejects(
    retryPayoutWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        throw new Error("boom: connection reset");
      },
      { now: () => NaN },
    ),
    /retryPayoutWebhookOutbox: now must return a finite number of milliseconds since the epoch, got NaN/,
  );
  // The guard fires at the round boundary, before the worker ever
  // runs: the throwing deliverOne is never invoked, and the pair
  // is untouched — still pending with its single seeded attempt.
  assert.equal(calls, 0);
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0].attempts, 1);
  assert.equal(outbox.pending()[0].lastAt, 1000);
});

test("NaN clock throws the config error before any delivery (false deliverOne)", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  let calls = 0;
  await assert.rejects(
    retryPayoutWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      { now: () => NaN },
    ),
    /retryPayoutWebhookOutbox: now must return a finite number of milliseconds since the epoch, got NaN/,
  );
  assert.equal(calls, 0);
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("Infinity clock throws the verbatim config error with zero deliveries", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  let calls = 0;
  await assert.rejects(
    retryPayoutWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      { now: () => Infinity },
    ),
    /retryPayoutWebhookOutbox: now must return a finite number of milliseconds since the epoch, got Infinity/,
  );
  assert.equal(calls, 0);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("non-number clock reading throws the verbatim config error", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  let calls = 0;
  await assert.rejects(
    retryPayoutWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      { now: (() => "x") as unknown as () => number },
    ),
    /retryPayoutWebhookOutbox: now must return a finite number of milliseconds since the epoch, got x/,
  );
  assert.equal(calls, 0);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("three pending pairs under a NaN clock: zero deliveries, all untouched", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);
  fail(outbox, C, EVT_3);

  let calls = 0;
  await assert.rejects(
    retryPayoutWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      { now: () => NaN },
    ),
    /now must return a finite number/,
  );
  // The old behaviour threw out of the first pair's worker and
  // rejected the whole Promise.all with no summary; the guard
  // stops the run before the pool even starts, so no pair moves.
  assert.equal(calls, 0);
  assert.equal(outbox.pending().length, 3);
  assert.ok(outbox.pending().every((e) => e.attempts === 1));
});

test("clock going bad mid-run fails at the next round boundary, earlier round kept", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  // First reading is good (2000), every later reading is NaN:
  // round 1 records normally, round 2 must fail at its boundary.
  let reads = 0;
  const clock = () => {
    reads += 1;
    return reads === 1 ? 2000 : NaN;
  };

  let calls = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    retryPayoutWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      {
        now: clock,
        maxRounds: 2,
        backoffMs: 1000,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      },
    ),
    /retryPayoutWebhookOutbox: now must return a finite number of milliseconds since the epoch, got NaN/,
  );
  // Round 1 ran once and recorded at its resolved 2000; the
  // between-rounds sleep happened; round 2 never delivered.
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(reads, 2);
  const pending = outbox.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 2);
  assert.equal(pending[0].lastAt, 2000);
});

test("good clock: false and throwing branches keep the normal summary", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async (endpoint) => {
      if (endpoint === A) throw new Error("boom: connection reset");
      return false;
    },
    { now: () => 2000 },
  );
  assert.deepEqual(summary, {
    attempted: 2,
    acknowledged: 0,
    stillPending: 2,
    deadLettered: 0,
    aborted: false,
  });
  const pending = outbox.pending();
  assert.equal(pending.length, 2);
  // Both failures are stamped with the round's resolved clock,
  // not with a per-call re-read.
  assert.ok(pending.every((e) => e.attempts === 2 && e.lastAt === 2000));
  assert.equal(
    pending.find((e) => e.endpoint === A)?.lastError,
    "boom: connection reset",
  );
  assert.equal(
    pending.find((e) => e.endpoint === B)?.lastError,
    undefined,
  );
});

test("NaN clock dry run still reports wouldRetry and never reads the clock", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  let clockReads = 0;
  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return true;
    },
    {
      now: () => {
        clockReads += 1;
        return NaN;
      },
      dryRun: true,
    },
  );
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
    wouldRetry: [{ endpoint: A, eventId: EVT_1, wouldRetry: true }],
  });
  assert.equal(clockReads, 0);
  assert.equal(calls, 0);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("empty pending list returns an empty summary without reading the clock", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });

  let clockReads = 0;
  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return true;
    },
    {
      now: () => {
        clockReads += 1;
        return NaN;
      },
      maxRounds: 5,
      backoffMs: 1000,
      sleepImpl: async () => {},
    },
  );
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
  });
  assert.equal(clockReads, 0);
  assert.equal(calls, 0);
});

test("attempts are stamped with the round-start value, not a mid-round clock move", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  // The clock advances while the delivery is in flight: the
  // attempt must still carry the value resolved at the round's
  // start (2000), proving the stamp is pinned per round.
  let t = 2000;
  let reads = 0;
  const clock = () => {
    reads += 1;
    return t;
  };
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      t = 5000;
      return false;
    },
    { now: clock },
  );
  assert.equal(summary.attempted, 1);
  assert.equal(reads, 1);
  assert.equal(outbox.pending()[0].attempts, 2);
  assert.equal(outbox.pending()[0].lastAt, 2000);
});
