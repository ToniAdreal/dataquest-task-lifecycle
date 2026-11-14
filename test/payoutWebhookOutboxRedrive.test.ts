import test from "node:test";
import assert from "node:assert/strict";
import { PayoutWebhookOutbox } from "../src/index.js";

/**
 * Payout webhook outbox dead-letter redrive (backlog #1135).
 *
 * The outbox had no way back from the dead letter: once a pair
 * exhausted its retries, the only recovery was `clear()` (lose the
 * record) or rebuilding the pair by hand (attempts history lost).
 * `redrive()` moves a dead-lettered pair back to pending for a
 * fresh delivery round, mirroring escrow's `SettlementWebhookOutbox`
 * redrive (backlog #1126). Rules under test:
 *  - only a dead-lettered pair redrives: a pending pair and an
 *    untracked pair both throw, and the ledger is untouched
 *  - a redriven pair is pending with `attempts: 0`, `lastAt` stamped
 *    with the redrive time, and no `lastError` (the old error
 *    belonged to the exhausted round); `size` is unchanged and
 *    `stats()` follows
 *  - a later failure counts from 1 again; failing back to the cap
 *    dead-letters it again, and a second `redrive()` then works
 *    (while redriving the now-pending pair throws)
 *  - `opts.now` stamps `lastAt`; the default is the outbox clock
 *  - invalid `opts.now` / endpoint / eventId throw before anything
 *    changes
 *  - redrive keeps first-recorded order and is per-pair: the same
 *    eventId on another endpoint is untouched
 *  - restore keeps redrive semantics: a restored dead letter
 *    redrives the same way, and a redriven pair exports with
 *    `attempts: 0` and restores as pending (including through a
 *    JSON hop); the pending/dead-letter boundary is re-derived
 *    from the restoring outbox's `maxAttempts`, so a snapshot
 *    restored under a looser cap is pending and cannot be redriven
 *  - a hand-built snapshot entry with `attempts: 0` restores as
 *    pending (restore accepts the redriven count; negative and
 *    non-integer counts still fail closed)
 */

const A = "https://payouts.example/hooks/payout";
const B = "https://ledger.example/hooks/payout";
const EVT_1 = "evt-0001";
const EVT_2 = "evt-0002";
const EVT_3 = "evt-0003";

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
  times = 1,
  error = "server responded with status 500",
): void {
  for (let i = 0; i < times; i++) {
    outbox.recordAttempt({ endpoint, eventId, ok: false, error });
  }
}

function deadLettered(
  outbox: PayoutWebhookOutbox,
  endpoint: string,
  eventId: string,
  error = "gateway timeout",
): void {
  fail(outbox, endpoint, eventId, 3, error);
}

test("a dead-lettered pair redrives into pending with attempts reset and the old error dropped", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  deadLettered(outbox, A, EVT_1, "gateway timeout");
  fail(outbox, B, EVT_2, 1); // pending control pair
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 1,
    deadLettered: 1,
    totalAttempts: 4,
  });

  clock.advance(5_000);
  outbox.redrive(A, EVT_1);

  assert.deepEqual(outbox.pending(), [
    { endpoint: A, eventId: EVT_1, attempts: 0, lastAt: 1_005_000 },
    {
      endpoint: B,
      eventId: EVT_2,
      attempts: 1,
      lastError: "server responded with status 500",
      lastAt: 1_000_000,
    },
  ]);
  assert.deepEqual(outbox.deadLetter(), []);
  assert.equal(outbox.size, 2);
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 2,
    deadLettered: 0,
    totalAttempts: 1,
  });
});

test("redriving a pending pair throws and leaves the ledger untouched", () => {
  const outbox = new PayoutWebhookOutbox();
  fail(outbox, A, EVT_1, 2);
  const pendingBefore = outbox.pending();
  const deadBefore = outbox.deadLetter();

  assert.throws(
    () => outbox.redrive(A, EVT_1),
    /PayoutWebhookOutbox: cannot redrive a pending pair/,
  );
  assert.deepEqual(outbox.pending(), pendingBefore);
  assert.deepEqual(outbox.deadLetter(), deadBefore);
  assert.equal(outbox.size, 1);
});

test("redriving an untracked pair throws and leaves the ledger untouched", () => {
  const outbox = new PayoutWebhookOutbox();
  fail(outbox, A, EVT_1, 1);
  const pendingBefore = outbox.pending();
  const deadBefore = outbox.deadLetter();

  assert.throws(
    () => outbox.redrive(A, "evt-nope"),
    /PayoutWebhookOutbox: cannot redrive an untracked pair/,
  );
  assert.throws(
    () => outbox.redrive(B, EVT_1),
    /PayoutWebhookOutbox: cannot redrive an untracked pair/,
  );
  assert.deepEqual(outbox.pending(), pendingBefore);
  assert.deepEqual(outbox.deadLetter(), deadBefore);
  assert.equal(outbox.size, 1);
});

test("a failure after redrive counts from 1 again, and the pair can dead-letter and redrive again", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  deadLettered(outbox, A, EVT_1);
  outbox.redrive(A, EVT_1);

  fail(outbox, A, EVT_1, 1);
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

  fail(outbox, A, EVT_1, 2);
  assert.deepEqual(outbox.pending(), []);
  assert.equal(outbox.deadLetter().length, 1);

  clock.advance(60_000);
  outbox.redrive(A, EVT_1);
  assert.deepEqual(outbox.pending(), [
    { endpoint: A, eventId: EVT_1, attempts: 0, lastAt: 1_060_000 },
  ]);
  assert.deepEqual(outbox.deadLetter(), []);
});

test("a second redrive throws while the pair is pending", () => {
  const outbox = new PayoutWebhookOutbox();
  deadLettered(outbox, A, EVT_1);
  outbox.redrive(A, EVT_1);

  assert.throws(
    () => outbox.redrive(A, EVT_1),
    /PayoutWebhookOutbox: cannot redrive a pending pair/,
  );
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0].attempts, 0);
  assert.deepEqual(outbox.deadLetter(), []);
});

test("opts.now stamps lastAt; the default is the outbox clock", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  deadLettered(outbox, A, EVT_1);
  deadLettered(outbox, B, EVT_2);

  outbox.redrive(A, EVT_1, { now: 2_000_000 });
  assert.equal(outbox.pending()[0].lastAt, 2_000_000);

  clock.advance(7_000);
  outbox.redrive(B, EVT_2);
  assert.equal(outbox.pending()[1].lastAt, 1_007_000);
});

test("invalid redrive arguments throw before anything changes", () => {
  const outbox = new PayoutWebhookOutbox();
  deadLettered(outbox, A, EVT_1);
  const pendingBefore = outbox.pending();
  const deadBefore = outbox.deadLetter();
  const snapshotBefore = outbox.exportSnapshot();

  const bad: unknown[][] = [
    ["", EVT_1],
    [42, EVT_1],
    [A, ""],
    [A, 7],
    [null, EVT_1],
    [A, null],
  ];
  for (const [endpoint, eventId] of bad) {
    assert.throws(
      () =>
        outbox.redrive(endpoint as string, eventId as string),
      /PayoutWebhookOutbox: endpoint must be a non-empty string|PayoutWebhookOutbox: eventId must be a non-empty string/,
    );
  }
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, "now"]) {
    assert.throws(
      () => outbox.redrive(A, EVT_1, { now: now as unknown as number }),
      /PayoutWebhookOutbox: redrive now must be a finite number/,
    );
  }
  assert.deepEqual(outbox.pending(), pendingBefore);
  assert.deepEqual(outbox.deadLetter(), deadBefore);
  assert.deepEqual(outbox.exportSnapshot(), snapshotBefore);
});

test("redrive keeps first-recorded order", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  deadLettered(outbox, A, EVT_1);
  fail(outbox, A, EVT_2, 1);
  deadLettered(outbox, B, EVT_3);

  outbox.redrive(B, EVT_3);
  // EVT_3 keeps its first-recorded position (after EVT_2), it does
  // not jump the queue.
  assert.deepEqual(
    outbox.pending().map((e) => `${e.endpoint}|${e.eventId}|${e.attempts}`),
    [`${A}|${EVT_2}|1`, `${B}|${EVT_3}|0`],
  );
  assert.deepEqual(
    outbox.deadLetter().map((e) => `${e.endpoint}|${e.eventId}`),
    [`${A}|${EVT_1}`],
  );

  outbox.redrive(A, EVT_1);
  assert.deepEqual(
    outbox.pending().map((e) => `${e.endpoint}|${e.eventId}|${e.attempts}`),
    [`${A}|${EVT_1}|0`, `${A}|${EVT_2}|1`, `${B}|${EVT_3}|0`],
  );
  assert.deepEqual(outbox.deadLetter(), []);
});

test("redrive is per-pair: the same eventId on another endpoint is untouched", () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  deadLettered(outbox, A, EVT_1, "payouts gateway down");
  deadLettered(outbox, B, EVT_1, "ledger gateway down");

  outbox.redrive(A, EVT_1);
  assert.deepEqual(outbox.pending(), [
    { endpoint: A, eventId: EVT_1, attempts: 0, lastAt: 1_000_000 },
  ]);
  assert.deepEqual(outbox.deadLetter(), [
    {
      endpoint: B,
      eventId: EVT_1,
      attempts: 3,
      lastError: "ledger gateway down",
      lastAt: 1_000_000,
    },
  ]);
});

test("a restored dead letter redrives the same way; the original outbox is untouched", () => {
  const outbox = new PayoutWebhookOutbox();
  deadLettered(outbox, A, EVT_1);
  const restored = PayoutWebhookOutbox.restore(
    JSON.parse(JSON.stringify(outbox.exportSnapshot())),
  );
  assert.equal(restored.deadLetter().length, 1);

  restored.redrive(A, EVT_1);
  assert.equal(restored.pending().length, 1);
  assert.equal(restored.pending()[0].attempts, 0);
  assert.deepEqual(restored.deadLetter(), []);
  assert.deepEqual(restored.stats(), {
    size: 1,
    pending: 1,
    deadLettered: 0,
    totalAttempts: 0,
  });

  // Restore produced a fresh object: the original still holds the
  // dead letter.
  assert.equal(outbox.deadLetter().length, 1);
  assert.deepEqual(outbox.pending(), []);
});

test("a redriven pair exports with attempts 0 and restores as pending, through a JSON hop", () => {
  const outbox = new PayoutWebhookOutbox();
  deadLettered(outbox, A, EVT_1, "boom");
  outbox.redrive(A, EVT_1, { now: 5_000_000 });

  const snapshot = outbox.exportSnapshot();
  assert.deepEqual(snapshot, {
    v: 1,
    entries: [{ endpoint: A, eventId: EVT_1, attempts: 0, lastAt: 5_000_000 }],
  });

  const restored = PayoutWebhookOutbox.restore(
    JSON.parse(JSON.stringify(snapshot)),
  );
  assert.deepEqual(restored.pending(), [
    { endpoint: A, eventId: EVT_1, attempts: 0, lastAt: 5_000_000 },
  ]);
  assert.deepEqual(restored.deadLetter(), []);
  assert.deepEqual(restored.stats(), {
    size: 1,
    pending: 1,
    deadLettered: 0,
    totalAttempts: 0,
  });
});

test("restore under a looser cap leaves the pair pending, so redrive throws; under a stricter cap it stays dead-lettered", () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  deadLettered(outbox, A, EVT_1);
  const snapshot = outbox.exportSnapshot();

  const looser = PayoutWebhookOutbox.restore(snapshot, {
    maxAttempts: 5,
  });
  assert.equal(looser.pending().length, 1);
  assert.deepEqual(looser.deadLetter(), []);
  assert.throws(
    () => looser.redrive(A, EVT_1),
    /PayoutWebhookOutbox: cannot redrive a pending pair/,
  );

  const stricter = PayoutWebhookOutbox.restore(snapshot, {
    maxAttempts: 2,
  });
  assert.deepEqual(stricter.pending(), []);
  assert.equal(stricter.deadLetter().length, 1);
  stricter.redrive(A, EVT_1);
  assert.equal(stricter.pending().length, 1);
  assert.equal(stricter.pending()[0].attempts, 0);
});

test("restore accepts a hand-built attempts-0 entry as pending; negative and non-integer counts still fail closed", () => {
  const restored = PayoutWebhookOutbox.restore({
    v: 1,
    entries: [{ endpoint: A, eventId: EVT_1, attempts: 0, lastAt: 1_000_000 }],
  });
  assert.deepEqual(restored.pending(), [
    { endpoint: A, eventId: EVT_1, attempts: 0, lastAt: 1_000_000 },
  ]);
  assert.deepEqual(restored.deadLetter(), []);

  for (const attempts of [-1, 1.5, "0", null]) {
    assert.throws(
      () =>
        PayoutWebhookOutbox.restore({
          v: 1,
          entries: [
            { endpoint: A, eventId: EVT_1, attempts, lastAt: 1_000_000 },
          ],
        }),
      /PayoutWebhookOutbox: invalid snapshot: entries\[0\]: attempts must be a non-negative integer/,
    );
  }
});
