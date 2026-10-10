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
 * Payout webhook delivery external `AbortSignal` support (backlog
 * #160): the dataquest-side peer of escrow's `deliverSettlementWebhook`
 * signal (#115-era), adapted to this repo's "delivery outcomes are
 * reported, never thrown" convention.
 *
 * Rules under test:
 *  - a pre-aborted signal makes ZERO fetch calls and reports
 *    `{ ok: false, attempts: 0, error: "payout webhook delivery aborted" }`
 *  - aborting during the backoff sleep (plain backoff or a clamped
 *    `Retry-After` wait) starts no new attempt and reports the attempts
 *    actually made
 *  - aborting an in-flight request reports the abort at once (never
 *    retried, never confused with the per-attempt timeout)
 *  - a non-`AbortSignal` value is a caller configuration error: it
 *    throws `cannot deliver payout webhook: …` before any request
 *  - a signal that never aborts leaves the pre-#160 behavior untouched
 *  - `deliverPayoutWebhookToMany` passes the call-level signal through
 *    to every endpoint, and a per-endpoint `signal` overrides it
 *
 * Every test injects `fetchImpl`/`sleepImpl`: no real network, and the
 * in-flight stubs honor `init.signal` exactly like real `fetch` does.
 */

const SECRET = "whsec_test_payout_abort_20261010";
const HOOK_URL = "https://accounting.example.com/hooks/payout";
const ABORTED = "payout webhook delivery aborted";

/** Drive a task from DRAFT all the way to PAID. */
function goldenTask(): TaskLifecycle {
  const t = new TaskLifecycle("task-abort-signal");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-abort-1",
    payoutAmount: 4200,
  });
  return t;
}

function goldenWebhook(): PayoutWebhook {
  return buildPayoutWebhook(goldenTask(), SECRET, {
    eventId: "evt-abort-1",
    now: new Date("2026-10-10T00:00:00.000Z"),
  });
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

const res = (status: number, headers?: Record<string, string>) =>
  new Response("{}", { status, headers });

/** A fetch stub that answers from a script (last entry repeats). */
function stubFetch(script: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    return new Response(step.body, {
      status: step.status,
      headers: step.headers,
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * A fetch stub whose request never completes on its own: it settles
 * only when the composed per-attempt signal it receives aborts, exactly
 * like a real `fetch` against a server that never responds.
 */
function hangingFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return await new Promise<Response>((_resolve, reject) => {
      const sig = init.signal;
      if (sig?.aborted) {
        reject(new Error("The operation was aborted"));
        return;
      }
      sig?.addEventListener(
        "abort",
        () => reject(new Error("The operation was aborted")),
        { once: true },
      );
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** First call answers 500; every later call hangs until aborted. */
function failThenHangFetch(): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (calls.length === 1) return res(500);
    return await new Promise<Response>((_resolve, reject) => {
      const sig = init.signal;
      if (sig?.aborted) {
        reject(new Error("The operation was aborted"));
        return;
      }
      sig?.addEventListener(
        "abort",
        () => reject(new Error("The operation was aborted")),
        { once: true },
      );
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A sleep stub that records delays and resolves immediately. */
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

/** A sleep stub that records the delay and then never resolves. */
function hangingSleep(): {
  sleepImpl: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleepImpl: (ms: number) => {
      delays.push(ms);
      return new Promise<void>(() => {});
    },
  };
}

/** Fire `controller.abort()` after `ms`. */
function abortAfter(controller: AbortController, ms: number): void {
  setTimeout(() => controller.abort(), ms);
}

test("pre-aborted signal reports attempts: 0 with zero fetch calls", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([res(200)]);
  const { sleepImpl } = stubSleep();
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    signal: controller.signal,
  });
  assert.deepEqual(result, { ok: false, attempts: 0, error: ABORTED });
  assert.equal(calls.length, 0, "no request may be made after a pre-abort");
  assert.ok(Date.now() - started < 2000, "pre-abort must fail fast");
});

test("abort during the backoff sleep starts no new attempt", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([res(500)]);
  const { sleepImpl, delays } = hangingSleep();
  const controller = new AbortController();
  const started = Date.now();
  abortAfter(controller, 20);
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    // Without the abort this sleep (30s before retry 1) never resolves.
    backoffMs: 30_000,
    maxAttempts: 3,
    signal: controller.signal,
  });
  assert.deepEqual(result, {
    ok: false,
    attempts: 1,
    status: 500,
    error: ABORTED,
  });
  assert.equal(calls.length, 1, "only the initial attempt went out");
  assert.deepEqual(delays, [30_000], "the backoff sleep was entered once");
  assert.ok(
    Date.now() - started < 5000,
    "abort must cut the pending backoff short",
  );
});

test("abort during a Retry-After wait stops the loop", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([
    res(429, { "Retry-After": "30" }),
    res(200),
  ]);
  const { sleepImpl, delays } = hangingSleep();
  const controller = new AbortController();
  const started = Date.now();
  abortAfter(controller, 20);
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 10,
    maxAttempts: 3,
    signal: controller.signal,
  });
  assert.deepEqual(result, {
    ok: false,
    attempts: 1,
    status: 429,
    error: ABORTED,
  });
  assert.equal(calls.length, 1, "the Retry-After wait must be interruptible");
  assert.deepEqual(delays, [30_000], "the clamped hint was the sleep entered");
  assert.ok(Date.now() - started < 5000, "the 30s hint must not be waited out");
});

test("abort during an in-flight request is reported, not retried", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = hangingFetch();
  const { sleepImpl } = stubSleep();
  const controller = new AbortController();
  const started = Date.now();
  abortAfter(controller, 20);
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    // Without the abort the 30s per-attempt timeout would fire instead.
    timeoutMs: 30_000,
    maxAttempts: 3,
    signal: controller.signal,
  });
  assert.deepEqual(result, { ok: false, attempts: 1, error: ABORTED });
  assert.equal(
    calls.length,
    1,
    "the abort must not be treated as a retryable network error",
  );
  assert.ok(
    Date.now() - started < 5000,
    "abort must win over the 30s timeout",
  );
});

test("abort on a retry attempt reports the attempts actually made", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = failThenHangFetch();
  const { sleepImpl, delays } = stubSleep();
  const controller = new AbortController();
  abortAfter(controller, 80);
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 5,
    timeoutMs: 30_000,
    maxAttempts: 3,
    signal: controller.signal,
  });
  assert.deepEqual(result, { ok: false, attempts: 2, error: ABORTED });
  assert.equal(
    calls.length,
    2,
    "the first (failed) attempt stands; the in-flight retry is aborted, not retried",
  );
  assert.deepEqual(delays, [5], "one backoff sleep ran to completion");
});

test("non-AbortSignal values are config errors before any request", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([res(200)]);
  const { sleepImpl } = stubSleep();
  for (const bad of [{}, "x", null, 123]) {
    await assert.rejects(
      () =>
        deliverPayoutWebhook(HOOK_URL, webhook, {
          fetchImpl,
          sleepImpl,
          signal: bad as unknown as AbortSignal,
        }),
      /cannot deliver payout webhook: signal must be an AbortSignal/,
      `expected a config error for signal=${String(bad)}`,
    );
  }
  assert.equal(calls.length, 0, "a bad signal must fail before any request");
});

test("a signal that never aborts leaves success and retry behavior unchanged", async () => {
  const webhook = goldenWebhook();
  const controller = new AbortController();

  const okRun = stubFetch([res(200)]);
  const okSleep = stubSleep();
  const okResult = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl: okRun.fetchImpl,
    sleepImpl: okSleep.sleepImpl,
    signal: controller.signal,
  });
  assert.deepEqual(okResult, { ok: true, attempts: 1, status: 200 });
  assert.equal(okRun.calls.length, 1);
  assert.deepEqual(okSleep.delays, []);

  const retryRun = stubFetch([res(500), res(200)]);
  const retrySleep = stubSleep();
  const retryResult = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl: retryRun.fetchImpl,
    sleepImpl: retrySleep.sleepImpl,
    backoffMs: 10,
    signal: controller.signal,
  });
  assert.deepEqual(retryResult, { ok: true, attempts: 2, status: 200 });
  assert.equal(retryRun.calls.length, 2);
  assert.deepEqual(retrySleep.delays, [10], "the usual backoff schedule ran");
});

test("fan-out passes the call-level signal through to every endpoint", async () => {
  const task = goldenTask();
  const { fetchImpl, calls } = stubFetch([res(200)]);
  const { sleepImpl } = stubSleep();
  const controller = new AbortController();
  controller.abort();
  const out = await deliverPayoutWebhookToMany(
    task,
    [
      { url: "https://billing.example.com/hooks/payout", secret: SECRET },
      { url: "https://risk.example.com/hooks/payout", secret: SECRET },
    ],
    { fetchImpl, sleepImpl, signal: controller.signal },
  );
  assert.deepEqual(out.results, [
    { ok: false, attempts: 0, error: ABORTED },
    { ok: false, attempts: 0, error: ABORTED },
  ]);
  assert.equal(out.delivered, 0);
  assert.equal(out.failed, 2);
  assert.equal(calls.length, 0, "a pre-aborted shared signal fetches nowhere");
});

test("fan-out per-endpoint signal overrides the call-level signal", async () => {
  const task = goldenTask();
  const { fetchImpl, calls } = stubFetch([res(200)]);
  const { sleepImpl } = stubSleep();
  const endpointController = new AbortController();
  endpointController.abort();
  const out = await deliverPayoutWebhookToMany(
    task,
    [
      {
        url: "https://billing.example.com/hooks/payout",
        secret: SECRET,
        signal: endpointController.signal,
      },
      { url: "https://risk.example.com/hooks/payout", secret: SECRET },
    ],
    { fetchImpl, sleepImpl },
  );
  assert.deepEqual(out.results[0], {
    ok: false,
    attempts: 0,
    error: ABORTED,
  });
  assert.deepEqual(out.results[1], { ok: true, attempts: 1, status: 200 });
  assert.equal(out.delivered, 1);
  assert.equal(out.failed, 1);
  assert.equal(calls.length, 1, "only the un-aborted endpoint was fetched");
  assert.equal(calls[0].url, "https://risk.example.com/hooks/payout");
});
