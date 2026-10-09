import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
} from "../src/index.js";
import type { PayoutWebhookPayload } from "../src/index.js";

/**
 * Payout webhook freshness / replay window (backlog #124): the
 * dataquest-side peer of escrow's webhookFreshness (#100).
 *
 * Rules under test:
 *  - `verifyPayoutWebhook(body, signature, secret, { maxAgeMs, now? })`
 *    checks the HMAC signature FIRST (constant time, unchanged); only a
 *    signature-valid payload is timestamp-parsed, and it then returns
 *    false when `now - payload.at > maxAgeMs`
 *  - the window is opt-in: omitting opts (or `maxAgeMs`) keeps the exact
 *    legacy signature-only behavior, however old the payload is
 *  - the boundary is inclusive: age exactly `maxAgeMs` passes, one
 *    millisecond more fails; `maxAgeMs: 0` passes only `at == now`
 *  - future `at` timestamps pass (clock-skew tolerance, documented)
 *  - illegal `maxAgeMs` (-1 / NaN / Infinity / non-number) and an
 *    invalid injected `now` are caller configuration errors that throw
 *  - an unparseable `at` (or an unparseable string body) with
 *    `maxAgeMs` set fails closed as false, never throws
 */

const SECRET = "s3cr3t";
const NOW_ISO = "2026-10-09T10:00:00.000Z";
const NOW = new Date(NOW_ISO);
const ONE_HOUR = 3_600_000;

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(t.state, "PAID");
  return t;
}

/** Sign an arbitrary body string with the test secret (test-side signer). */
function signBodyString(bodyString: string, secret: string = SECRET): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(bodyString, "utf8").digest("hex")
  );
}

test("fresh payload passes the maxAgeMs window (object and string bodies)", () => {
  const task = toPaid("task-fresh");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-fresh",
    now: new Date(NOW.getTime() - 5 * 60_000),
  });
  const opts = { maxAgeMs: ONE_HOUR, now: NOW };
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET, opts), true);
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET, opts),
    true,
  );
  // `now` also accepts an ISO string.
  assert.equal(
    verifyPayoutWebhook(payload, signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      now: NOW_ISO,
    }),
    true,
  );
});

test("legitimately-signed payload older than the window returns false", () => {
  const task = toPaid("task-stale");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-stale",
    now: new Date(NOW.getTime() - 2 * ONE_HOUR),
  });
  const opts = { maxAgeMs: ONE_HOUR, now: NOW };
  // The signature itself is valid — only the freshness gate rejects it.
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET, opts), false);
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET, opts),
    false,
  );
});

test("maxAgeMs: 0 boundary — at == now passes, 1ms older fails", () => {
  const task = toPaid("task-zero");
  const exact = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-zero-exact",
    now: NOW,
  });
  assert.equal(
    verifyPayoutWebhook(exact.payload, exact.signature, SECRET, {
      maxAgeMs: 0,
      now: NOW,
    }),
    true,
  );
  const oneMsOld = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-zero-old",
    now: new Date(NOW.getTime() - 1),
  });
  assert.equal(
    verifyPayoutWebhook(oneMsOld.payload, oneMsOld.signature, SECRET, {
      maxAgeMs: 0,
      now: NOW,
    }),
    false,
  );
  // Age exactly maxAgeMs is inclusive at a non-zero window too.
  const atBoundary = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-boundary",
    now: new Date(NOW.getTime() - ONE_HOUR),
  });
  assert.equal(
    verifyPayoutWebhook(atBoundary.payload, atBoundary.signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
});

test("future at passes — sender clock skew is tolerated", () => {
  const task = toPaid("task-future");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-future",
    now: new Date(NOW.getTime() + 2 * ONE_HOUR),
  });
  assert.equal(
    verifyPayoutWebhook(payload, signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  // Even a zero window tolerates a future timestamp (negative age).
  assert.equal(
    verifyPayoutWebhook(payload, signature, SECRET, { maxAgeMs: 0, now: NOW }),
    true,
  );
});

test("illegal maxAgeMs values throw a configuration error", () => {
  const task = toPaid("task-bad-window");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-bad-window",
    now: NOW,
  });
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60000"]) {
    assert.throws(
      () =>
        verifyPayoutWebhook(payload, signature, SECRET, {
          maxAgeMs: bad as number,
          now: NOW,
        }),
      /cannot verify payout webhook: maxAgeMs must be a finite non-negative number/,
      `expected throw for maxAgeMs=${String(bad)}`,
    );
  }
});

test("invalid injected now throws a configuration error", () => {
  const task = toPaid("task-bad-now");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-bad-now",
    now: NOW,
  });
  assert.throws(
    () =>
      verifyPayoutWebhook(payload, signature, SECRET, {
        maxAgeMs: ONE_HOUR,
        now: "not-a-date",
      }),
    /cannot verify payout webhook: invalid 'now' timestamp/,
  );
  assert.throws(
    () =>
      verifyPayoutWebhook(payload, signature, SECRET, {
        maxAgeMs: ONE_HOUR,
        now: new Date("banana"),
      }),
    /cannot verify payout webhook: invalid 'now' timestamp/,
  );
});

test("omitting opts keeps legacy signature-only behavior (old payload verifies)", () => {
  const task = toPaid("task-legacy");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-legacy",
    now: new Date(NOW.getTime() - 365 * 24 * ONE_HOUR),
  });
  // A year-old signature is still cryptographically valid without the opt-in.
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET, {}), true);
  assert.equal(
    verifyPayoutWebhook(payload, signature, SECRET, { now: NOW }),
    true,
    "now without maxAgeMs does not enable the gate",
  );
});

test("tampered at fails on the signature check, before any freshness gate", () => {
  const task = toPaid("task-tamper-at");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-tamper-at",
    now: new Date(NOW.getTime() - 2 * ONE_HOUR),
  });
  // Attacker rewinds `at` into the window but cannot re-sign: the
  // signature check rejects it even though the forged `at` is fresh.
  const forged: PayoutWebhookPayload = { ...payload, at: NOW_ISO };
  assert.equal(
    verifyPayoutWebhook(forged, signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(forged), signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
  // Wrong secret with a fresh payload: also a signature failure.
  assert.equal(
    verifyPayoutWebhook(payload, signature, "wrong-secret", {
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
});

test("invalid at with maxAgeMs fails closed; without it the signature alone decides", () => {
  const bad: PayoutWebhookPayload = {
    event: "PAYOUT_COMPLETE",
    taskId: "task-bad-at",
    at: "banana",
    eventId: "evt-bad-at",
  };
  const body = JSON.stringify(bad);
  const sig = signBodyString(body);
  assert.equal(
    verifyPayoutWebhook(bad, sig, SECRET, { maxAgeMs: ONE_HOUR, now: NOW }),
    false,
  );
  assert.equal(
    verifyPayoutWebhook(body, sig, SECRET, { maxAgeMs: ONE_HOUR, now: NOW }),
    false,
  );
  // Backward compat: freshness is opt-in; a valid signature decides.
  assert.equal(verifyPayoutWebhook(bad, sig, SECRET), true);
  assert.equal(verifyPayoutWebhook(body, sig, SECRET), true);
});

test("unparseable string body with a valid signature + maxAgeMs fails closed, never throws", () => {
  const body = "not json at all";
  const sig = signBodyString(body);
  // The signature genuinely matches these bytes, so verification reaches
  // the freshness gate — which cannot find a parseable `at` and fails
  // closed instead of throwing.
  assert.equal(verifyPayoutWebhook(body, sig, SECRET), true);
  assert.equal(
    verifyPayoutWebhook(body, sig, SECRET, { maxAgeMs: ONE_HOUR, now: NOW }),
    false,
  );
  // Valid JSON that is not an object with a string `at` also fails closed.
  for (const json of ['"just a string"', "42", "null", '{"taskId":"x"}']) {
    assert.equal(
      verifyPayoutWebhook(json, signBodyString(json), SECRET, {
        maxAgeMs: ONE_HOUR,
        now: NOW,
      }),
      false,
      `expected false for ${json}`,
    );
  }
});

test("default now uses the real clock", () => {
  const task = toPaid("task-real-clock");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-real-clock",
  });
  // Built "just now" on the wall clock; a 60s window with no injected
  // `now` must pass on any machine.
  assert.equal(
    verifyPayoutWebhook(payload, signature, SECRET, { maxAgeMs: 60_000 }),
    true,
  );
});
