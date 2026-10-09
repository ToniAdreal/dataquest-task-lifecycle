import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
  parsePayoutRetryAfter,
  verifyPayoutWebhook,
} from "../src/index.js";
import type { PayoutWebhook } from "../src/index.js";

/**
 * Payout webhook delivery (backlog #121): the dataquest-side peer of
 * escrow's `deliverSettlementWebhook` (#40/#50/#100/#115), adapted to
 * this repo's result-object style.
 *
 * Rules under test:
 *  - 2xx succeeds in one attempt; the wire request is a POST whose body
 *    is byte-identical to the signed payload and whose
 *    `X-Hub-Signature-256` header carries the build-time signature
 *  - 429 and 5xx and network errors retry with exponential backoff, up
 *    to `maxAttempts` total attempts; a 429 `Retry-After` hint wins
 *    over backoff and is clamped to `maxRetryDelayMs` (default 60s)
 *  - other 3xx/4xx fail immediately without a retry; delivery failure
 *    is reported as `{ ok: false, ... }`, never thrown
 *  - invalid URLs/options are caller configuration errors: they throw
 *    before any request is made (zero fetch calls)
 *  - every test injects `fetchImpl`/`sleepImpl`: no real network, and
 *    the exact delay schedule is asserted instead of really sleeping
 */

const SECRET = "whsec_test_payout_delivery_20261009";
const HOOK_URL = "https://accounting.example.com/hooks/payout";

/** Drive a task from DRAFT all the way to PAID and build its webhook. */
function goldenWebhook(): PayoutWebhook {
  const t = new TaskLifecycle("task-deliver");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-deliver-1",
    payoutAmount: 4200,
  });
  return buildPayoutWebhook(t, SECRET, {
    eventId: "evt-deliver-1",
    now: new Date("2026-10-09T00:00:00.000Z"),
  });
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/**
 * A fetch stub driven by a script of responses/errors (the last entry
 * repeats once the script is exhausted), recording every call.
 */
function stubFetch(
  script: Array<Response | Error>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    // Fresh Response per call: a Response body can only be consumed once.
    return new Response(step.body, {
      status: step.status,
      headers: step.headers,
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
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

test("200 succeeds on the first attempt with the signed body and signature header", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([res(200)]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
  });
  assert.deepEqual(result, { ok: true, attempts: 1, status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HOOK_URL);
  assert.equal(calls[0].init.method, "POST");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-hub-signature-256"), webhook.signature);
  // The wire body is byte-identical to what was signed.
  assert.equal(calls[0].init.body, JSON.stringify(webhook.payload));
  assert.ok(
    verifyPayoutWebhook(
      String(calls[0].init.body),
      String(headers.get("x-hub-signature-256")),
      SECRET,
    ),
  );
  assert.deepEqual(delays, [], "no backoff sleep on a first-try success");
});

test("429 Retry-After: 120 is clamped to the default 60s cap", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([
    res(429, { "retry-after": "120" }),
    res(200),
  ]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
  });
  assert.deepEqual(result, { ok: true, attempts: 2, status: 200 });
  assert.equal(calls.length, 2);
  // The 120s hint is honored only up to the default maxRetryDelayMs.
  assert.deepEqual(delays, [60_000]);
});

test("429 Retry-After below the cap is honored exactly; a smaller explicit cap clamps harder", async () => {
  const webhook = goldenWebhook();
  {
    const { fetchImpl } = stubFetch([res(429, { "retry-after": "2" }), res(200)]);
    const { sleepImpl, delays } = stubSleep();
    const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
      fetchImpl,
      sleepImpl,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(delays, [2000]);
  }
  {
    const { fetchImpl } = stubFetch([
      res(429, { "retry-after": "120" }),
      res(200),
    ]);
    const { sleepImpl, delays } = stubSleep();
    const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
      fetchImpl,
      sleepImpl,
      maxRetryDelayMs: 500,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(delays, [500]);
  }
});

test("two 5xx responses then 200 succeeds on attempt 3 with exponential backoff", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([res(500), res(502), res(200)]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 100,
  });
  assert.deepEqual(result, { ok: true, attempts: 3, status: 200 });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [100, 200], "backoff doubles per retry");
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("x-hub-signature-256"), webhook.signature);
    assert.equal(call.init.body, JSON.stringify(webhook.payload));
  }
});

test("network errors retry to exhaustion and report ok:false instead of throwing", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([new Error("socket hang up")]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 10,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3, "default maxAttempts is 3 total attempts");
  assert.equal(result.status, undefined, "no response was ever received");
  assert.match(result.error ?? "", /socket hang up/);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("invalid and empty URLs fail fast with zero fetch calls", async () => {
  const webhook = goldenWebhook();
  for (const bad of ["not a url", "", "://missing-scheme"]) {
    const { fetchImpl, calls } = stubFetch([res(200)]);
    await assert.rejects(
      () => deliverPayoutWebhook(bad, webhook, { fetchImpl }),
      /cannot deliver payout webhook: invalid url/,
      `url ${JSON.stringify(bad)}`,
    );
    assert.equal(calls.length, 0);
  }
});

test("non-http(s) protocols fail fast with zero fetch calls", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([res(200)]);
  await assert.rejects(
    () => deliverPayoutWebhook("ftp://example.com/hook", webhook, { fetchImpl }),
    /cannot deliver payout webhook: unsupported protocol/,
  );
  assert.equal(calls.length, 0);
});

test("per-attempt timeout aborts the request via AbortController and is retried", async () => {
  const webhook = goldenWebhook();
  let abortsSeen = 0;
  // A fetch that never answers on its own: it only settles when the
  // caller's AbortSignal fires, exactly like the real fetch.
  const fetchImpl = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => {
          abortsSeen += 1;
          reject(new Error("The operation was aborted"));
        },
        { once: true },
      );
    })) as typeof fetch;
  const { sleepImpl } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    timeoutMs: 25,
    maxAttempts: 2,
    backoffMs: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.match(result.error ?? "", /timed out after 25ms/);
  assert.equal(abortsSeen, 2, "each attempt's controller aborted on timeout");
});

test("maxAttempts: 1 disables retries on a retryable 500", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([res(500), res(200)]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    maxAttempts: 1,
  });
  assert.deepEqual(result, {
    ok: false,
    attempts: 1,
    status: 500,
    error: "server responded with status 500",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test("400 is not retried: the request itself is at fault", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([res(400), res(200)]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.status, 400);
  assert.match(result.error ?? "", /not retried/);
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test("persistent 429 exhausts attempts and reports the last status", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl, calls } = stubFetch([res(429)]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.status, 429);
  assert.match(result.error ?? "", /status 429/);
  assert.equal(calls.length, 3);
  // No Retry-After header on these 429s: plain exponential backoff.
  assert.deepEqual(delays, [5, 10]);
});

test("unparsable Retry-After falls back to exponential backoff", async () => {
  const webhook = goldenWebhook();
  const { fetchImpl } = stubFetch([
    res(429, { "retry-after": "banana" }),
    res(200),
  ]);
  const { sleepImpl, delays } = stubSleep();
  const result = await deliverPayoutWebhook(HOOK_URL, webhook, {
    fetchImpl,
    sleepImpl,
    backoffMs: 40,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(delays, [40]);
});

test("invalid delivery options throw config errors before any request", async () => {
  const webhook = goldenWebhook();
  const cases: Array<{
    opts: Record<string, unknown>;
    pattern: RegExp;
  }> = [
    { opts: { maxAttempts: 0 }, pattern: /maxAttempts must be a positive integer/ },
    { opts: { maxAttempts: 1.5 }, pattern: /maxAttempts must be a positive integer/ },
    { opts: { timeoutMs: 0 }, pattern: /timeoutMs must be a positive number/ },
    { opts: { timeoutMs: -5 }, pattern: /timeoutMs must be a positive number/ },
    { opts: { backoffMs: -1 }, pattern: /backoffMs must be a non-negative number/ },
    {
      opts: { maxRetryDelayMs: -1 },
      pattern: /maxRetryDelayMs must be a non-negative number/,
    },
    {
      opts: { maxRetryDelayMs: Number.NaN },
      pattern: /maxRetryDelayMs must be a non-negative number/,
    },
  ];
  for (const { opts, pattern } of cases) {
    const { fetchImpl, calls } = stubFetch([res(200)]);
    await assert.rejects(
      () =>
        deliverPayoutWebhook(HOOK_URL, webhook, {
          fetchImpl,
          ...(opts as object),
        }),
      pattern,
    );
    assert.equal(calls.length, 0, `no request for ${JSON.stringify(opts)}`);
  }
});

test("parsePayoutRetryAfter: seconds, HTTP-date, and garbage", () => {
  const now = Date.parse("2026-10-09T00:00:00.000Z");
  assert.equal(parsePayoutRetryAfter("120", now), 120_000);
  assert.equal(parsePayoutRetryAfter("0", now), 0);
  assert.equal(parsePayoutRetryAfter("  30 ", now), 30_000);
  const future = new Date(now + 5000).toUTCString();
  const delta = parsePayoutRetryAfter(future, now);
  assert.ok(delta !== undefined && delta > 4000 && delta <= 5000);
  assert.equal(parsePayoutRetryAfter(new Date(now - 1000).toUTCString(), now), 0);
  assert.equal(parsePayoutRetryAfter("banana", now), undefined);
  assert.equal(parsePayoutRetryAfter("-5", now), undefined);
  assert.equal(parsePayoutRetryAfter(null, now), undefined);
  assert.equal(parsePayoutRetryAfter(undefined, now), undefined);
});
