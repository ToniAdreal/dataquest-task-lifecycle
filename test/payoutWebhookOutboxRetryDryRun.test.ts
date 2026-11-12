import test from "node:test";
import assert from "node:assert/strict";
import {
  PayoutWebhookOutbox,
  retryPayoutWebhookOutbox,
} from "../src/index.js";

/**
 * Dry-run rehearsal port for the payout webhook outbox retry
 * runner (backlog #1089, the escrow `retrySettlementWebhookOutbox`
 * dry run from #1088 mirrored for the dataquest runner). Same idiom
 * as `actOnStaleTasks` (#1086) and `expireOverdueTasks` (#1050):
 * preview the batch before running a real action over it. Rules
 * under test:
 *  - a dry run lists exactly the pending set as `{ endpoint,
 *    eventId, wouldRetry: true }` entries, in `pending()` order,
 *    and makes zero `deliverOne` calls
 *  - the ledger is untouched: pending attempts / lastError / lastAt
 *    and the dead letter are all exactly as before, and a live run
 *    right after the dry run still delivers every pair
 *  - a `deliverOne` that would throw or return `false` is never
 *    called in a dry run, so the summary carries no failure counts
 *  - dead-lettered pairs are not in `wouldRetry` (they are never
 *    retried), but the summary still reports their count
 *  - a dry run never sleeps, whatever `maxRounds`/`backoffMs` say
 *  - a pre-aborted signal reports `aborted: true` with an empty
 *    `wouldRetry` list and zero calls
 *  - invalid options (including a non-boolean `dryRun`) fail fast
 *    with zero calls, and the ledger is untouched
 *  - `dryRun: false` (or omitting it) is the live run
 *  - the returned `wouldRetry` entries are detached copies
 */

const A = "https://payouts.example/hooks/payout";
const B = "https://ledger.example/hooks/payout";
const EVT_1 = "evt-0001";
const EVT_2 = "evt-0002";
const EVT_3 = "evt-0003";

function fakeClock(start = 1_700_000_000_000) {
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

/** Snapshot the whole ledger for "untouched" assertions. */
function ledgerSnapshot(outbox: PayoutWebhookOutbox) {
  return {
    pending: outbox.pending(),
    deadLetter: outbox.deadLetter(),
    size: outbox.size,
  };
}

test("dry run lists exactly the pending set and calls nothing", async () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3, now: clock.now });
  fail(outbox, A, EVT_1, "first failure", clock.now());
  fail(outbox, A, EVT_1, "second failure", clock.now());
  fail(outbox, B, EVT_2, "other endpoint", clock.now());
  fail(outbox, A, EVT_3, "third pair", clock.now());
  const before = ledgerSnapshot(outbox);

  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return true;
    },
    { dryRun: true, now: clock.now },
  );
  assert.equal(calls, 0);
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 3,
    deadLettered: 0,
    aborted: false,
    wouldRetry: [
      // pending() order: the ledger groups by endpoint, so both A
      // pairs precede the B pair — the dry run reports pending()
      // order verbatim, it does not re-sort.
      { endpoint: A, eventId: EVT_1, wouldRetry: true },
      { endpoint: A, eventId: EVT_3, wouldRetry: true },
      { endpoint: B, eventId: EVT_2, wouldRetry: true },
    ],
  });
  // The ledger is untouched: same attempts, same lastError/lastAt.
  assert.deepEqual(ledgerSnapshot(outbox), before);
});

test("a dry run then a live run still delivers every pair", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  const rehearsed = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      throw new Error("must not be called in a dry run");
    },
    { dryRun: true },
  );
  assert.equal(rehearsed.wouldRetry?.length, 2);

  const calls: Array<[string, string]> = [];
  const live = await retryPayoutWebhookOutbox(
    outbox,
    async (endpoint, eventId) => {
      calls.push([endpoint, eventId]);
      return true;
    },
    {},
  );
  assert.deepEqual(calls, [
    [A, EVT_1],
    [B, EVT_2],
  ]);
  assert.deepEqual(live, {
    attempted: 2,
    acknowledged: 2,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
  });
  // A live summary never carries wouldRetry.
  assert.equal("wouldRetry" in live, false);
  assert.equal(outbox.pending().length, 0);
});

test("a throwing or failing deliverOne is never called in a dry run", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      throw new Error("boom: connection reset");
    },
    { dryRun: true },
  );
  assert.equal(calls, 0);
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
    wouldRetry: [{ endpoint: A, eventId: EVT_1, wouldRetry: true }],
  });
  // No failure was recorded for the never-made attempt.
  assert.equal(outbox.pending()[0].attempts, 1);
  assert.equal(outbox.pending()[0].lastError, "server responded with status 500");

  // Same for a deliverOne that would return false.
  calls = 0;
  const summary2 = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return false;
    },
    { dryRun: true },
  );
  assert.equal(calls, 0);
  assert.equal(summary2.attempted, 0);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("dead-lettered pairs are excluded from wouldRetry", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);
  assert.equal(outbox.deadLetter().length, 1);
  assert.equal(outbox.pending().length, 1);

  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return true;
    },
    { dryRun: true },
  );
  assert.equal(calls, 0);
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 1,
    aborted: false,
    wouldRetry: [{ endpoint: B, eventId: EVT_2, wouldRetry: true }],
  });
});

test("empty pending list dry-runs to an empty wouldRetry list", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return true;
    },
    { dryRun: true, maxRounds: 5, backoffMs: 1000 },
  );
  assert.equal(calls, 0);
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
    wouldRetry: [],
  });
});

test("a dry run never sleeps, whatever maxRounds and backoffMs say", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 10 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  const sleeps: number[] = [];
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => true,
    {
      dryRun: true,
      maxRounds: 3,
      backoffMs: 1000,
      jitterMs: 500,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.deepEqual(sleeps, []);
  // One pass only: no round repeats the same pending list.
  assert.equal(summary.wouldRetry?.length, 2);
});

test("pre-aborted signal reports aborted with an empty wouldRetry list", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  const before = ledgerSnapshot(outbox);

  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return true;
    },
    { dryRun: true, signal: controller.signal },
  );
  assert.equal(calls, 0);
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: true,
    wouldRetry: [],
  });
  assert.deepEqual(ledgerSnapshot(outbox), before);
});

test("a live signal does not change the dry-run list", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  const controller = new AbortController();
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => true,
    { dryRun: true, signal: controller.signal },
  );
  assert.equal(summary.aborted, false);
  assert.deepEqual(summary.wouldRetry, [
    { endpoint: A, eventId: EVT_1, wouldRetry: true },
  ]);
});

test("invalid options fail fast with zero calls, including dryRun", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  const before = ledgerSnapshot(outbox);

  const cases: Array<{
    label: string;
    opts: Record<string, unknown>;
    pattern: RegExp;
  }> = [
    { label: "dryRun string", opts: { dryRun: "yes" }, pattern: /dryRun must be a boolean/ },
    { label: "dryRun 1", opts: { dryRun: 1 }, pattern: /dryRun must be a boolean/ },
    { label: "dryRun null", opts: { dryRun: null }, pattern: /dryRun must be a boolean/ },
    { label: "dryRun + bad maxRounds", opts: { dryRun: true, maxRounds: 0 }, pattern: /maxRounds must be a positive integer/ },
    { label: "dryRun + bad backoffMs", opts: { dryRun: true, backoffMs: -1 }, pattern: /backoffMs must be a non-negative number/ },
    { label: "dryRun + bad jitterMs", opts: { dryRun: true, jitterMs: -5 }, pattern: /jitterMs must be a non-negative number/ },
    { label: "dryRun + bad maxConcurrency", opts: { dryRun: true, maxConcurrency: 0 }, pattern: /maxConcurrency must be a positive integer/ },
    { label: "dryRun + bad signal", opts: { dryRun: true, signal: "abort" }, pattern: /signal must be an AbortSignal/ },
    { label: "dryRun + bad sleepImpl", opts: { dryRun: true, sleepImpl: 42 }, pattern: /sleepImpl must be a function/ },
    { label: "dryRun + bad now", opts: { dryRun: true, now: "now" }, pattern: /now must be a function/ },
  ];
  for (const c of cases) {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return true;
    };
    await assert.rejects(
      retryPayoutWebhookOutbox(
        outbox,
        counting,
        c.opts as Parameters<typeof retryPayoutWebhookOutbox>[2],
      ),
      c.pattern,
      c.label,
    );
    assert.equal(calls, 0, `${c.label}: no deliverOne call may be made`);
  }
  assert.deepEqual(ledgerSnapshot(outbox), before);
});

test("dryRun false and omitted options are the live run", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => true,
    { dryRun: false },
  );
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 1,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
  });
  assert.equal("wouldRetry" in summary, false);

  fail(outbox, B, EVT_2);
  const summary2 = await retryPayoutWebhookOutbox(
    outbox,
    async () => true,
    {},
  );
  assert.equal(summary2.acknowledged, 1);
  assert.equal("wouldRetry" in summary2, false);
});

test("returned wouldRetry entries are detached from the ledger", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => true,
    { dryRun: true },
  );
  assert.equal(summary.wouldRetry?.length, 1);
  // Mutating a returned entry must not touch the ledger.
  summary.wouldRetry![0].endpoint = "https://forged.example/hooks";
  summary.wouldRetry![0].eventId = "evt-forged";
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0].endpoint, A);
  assert.equal(outbox.pending()[0].eventId, EVT_1);

  // A second dry run reports the same pair again, freshly built.
  const again = await retryPayoutWebhookOutbox(
    outbox,
    async () => true,
    { dryRun: true },
  );
  assert.deepEqual(again.wouldRetry, [
    { endpoint: A, eventId: EVT_1, wouldRetry: true },
  ]);
});
