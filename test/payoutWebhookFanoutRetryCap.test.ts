import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  deliverPayoutWebhookToMany,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook fan-out x Retry-After cap (backlog #704).
 *
 * Gap under test: fan-out (`payoutWebhookFanout.test.ts` /
 * `payoutWebhookFanoutLimits.test.ts`) and the single-endpoint
 * `maxRetryDelayMs` cap (`payoutWebhookDelivery.test.ts`) each had
 * coverage, but no test pinned that the cap survives the fan-out
 * path — if `deliverPayoutWebhookToMany` dropped the option, a
 * malicious `Retry-After` could stall a batch delivery.
 *
 * Rules under test:
 *  - a 429 `Retry-After: 30` on one fan-out endpoint is clamped to
 *    the call-level `maxRetryDelayMs` (not 30 seconds) before its
 *    retry, while the sibling endpoint is unaffected
 *  - a non-429 (500) response carrying a `Retry-After` header does
 *    NOT take the hint: it falls back to exponential backoff, the
 *    same rule as the single-endpoint path
 *  - every test injects fetch/sleep stubs: no real network, no real
 *    sleeps
 */

const SECRET_A = "whsec_fanout_retrycap_billing_20261029";
const SECRET_B = "whsec_fanout_retrycap_risk_20261029";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const NOW = new Date("2026-10-29T00:00:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-retrycap"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-retrycap-1",
    payoutAmount: 4200,
  });
  return t;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/**
 * A fetch stub routing by URL: each URL has its own script of
 * responses (the last entry repeats once exhausted), and every call
 * is recorded per URL so per-endpoint attempt counts are exact.
 */
function routerFetch(scripts: Record<string, Response[]>): {
  fetchImpl: PayoutWebhookFetchImpl;
  callsTo: (url: string) => RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const seen = new Map<string, number>();
  const fetchImpl: PayoutWebhookFetchImpl = async (url, init) => {
    calls.push({ url, init });
    const script = scripts[url];
    assert.ok(script, `unexpected fetch to ${url}`);
    const n = seen.get(url) ?? 0;
    seen.set(url, n + 1);
    const step = script[Math.min(n, script.length - 1)];
    // Fresh Response per call: a Response body can only be consumed once.
    return new Response(step.body, { status: step.status, headers: step.headers });
  };
  return { fetchImpl, callsTo: (u) => calls.filter((c) => c.url === u) };
}

const res = (status: number, headers?: Record<string, string>) =>
  new Response("{}", { status, headers });

/** A sleep stub that records the requested delays instead of sleeping. */
function recordingSleep(): {
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

test("fan-out 429 Retry-After: 30 is clamped to the call-level maxRetryDelayMs; sibling endpoint unaffected", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(429, { "retry-after": "30" }), res(200)],
    [URL_B]: [res(200)],
  });
  const { sleepImpl, delays } = recordingSleep();
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    {
      fetchImpl,
      sleepImpl,
      now: NOW,
      eventId: "evt-fanout-retrycap-1",
      maxRetryDelayMs: 5000,
      backoffMs: 100,
    },
  );
  assert.deepEqual(out.results, [
    { ok: true, attempts: 2, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 0);
  assert.equal(callsTo(URL_A).length, 2, "429 endpoint retried once");
  assert.equal(callsTo(URL_B).length, 1, "healthy endpoint was not retried");
  // The 30s hint is honored only up to the call-level cap — and the
  // sibling endpoint contributed no sleep at all.
  assert.deepEqual(delays, [5000]);
  // Same logical event across the fan-out.
  assert.equal(
    JSON.parse(String(callsTo(URL_A)[0].init.body)).eventId,
    "evt-fanout-retrycap-1",
  );
  assert.equal(
    JSON.parse(String(callsTo(URL_B)[0].init.body)).eventId,
    "evt-fanout-retrycap-1",
  );
});

test("fan-out 500 carrying Retry-After does not take the hint: it falls back to exponential backoff", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500, { "retry-after": "30" }), res(200)],
    [URL_B]: [res(200)],
  });
  const { sleepImpl, delays } = recordingSleep();
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    {
      fetchImpl,
      sleepImpl,
      now: NOW,
      eventId: "evt-fanout-retrycap-500",
      maxRetryDelayMs: 5000,
      backoffMs: 100,
    },
  );
  assert.deepEqual(out.results, [
    { ok: true, attempts: 2, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
  assert.equal(out.delivered, 2);
  assert.equal(callsTo(URL_A).length, 2);
  assert.equal(callsTo(URL_B).length, 1);
  // Had the 500's hint been honored, the delay would have been the
  // clamped 5000 ms; the backoff (100 ms) proves it was ignored.
  assert.deepEqual(delays, [100]);
});
