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
 * Payout webhook future-skew bound (backlog #148):
 * `VerifyPayoutWebhookOptions.maxFutureSkewMs`.
 *
 * Rules under test:
 *  - only after the HMAC signature matches, `at - now > maxFutureSkewMs`
 *    returns false (fail-closed, never throws)
 *  - the boundary is inclusive: skew exactly `maxFutureSkewMs` passes,
 *    one millisecond more fails; `maxFutureSkewMs: 0` passes only
 *    `at == now` (or earlier)
 *  - unset keeps legacy behavior: a far-future timestamp still passes
 *  - illegal `maxFutureSkewMs` (negative / NaN / Infinity / non-number)
 *    throws a caller configuration error, in the `maxAgeMs` style
 *  - a forged signature fails on the signature check, before any
 *    timestamp is looked at
 *  - `maxAgeMs` + `maxFutureSkewMs` together form a two-sided window
 */

const SECRET = "s3cr3t";
const NOW_ISO = "2026-10-09T10:00:00.000Z";
const NOW = new Date(NOW_ISO);
const ONE_HOUR = 3_600_000;

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

function signBodyString(bodyString: string, secret: string = SECRET): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(bodyString, "utf8").digest("hex")
  );
}

test("far-future payload beyond maxFutureSkewMs returns false (object and string bodies)", () => {
  const task = toPaid("task-far-future");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-far-future",
    now: new Date(NOW.getTime() + 2 * ONE_HOUR),
  });
  const opts = { maxFutureSkewMs: ONE_HOUR, now: NOW };
  // The signature itself is valid — only the future-skew gate rejects it.
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET, opts), false);
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET, opts),
    false,
  );
});

test("future payload inside the window, and exactly at its boundary, passes", () => {
  const task = toPaid("task-near-future");
  const inside = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-near-future-inside",
    now: new Date(NOW.getTime() + ONE_HOUR - 1),
  });
  assert.equal(
    verifyPayoutWebhook(inside.payload, inside.signature, SECRET, {
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  const atBoundary = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-near-future-boundary",
    now: new Date(NOW.getTime() + ONE_HOUR),
  });
  const boundaryOpts = { maxFutureSkewMs: ONE_HOUR, now: NOW };
  assert.equal(
    verifyPayoutWebhook(atBoundary.payload, atBoundary.signature, SECRET, boundaryOpts),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(
      JSON.stringify(atBoundary.payload),
      atBoundary.signature,
      SECRET,
      boundaryOpts,
    ),
    true,
  );
  // A past / present payload is never rejected by the future bound alone.
  const past = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-past-with-future-bound",
    now: new Date(NOW.getTime() - 365 * 24 * ONE_HOUR),
  });
  assert.equal(
    verifyPayoutWebhook(past.payload, past.signature, SECRET, boundaryOpts),
    true,
  );
});

test("maxFutureSkewMs: 0 boundary — at == now passes, 1ms in the future fails", () => {
  const task = toPaid("task-zero-skew");
  const exact = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-zero-skew-exact",
    now: NOW,
  });
  assert.equal(
    verifyPayoutWebhook(exact.payload, exact.signature, SECRET, {
      maxFutureSkewMs: 0,
      now: NOW,
    }),
    true,
  );
  const oneMsFuture = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-zero-skew-future",
    now: new Date(NOW.getTime() + 1),
  });
  assert.equal(
    verifyPayoutWebhook(oneMsFuture.payload, oneMsFuture.signature, SECRET, {
      maxFutureSkewMs: 0,
      now: NOW,
    }),
    false,
  );
});

test("omitting maxFutureSkewMs keeps legacy behavior (far future still passes)", () => {
  const task = toPaid("task-future-legacy");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-future-legacy",
    now: new Date(NOW.getTime() + 365 * 24 * ONE_HOUR),
  });
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET, {}), true);
  // A maxAgeMs-only window does not bound the future either.
  assert.equal(
    verifyPayoutWebhook(payload, signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET, {
      now: NOW,
    }),
    true,
  );
});

test("illegal maxFutureSkewMs values throw a configuration error", () => {
  const task = toPaid("task-bad-skew");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-bad-skew",
    now: NOW,
  });
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60000"]) {
    assert.throws(
      () =>
        verifyPayoutWebhook(payload, signature, SECRET, {
          maxFutureSkewMs: bad as number,
          now: NOW,
        }),
      /cannot verify payout webhook: maxFutureSkewMs must be a finite non-negative number/,
      `expected throw for maxFutureSkewMs=${String(bad)}`,
    );
  }
});

test("forged signature fails on the signature check, before any timestamp check", () => {
  const task = toPaid("task-forged-future");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-forged-future",
    now: new Date(NOW.getTime() + 2 * ONE_HOUR),
  });
  const opts = { maxFutureSkewMs: ONE_HOUR, now: NOW };
  // Wrong secret: a signature failure, regardless of the timestamp.
  assert.equal(
    verifyPayoutWebhook(payload, signature, "wrong-secret", opts),
    false,
  );
  // Tampering `at` back into the window cannot help: the attacker
  // cannot re-sign, so the signature check rejects the forged body.
  const forged: PayoutWebhookPayload = { ...payload, at: NOW_ISO };
  assert.equal(verifyPayoutWebhook(forged, signature, SECRET, opts), false);
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(forged), signature, SECRET, opts),
    false,
  );
});

test("maxAgeMs and maxFutureSkewMs together form a two-sided window", () => {
  const task = toPaid("task-two-sided");
  const opts = { maxAgeMs: ONE_HOUR, maxFutureSkewMs: ONE_HOUR, now: NOW };
  const inside = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-two-sided-inside",
    now: new Date(NOW.getTime() + 30 * 60_000),
  });
  assert.equal(
    verifyPayoutWebhook(inside.payload, inside.signature, SECRET, opts),
    true,
  );
  const tooOld = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-two-sided-old",
    now: new Date(NOW.getTime() - 2 * ONE_HOUR),
  });
  assert.equal(
    verifyPayoutWebhook(tooOld.payload, tooOld.signature, SECRET, opts),
    false,
  );
  const tooFuture = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-two-sided-future",
    now: new Date(NOW.getTime() + 2 * ONE_HOUR),
  });
  assert.equal(
    verifyPayoutWebhook(tooFuture.payload, tooFuture.signature, SECRET, opts),
    false,
  );
});

test("unparseable at with only maxFutureSkewMs set fails closed; without it the signature decides", () => {
  const bad: PayoutWebhookPayload = {
    event: "PAYOUT_COMPLETE",
    taskId: "task-bad-at-skew",
    at: "banana",
    eventId: "evt-bad-at-skew",
  };
  const body = JSON.stringify(bad);
  const sig = signBodyString(body);
  assert.equal(
    verifyPayoutWebhook(bad, sig, SECRET, { maxFutureSkewMs: ONE_HOUR, now: NOW }),
    false,
  );
  assert.equal(
    verifyPayoutWebhook(body, sig, SECRET, { maxFutureSkewMs: ONE_HOUR, now: NOW }),
    false,
  );
  assert.equal(verifyPayoutWebhook(bad, sig, SECRET), true);
  assert.equal(verifyPayoutWebhook(body, sig, SECRET), true);
});
