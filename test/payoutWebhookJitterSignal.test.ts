import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
} from "../src/index.js";
import type { PayoutWebhook } from "../src/index.js";

/**
 * Payout webhook delivery `jitterMs` x `signal` orthogonal coverage
 * (backlog #666).
 *
 * The two features were tested in isolation — `payoutWebhookJitter`
 * never passed a `signal`, and `payoutWebhookAbortSignal` never set
 * `jitterMs` — so the combination had no test backing: an abort that
 * lands inside a *jittered* backoff sleep must still cut the wait short
 * and report the abort faithfully, and a signal that never aborts must
 * leave the jittered retry schedule untouched.
 *
 * Rules under test:
 *  - a pre-aborted signal with `jitterMs` set makes ZERO fetch calls
 *    and reports `{ ok: false, attempts: 0, error: ABORTED }`
 *  - aborting inside the first jittered backoff sleep (5xx path)
 *    starts no new attempt, reports the attempts actually made with
 *    the last status, and the sleep entered really was a jittered
 *    wait inside `[backoff, backoff + jitterMs]`
 *  - aborting inside the second jittered backoff sleep reports
 *    attempts 2 (both waits jittered, second window checked)
 *  - aborting inside a jittered sleep after a network error reports
 *    the abort with no status field (network failures carry none)
 *  - an abort during a long jittered wait reports the abort wording,
 *    never a timeout wording, and cuts the wait short (fail-fast
 *    bound, not a trigger)
 *  - a signal that never aborts leaves the jittered retry schedule
 *    exactly as the jitter-only tests pin it
 *
 * Deterministic abort triggers (same de-racing treatment as the
 * abort-signal tests, backlog #193): every abort fires from inside the
 * injected `sleepImpl`, whose invocation proves the delivery is in the
 * wait under test. No `setTimeout` guessing, no wall-clock racing.
 * Wall clock survives only as loose upper-bound assertions.
 */

const SECRET = "whsec_test_payout_jitter_signal_20261028";
const HOOK_URL = "https://accounting.example.com/hooks/payout";
const ABORTED = "payout webhook delivery aborted";

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-jitter-signal"): TaskLifecycle {
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
    payoutRef: "xfer-jitter-signal-1",
    payoutAmount: 4200,
  });
  return t;
}

function goldenWebhook(): PayoutWebhook {
  return buildPayoutWebhook(paidTask(), SECRET, {
    eventId: "evt-jitter-signal-1",
    now: new Date("2026-10-28T00:00:00.000Z"),
  });
}

const res = (status: number, headers?: Record<string, string>) =>
  new Response("{}", { status, headers });

/** A fetch stub driven by a script of responses/errors. */
function stubFetch(script: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  calls: number;
} {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    state.calls += 1;
    const step = script[Math.min(state.calls - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    return new Response(step.body, { status: step.status, headers: step.headers });
  }) as typeof fetch;
  return {
    fetchImpl,
    get calls() {
      return state.calls;
    },
  };
}

/**
 * A sleep stub that records delays and resolves immediately — except
 * on the `abortOnCall`-th invocation (1-based), where it aborts the
 * controller the moment the sleep is entered and then never resolves.
 * The delivery's abort listener is registered before the sleep is
 * invoked, so the abort fired here still wins the race
 * deterministically; the never-resolving promise only proves the abort
 * (not a completed wait) is what ends the delivery.
 */
function abortingSleep(
  controller: AbortController,
  abortOnCall: number,
): {
  sleepImpl: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  let calls = 0;
  return {
    delays,
    sleepImpl: (ms: number) => {
      delays.push(ms);
      calls += 1;
      if (calls === abortOnCall) {
        controller.abort();
        return new Promise<void>(() => {});
      }
      return Promise.resolve();
    },
  };
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

test("pre-aborted signal with jitterMs set makes zero fetch calls", async () => {
  const webhook = goldenWebhook();
  const fetch = stubFetch([res(200)]);
  const { sleepImpl } = stubSleep();
  const controller = new AbortController();
  controller.abort();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl: fetch.fetchImpl,
    sleepImpl,
    jitterMs: 1000,
    signal: controller.signal,
  });
  assert.deepEqual(result, { ok: false, attempts: 0, error: ABORTED });
  assert.equal(fetch.calls, 0, "a pre-abort must fetch nowhere, jitter or not");
});

test("abort inside the first jittered backoff sleep starts no new attempt", async () => {
  const webhook = goldenWebhook();
  const fetch = stubFetch([res(500), res(200)]);
  const controller = new AbortController();
  const { sleepImpl, delays } = abortingSleep(controller, 1);
  const started = Date.now();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl: fetch.fetchImpl,
    sleepImpl,
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
    signal: controller.signal,
  });
  assert.deepEqual(result, {
    ok: false,
    attempts: 1,
    status: 500,
    error: ABORTED,
  });
  assert.equal(fetch.calls, 1, "only the initial attempt went out");
  assert.equal(delays.length, 1, "exactly one jittered wait was entered");
  assert.ok(
    delays[0] >= 100 && delays[0] <= 1100,
    `jittered wait ${delays[0]} outside [100, 1100] — the sleep entered was not a jittered backoff`,
  );
  assert.ok(
    Date.now() - started < 5000,
    "abort must cut the pending jittered wait short",
  );
});

test("abort inside the second jittered backoff sleep reports attempts 2", async () => {
  const webhook = goldenWebhook();
  const fetch = stubFetch([res(500), res(500), res(200)]);
  const controller = new AbortController();
  const { sleepImpl, delays } = abortingSleep(controller, 2);
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl: fetch.fetchImpl,
    sleepImpl,
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
    signal: controller.signal,
  });
  assert.deepEqual(result, {
    ok: false,
    attempts: 2,
    status: 500,
    error: ABORTED,
  });
  assert.equal(fetch.calls, 2, "the aborted retry was never started");
  assert.equal(delays.length, 2, "both jittered waits were entered");
  assert.ok(delays[0] >= 100 && delays[0] <= 1100, `first wait ${delays[0]} outside [100, 1100]`);
  assert.ok(delays[1] >= 200 && delays[1] <= 1200, `second wait ${delays[1]} outside [200, 1200]`);
});

test("abort inside a jittered sleep after a network error reports no status", async () => {
  const webhook = goldenWebhook();
  const fetch = stubFetch([new Error("socket hang up"), res(200)]);
  const controller = new AbortController();
  const { sleepImpl, delays } = abortingSleep(controller, 1);
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl: fetch.fetchImpl,
    sleepImpl,
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
    signal: controller.signal,
  });
  // Network failures carry no status: the abort result must not invent one.
  assert.deepEqual(result, { ok: false, attempts: 1, error: ABORTED });
  assert.equal(fetch.calls, 1, "no retry was started after the abort");
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 100 && delays[0] <= 1100, `jittered wait ${delays[0]} outside [100, 1100]`);
});

test("abort during a long jittered wait reports abort wording, never timeout wording", async () => {
  const webhook = goldenWebhook();
  const fetch = stubFetch([res(500), res(200)]);
  const controller = new AbortController();
  const { sleepImpl, delays } = abortingSleep(controller, 1);
  const started = Date.now();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl: fetch.fetchImpl,
    sleepImpl,
    backoffMs: 100,
    jitterMs: 30000,
    maxAttempts: 3,
    // A long per-attempt timeout: if the abort were misattributed, the
    // timeout wording would be the plausible wrong answer.
    timeoutMs: 30000,
    signal: controller.signal,
  });
  assert.equal(result.error, ABORTED, "the abort must be reported as an abort");
  assert.ok(
    !result.error!.includes("timed out"),
    `abort during a jittered wait must not be reported as a timeout, got: ${result.error}`,
  );
  assert.deepEqual(result, {
    ok: false,
    attempts: 1,
    status: 500,
    error: ABORTED,
  });
  assert.equal(fetch.calls, 1);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 100 && delays[0] <= 30100, `jittered wait ${delays[0]} outside [100, 30100]`);
  assert.ok(
    Date.now() - started < 5000,
    "abort must cut a potentially 30s jittered wait short",
  );
});

test("a signal that never aborts leaves the jittered retry schedule untouched", async () => {
  const webhook = goldenWebhook();
  const fetch = stubFetch([res(500), res(500), res(200)]);
  const { sleepImpl, delays } = stubSleep();
  const controller = new AbortController();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl: fetch.fetchImpl,
    sleepImpl,
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
    signal: controller.signal,
  });
  assert.deepEqual(result, { ok: true, attempts: 3, status: 200 });
  assert.equal(fetch.calls, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays[0] >= 100 && delays[0] <= 1100, `first wait ${delays[0]} outside [100, 1100]`);
  assert.ok(delays[1] >= 200 && delays[1] <= 1200, `second wait ${delays[1]} outside [200, 1200]`);
});
