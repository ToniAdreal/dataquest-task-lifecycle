import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook multi-endpoint fan-out (backlog #142).
 *
 * Rules under test:
 *  - one logical settlement event is fanned out concurrently to every
 *    endpoint; each endpoint's copy is built (and signed) independently
 *    with that endpoint's own secret, under ONE shared eventId and `at`
 *  - results come back in input order with aggregate delivered/failed
 *    counts; one endpoint's failure (retries exhausted, network error,
 *    invalid URL) never blocks or fails the others
 *  - retry budgets are counted per endpoint independently
 *  - call-level configuration errors throw before any request: empty /
 *    non-array endpoints, invalid global delivery options
 *  - every test injects fetch/sleep stubs: no real network, no real
 *    sleeps
 */

const SECRET_A = "whsec_fanout_billing_20261009";
const SECRET_B = "whsec_fanout_risk_20261009";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const NOW = new Date("2026-10-09T00:00:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-1",
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
  calls: RecordedCall[];
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
  return { fetchImpl, calls, callsTo: (u) => calls.filter((c) => c.url === u) };
}

const noSleep = async () => {};
const res = (status: number) => new Response("{}", { status });

function bodyOf(call: RecordedCall): string {
  return String(call.init.body);
}
function signatureOf(call: RecordedCall): string {
  return String(new Headers(call.init.headers).get("x-hub-signature-256"));
}

test("two endpoints both 200: each receives a body signed with its own secret, verification passes", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(200)],
    [URL_B]: [res(200)],
  });
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    { fetchImpl, sleepImpl: noSleep, now: NOW, eventId: "evt-fanout-1" },
  );
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 0);
  assert.deepEqual(out.results, [
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
  const [callA] = callsTo(URL_A);
  const [callB] = callsTo(URL_B);
  // Same logical event: identical payload bytes (shared eventId + at)…
  assert.equal(bodyOf(callA), bodyOf(callB));
  assert.equal(JSON.parse(bodyOf(callA)).eventId, "evt-fanout-1");
  // …but independently signed per endpoint.
  assert.notEqual(signatureOf(callA), signatureOf(callB));
  assert.ok(verifyPayoutWebhook(bodyOf(callA), signatureOf(callA), SECRET_A));
  assert.ok(verifyPayoutWebhook(bodyOf(callB), signatureOf(callB), SECRET_B));
});

test("one endpoint persistent 500, other succeeds: results stay in input order with aggregate counts", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500)],
    [URL_B]: [res(200)],
  });
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    { fetchImpl, sleepImpl: noSleep, now: NOW, backoffMs: 1 },
  );
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].ok, false, "failing endpoint is first, in input order");
  assert.equal(out.results[0].status, 500);
  assert.equal(out.results[0].attempts, 3, "default maxAttempts exhausted");
  assert.deepEqual(out.results[1], { ok: true, attempts: 1, status: 200 });
  assert.equal(out.delivered, 1);
  assert.equal(out.failed, 1);
  assert.equal(callsTo(URL_B).length, 1, "healthy endpoint was not retried or blocked");
});

test("secrets do not cross: A's secret cannot verify B's delivery", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(200)],
    [URL_B]: [res(200)],
  });
  await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    { fetchImpl, sleepImpl: noSleep, now: NOW },
  );
  const [callA] = callsTo(URL_A);
  const [callB] = callsTo(URL_B);
  assert.equal(verifyPayoutWebhook(bodyOf(callB), signatureOf(callB), SECRET_A), false);
  assert.equal(verifyPayoutWebhook(bodyOf(callA), signatureOf(callA), SECRET_B), false);
});

test("empty or non-array endpoints throw a configuration error before any request", async () => {
  const { fetchImpl, calls } = routerFetch({ [URL_A]: [res(200)] });
  await assert.rejects(
    () => deliverPayoutWebhookToMany(paidTask(), [], { fetchImpl }),
    /cannot deliver payout webhook to many endpoints: endpoints must be a non-empty array/,
  );
  await assert.rejects(
    () =>
      deliverPayoutWebhookToMany(
        paidTask(),
        undefined as unknown as [],
        { fetchImpl },
      ),
    /endpoints must be a non-empty array/,
  );
  assert.equal(calls.length, 0);
});

test("single endpoint is equivalent to deliverPayoutWebhook", async () => {
  const task = paidTask();
  const webhook = buildPayoutWebhook(task, SECRET_A, {
    now: NOW,
    eventId: "evt-single-equiv",
  });
  const singleFetch = routerFetch({ [URL_A]: [res(200)] });
  const single = await deliverPayoutWebhook(URL_A, webhook, {
    fetchImpl: singleFetch.fetchImpl,
    sleepImpl: noSleep,
  });
  const manyFetch = routerFetch({ [URL_A]: [res(200)] });
  const many = await deliverPayoutWebhookToMany(
    task,
    [{ url: URL_A, secret: SECRET_A }],
    { fetchImpl: manyFetch.fetchImpl, sleepImpl: noSleep, now: NOW, eventId: "evt-single-equiv" },
  );
  assert.deepEqual(many.results, [single]);
  assert.equal(many.delivered, 1);
  assert.equal(many.failed, 0);
  // And the wire bytes are identical too.
  assert.equal(bodyOf(manyFetch.calls[0]), bodyOf(singleFetch.calls[0]));
  assert.equal(signatureOf(manyFetch.calls[0]), signatureOf(singleFetch.calls[0]));
});

test("retry counts are counted per endpoint independently", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500), res(500), res(200)],
    [URL_B]: [res(500), res(200)],
  });
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    { fetchImpl, sleepImpl: noSleep, now: NOW, backoffMs: 1 },
  );
  assert.deepEqual(out.results, [
    { ok: true, attempts: 3, status: 200 },
    { ok: true, attempts: 2, status: 200 },
  ]);
  assert.equal(callsTo(URL_A).length, 3);
  assert.equal(callsTo(URL_B).length, 2);
  assert.equal(out.delivered, 2);
});

test("per-endpoint maxAttempts override applies only to that endpoint", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500)],
    [URL_B]: [res(500)],
  });
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A, maxAttempts: 1 },
      { url: URL_B, secret: SECRET_B },
    ],
    { fetchImpl, sleepImpl: noSleep, now: NOW, backoffMs: 1 },
  );
  assert.equal(out.results[0].attempts, 1, "override: no retries");
  assert.equal(out.results[1].attempts, 3, "global default applies");
  assert.equal(callsTo(URL_A).length, 1);
  assert.equal(callsTo(URL_B).length, 3);
  assert.equal(out.failed, 2);
});

test("invalid URL endpoint marks only itself failed and does not throw the whole call", async () => {
  const { fetchImpl, callsTo } = routerFetch({ [URL_B]: [res(200)] });
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: "not a url", secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    { fetchImpl, sleepImpl: noSleep, now: NOW },
  );
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].attempts, 0, "no request was attempted");
  assert.match(out.results[0].error ?? "", /cannot deliver payout webhook: invalid url/);
  assert.deepEqual(out.results[1], { ok: true, attempts: 1, status: 200 });
  assert.equal(out.delivered, 1);
  assert.equal(out.failed, 1);
  assert.equal(callsTo(URL_B).length, 1);
});

test("network-error endpoint exhausts its own retries while the other endpoint still succeeds", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [new Error("connection refused")],
    [URL_B]: [res(200)],
  });
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    { fetchImpl, sleepImpl: noSleep, now: NOW, backoffMs: 1 },
  );
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].attempts, 3);
  assert.match(out.results[0].error ?? "", /connection refused/);
  assert.deepEqual(out.results[1], { ok: true, attempts: 1, status: 200 });
  assert.equal(callsTo(URL_A).length, 3);
  assert.equal(out.delivered, 1);
  assert.equal(out.failed, 1);
});

test("invalid global delivery options throw a configuration error before any request", async () => {
  const { fetchImpl, calls } = routerFetch({
    [URL_A]: [res(200)],
    [URL_B]: [res(200)],
  });
  await assert.rejects(
    () =>
      deliverPayoutWebhookToMany(
        paidTask(),
        [
          { url: URL_A, secret: SECRET_A },
          { url: URL_B, secret: SECRET_B },
        ],
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 0 },
      ),
    /cannot deliver payout webhook: maxAttempts must be a positive integer/,
  );
  assert.equal(calls.length, 0, "global config errors are not per-endpoint outcomes");
});

test("per-endpoint fetchImpl override is used instead of the global fetch", async () => {
  const globalFetch = routerFetch({ [URL_A]: [res(500)] });
  const endpointFetch = routerFetch({ [URL_A]: [res(200)] });
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [{ url: URL_A, secret: SECRET_A, fetchImpl: endpointFetch.fetchImpl }],
    { fetchImpl: globalFetch.fetchImpl, sleepImpl: noSleep, now: NOW },
  );
  assert.deepEqual(out.results, [{ ok: true, attempts: 1, status: 200 }]);
  assert.equal(endpointFetch.calls.length, 1);
  assert.equal(globalFetch.calls.length, 0);
});
