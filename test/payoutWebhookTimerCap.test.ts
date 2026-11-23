import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
  deliverPayoutWebhookToMany,
  PayoutWebhookOutbox,
  retryPayoutWebhookOutbox,
} from "../src/index.js";
import type {
  PayoutWebhook,
  PayoutWebhookFetchImpl,
} from "../src/index.js";

/**
 * Payout webhook delivery timers obey the Node `setTimeout` ceiling
 * (backlog #1345, mirroring escrow #1326).
 *
 * Node stores timer delays in a 32-bit signed integer: anything above
 * `2^31 - 1` ms (~24.8 days) triggers a `TimeoutOverflowWarning` and
 * fires after 1ms instead of the requested wait (verified on this
 * machine: `setTimeout(3e9)` warns and fires after ~1ms). Four
 * caller-controlled durations reach `setTimeout` in this module —
 * the exponential backoff sleep, the per-attempt timeout, the fan-out
 * overall deadline, and the outbox runner's between-rounds sleep —
 * and an ordinary-looking configuration grows past the ceiling
 * (`backoffMs: 60_000` with 18 attempts reaches 3,932,160,000ms).
 * Rules under test:
 *  - every backoff sleep the delivery loop requests is at most the
 *    ceiling, with the over-ceiling tail clamped to exactly the
 *    ceiling (never 1ms, never dropped); small backoffs keep their
 *    exact schedule
 *  - a 429 `Retry-After` hint larger than the ceiling is likewise
 *    capped, even when `maxRetryDelayMs` is set above the ceiling
 *  - an over-ceiling `timeoutMs` arms the ceiling, not a 1ms
 *    misfire: a request that takes 50ms still completes normally
 *  - an over-ceiling `overallDeadlineMs` arms the ceiling and still
 *    stops a hanging endpoint with the deadline error text (the
 *    configured value is what the error reports)
 *  - the outbox runner's between-rounds sleep shares the same cap,
 *    whether the sleep is the default timer or an injected recorder
 *  - the real default sleep arms a capped `setTimeout`: observed by
 *    wrapping the global timer and reading the armed delay
 *
 * Every test injects `fetchImpl`/`sleepImpl` unless it is observing
 * the real timer: no real network, and the exact delay schedule is
 * asserted instead of really sleeping.
 */

const SECRET = "whsec_test_payout_timer_cap_20261123";
const HOOK_URL = "https://accounting.example.com/hooks/payout";
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Drive a task from DRAFT all the way to PAID and build its webhook. */
function goldenWebhook(): PayoutWebhook {
  const t = new TaskLifecycle("task-timer-cap");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-timer-cap-1",
    payoutAmount: 4200,
  });
  return buildPayoutWebhook(t, SECRET, {
    eventId: "evt-timer-cap-1",
    now: new Date("2026-11-23T00:00:00.000Z"),
  });
}

/** Drive a task from DRAFT all the way to PAID (fan-out input). */
function paidTask(): TaskLifecycle {
  const t = new TaskLifecycle("task-timer-cap-fanout");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-timer-cap-2",
    payoutAmount: 4200,
  });
  return t;
}

const res = (status: number, headers?: Record<string, string>) =>
  new Response("{}", {
    status,
    ...(headers !== undefined ? { headers } : {}),
  });

/**
 * A fetch stub driven by a script of responses/errors (the last entry
 * repeats once the script is exhausted), recording every call.
 */
function stubFetch(script: Array<Response | Error>): {
  fetchImpl: PayoutWebhookFetchImpl;
  calls: number;
} {
  let calls = 0;
  const fetchImpl = (async (_url: string, _init: RequestInit) => {
    calls += 1;
    const step = script[Math.min(calls - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    // Fresh Response per call: a Response body can only be consumed once.
    return new Response(step.body, {
      status: step.status,
      headers: step.headers,
    });
  }) as PayoutWebhookFetchImpl;
  return {
    fetchImpl,
    get calls() {
      return calls;
    },
  };
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

test("exponential backoff past the ceiling is clamped to exactly 2^31-1", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([res(500)]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 60_000,
    maxAttempts: 18,
    jitterMs: 0,
  });
  assert.deepEqual(result, {
    ok: false,
    attempts: 18,
    status: 500,
    error: "server responded with status 500",
  });
  // 17 sleeps: 60_000 * 2^0 .. 60_000 * 2^16; the last computed wait
  // (3,932,160,000) is past the ceiling and must be capped, never armed
  // raw (which would misfire after 1ms and retry immediately).
  const expected = Array.from({ length: 17 }, (_, i) =>
    Math.min(60_000 * 2 ** i, MAX_TIMER_MS),
  );
  assert.deepEqual(delays, expected);
  assert.equal(delays[15], 1_966_080_000);
  assert.equal(delays[16], MAX_TIMER_MS);
  assert.ok(Math.max(...delays) <= MAX_TIMER_MS);
});

test("small backoffs keep their exact schedule", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([res(500)]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 1000,
    maxAttempts: 3,
    jitterMs: 0,
  });
  assert.deepEqual(result, {
    ok: false,
    attempts: 3,
    status: 500,
    error: "server responded with status 500",
  });
  assert.deepEqual(delays, [1000, 2000]);
});

test("a 429 Retry-After hint above the ceiling is capped even when maxRetryDelayMs is too", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([
    res(429, { "retry-after": "31536000" }),
    res(200),
  ]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 1000,
    maxAttempts: 2,
    // The hint (31,536,000 seconds) is first clamped to this cap
    // (3e9, itself above the ceiling) and then to the ceiling.
    maxRetryDelayMs: 3e9,
    jitterMs: 0,
  });
  assert.deepEqual(result, { ok: true, attempts: 2, status: 200 });
  assert.deepEqual(delays, [MAX_TIMER_MS]);
});

test("an over-ceiling timeoutMs does not misfire after 1ms", async () => {
  const webhook = goldenWebhook();
  // A request that takes 50ms of real time and honors its abort
  // signal: with a raw `setTimeout(3e9)` the timeout timer would
  // fire after ~1ms and abort this request; with the clamp the
  // request completes normally.
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls += 1;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 50);
      init.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    return new Response("{}", { status: 200 });
  }) as PayoutWebhookFetchImpl;
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    timeoutMs: 3e9,
  });
  assert.deepEqual(result, { ok: true, attempts: 1, status: 200 });
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("an over-ceiling overallDeadlineMs still stops a hanging endpoint", async () => {
  const task = paidTask();
  // A fetch that hangs until its signal aborts.
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls += 1;
    await new Promise<void>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
    return new Response("{}", { status: 200 });
  }) as PayoutWebhookFetchImpl;
  // Wrap the global timer: delivery timers armed at the ceiling are
  // fired after 20ms of real time instead of ~24.8 days, so the test
  // never waits out the ceiling; every other timer passes through
  // untouched. The armed delay is recorded to prove the clamp.
  const armed: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const wrapped = (
    cb: (...args: any[]) => void,
    ms?: number,
    ...args: any[]
  ) => {
    const stack = new Error().stack ?? "";
    if (ms === MAX_TIMER_MS && stack.includes("settlementWebhook")) {
      armed.push(ms);
      return realSetTimeout(cb, 20, ...args);
    }
    return ms === undefined
      ? realSetTimeout(cb, ...args)
      : realSetTimeout(cb, ms, ...args);
  };
  globalThis.setTimeout = wrapped as typeof setTimeout;
  try {
    const out = await deliverPayoutWebhookToMany(
      task,
      [{ url: HOOK_URL, secret: SECRET }],
      {
        fetchImpl,
        sleepImpl: async () => {},
        overallDeadlineMs: 3e9,
        now: new Date("2026-11-23T00:00:00.000Z"),
        eventId: "evt-timer-cap-deadline",
      },
    );
    assert.equal(out.deadlineExceeded, true);
    assert.equal(out.delivered, 0);
    assert.equal(out.failed, 1);
    assert.deepEqual(out.results, [
      {
        ok: false,
        attempts: 1,
        error:
          "payout webhook delivery timed out: overall deadline of 3000000000ms exceeded",
      },
    ]);
    assert.equal(calls, 1);
    // The deadline timer was armed at exactly the ceiling, not at
    // the configured 3e9 (which would have misfired after 1ms).
    assert.deepEqual(armed, [MAX_TIMER_MS]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("outbox runner between-rounds sleep is capped across 18 rounds", async () => {
  const outbox = new PayoutWebhookOutbox({
    maxAttempts: 100,
    now: () => 1_700_000_000_000,
  });
  outbox.recordAttempt({
    endpoint: HOOK_URL,
    eventId: "evt-timer-cap-outbox",
    ok: false,
    error: "server responded with status 500",
    at: 1_700_000_000_000,
  });
  assert.equal(outbox.pending().length, 1);
  const { sleepImpl, delays } = stubSleep();
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => false,
    { backoffMs: 60_000, maxRounds: 18, sleepImpl, jitterMs: 0 },
  );
  assert.equal(summary.attempted, 18);
  assert.equal(summary.acknowledged, 0);
  assert.equal(summary.stillPending, 1);
  assert.equal(summary.deadLettered, 0);
  // 17 between-rounds sleeps: 60_000 * 2^0 .. 60_000 * 2^16, the
  // last capped at the ceiling. The injected recorder sees the
  // capped values because the runner clamps at its sleep call site
  // (an injected sleep bypasses `sleepWithSignal`).
  const expected = Array.from({ length: 17 }, (_, i) =>
    Math.min(60_000 * 2 ** i, MAX_TIMER_MS),
  );
  assert.deepEqual(delays, expected);
  assert.equal(delays[16], MAX_TIMER_MS);
  assert.ok(Math.max(...delays) <= MAX_TIMER_MS);
});

test("the real default sleep arms a capped setTimeout", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([res(500)]);
  // Wrap the global timer: sleeps armed from `defaultSleep` are
  // recorded and fired immediately (a sleep resolving early is
  // harmless for the schedule assertion); every other timer —
  // including the per-attempt timeout armed by `postOnce` — passes
  // through untouched.
  const armed: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const wrapped = (
    cb: (...args: any[]) => void,
    ms?: number,
    ...args: any[]
  ) => {
    const stack = new Error().stack ?? "";
    if (stack.includes("defaultSleep")) {
      armed.push(ms ?? 0);
      cb(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return ms === undefined
      ? realSetTimeout(cb, ...args)
      : realSetTimeout(cb, ms, ...args);
  };
  globalThis.setTimeout = wrapped as typeof setTimeout;
  try {
    const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
      fetchImpl,
      // No sleepImpl: the real default sleep runs.
      backoffMs: 60_000,
      maxAttempts: 18,
      jitterMs: 0,
    });
    assert.deepEqual(result, {
      ok: false,
      attempts: 18,
      status: 500,
      error: "server responded with status 500",
    });
    const expected = Array.from({ length: 17 }, (_, i) =>
      Math.min(60_000 * 2 ** i, MAX_TIMER_MS),
    );
    assert.deepEqual(armed, expected);
    assert.equal(armed[16], MAX_TIMER_MS);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
