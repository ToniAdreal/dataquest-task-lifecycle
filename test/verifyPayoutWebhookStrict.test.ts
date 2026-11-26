import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  STRICT_PAYOUT_WEBHOOK_MAX_AGE_MS,
  STRICT_PAYOUT_WEBHOOK_MAX_FUTURE_SKEW_MS,
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
  verifyPayoutWebhookStrict,
} from "../src/index.js";
import type {
  PayoutWebhookPayload,
  VerifyPayoutWebhookOptions,
} from "../src/index.js";

/**
 * Strict payout webhook verification (backlog #1427): the recommended
 * receiver path — `verifyPayoutWebhook` with all three opt-in gates
 * switched on by default in one call.
 *
 * Rules under test:
 *  - defaults: `maxAgeMs` 300_000 (5 minutes), `maxFutureSkewMs`
 *    60_000, `requireEventId: true`; each is overridable per field
 *  - strict accepts a fresh, keyed, correctly-signed payload
 *  - strict rejects a legitimately-signed payload older than 5 minutes
 *    and one more than 60 seconds in the future
 *  - strict rejects a signed payload with a missing, empty, or
 *    non-string `eventId`
 *  - an explicit `maxAgeMs` override is honored (1 hour accepts a
 *    10-minute-old payload); likewise `maxFutureSkewMs`
 *  - the legacy `verifyPayoutWebhook()` defaults are untouched: the
 *    same old/keyless payloads still verify on their signature alone
 *  - downgrade guard: explicitly passing `maxAgeMs: undefined` together
 *    with `requireEventId: false` throws a configuration error, so
 *    strict cannot be quietly downgraded to signature-only
 *  - an explicit `maxAgeMs: undefined` on its own falls back to the
 *    300-second default (it does not disable the window)
 *  - boundaries are inclusive: exactly 5 minutes old passes, 1ms more
 *    fails; exactly 60 seconds in the future passes, 1ms more fails
 *  - strict composes with secret rotation (`secrets: [new, old]`)
 */

const SECRET = "whsec_test_strict_verify_20261126";
const OLD_SECRET = "whsec_test_strict_verify_old_20261126";
const NOW = Date.parse("2026-11-26T10:00:00.000Z");
const FIVE_MINUTES = 300_000;
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
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-strict-verify",
    payoutAmount: 10098.5,
  });
  assert.equal(t.state, "PAID");
  return t;
}

/** Sign an arbitrary body with the test secret (test-side signer). */
function signBody(body: unknown, secret: string = SECRET): string {
  const bodyString = typeof body === "string" ? body : JSON.stringify(body);
  return (
    "sha256=" +
    createHmac("sha256", secret).update(bodyString, "utf8").digest("hex")
  );
}

/** A built payload carrying a fixed `eventId`, signed over its bytes. */
function keyedBody(
  builtAtMs: number,
  secret: string = SECRET,
  eventId = "evt-strict-verify",
) {
  const task = toPaid(`task-strict-verify-${builtAtMs}-${eventId}`);
  return buildPayoutWebhook(task, secret, {
    now: new Date(builtAtMs),
    eventId,
  });
}

/** The built payload with `eventId` removed (signed over the keyless bytes). */
function keylessBody(builtAtMs: number): {
  bodyString: string;
  signature: string;
} {
  const task = toPaid(`task-strict-verify-keyless-${builtAtMs}`);
  const { payload } = buildPayoutWebhook(task, SECRET, {
    now: new Date(builtAtMs),
    eventId: "evt-strict-verify-keyless",
  });
  const { eventId: _dropped, ...noId } = payload;
  const bodyString = JSON.stringify(noId);
  return { bodyString, signature: signBody(bodyString) };
}

test("strict defaults are the documented safe values", () => {
  assert.equal(STRICT_PAYOUT_WEBHOOK_MAX_AGE_MS, 300_000);
  assert.equal(STRICT_PAYOUT_WEBHOOK_MAX_FUTURE_SKEW_MS, 60_000);
});

test("strict: fresh keyed correctly-signed payload verifies (string and object)", () => {
  const { payload, signature } = keyedBody(NOW);
  assert.equal(
    verifyPayoutWebhookStrict(JSON.stringify(payload), signature, SECRET, {
      now: new Date(NOW),
    }),
    true,
  );
  assert.equal(
    verifyPayoutWebhookStrict(payload, signature, SECRET, {
      now: new Date(NOW),
    }),
    true,
  );
  // No `now` either: the real clock is long past the fixed build time,
  // so this only pins that the call does not throw without opts.
  assert.equal(
    typeof verifyPayoutWebhookStrict(
      JSON.stringify(payload),
      signature,
      SECRET,
    ),
    "boolean",
  );
});

test("strict: payload older than 5 minutes is rejected", () => {
  const { payload, signature } = keyedBody(NOW - 10 * 60_000);
  // The signature itself is valid — only the strict age gate rejects it.
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
  assert.equal(
    verifyPayoutWebhookStrict(JSON.stringify(payload), signature, SECRET, {
      now: new Date(NOW),
    }),
    false,
  );
  assert.equal(
    verifyPayoutWebhookStrict(payload, signature, SECRET, {
      now: new Date(NOW),
    }),
    false,
  );
});

test("strict: payload more than 60 seconds in the future is rejected", () => {
  const { payload, signature } = keyedBody(NOW + 2 * 60_000);
  // Under `maxAgeMs` alone a future timestamp passes; strict bounds it.
  assert.equal(
    verifyPayoutWebhook(payload, signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      now: new Date(NOW),
    }),
    true,
  );
  assert.equal(
    verifyPayoutWebhookStrict(JSON.stringify(payload), signature, SECRET, {
      now: new Date(NOW),
    }),
    false,
  );
});

test("strict: signed payload without eventId fails closed (string and object)", () => {
  const { bodyString, signature } = keylessBody(NOW);
  assert.equal(
    verifyPayoutWebhookStrict(bodyString, signature, SECRET, {
      now: new Date(NOW),
    }),
    false,
  );
  const parsed = JSON.parse(bodyString) as PayoutWebhookPayload;
  assert.equal(
    verifyPayoutWebhookStrict(parsed, signature, SECRET, {
      now: new Date(NOW),
    }),
    false,
  );
});

test("strict: empty-string eventId fails closed", () => {
  const { payload } = keyedBody(NOW);
  const body = { ...payload, eventId: "" };
  const bodyString = JSON.stringify(body);
  assert.equal(
    verifyPayoutWebhookStrict(bodyString, signBody(bodyString), SECRET, {
      now: new Date(NOW),
    }),
    false,
  );
});

test("strict: non-string eventId fails closed", () => {
  const { payload } = keyedBody(NOW);
  const body = { ...payload, eventId: 42 } as unknown as PayoutWebhookPayload;
  const bodyString = JSON.stringify(body);
  assert.equal(
    verifyPayoutWebhookStrict(bodyString, signBody(bodyString), SECRET, {
      now: new Date(NOW),
    }),
    false,
  );
});

test("strict: explicit maxAgeMs override is honored", () => {
  const { payload, signature } = keyedBody(NOW - 10 * 60_000);
  // 10 minutes old: past the 5-minute default, inside an explicit hour.
  assert.equal(
    verifyPayoutWebhookStrict(JSON.stringify(payload), signature, SECRET, {
      maxAgeMs: ONE_HOUR,
      now: new Date(NOW),
    }),
    true,
  );
  // And a tighter explicit window still rejects it.
  assert.equal(
    verifyPayoutWebhookStrict(JSON.stringify(payload), signature, SECRET, {
      maxAgeMs: 60_000,
      now: new Date(NOW),
    }),
    false,
  );
});

test("strict: explicit maxFutureSkewMs override is honored", () => {
  const { payload, signature } = keyedBody(NOW + 2 * 60_000);
  assert.equal(
    verifyPayoutWebhookStrict(JSON.stringify(payload), signature, SECRET, {
      maxFutureSkewMs: 5 * 60_000,
      now: new Date(NOW),
    }),
    true,
  );
});

test("strict: explicit requireEventId: false keeps the freshness gates", () => {
  const { bodyString, signature } = keylessBody(NOW);
  // Keyless but fresh: the age/future gates still pass without the key.
  assert.equal(
    verifyPayoutWebhookStrict(bodyString, signature, SECRET, {
      requireEventId: false,
      now: new Date(NOW),
    }),
    true,
  );
  // Keyless and stale: the age gate still rejects.
  const stale = keylessBody(NOW - 10 * 60_000);
  assert.equal(
    verifyPayoutWebhookStrict(stale.bodyString, stale.signature, SECRET, {
      requireEventId: false,
      now: new Date(NOW),
    }),
    false,
  );
});

test("legacy verifyPayoutWebhook() still accepts the same old/keyless payloads", () => {
  const { payload, signature } = keyedBody(NOW - 10 * 60_000);
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
  const { bodyString, signature: keylessSignature } = keylessBody(NOW);
  assert.equal(
    verifyPayoutWebhook(bodyString, keylessSignature, SECRET),
    true,
  );
});

test("strict: explicit maxAgeMs: undefined with requireEventId: false throws", () => {
  const { payload, signature } = keyedBody(NOW);
  // The repo compiles with `exactOptionalPropertyTypes`, so a typed
  // caller cannot even write `maxAgeMs: undefined` — the cast below
  // stands in for a JavaScript caller, which is who the runtime guard
  // protects.
  const downgradeOpts = {
    maxAgeMs: undefined,
    requireEventId: false,
    now: new Date(NOW),
  } as unknown as VerifyPayoutWebhookOptions;
  assert.throws(
    () =>
      verifyPayoutWebhookStrict(
        JSON.stringify(payload),
        signature,
        SECRET,
        downgradeOpts,
      ),
    /cannot verify payout webhook \(strict\): maxAgeMs must not be explicitly disabled while requireEventId is false/,
  );
  // Both windows explicitly disabled the same way throws too.
  const bothDisabledOpts = {
    maxAgeMs: undefined,
    maxFutureSkewMs: undefined,
    requireEventId: false,
    now: new Date(NOW),
  } as unknown as VerifyPayoutWebhookOptions;
  assert.throws(
    () =>
      verifyPayoutWebhookStrict(
        JSON.stringify(payload),
        signature,
        SECRET,
        bothDisabledOpts,
      ),
    /cannot verify payout webhook \(strict\): maxAgeMs must not be explicitly disabled while requireEventId is false/,
  );
});

test("strict: explicit maxAgeMs: undefined alone falls back to the 5-minute default", () => {
  // Same `exactOptionalPropertyTypes` cast as the guard test above:
  // this stands in for a JavaScript caller passing an explicit
  // `undefined` for the window while leaving the eventId gate on.
  const unsetAgeOpts = {
    maxAgeMs: undefined,
    now: new Date(NOW),
  } as unknown as VerifyPayoutWebhookOptions;
  const fresh = keyedBody(NOW);
  assert.equal(
    verifyPayoutWebhookStrict(
      JSON.stringify(fresh.payload),
      fresh.signature,
      SECRET,
      unsetAgeOpts,
    ),
    true,
  );
  const stale = keyedBody(NOW - 10 * 60_000);
  assert.equal(
    verifyPayoutWebhookStrict(
      JSON.stringify(stale.payload),
      stale.signature,
      SECRET,
      unsetAgeOpts,
    ),
    false,
  );
});

test("strict: inclusive boundaries — exactly 5 minutes old and exactly 60 seconds future pass", () => {
  const ageEdge = keyedBody(NOW - FIVE_MINUTES);
  assert.equal(
    verifyPayoutWebhookStrict(
      JSON.stringify(ageEdge.payload),
      ageEdge.signature,
      SECRET,
      { now: new Date(NOW) },
    ),
    true,
  );
  const ageOver = keyedBody(NOW - FIVE_MINUTES - 1);
  assert.equal(
    verifyPayoutWebhookStrict(
      JSON.stringify(ageOver.payload),
      ageOver.signature,
      SECRET,
      { now: new Date(NOW) },
    ),
    false,
  );
  const futureEdge = keyedBody(NOW + 60_000);
  assert.equal(
    verifyPayoutWebhookStrict(
      JSON.stringify(futureEdge.payload),
      futureEdge.signature,
      SECRET,
      { now: new Date(NOW) },
    ),
    true,
  );
  const futureOver = keyedBody(NOW + 60_001);
  assert.equal(
    verifyPayoutWebhookStrict(
      JSON.stringify(futureOver.payload),
      futureOver.signature,
      SECRET,
      { now: new Date(NOW) },
    ),
    false,
  );
});

test("strict: composes with secret rotation", () => {
  const keyed = keyedBody(NOW, OLD_SECRET, "evt-strict-verify-rotation");
  assert.equal(
    verifyPayoutWebhookStrict(
      JSON.stringify(keyed.payload),
      keyed.signature,
      undefined,
      { secrets: [SECRET, OLD_SECRET], now: new Date(NOW) },
    ),
    true,
  );
  // A keyless body signed with the old secret still fails the eventId gate.
  const { eventId: _dropped, ...noId } = keyed.payload;
  const keylessString = JSON.stringify(noId);
  assert.equal(
    verifyPayoutWebhookStrict(
      keylessString,
      signBody(keylessString, OLD_SECRET),
      undefined,
      { secrets: [SECRET, OLD_SECRET], now: new Date(NOW) },
    ),
    false,
  );
});

test("strict: unknown option keys and illegal values still throw", () => {
  const { payload, signature } = keyedBody(NOW);
  assert.throws(
    () =>
      verifyPayoutWebhookStrict(JSON.stringify(payload), signature, SECRET, {
        maxAge: ONE_HOUR,
        now: new Date(NOW),
      } as unknown as Parameters<typeof verifyPayoutWebhookStrict>[3]),
    /cannot verify payout webhook: unknown option "maxAge"/,
  );
  assert.throws(
    () =>
      verifyPayoutWebhookStrict(JSON.stringify(payload), signature, SECRET, {
        maxAgeMs: -1,
        now: new Date(NOW),
      }),
    /cannot verify payout webhook: maxAgeMs must be a finite non-negative number/,
  );
  assert.throws(
    () =>
      verifyPayoutWebhookStrict(JSON.stringify(payload), signature, SECRET, {
        requireEventId: "yes" as unknown as boolean,
        now: new Date(NOW),
      }),
    /cannot verify payout webhook: requireEventId must be a boolean/,
  );
});
