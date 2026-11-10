import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  deliverPayoutWebhookToMany,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook fan-out concurrency cap (backlog #1033, mirrors
 * escrow #1032): `DeliverPayoutWebhookToManyOptions.maxConcurrency`.
 *
 * Rules under test:
 *  - maxConcurrency bounds the in-flight deliveries: with a cap of 2
 *    over 5 endpoints the in-flight peak is exactly 2; with a cap of
 *    1 deliveries run strictly serially, in endpoint order
 *  - unset, the behaviour is unchanged: every endpoint starts at once
 *    (peak equals the endpoint count); a cap larger than the endpoint
 *    count behaves the same way
 *  - invalid caps (0, negative, non-integer, NaN, non-number) throw a
 *    caller configuration error before any request (zero fetch calls)
 *  - the deadline still aborts in-flight deliveries under a cap, and
 *    endpoints that have not started when the deadline fires are
 *    reported as deadline failures with 0 attempts and no request made
 *  - a slow endpoint does not serialize the fast ones behind it, and
 *    results stay in endpoint order
 *  - one endpoint failing (500) never blocks the pool's other
 *    endpoints
 *  - maxEndpoints and maxConcurrency compose: exceeding the endpoint
 *    cap throws before any request, whatever the concurrency cap is
 *  - every test uses an injected fetch stub: zero network
 */

const SECRET_A = "whsec_fanout_concurrency_billing_20261110";
const SECRET_B = "whsec_fanout_concurrency_risk_20261110";
const SECRET_C = "whsec_fanout_concurrency_notify_20261110";
const SECRET_D = "whsec_fanout_concurrency_audit_20261110";
const SECRET_E = "whsec_fanout_concurrency_archive_20261110";
const NOW = new Date("2026-11-10T19:28:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-concurrency"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-concurrency-1",
    payoutAmount: 4200,
  });
  return t;
}

function endpointUrls(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `https://endpoint-${i}.example.com/hooks/payout`,
  );
}

const SECRETS = [SECRET_A, SECRET_B, SECRET_C, SECRET_D, SECRET_E];

function endpoints(n: number): { url: string; secret: string }[] {
  return endpointUrls(n).map((url, i) => ({ url, secret: SECRETS[i] }));
}

interface EndpointBehaviour {
  /** Milliseconds before the stub answers. */
  delayMs: number;
  /** HTTP status to answer with. */
  status: number;
}

interface CountingFetch {
  fetchImpl: PayoutWebhookFetchImpl;
  /** URLs in the order fetch was called. */
  calls: string[];
  /** In-flight peak over the whole call. */
  peak: () => number;
  startedAt: Map<string, number>;
  finishedAt: Map<string, number>;
}

/**
 * A stub transport that records concurrency: every call bumps the
 * in-flight count (and the peak) until it resolves or its signal
 * aborts. Per-URL behaviour comes from `byUrl` (default: 0ms, 200).
 */
function makeCountingFetch(
  byUrl: Map<string, EndpointBehaviour>,
): CountingFetch {
  const calls: string[] = [];
  const startedAt = new Map<string, number>();
  const finishedAt = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: PayoutWebhookFetchImpl = (url, init) => {
    calls.push(url);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    startedAt.set(url, Date.now());
    const behaviour = byUrl.get(url) ?? { delayMs: 0, status: 200 };
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        inFlight -= 1;
        finishedAt.set(url, Date.now());
        resolve(new Response("{}", { status: behaviour.status }));
      }, behaviour.delayMs);
      const signal = init.signal;
      const onAbort = () => {
        clearTimeout(timer);
        inFlight -= 1;
        reject(new Error("aborted"));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  };
  return {
    fetchImpl,
    calls,
    peak: () => peak,
    startedAt,
    finishedAt,
  };
}

const noSleep = async () => {};

const BASE_OPTS = {
  backoffMs: 1,
  maxAttempts: 1,
  sleepImpl: noSleep,
  now: NOW,
  eventId: "evt-fanout-concurrency-1",
} as const;

test("maxConcurrency=2 caps the in-flight peak at exactly 2 over 5 endpoints", async () => {
  const urls = endpointUrls(5);
  const byUrl = new Map(
    urls.map((url) => [url, { delayMs: 40, status: 200 }]),
  );
  const counting = makeCountingFetch(byUrl);
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    endpoints(5),
    { ...BASE_OPTS, fetchImpl: counting.fetchImpl, maxConcurrency: 2 },
  );
  assert.equal(counting.peak(), 2);
  assert.equal(counting.calls.length, 5);
  assert.deepEqual(counting.calls.slice().sort(), urls.slice().sort());
  assert.equal(out.delivered, 5);
  assert.equal(out.failed, 0);
  assert.equal(out.deadlineExceeded, false);
  assert.ok(out.results.every((r) => r.ok && r.attempts === 1));
  assert.deepEqual(out.results, [
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
});

test("maxConcurrency=1 runs strictly serially, in endpoint order", async () => {
  const urls = endpointUrls(5);
  const byUrl = new Map(
    urls.map((url) => [url, { delayMs: 20, status: 200 }]),
  );
  const counting = makeCountingFetch(byUrl);
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    endpoints(5),
    { ...BASE_OPTS, fetchImpl: counting.fetchImpl, maxConcurrency: 1 },
  );
  assert.equal(counting.peak(), 1);
  assert.deepEqual(counting.calls, urls);
  assert.equal(out.delivered, 5);
  assert.equal(out.failed, 0);
});

test("maxConcurrency unset keeps full concurrency: peak equals the endpoint count", async () => {
  const urls = endpointUrls(5);
  const byUrl = new Map(
    urls.map((url) => [url, { delayMs: 40, status: 200 }]),
  );
  const counting = makeCountingFetch(byUrl);
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    endpoints(5),
    { ...BASE_OPTS, fetchImpl: counting.fetchImpl },
  );
  assert.equal(counting.peak(), 5);
  assert.equal(counting.calls.length, 5);
  assert.equal(out.delivered, 5);
  assert.equal(out.failed, 0);
});

test("maxConcurrency above the endpoint count behaves like unbounded", async () => {
  const urls = endpointUrls(3);
  const byUrl = new Map(
    urls.map((url) => [url, { delayMs: 40, status: 200 }]),
  );
  const counting = makeCountingFetch(byUrl);
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    endpoints(3),
    { ...BASE_OPTS, fetchImpl: counting.fetchImpl, maxConcurrency: 10 },
  );
  assert.equal(counting.peak(), 3);
  assert.equal(out.delivered, 3);
  assert.equal(out.failed, 0);
});

test("invalid maxConcurrency values throw before any request", async () => {
  const urls = endpointUrls(1);
  const counting = makeCountingFetch(
    new Map(urls.map((url) => [url, { delayMs: 0, status: 200 }])),
  );
  for (const bad of [0, -1, 1.5, Number.NaN, "2"]) {
    await assert.rejects(
      () =>
        deliverPayoutWebhookToMany(paidTask(), endpoints(1), {
          ...BASE_OPTS,
          fetchImpl: counting.fetchImpl,
          maxConcurrency: bad as unknown as number,
        }),
      /cannot deliver payout webhook to many endpoints: maxConcurrency must be a positive integer/,
    );
  }
  assert.equal(counting.calls.length, 0);
});

test("deadline under a cap aborts the in-flight endpoint and reports queued endpoints without a request", async () => {
  const urls = endpointUrls(3);
  const byUrl = new Map([
    // First endpoint hangs until its signal aborts; the other two
    // would answer fast, but the deadline fires before the pool
    // reaches them.
    [urls[0], { delayMs: 60_000, status: 200 }],
    [urls[1], { delayMs: 0, status: 200 }],
    [urls[2], { delayMs: 0, status: 200 }],
  ]);
  const counting = makeCountingFetch(byUrl);
  const started = Date.now();
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    endpoints(3),
    {
      ...BASE_OPTS,
      fetchImpl: counting.fetchImpl,
      maxConcurrency: 1,
      timeoutMs: 10_000,
      overallDeadlineMs: 100,
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 5000,
    `deadline must stop the call, not the 60s hang (elapsed ${elapsed}ms)`,
  );
  assert.deepEqual(out.results[0], {
    ok: false,
    attempts: 1,
    error:
      "payout webhook delivery timed out: overall deadline of 100ms exceeded",
  });
  // Queued endpoints were never started: deadline failure, 0 attempts.
  assert.deepEqual(out.results[1], {
    ok: false,
    attempts: 0,
    error:
      "payout webhook delivery timed out: overall deadline of 100ms exceeded",
  });
  assert.deepEqual(out.results[2], {
    ok: false,
    attempts: 0,
    error:
      "payout webhook delivery timed out: overall deadline of 100ms exceeded",
  });
  assert.equal(out.delivered, 0);
  assert.equal(out.failed, 3);
  assert.equal(out.deadlineExceeded, true);
  assert.deepEqual(counting.calls, [urls[0]]);
});

test("a slow endpoint does not serialize the fast ones behind it, results stay in endpoint order", async () => {
  const urls = endpointUrls(3);
  const byUrl = new Map([
    [urls[0], { delayMs: 150, status: 200 }],
    [urls[1], { delayMs: 10, status: 200 }],
    [urls[2], { delayMs: 10, status: 200 }],
  ]);
  const counting = makeCountingFetch(byUrl);
  const started = Date.now();
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    endpoints(3),
    { ...BASE_OPTS, fetchImpl: counting.fetchImpl, maxConcurrency: 2 },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 1000,
    `the fast endpoints must not queue behind the slow one (elapsed ${elapsed}ms)`,
  );
  assert.deepEqual(out.results, [
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
  assert.ok(out.results.every((r) => r.ok && r.attempts === 1));
  // The third endpoint finished before the slow first one did: it
  // started as soon as the second finished, not after the first.
  const slowFinishedAt = counting.finishedAt.get(urls[0]) ?? 0;
  const thirdFinishedAt = counting.finishedAt.get(urls[2]) ?? 0;
  assert.ok(
    thirdFinishedAt < slowFinishedAt,
    "third endpoint must finish before the slow first endpoint",
  );
});

test("one endpoint failing with 500 never blocks the pool's other endpoints", async () => {
  const urls = endpointUrls(3);
  const byUrl = new Map([
    [urls[0], { delayMs: 0, status: 200 }],
    [urls[1], { delayMs: 0, status: 500 }],
    [urls[2], { delayMs: 0, status: 200 }],
  ]);
  const counting = makeCountingFetch(byUrl);
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    endpoints(3),
    { ...BASE_OPTS, fetchImpl: counting.fetchImpl, maxConcurrency: 1 },
  );
  assert.equal(counting.calls.length, 3);
  assert.deepEqual(counting.calls, urls);
  assert.deepEqual(out.results[0], {
    ok: true,
    attempts: 1,
    status: 200,
  });
  assert.deepEqual(out.results[1], {
    ok: false,
    attempts: 1,
    status: 500,
    error: "server responded with status 500",
  });
  assert.deepEqual(out.results[2], {
    ok: true,
    attempts: 1,
    status: 200,
  });
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 1);
});

test("maxEndpoints and maxConcurrency compose: exceeding the endpoint cap throws before any request", async () => {
  const urls = endpointUrls(3);
  const counting = makeCountingFetch(
    new Map(urls.map((url) => [url, { delayMs: 0, status: 200 }])),
  );
  await assert.rejects(
    () =>
      deliverPayoutWebhookToMany(paidTask(), endpoints(3), {
        ...BASE_OPTS,
        fetchImpl: counting.fetchImpl,
        maxEndpoints: 2,
        maxConcurrency: 1,
      }),
    /cannot deliver payout webhook to many endpoints: 3 endpoints exceed maxEndpoints 2/,
  );
  assert.equal(counting.calls.length, 0);
});
