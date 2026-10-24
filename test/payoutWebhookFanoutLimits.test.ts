import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  deliverPayoutWebhookToMany,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Fan-out limits (backlog #559): `maxEndpoints` and
 * `overallDeadlineMs` on `deliverPayoutWebhookToMany`.
 *
 * Rules under test:
 *  - `maxEndpoints` exceeded throws a call-level configuration error
 *    before any request (zero fetch calls); an exactly-at-cap call
 *    succeeds; invalid caps throw the same way
 *  - `overallDeadlineMs` invalid values throw before any request
 *  - a deadline that expires mid-fan-out stops the still-in-flight
 *    endpoints: their results carry the deadline timeout error (not
 *    the plain abort text), already-completed endpoints keep their
 *    results, `delivered`/`failed` count exactly what happened, and
 *    the aggregate result reports `deadlineExceeded: true`
 *  - a deadline that never expires leaves results untouched and
 *    reports `deadlineExceeded: false`
 *  - a per-endpoint signal override does NOT exempt an endpoint from
 *    the overall deadline
 *  - with neither option set, the aggregate result reports
 *    `deadlineExceeded: false` and per-endpoint behavior is unchanged
 *  - every test injects fetch/sleep stubs: no real network, no real
 *    sleeps except the short real deadline timers themselves
 */

const SECRET_A = "whsec_fanout_limits_billing_20261024";
const SECRET_B = "whsec_fanout_limits_risk_20261024";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const NOW = new Date("2026-10-24T00:00:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-limits"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-limits-1",
    payoutAmount: 4200,
  });
  return t;
}

const noSleep = async () => {};
const res = (status: number) => new Response("{}", { status });

/** Counting fetch stub: every call recorded, always 200. */
function countingFetch(): {
  fetchImpl: PayoutWebhookFetchImpl;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: PayoutWebhookFetchImpl = async (url) => {
    calls.push(url);
    return res(200);
  };
  return { fetchImpl, calls };
}

/**
 * A fetch stub that hangs until its signal aborts, then rejects — the
 * shape a real fetch takes when its AbortSignal fires. Without a
 * signal it hangs forever, which is exactly what the deadline must
 * rescue.
 */
function hangingFetch(): PayoutWebhookFetchImpl {
  return (_url, init) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal == null) return; // hangs: no signal can rescue it
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
}

test("maxEndpoints exceeded throws before any request: zero fetch calls", async () => {
  const { fetchImpl, calls } = countingFetch();
  await assert.rejects(
    () =>
      deliverPayoutWebhookToMany(
        paidTask(),
        [
          { url: URL_A, secret: SECRET_A },
          { url: URL_B, secret: SECRET_B },
        ],
        {
          fetchImpl,
          sleepImpl: noSleep,
          now: NOW,
          eventId: "evt-limits-cap",
          maxEndpoints: 1,
        },
      ),
    /cannot deliver payout webhook to many endpoints: 2 endpoints exceed maxEndpoints 1/,
  );
  assert.equal(calls.length, 0, "cap breach must not touch the network");
});

test("maxEndpoints exactly at the cap succeeds", async () => {
  const { fetchImpl, calls } = countingFetch();
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    {
      fetchImpl,
      sleepImpl: noSleep,
      now: NOW,
      eventId: "evt-limits-cap-exact",
      maxEndpoints: 2,
    },
  );
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 0);
  assert.equal(out.deadlineExceeded, false);
  assert.equal(calls.length, 2);
});

test("invalid maxEndpoints values throw a configuration error before any request", async () => {
  const bad = [0, -1, 1.5, Number.NaN, Infinity, "2" as unknown as number];
  for (const maxEndpoints of bad) {
    const { fetchImpl, calls } = countingFetch();
    await assert.rejects(
      () =>
        deliverPayoutWebhookToMany(
          paidTask(),
          [{ url: URL_A, secret: SECRET_A }],
          {
            fetchImpl,
            sleepImpl: noSleep,
            now: NOW,
            maxEndpoints,
          },
        ),
      /maxEndpoints must be a positive integer/,
    );
    assert.equal(calls.length, 0, `maxEndpoints=${String(maxEndpoints)} made no request`);
  }
});

test("invalid overallDeadlineMs values throw a configuration error before any request", async () => {
  const bad = [0, -1, Number.NaN, Infinity, "100" as unknown as number];
  for (const overallDeadlineMs of bad) {
    const { fetchImpl, calls } = countingFetch();
    await assert.rejects(
      () =>
        deliverPayoutWebhookToMany(
          paidTask(),
          [{ url: URL_A, secret: SECRET_A }],
          {
            fetchImpl,
            sleepImpl: noSleep,
            now: NOW,
            overallDeadlineMs,
          },
        ),
      /overallDeadlineMs must be a positive number/,
    );
    assert.equal(calls.length, 0, `overallDeadlineMs=${String(overallDeadlineMs)} made no request`);
  }
});

test("deadline expiry stops the hanging endpoint and marks it with the deadline timeout", async () => {
  const calls: string[] = [];
  const fetchImpl: PayoutWebhookFetchImpl = async (url, init) => {
    calls.push(url);
    if (url === URL_A) return res(200);
    return hangingFetch()(url, init);
  };
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    {
      fetchImpl,
      sleepImpl: noSleep,
      now: NOW,
      eventId: "evt-limits-deadline",
      overallDeadlineMs: 50,
    },
  );
  assert.deepEqual(out.results[0], { ok: true, attempts: 1, status: 200 });
  assert.equal(out.results[1].ok, false);
  assert.match(
    out.results[1].error ?? "",
    /payout webhook delivery timed out: overall deadline of 50ms exceeded/,
  );
  assert.notEqual(
    out.results[1].error,
    "payout webhook delivery aborted",
    "deadline stops must not masquerade as plain caller aborts",
  );
  assert.equal(out.delivered, 1, "only the completed endpoint counts as delivered");
  assert.equal(out.failed, 1);
  assert.equal(out.deadlineExceeded, true);
  assert.equal(calls.length, 2);
});

test("deadline that never expires leaves results untouched and reports deadlineExceeded false", async () => {
  const { fetchImpl } = countingFetch();
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    {
      fetchImpl,
      sleepImpl: noSleep,
      now: NOW,
      eventId: "evt-limits-no-deadline-hit",
      overallDeadlineMs: 60_000,
    },
  );
  assert.deepEqual(out.results, [
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 0);
  assert.equal(out.deadlineExceeded, false);
});

test("per-endpoint signal override does not exempt an endpoint from the deadline", async () => {
  const ownSignal = new AbortController().signal; // never aborted
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B, signal: ownSignal },
    ],
    {
      fetchImpl: hangingFetch(),
      sleepImpl: noSleep,
      now: NOW,
      eventId: "evt-limits-deadline-override",
      overallDeadlineMs: 50,
    },
  );
  // Both endpoints hang, so both must be deadline-stopped even though
  // the second carries its own (never-aborted) signal.
  assert.equal(out.results.length, 2);
  for (const result of out.results) {
    assert.equal(result.ok, false);
    assert.match(
      result.error ?? "",
      /overall deadline of 50ms exceeded/,
    );
  }
  assert.equal(out.delivered, 0);
  assert.equal(out.failed, 2);
  assert.equal(out.deadlineExceeded, true);
});

test("no limits set: default fan-out path reports deadlineExceeded false", async () => {
  const { fetchImpl } = countingFetch();
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
    ],
    { fetchImpl, sleepImpl: noSleep, now: NOW, eventId: "evt-limits-default" },
  );
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 0);
  assert.equal(out.deadlineExceeded, false);
});

test("maxEndpoints breach throws even when a deadline is also set, still zero requests", async () => {
  const { fetchImpl, calls } = countingFetch();
  await assert.rejects(
    () =>
      deliverPayoutWebhookToMany(
        paidTask(),
        [
          { url: URL_A, secret: SECRET_A },
          { url: URL_B, secret: SECRET_B },
        ],
        {
          fetchImpl,
          sleepImpl: noSleep,
          now: NOW,
          maxEndpoints: 1,
          overallDeadlineMs: 1000,
        },
      ),
    /2 endpoints exceed maxEndpoints 1/,
  );
  assert.equal(calls.length, 0);
});
