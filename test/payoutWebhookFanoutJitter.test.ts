import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook fan-out x jitterMs combination (backlog #714).
 *
 * The single-endpoint jitter path is covered by
 * `test/payoutWebhookJitter.test.ts`, and the fan-out path by
 * `test/payoutWebhookFanout*.test.ts` — but no fan-out test touched
 * jitter at all (`grep jitter` over the fan-out files was empty).
 * This file pins the combination: the call-level and per-endpoint
 * `jitterMs` values that `deliverPayoutWebhookToMany` forwards to
 * each endpoint's delivery actually spread that endpoint's retries,
 * without the endpoints' retry schedules leaking into each other.
 *
 * Rules under test:
 *  - call-level `jitterMs` spreads every endpoint's backoff waits
 *    into `[backoff, backoff + jitterMs]` per attempt
 *    (500/500/200 per endpoint, all four succeed)
 *  - `jitterMs: 0` keeps the pure exponential schedule on every
 *    fan-out endpoint
 *  - a per-endpoint `jitterMs` overrides the call-level value
 *    (in both directions: 0 cancels it, a larger value widens it)
 *  - sleep records stay per endpoint and never cross-wire: each
 *    endpoint's recorded delays are exactly its own schedule, even
 *    when the endpoints run with different backoffs
 *  - the jittered fan-out is still one logical event: every
 *    endpoint receives the same shared `eventId` (and identical
 *    payload bytes), signed with its own secret
 *  - one endpoint's jittered retries never consume a sibling's
 *    budget or delay it
 *  - every test injects fetch/sleep stubs: no real network, and
 *    the exact delay schedule is asserted instead of really sleeping
 */

const SECRET_A = "whsec_fanout_jitter_billing_20261029";
const SECRET_B = "whsec_fanout_jitter_risk_20261029";
const SECRET_C = "whsec_fanout_jitter_notify_20261029";
const SECRET_D = "whsec_fanout_jitter_ledger_20261029";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const URL_C = "https://notify.example.com/hooks/payout";
const URL_D = "https://ledger.example.com/hooks/payout";
const NOW = new Date("2026-10-29T00:00:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-jitter"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-jitter-1",
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
 * responses/errors (the last entry repeats once exhausted), and every
 * call is recorded per URL so per-endpoint attempt counts are exact.
 */
function routerFetch(scripts: Record<string, Array<Response | Error>>): {
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
    if (step instanceof Error) throw step;
    // Fresh Response per call: a Response body can only be consumed once.
    return new Response(step.body, { status: step.status, headers: step.headers });
  };
  return { fetchImpl, callsTo: (u) => calls.filter((c) => c.url === u) };
}

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

const res = (status: number) => new Response("{}", { status });

function bodyOf(call: RecordedCall): string {
  return String(call.init.body);
}
function signatureOf(call: RecordedCall): string {
  return String(new Headers(call.init.headers).get("x-hub-signature-256"));
}

function inWindow(delay: number, backoff: number, jitter: number): boolean {
  return delay >= backoff && delay <= backoff + jitter;
}

/** Four endpoints, each answering 500/500/200, each with its own sleep recorder. */
function fourEndpoints() {
  const sleeps = [
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
  ];
  const endpoints = [
    { url: URL_A, secret: SECRET_A, sleepImpl: sleeps[0].sleepImpl },
    { url: URL_B, secret: SECRET_B, sleepImpl: sleeps[1].sleepImpl },
    { url: URL_C, secret: SECRET_C, sleepImpl: sleeps[2].sleepImpl },
    { url: URL_D, secret: SECRET_D, sleepImpl: sleeps[3].sleepImpl },
  ];
  return { endpoints, sleeps };
}

test("call-level jitterMs spreads every endpoint's retries inside [backoff, backoff + jitterMs]", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500), res(500), res(200)],
    [URL_B]: [res(500), res(500), res(200)],
    [URL_C]: [res(500), res(500), res(200)],
    [URL_D]: [res(500), res(500), res(200)],
  });
  const { endpoints, sleeps } = fourEndpoints();
  const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
    fetchImpl,
    now: NOW,
    eventId: "evt-fanout-jitter-1",
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
  });
  assert.equal(out.delivered, 4);
  assert.equal(out.failed, 0);
  assert.deepEqual(out.results, [
    { ok: true, attempts: 3, status: 200 },
    { ok: true, attempts: 3, status: 200 },
    { ok: true, attempts: 3, status: 200 },
    { ok: true, attempts: 3, status: 200 },
  ]);
  for (const [i, sleep] of sleeps.entries()) {
    // Exactly two sleeps per endpoint: no record crossed over from a
    // sibling endpoint's concurrent delivery.
    assert.equal(sleep.delays.length, 2, `endpoint ${i} must record exactly its own 2 sleeps`);
    assert.ok(
      inWindow(sleep.delays[0], 100, 1000),
      `endpoint ${i} first delay ${sleep.delays[0]} outside [100, 1100]`,
    );
    assert.ok(
      inWindow(sleep.delays[1], 200, 1000),
      `endpoint ${i} second delay ${sleep.delays[1]} outside [200, 1200]`,
    );
  }
  for (const url of [URL_A, URL_B, URL_C, URL_D]) {
    assert.equal(callsTo(url).length, 3, `${url} must be attempted exactly 3 times`);
  }
});

test("jitterMs 0 keeps the pure exponential schedule on every fan-out endpoint", async () => {
  const { fetchImpl } = routerFetch({
    [URL_A]: [res(500), res(500), res(200)],
    [URL_B]: [res(500), res(500), res(200)],
    [URL_C]: [res(500), res(500), res(200)],
    [URL_D]: [res(500), res(500), res(200)],
  });
  const { endpoints, sleeps } = fourEndpoints();
  const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
    fetchImpl,
    now: NOW,
    backoffMs: 100,
    jitterMs: 0,
    maxAttempts: 3,
  });
  assert.equal(out.delivered, 4);
  for (const [i, sleep] of sleeps.entries()) {
    assert.deepEqual(
      sleep.delays,
      [100, 200],
      `endpoint ${i}: jitterMs 0 must keep the exact 100, 200 schedule`,
    );
  }
});

test("per-endpoint jitterMs overrides the call-level value in both directions", async () => {
  const { fetchImpl } = routerFetch({
    [URL_A]: [res(500), res(500), res(200)],
    [URL_B]: [res(500), res(500), res(200)],
    [URL_C]: [res(500), res(500), res(200)],
    [URL_D]: [res(500), res(500), res(200)],
  });
  const sleeps = [
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
  ];
  const endpoints = [
    // Inherits the call-level 1000.
    { url: URL_A, secret: SECRET_A, sleepImpl: sleeps[0].sleepImpl },
    // 0 cancels the call-level jitter: exact schedule.
    { url: URL_B, secret: SECRET_B, sleepImpl: sleeps[1].sleepImpl, jitterMs: 0 },
    // A wider per-endpoint window wins over the call-level one.
    { url: URL_C, secret: SECRET_C, sleepImpl: sleeps[2].sleepImpl, jitterMs: 2000 },
    // A narrower per-endpoint window wins over the call-level one.
    { url: URL_D, secret: SECRET_D, sleepImpl: sleeps[3].sleepImpl, jitterMs: 500 },
  ];
  const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
    fetchImpl,
    now: NOW,
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
  });
  assert.equal(out.delivered, 4);
  assert.ok(inWindow(sleeps[0].delays[0], 100, 1000), "inherited: first delay in [100, 1100]");
  assert.ok(inWindow(sleeps[0].delays[1], 200, 1000), "inherited: second delay in [200, 1200]");
  assert.deepEqual(sleeps[1].delays, [100, 200], "per-endpoint 0 cancels call-level jitter");
  assert.ok(inWindow(sleeps[2].delays[0], 100, 2000), "wider override: first delay in [100, 2100]");
  assert.ok(inWindow(sleeps[2].delays[1], 200, 2000), "wider override: second delay in [200, 2200]");
  assert.ok(inWindow(sleeps[3].delays[0], 100, 500), "narrower override: first delay in [100, 600]");
  assert.ok(inWindow(sleeps[3].delays[1], 200, 500), "narrower override: second delay in [200, 700]");
});

test("sleep records never cross-wire: distinct per-endpoint backoffs stay distinct", async () => {
  const { fetchImpl } = routerFetch({
    [URL_A]: [res(500), res(500), res(200)],
    [URL_B]: [res(500), res(500), res(200)],
    [URL_C]: [res(500), res(500), res(200)],
    [URL_D]: [res(500), res(500), res(200)],
  });
  const sleeps = [
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
  ];
  // Deliberately different backoffs with jitter 0, so any cross-wiring
  // (a shared recorder, a swapped array) shows up as a wrong exact value.
  const backoffs = [100, 200, 400, 800];
  const urls = [URL_A, URL_B, URL_C, URL_D];
  const secrets = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
  const endpoints = urls.map((url, i) => ({
    url,
    secret: secrets[i],
    sleepImpl: sleeps[i].sleepImpl,
    backoffMs: backoffs[i],
  }));
  const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
    fetchImpl,
    now: NOW,
    jitterMs: 0,
    maxAttempts: 3,
  });
  assert.equal(out.delivered, 4);
  for (const [i, sleep] of sleeps.entries()) {
    assert.deepEqual(
      sleep.delays,
      [backoffs[i], backoffs[i] * 2],
      `endpoint ${i} must record exactly its own backoff schedule`,
    );
  }
});

test("jittered fan-out retries actually spread across runs (not silently ignored)", async () => {
  const observed = new Set<number>();
  for (let run = 0; run < 20; run += 1) {
    const { fetchImpl } = routerFetch({
      [URL_A]: [res(500), res(500), res(200)],
      [URL_B]: [res(500), res(500), res(200)],
      [URL_C]: [res(500), res(500), res(200)],
      [URL_D]: [res(500), res(500), res(200)],
    });
    const { endpoints, sleeps } = fourEndpoints();
    const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
      fetchImpl,
      now: NOW,
      backoffMs: 100,
      jitterMs: 1000,
      maxAttempts: 3,
    });
    assert.equal(out.delivered, 4);
    for (const sleep of sleeps) {
      assert.equal(sleep.delays.length, 2);
      assert.ok(inWindow(sleep.delays[0], 100, 1000));
      assert.ok(inWindow(sleep.delays[1], 200, 1000));
      observed.add(sleep.delays[0]);
      observed.add(sleep.delays[1]);
    }
  }
  assert.ok(
    observed.size > 2,
    "jitter must actually spread the fan-out delays across the window",
  );
});

test("jittered fan-out is still one logical event: shared eventId, per-endpoint signatures", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500), res(500), res(200)],
    [URL_B]: [res(500), res(500), res(200)],
    [URL_C]: [res(500), res(500), res(200)],
    [URL_D]: [res(500), res(500), res(200)],
  });
  const { endpoints } = fourEndpoints();
  const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
    fetchImpl,
    now: NOW,
    eventId: "evt-fanout-jitter-shared",
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
  });
  assert.equal(out.delivered, 4);
  const calls = [URL_A, URL_B, URL_C, URL_D].map((url) => callsTo(url)[0]);
  const bodies = calls.map(bodyOf);
  for (const body of bodies) {
    assert.equal(JSON.parse(body).eventId, "evt-fanout-jitter-shared");
  }
  assert.ok(bodies.every((b) => b === bodies[0]), "all four payload bytes are identical");
  const signatures = calls.map(signatureOf);
  assert.equal(new Set(signatures).size, 4, "each endpoint signs with its own secret");
  const secrets = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
  for (const [i, call] of calls.entries()) {
    assert.ok(
      verifyPayoutWebhook(bodyOf(call), signatureOf(call), secrets[i]),
      `endpoint ${i} delivery verifies under its own secret`,
    );
    assert.equal(
      verifyPayoutWebhook(bodyOf(call), signatureOf(call), secrets[(i + 1) % 4]),
      false,
      "a sibling secret must not verify this endpoint's delivery",
    );
  }
});

test("one endpoint's jittered retries never delay or consume a sibling's budget", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500), res(500), res(200)],
    [URL_B]: [res(200)],
    [URL_C]: [res(200)],
    [URL_D]: [res(200)],
  });
  const { endpoints, sleeps } = fourEndpoints();
  const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
    fetchImpl,
    now: NOW,
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
  });
  assert.deepEqual(out.results, [
    { ok: true, attempts: 3, status: 200 },
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
  assert.equal(sleeps[0].delays.length, 2, "retrying endpoint slept twice");
  assert.ok(inWindow(sleeps[0].delays[0], 100, 1000));
  assert.ok(inWindow(sleeps[0].delays[1], 200, 1000));
  for (const i of [1, 2, 3]) {
    assert.deepEqual(sleeps[i].delays, [], `healthy endpoint ${i} must not sleep at all`);
  }
  assert.equal(callsTo(URL_A).length, 3);
  for (const url of [URL_B, URL_C, URL_D]) {
    assert.equal(callsTo(url).length, 1, "healthy endpoint was not retried");
  }
});
