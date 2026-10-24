import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
  deliverPayoutWebhookToMany,
} from "../src/index.js";
import type { PayoutWebhook } from "../src/index.js";

/**
 * Opt-in retry jitter on payout webhook delivery (backlog #547):
 * `DeliverPayoutWebhookOptions.jitterMs`.
 *
 * Rules under test:
 *  - default `jitterMs` is 0 and the delay schedule is exactly the
 *    pre-jitter exponential backoff sequence (regression lock) — on
 *    both the 5xx path and the network-error path
 *  - `jitterMs > 0` spreads each backoff wait into
 *    `[backoff, backoff + jitterMs]` (bounds only — never an exact
 *    value, so the test cannot be flaky)
 *  - a 429 `Retry-After` hint is the receiver's own prescribed time:
 *    it is waited exactly, with no jitter added
 *  - invalid `jitterMs` (negative, NaN, infinite, non-number) is a
 *    caller configuration error: it throws before any request is made
 *  - `deliverPayoutWebhookToMany` forwards `jitterMs` (call-level and
 *    per-endpoint) and keeps the exact schedule by default
 *  - every test injects `fetchImpl`/`sleepImpl`: no real network, and
 *    the exact delay schedule is asserted instead of really sleeping
 */

const SECRET = "whsec_test_payout_jitter_20261024";
const HOOK_URL = "https://accounting.example.com/hooks/payout";

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-jitter"): TaskLifecycle {
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
    payoutRef: "xfer-jitter-1",
    payoutAmount: 4200,
  });
  return t;
}

function goldenWebhook(): PayoutWebhook {
  return buildPayoutWebhook(paidTask(), SECRET, {
    eventId: "evt-jitter-1",
    now: new Date("2026-10-24T00:00:00.000Z"),
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

test("default jitterMs=0 keeps the exact exponential backoff sequence (5xx path)", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([res(500), res(500), res(200)]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 100,
    maxAttempts: 3,
  });
  assert.deepEqual(result, { ok: true, attempts: 3, status: 200 });
  // Regression lock: no jitter configured => pure 100, 200 sequence.
  assert.deepEqual(delays, [100, 200]);
});

test("default jitterMs=0 keeps the exact exponential backoff sequence (network-error path)", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([
    new Error("socket hang up"),
    new Error("socket hang up"),
    res(200),
  ]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 100,
    maxAttempts: 3,
  });
  assert.deepEqual(result, { ok: true, attempts: 3, status: 200 });
  assert.deepEqual(delays, [100, 200]);
});

test("jitterMs spreads each backoff wait inside [backoff, backoff + jitterMs]", async () => {
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

test("a 429 Retry-After hint is waited exactly even with jitterMs set", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([
    res(429, { "retry-after": "30" }),
    res(500),
    res(200),
  ]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
  });
  assert.deepEqual(result, { ok: true, attempts: 3, status: 200 });
  // The hint is the receiver's prescribed time: exact, no jitter.
  assert.equal(delays[0], 30000);
  // The 500 fallback still carries jitter.
  assert.ok(delays[1] >= 200 && delays[1] <= 1200);
});

test("invalid jitterMs throws before any request is made", async () => {
  const webhook = goldenWebhook();
  for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, "100"]) {
    const { fetchImpl, state } = stubFetch([res(200)]);
    const { sleepImpl } = stubSleep();
    await assert.rejects(
      () =>
        deliverPayoutWebhook(HOOK_URL, webhook, {
          fetchImpl,
          sleepImpl,
          jitterMs: bad as unknown as number,
        }),
      /cannot deliver payout webhook: jitterMs must be a non-negative number/,
      `jitterMs=${String(bad)}`,
    );
    assert.equal(state.calls, 0, `jitterMs=${String(bad)} must make zero fetch calls`);
  }
});

test("jitterMs: null follows the module's ??-default convention (treated as 0)", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([res(500), res(200)]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 100,
    maxAttempts: 2,
    jitterMs: null as unknown as number,
  });
  assert.deepEqual(result, { ok: true, attempts: 2, status: 200 });
  assert.deepEqual(delays, [100], "null => default 0 => exact schedule");
});

test("deliverPayoutWebhookToMany keeps the exact schedule by default", async () => {
  const task = paidTask("task-jitter-many");
  const mkEndpoint = () => {
    const { fetchImpl } = stubFetch([res(500), res(200)]);
    const { sleepImpl, delays } = stubSleep();
    return {
      endpoint: {
        url: HOOK_URL,
        secret: SECRET,
        fetchImpl,
        sleepImpl,
        backoffMs: 100,
      },
      delays,
    };
  };
  const a = mkEndpoint();
  const b = mkEndpoint();
  const out = await deliverPayoutWebhookToMany(
    task,
    [a.endpoint, b.endpoint],
    { maxAttempts: 2 },
  );
  assert.equal(out.delivered, 2);
  assert.deepEqual(a.delays, [100], "endpoint A: no jitter by default");
  assert.deepEqual(b.delays, [100], "endpoint B: no jitter by default");
});

test("deliverPayoutWebhookToMany forwards call-level and per-endpoint jitterMs", async () => {
  const task = paidTask("task-jitter-many-2");
  const mkEndpoint = (overrides: object = {}) => {
    const { fetchImpl } = stubFetch([res(500), res(200)]);
    const { sleepImpl, delays } = stubSleep();
    return {
      endpoint: {
        url: HOOK_URL,
        secret: SECRET,
        fetchImpl,
        sleepImpl,
        backoffMs: 100,
        ...overrides,
      },
      delays,
    };
  };
  // Call-level jitter applies to endpoints without their own override;
  // the per-endpoint override wins over the call-level one.
  const inherited = mkEndpoint();
  const overridden = mkEndpoint({ jitterMs: 0 });
  const out = await deliverPayoutWebhookToMany(
    task,
    [inherited.endpoint, overridden.endpoint],
    { maxAttempts: 2, jitterMs: 1000 },
  );
  assert.equal(out.delivered, 2);
  assert.equal(inherited.delays.length, 1);
  assert.ok(
    inherited.delays[0] >= 100 && inherited.delays[0] <= 1100,
    "call-level jitter must reach the endpoint",
  );
  assert.deepEqual(
    overridden.delays,
    [100],
    "per-endpoint jitterMs=0 overrides the call-level jitter",
  );
});
