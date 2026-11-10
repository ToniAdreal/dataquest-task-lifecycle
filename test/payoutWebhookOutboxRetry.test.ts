import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
  PayoutWebhookOutbox,
  retryPayoutWebhookOutbox,
} from "../src/index.js";
import type { PayoutWebhook } from "../src/index.js";

/**
 * Payout webhook outbox retry runner (backlog #1035).
 *
 * `PayoutWebhookOutbox` (#1020) only records failures and never
 * retries, so every caller had to hand-write the same loop — and the
 * two easiest mistakes in a hand-written loop are retrying a dead
 * letter and forgetting to clear a pair after a success. The runner
 * is the one correct usage of the ledger. Rules under test:
 *  - a successful re-delivery acknowledges (clears) the pair, so a
 *    later failure counts from 1 again; the summary counts the
 *    acknowledgement
 *  - a failed re-delivery records one more attempt (with the
 *    runner's injected `now` as `at`) and the pair stays pending
 *  - the 3rd consecutive failure dead-letters the pair and a later
 *    round never re-delivers it (`deliverOne` is not called again);
 *    pairs already dead-lettered before the run are never attempted
 *  - abort stops the run at a round boundary (whether the signal
 *    aborts during the between-rounds sleep or before a round
 *    starts) and already-made attempts keep their results; a
 *    pre-aborted signal makes zero calls
 *  - the between-rounds backoff is the deterministic exponential
 *    sequence (`backoffMs * 2^(r-1)`, jitter 0) and is recorded
 *    verbatim through an injected sleep; opt-in jitter stays inside
 *    `[backoff, backoff + jitterMs]`
 *  - `maxRounds` bounds the loop: the summary numbers match the
 *    calls made, exactly; an empty pending list makes zero calls
 *    and returns an all-zero summary
 *  - a `deliverOne` that throws is recorded as a failed attempt
 *    (with its message as `lastError`), never a runner crash; a
 *    `deliverOne` that resolves to a non-boolean is a caller bug
 *    and throws before anything is recorded for that pair
 *  - `maxConcurrency` bounds the in-flight re-deliveries (default
 *    serial); invalid options throw before any call is made
 *  - the documented usage wraps `deliverPayoutWebhook` and returns
 *    `result.ok` (this module reports delivery failure, never
 *    throws it): a stubbed 500 then 200 re-delivers end to end
 *    through the runner
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

/** Drive a task from DRAFT all the way to PAID and build its webhook. */
function goldenWebhook(): PayoutWebhook {
  const t = new TaskLifecycle("task-retry");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-retry-1",
    payoutAmount: 4200,
  });
  return buildPayoutWebhook(t, "whsec_test_payout_outbox_retry", {
    eventId: EVT_1,
    now: new Date("2026-10-09T00:00:00.000Z"),
  });
}

test("success acknowledges the pair and the summary counts it", async () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3, now: clock.now });
  fail(outbox, A, EVT_1, "server responded with status 500", clock.now());
  fail(outbox, A, EVT_1, "server responded with status 500", clock.now());
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0].attempts, 2);

  const calls: Array<[string, string]> = [];
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async (endpoint, eventId) => {
      calls.push([endpoint, eventId]);
      return true;
    },
    { now: clock.now },
  );
  assert.deepEqual(calls, [[A, EVT_1]]);
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 1,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
  });
  assert.equal(outbox.pending().length, 0);
  assert.equal(outbox.size, 0);

  // A later failure for the same pair counts from 1 again.
  fail(outbox, A, EVT_1);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("failure records one more attempt and the pair stays pending", async () => {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3, now: clock.now });
  fail(outbox, A, EVT_1, "first failure", clock.now());
  clock.advance(5_000);

  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => false,
    { now: clock.now },
  );
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
  });
  const pending = outbox.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 2);
  // The runner stamps the attempt with its injected clock.
  assert.equal(pending[0].lastAt, clock.now());
  assert.equal(pending[0].lastError, undefined);
});

test("third failure dead-letters and the next round does not re-deliver", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  assert.equal(outbox.pending()[0].attempts, 2);

  let calls = 0;
  const sleeps: number[] = [];
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return false;
    },
    {
      maxRounds: 2,
      backoffMs: 1000,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  // Round 1: the 3rd failure dead-letters the pair. Round 2 finds an
  // empty pending list and stops — no second call, no second sleep.
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 0,
    stillPending: 0,
    deadLettered: 1,
    aborted: false,
  });
  assert.equal(outbox.deadLetter().length, 1);
  assert.equal(outbox.deadLetter()[0].attempts, 3);
});

test("already dead-lettered pairs are never attempted", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);
  assert.equal(outbox.deadLetter().length, 1);
  assert.equal(outbox.pending().length, 1);

  const calls: Array<[string, string]> = [];
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async (endpoint, eventId) => {
      calls.push([endpoint, eventId]);
      return true;
    },
    { maxRounds: 3, backoffMs: 10, sleepImpl: async () => {} },
  );
  // Only the pending pair is attempted (and acknowledged); the dead
  // letter is never touched, whatever the round count.
  assert.deepEqual(calls, [[B, EVT_2]]);
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 1,
    stillPending: 0,
    deadLettered: 1,
    aborted: false,
  });
});

test("abort during the between-rounds sleep stops at the boundary", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  const controller = new AbortController();
  let calls = 0;
  const sleeps: number[] = [];
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return false;
    },
    {
      maxRounds: 3,
      backoffMs: 1000,
      signal: controller.signal,
      sleepImpl: async (ms, signal) => {
        sleeps.push(ms);
        controller.abort();
        if (signal?.aborted) throw new Error("payout webhook outbox retry aborted");
      },
    },
  );
  // Round 1 ran both pairs (2 calls); the sleep aborted, so rounds 2
  // and 3 never ran — but round 1's recorded failures are kept.
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(summary, {
    attempted: 2,
    acknowledged: 0,
    stillPending: 2,
    deadLettered: 0,
    aborted: true,
  });
  assert.equal(outbox.pending().length, 2);
  assert.ok(outbox.pending().every((e) => e.attempts === 2));
});

test("abort between rounds via a resolving sleep is caught at the next boundary", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  const controller = new AbortController();
  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return false;
    },
    {
      maxRounds: 3,
      backoffMs: 1000,
      signal: controller.signal,
      // Abort, but resolve anyway: the runner must still stop at the
      // round boundary instead of running round 2.
      sleepImpl: async () => {
        controller.abort();
      },
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: true,
  });
});

test("pre-aborted signal makes zero calls and reports aborted", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return true;
    },
    { maxRounds: 3, signal: controller.signal },
  );
  assert.equal(calls, 0);
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: true,
  });
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("backoff sequence is recorded verbatim with jitter 0", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 10 });
  fail(outbox, A, EVT_1);

  const sleeps: number[] = [];
  const summary = await retryPayoutWebhookOutbox(outbox, async () => false, {
    maxRounds: 3,
    backoffMs: 1000,
    jitterMs: 0,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  // Round 1 -> 2 waits 1000, round 2 -> 3 waits 2000; no sleep after
  // the last round.
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(summary.attempted, 3);
  assert.equal(outbox.pending()[0].attempts, 4);
});

test("opt-in jitter stays inside [backoff, backoff + jitterMs]", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 10 });
  fail(outbox, A, EVT_1);

  const sleeps: number[] = [];
  await retryPayoutWebhookOutbox(outbox, async () => false, {
    maxRounds: 4,
    backoffMs: 1000,
    jitterMs: 500,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(sleeps.length, 3);
  const bases = [1000, 2000, 4000];
  for (let i = 0; i < sleeps.length; i++) {
    assert.ok(
      sleeps[i] >= bases[i] && sleeps[i] < bases[i] + 500,
      `sleep ${i} (${sleeps[i]}ms) outside [${bases[i]}, ${bases[i] + 500})`,
    );
  }
});

test("maxRounds bounds the loop and the summary matches exactly", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 10 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return false;
    },
    { maxRounds: 2, backoffMs: 0, sleepImpl: async () => {} },
  );
  // 2 pairs x 2 rounds = 4 attempts; nothing acknowledged, nothing
  // dead-lettered (2 attempts each against maxAttempts 10).
  assert.equal(calls, 4);
  assert.deepEqual(summary, {
    attempted: 4,
    acknowledged: 0,
    stillPending: 2,
    deadLettered: 0,
    aborted: false,
  });
  assert.ok(outbox.pending().every((e) => e.attempts === 3));
});

test("empty pending list makes zero calls and returns an all-zero summary", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  let calls = 0;
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return true;
    },
    { maxRounds: 5, backoffMs: 1000, sleepImpl: async () => {} },
  );
  assert.equal(calls, 0);
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
  });
});

test("a throwing deliverOne is recorded as a failed attempt, not a crash", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => {
      throw new Error("boom: connection reset");
    },
    {},
  );
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
  });
  const pending = outbox.pending();
  assert.equal(pending[0].attempts, 2);
  assert.equal(pending[0].lastError, "boom: connection reset");
});

test("a non-boolean deliverOne result throws before anything is recorded", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  await assert.rejects(
    retryPayoutWebhookOutbox(
      outbox,
      async () => undefined as unknown as boolean,
      {},
    ),
    /deliverOne must resolve to a boolean, got undefined/,
  );
  // The run aborted on the first pair's caller bug; both pairs are
  // untouched (the second was never attempted).
  assert.equal(outbox.pending().length, 2);
  assert.ok(outbox.pending().every((e) => e.attempts === 1));
});

test("maxConcurrency bounds the in-flight re-deliveries", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_2);
  fail(outbox, B, EVT_1);
  fail(outbox, B, EVT_2);

  let inFlight = 0;
  let peak = 0;
  const deliverOne = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return true;
  };
  const summary = await retryPayoutWebhookOutbox(outbox, deliverOne, {
    maxConcurrency: 2,
  });
  assert.equal(peak, 2);
  assert.deepEqual(summary, {
    attempted: 4,
    acknowledged: 4,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
  });
});

test("default concurrency is serial (peak 1)", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_2);
  fail(outbox, B, EVT_3);

  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const summary = await retryPayoutWebhookOutbox(outbox, async (_e, id) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    order.push(id);
    await Promise.resolve();
    inFlight -= 1;
    return true;
  });
  assert.equal(peak, 1);
  // Serial runs visit the pending list in first-recorded order.
  assert.deepEqual(order, [EVT_1, EVT_2, EVT_3]);
  assert.equal(summary.acknowledged, 3);
});

test("invalid options throw before any call is made", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  const cases: Array<{
    label: string;
    outbox: unknown;
    deliverOne: unknown;
    opts: Record<string, unknown>;
    pattern: RegExp;
  }> = [
    {
      label: "maxRounds 0",
      outbox,
      deliverOne: async () => true,
      opts: { maxRounds: 0 },
      pattern: /maxRounds must be a positive integer/,
    },
    {
      label: "maxRounds non-integer",
      outbox,
      deliverOne: async () => true,
      opts: { maxRounds: 1.5 },
      pattern: /maxRounds must be a positive integer/,
    },
    {
      label: "backoffMs negative",
      outbox,
      deliverOne: async () => true,
      opts: { backoffMs: -1 },
      pattern: /backoffMs must be a non-negative number/,
    },
    {
      label: "jitterMs negative",
      outbox,
      deliverOne: async () => true,
      opts: { jitterMs: -5 },
      pattern: /jitterMs must be a non-negative number/,
    },
    {
      label: "maxConcurrency 0",
      outbox,
      deliverOne: async () => true,
      opts: { maxConcurrency: 0 },
      pattern: /maxConcurrency must be a positive integer/,
    },
    {
      label: "deliverOne not a function",
      outbox,
      deliverOne: true,
      opts: {},
      pattern: /deliverOne must be a function/,
    },
    {
      label: "outbox not an outbox",
      outbox: {},
      deliverOne: async () => true,
      opts: {},
      pattern: /outbox must be a PayoutWebhookOutbox/,
    },
    {
      label: "signal not an AbortSignal",
      outbox,
      deliverOne: async () => true,
      opts: { signal: "abort" },
      pattern: /signal must be an AbortSignal/,
    },
    {
      label: "sleepImpl not a function",
      outbox,
      deliverOne: async () => true,
      opts: { sleepImpl: 42 },
      pattern: /sleepImpl must be a function/,
    },
    {
      label: "now not a function",
      outbox,
      deliverOne: async () => true,
      opts: { now: "now" },
      pattern: /now must be a function/,
    },
  ];
  for (const c of cases) {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return true;
    };
    await assert.rejects(
      retryPayoutWebhookOutbox(
        c.outbox as PayoutWebhookOutbox,
        (typeof c.deliverOne === "function"
          ? counting
          : c.deliverOne) as (
          endpoint: string,
          eventId: string,
        ) => Promise<boolean>,
        c.opts as Parameters<typeof retryPayoutWebhookOutbox>[2],
      ),
      c.pattern,
      c.label,
    );
    assert.equal(calls, 0, `${c.label}: no deliverOne call may be made`);
  }
  // The ledger is untouched by all the rejected runs.
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("a sleep that rejects while the signal is live propagates (not masked as abort)", async () => {
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);

  await assert.rejects(
    retryPayoutWebhookOutbox(outbox, async () => false, {
      maxRounds: 2,
      backoffMs: 100,
      sleepImpl: async () => {
        throw new Error("sleep broke");
      },
    }),
    /sleep broke/,
  );
  // Round 1's failure is still recorded; the run died on the sleep bug.
  assert.equal(outbox.pending()[0].attempts, 2);
});

test("deliverPayoutWebhook wrapper (result.ok) re-delivers end to end", async () => {
  const webhook = goldenWebhook();
  const outbox = new PayoutWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, "server responded with status 500");

  // Stubbed fetch: 500 on the first delivery, 200 on the second.
  const statuses = [500, 200];
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response(null, {
      status: statuses[Math.min(fetchCalls - 1, statuses.length - 1)],
    });
  }) as typeof fetch;

  const sleeps: number[] = [];
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    // The documented usage: this module reports delivery failure
    // instead of throwing it, so the wrapper returns `result.ok`
    // rather than a try/catch.
    async (endpoint) => {
      const result = await deliverPayoutWebhook(endpoint, webhook, {
        maxAttempts: 1,
        backoffMs: 0,
        fetchImpl,
        sleepImpl: async () => {},
      });
      return result.ok;
    },
    {
      maxRounds: 2,
      backoffMs: 1000,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(fetchCalls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(summary, {
    attempted: 2,
    acknowledged: 1,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
  });
  assert.equal(outbox.pending().length, 0);
  // The first round's failure was recorded before the second
  // round's success cleared the pair.
  assert.equal(outbox.size, 0);
});
