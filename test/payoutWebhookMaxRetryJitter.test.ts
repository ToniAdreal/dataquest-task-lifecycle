import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
} from "../src/index.js";
import type { PayoutWebhook } from "../src/index.js";

/**
 * Single-endpoint `deliverPayoutWebhook` with `maxRetryDelayMs` AND
 * `jitterMs` open at the same time (backlog #720).
 *
 * The two options already have single-option coverage — the cap row in
 * `test/payoutWebhookDelivery.test.ts` never mentions `jitterMs`, and
 * the jitter row in `test/payoutWebhookJitter.test.ts` never mentions
 * `maxRetryDelayMs` — so the semantics when both are set had no
 * backing. The source rule under test (`retryDelayMs` in
 * `src/settlementWebhook.ts`): a 429 `Retry-After` hint wins over
 * backoff, is clamped to `maxRetryDelayMs`, and is waited exactly —
 * jitter is never added on top of it. Only when the hint is absent or
 * unparsable does the jittered backoff run, and the cap never clamps
 * that backoff.
 *
 * Every test injects `fetchImpl`/`sleepImpl`: no real network, and the
 * exact delay schedule is asserted instead of really sleeping.
 */

const SECRET = "whsec_test_payout_maxretry_jitter_20261030";
const HOOK_URL = "https://accounting.example.com/hooks/payout";

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-maxretry-jitter"): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-maxretry-jitter-1",
    payoutAmount: 4200,
  });
  return t;
}

function goldenWebhook(): PayoutWebhook {
  return buildPayoutWebhook(paidTask(), SECRET, {
    eventId: "evt-maxretry-jitter-1",
    now: new Date("2026-10-30T00:00:00.000Z"),
  });
}

/** A fetch stub driven by a script of responses/errors. */
function stubFetch(script: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    state.calls += 1;
    const step = script[Math.min(state.calls - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    return new Response(step.body, { status: step.status, headers: step.headers });
  }) as typeof fetch;
  return { fetchImpl, state };
}

/** A sleep stub that records the requested delays instead of sleeping. */
function stubSleep(): {
  sleepImpl: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleepImpl: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const res = (status: number, headers?: Record<string, string>) =>
  new Response("{}", { status, headers });

test("over-cap 429 hint + jitterMs: sleep is exactly the cap, jitter never pushes it over", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([
    res(429, { "retry-after": "120" }),
    res(200),
  ]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 100,
    maxRetryDelayMs: 500,
    jitterMs: 1000,
    maxAttempts: 2,
  });
  assert.deepEqual(result, { ok: true, attempts: 2, status: 200 });
  // The 120s hint is clamped to 500ms; the 1000ms jitter must NOT be
  // added on top of the clamped wait (500 + jitter would exceed cap).
  assert.deepEqual(delays, [500]);
});

test("under-cap 429 hint + jitterMs: sleep is exactly the hint, no jitter added", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([
    res(429, { "retry-after": "2" }),
    res(200),
  ]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 100,
    maxRetryDelayMs: 60_000,
    jitterMs: 1000,
    maxAttempts: 2,
  });
  assert.deepEqual(result, { ok: true, attempts: 2, status: 200 });
  // The hint is the receiver's own prescribed time: exact, even though
  // jitter is configured and the hint sits below the cap.
  assert.deepEqual(delays, [2000]);
});

test("no-hint 500 + cap + jitterMs: sleep stays inside the jitter window", async () => {
  // Repeat the delivery many times: every sample must stay inside its
  // window, and the samples must actually vary (jitter applied, not
  // silently ignored). Only bounds are asserted — never exact values.
  const observed = new Set<number>();
  for (let run = 0; run < 30; run += 1) {
    const webhook = goldenWebhook();
    const { fetchImpl } = stubFetch([res(500), res(500), res(200)]);
    const { sleepImpl, delays } = stubSleep();
    const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
      fetchImpl,
      sleepImpl,
      backoffMs: 100,
      maxRetryDelayMs: 500,
      jitterMs: 1000,
      maxAttempts: 3,
    });
    assert.equal(result.ok, true);
    assert.equal(delays.length, 2);
    const [first, second] = delays;
    assert.ok(
      first >= 100 && first <= 1100,
      `first delay ${first} outside [100, 1100]`,
    );
    assert.ok(
      second >= 200 && second <= 1200,
      `second delay ${second} outside [200, 1200]`,
    );
    observed.add(first);
    observed.add(second);
  }
  assert.ok(
    observed.size > 2,
    "jitter must actually spread the delays across the window",
  );
});

test("jitterMs=0 + over-cap hint: sleep is exactly the cap", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([
    res(429, { "retry-after": "120" }),
    res(200),
  ]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 100,
    maxRetryDelayMs: 500,
    jitterMs: 0,
    maxAttempts: 2,
  });
  assert.deepEqual(result, { ok: true, attempts: 2, status: 200 });
  assert.deepEqual(delays, [500]);
});

test("unparsable 429 hint + jitterMs: the cap never clamps the jittered backoff", async () => {
  // A "banana" hint falls back to the jittered backoff. The cap only
  // clamps hints, so across many runs at least one backoff sample must
  // exceed the 500ms cap — if the cap leaked into the backoff path,
  // every sample would sit at or below 500.
  const observed: number[] = [];
  for (let run = 0; run < 30; run += 1) {
    const webhook = goldenWebhook();
    const { fetchImpl } = stubFetch([
      res(429, { "retry-after": "banana" }),
      res(200),
    ]);
    const { sleepImpl, delays } = stubSleep();
    const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
      fetchImpl,
      sleepImpl,
      backoffMs: 100,
      maxRetryDelayMs: 500,
      jitterMs: 1000,
      maxAttempts: 2,
    });
    assert.equal(result.ok, true);
    assert.equal(delays.length, 1);
    assert.ok(
      delays[0] >= 100 && delays[0] <= 1100,
      `delay ${delays[0]} outside [100, 1100]`,
    );
    observed.push(delays[0]);
  }
  assert.ok(
    Math.max(...observed) > 500,
    `cap must not clamp the backoff path, but all 30 samples stayed <= 500: ${observed.join(", ")}`,
  );
});

test("invalid maxRetryDelayMs/jitterMs combinations throw before any request is made", async () => {
  const webhook = goldenWebhook();
  const cases: Array<{
    opts: { maxRetryDelayMs: unknown; jitterMs: unknown };
    pattern: RegExp;
  }> = [
    {
      opts: { maxRetryDelayMs: -1, jitterMs: 1000 },
      pattern: /maxRetryDelayMs must be a non-negative number/,
    },
    {
      opts: { maxRetryDelayMs: 500, jitterMs: -1 },
      pattern: /jitterMs must be a non-negative number/,
    },
    {
      opts: { maxRetryDelayMs: Number.NaN, jitterMs: 1000 },
      pattern: /maxRetryDelayMs must be a non-negative number/,
    },
    {
      opts: { maxRetryDelayMs: 500, jitterMs: Number.NaN },
      pattern: /jitterMs must be a non-negative number/,
    },
    {
      opts: { maxRetryDelayMs: Number.POSITIVE_INFINITY, jitterMs: 1000 },
      pattern: /maxRetryDelayMs must be a non-negative number/,
    },
    {
      opts: { maxRetryDelayMs: 500, jitterMs: "1000" },
      pattern: /jitterMs must be a non-negative number/,
    },
  ];
  for (const { opts, pattern } of cases) {
    const { fetchImpl, state } = stubFetch([res(200)]);
    const { sleepImpl } = stubSleep();
    await assert.rejects(
      () =>
        deliverPayoutWebhook(HOOK_URL, webhook, {
          fetchImpl,
          sleepImpl,
          maxRetryDelayMs: opts.maxRetryDelayMs as number,
          jitterMs: opts.jitterMs as number,
        }),
      new RegExp(
        `cannot deliver payout webhook: ${pattern.source}`,
      ),
      `opts=${JSON.stringify(opts)}`,
    );
    assert.equal(
      state.calls,
      0,
      `opts=${JSON.stringify(opts)} must make zero fetch calls`,
    );
  }
});
