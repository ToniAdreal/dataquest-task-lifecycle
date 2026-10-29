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
 * Payout webhook HTTPS enforcement (backlog #701): the dataquest-side
 * peer of escrow's `DeliverWebhookOptions.allowInsecureHttp` (#551).
 *
 * Rules under test:
 *  - `http:` URLs are rejected by default, before any request is made
 *    (zero fetch calls), because the payload carries a settlement
 *    amount and the `X-Hub-Signature-256` HMAC header, which over
 *    plaintext could be captured and replayed in full
 *  - `allowInsecureHttp: true` opts a delivery (single or fan-out,
 *    call-level or per-endpoint) back into plaintext; `https:` URLs
 *    are unaffected either way
 *  - the rejection is a caller configuration error in this module's
 *    own wording (`cannot deliver payout webhook: …`), thrown by the
 *    single-endpoint call and reported per endpoint by fan-out
 *  - check order is URL parse, then protocol whitelist, then the
 *    HTTPS check, and an illegal opt-in type is a configuration error
 *  - every test injects `fetchImpl`/`sleepImpl`: no real network
 */

const SECRET = "whsec_test_payout_https_20261029";
const SECRET_BILLING = "whsec_test_payout_https_billing_20261029";
const SECRET_RISK = "whsec_test_payout_https_risk_20261029";
const HTTP_URL = "http://accounting.example.com/hooks/payout";
const HTTPS_URL = "https://accounting.example.com/hooks/payout";
const HTTP_BILLING = "http://billing.example.com/hooks/payout";
const HTTPS_RISK = "https://risk.example.com/hooks/payout";
const NOW = new Date("2026-10-29T00:00:00.000Z");

const INSECURE_MESSAGE =
  "cannot deliver payout webhook: insecure http url rejected: use https or set allowInsecureHttp: true";

/** Drive a task from DRAFT all the way to PAID and build its webhook. */
function goldenWebhook(): PayoutWebhook {
  const t = new TaskLifecycle("task-https");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-https-1",
    payoutAmount: 4200,
  });
  return buildPayoutWebhook(t, SECRET, {
    eventId: "evt-https-1",
    now: NOW,
  });
}

/** Drive a task from DRAFT all the way to PAID (for fan-out). */
function paidTask(id = "task-https-fanout"): TaskLifecycle {
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
    payoutRef: "xfer-https-fanout-1",
    payoutAmount: 4200,
  });
  return t;
}

const res200 = () => new Response("{}", { status: 200 });
const noSleep = async () => {};

test("http is rejected by default with zero fetch attempts", async () => {
  const webhook = goldenWebhook();
  let calls = 0;
  await assert.rejects(
    () =>
      deliverPayoutWebhook(HTTP_URL, webhook, {
        fetchImpl: async () => {
          calls += 1;
          return res200();
        },
        sleepImpl: noSleep,
        maxAttempts: 3,
      }),
    (err: unknown) =>
      err instanceof Error && err.message === INSECURE_MESSAGE,
  );
  assert.equal(calls, 0);
});

test("opt-in http delivers normally", async () => {
  const webhook = goldenWebhook();
  let calls = 0;
  const result = await deliverPayoutWebhook(HTTP_URL, webhook, {
    fetchImpl: async () => {
      calls += 1;
      return res200();
    },
    sleepImpl: noSleep,
    allowInsecureHttp: true,
  });
  assert.deepEqual(result, { ok: true, attempts: 1, status: 200 });
  assert.equal(calls, 1);
});

test("https is unaffected by the default (no opt-in needed)", async () => {
  const webhook = goldenWebhook();
  let calls = 0;
  const result = await deliverPayoutWebhook(HTTPS_URL, webhook, {
    fetchImpl: async () => {
      calls += 1;
      return res200();
    },
    sleepImpl: noSleep,
  });
  assert.deepEqual(result, { ok: true, attempts: 1, status: 200 });
  assert.equal(calls, 1);
});

test("fan-out: a per-endpoint opt-in delivers an http endpoint", async () => {
  const calls: string[] = [];
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      {
        url: HTTP_BILLING,
        secret: SECRET_BILLING,
        allowInsecureHttp: true,
      },
      { url: HTTPS_RISK, secret: SECRET_RISK },
    ],
    {
      fetchImpl: async (url) => {
        calls.push(url);
        return res200();
      },
      sleepImpl: noSleep,
      now: NOW,
      eventId: "evt-https-fanout-optin",
    },
  );
  assert.deepEqual(
    [out.delivered, out.failed, out.results.map((r) => r.ok)],
    [2, 0, [true, true]],
  );
  assert.deepEqual(calls.sort(), [HTTP_BILLING, HTTPS_RISK].sort());
});

test("fan-out: without any opt-in an http endpoint fails alone, https still delivers", async () => {
  const calls: string[] = [];
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: HTTP_BILLING, secret: SECRET_BILLING },
      { url: HTTPS_RISK, secret: SECRET_RISK },
    ],
    {
      fetchImpl: async (url) => {
        calls.push(url);
        return res200();
      },
      sleepImpl: noSleep,
      now: NOW,
      eventId: "evt-https-fanout-default",
    },
  );
  assert.equal(out.delivered, 1);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.results[0], {
    ok: false,
    attempts: 0,
    error: INSECURE_MESSAGE,
  });
  assert.deepEqual(out.results[1], { ok: true, attempts: 1, status: 200 });
  assert.deepEqual(calls, [HTTPS_RISK]);
});

test("fan-out: a call-level opt-in delivers an http endpoint", async () => {
  const calls: string[] = [];
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: HTTP_BILLING, secret: SECRET_BILLING },
      { url: HTTPS_RISK, secret: SECRET_RISK },
    ],
    {
      fetchImpl: async (url) => {
        calls.push(url);
        return res200();
      },
      sleepImpl: noSleep,
      allowInsecureHttp: true,
      now: NOW,
      eventId: "evt-https-fanout-call",
    },
  );
  assert.deepEqual(
    [out.delivered, out.failed],
    [2, 0],
  );
  assert.deepEqual(calls.sort(), [HTTP_BILLING, HTTPS_RISK].sort());
});

test("the rejection message is pinned verbatim", async () => {
  const webhook = goldenWebhook();
  await assert.rejects(
    () =>
      deliverPayoutWebhook(HTTP_URL, webhook, {
        fetchImpl: async () => res200(),
        sleepImpl: noSleep,
      }),
    (err: unknown) =>
      err instanceof Error && err.message === INSECURE_MESSAGE,
  );
});

test("check order: URL parse, then protocol whitelist, then the https check", async () => {
  const webhook = goldenWebhook();
  const counting = async () => res200();
  // Unparseable URL: the URL error, not the https error.
  await assert.rejects(
    () =>
      deliverPayoutWebhook("not a url", webhook, { fetchImpl: counting }),
    /cannot deliver payout webhook: invalid url "not a url"/,
  );
  // A parseable non-http(s) URL: the protocol error, not the https error.
  await assert.rejects(
    () =>
      deliverPayoutWebhook("ftp://example.com/hooks/payout", webhook, {
        fetchImpl: counting,
      }),
    /cannot deliver payout webhook: unsupported protocol "ftp:" \(http\/https only\)/,
  );
  // Only once both earlier checks pass does the https check fire.
  await assert.rejects(
    () =>
      deliverPayoutWebhook(HTTP_URL, webhook, { fetchImpl: counting }),
    (err: unknown) =>
      err instanceof Error && err.message === INSECURE_MESSAGE,
  );
});

test("a non-boolean opt-in is a configuration error with zero fetch calls", async () => {
  const webhook = goldenWebhook();
  let calls = 0;
  await assert.rejects(
    () =>
      deliverPayoutWebhook(HTTP_URL, webhook, {
        fetchImpl: async () => {
          calls += 1;
          return res200();
        },
        sleepImpl: noSleep,
        allowInsecureHttp: "yes" as never,
      }),
    /cannot deliver payout webhook: allowInsecureHttp must be a boolean, got yes/,
  );
  assert.equal(calls, 0);
});

test("fan-out: a per-endpoint illegal opt-in fails only its own endpoint", async () => {
  const calls: string[] = [];
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      {
        url: HTTP_BILLING,
        secret: SECRET_BILLING,
        allowInsecureHttp: 1 as never,
      },
      { url: HTTPS_RISK, secret: SECRET_RISK },
    ],
    {
      fetchImpl: async (url) => {
        calls.push(url);
        return res200();
      },
      sleepImpl: noSleep,
      now: NOW,
      eventId: "evt-https-fanout-bad-optin",
    },
  );
  assert.equal(out.delivered, 1);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.results[0], {
    ok: false,
    attempts: 0,
    error:
      "cannot deliver payout webhook: allowInsecureHttp must be a boolean, got 1",
  });
  assert.deepEqual(out.results[1], { ok: true, attempts: 1, status: 200 });
  assert.deepEqual(calls, [HTTPS_RISK]);
});

test("an uppercase HTTP scheme is still plaintext and is rejected", async () => {
  const webhook = goldenWebhook();
  let calls = 0;
  await assert.rejects(
    () =>
      deliverPayoutWebhook("HTTP://accounting.example.com/hooks/payout", webhook, {
        fetchImpl: async () => {
          calls += 1;
          return res200();
        },
        sleepImpl: noSleep,
      }),
    (err: unknown) =>
      err instanceof Error && err.message === INSECURE_MESSAGE,
  );
  assert.equal(calls, 0);
});
