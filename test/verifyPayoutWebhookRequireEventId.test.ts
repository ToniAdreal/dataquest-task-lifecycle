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
 * `verifyPayoutWebhook` opt-in `requireEventId` (backlog #1177): the
 * dataquest-side peer of escrow's `verifySettlementWebhook`
 * `requireEventId` (#1174).
 *
 * Rules under test:
 *  - with `requireEventId: true`, a payload whose signature verifies
 *    but whose `eventId` is missing, not a string, or an empty string
 *    returns `false` (fail-closed) — a signed-but-keyless notification
 *    would otherwise leave a receiver that deduplicates on `eventId`
 *    with no key, silently defeating replay detection
 *  - the gate runs only after the signature matches: a forged
 *    signature still fails on the signature comparison, never here
 *  - without the option (the default) a keyless payload verifies on
 *    its signature alone (legacy behavior, unchanged)
 *  - an unparseable string body fails the same way, never throws
 *  - a non-boolean `requireEventId` is a caller configuration error
 *  - the gate composes with secret rotation and the freshness window
 */

const SECRET = "whsec_test_require_event_id_20261115";
const OLD_SECRET = "whsec_test_require_event_id_old_20261115";
const NOW = Date.parse("2026-11-15T10:00:00.000Z");
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
    payoutRef: "xfer-require-event-id",
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

/** The built payload with `eventId` removed (signed over the keyless bytes). */
function keylessBody(): { bodyString: string; signature: string } {
  const task = toPaid("task-require-event-id");
  const { payload } = buildPayoutWebhook(task, SECRET, {
    now: new Date(NOW),
    eventId: "evt-require-event-id",
  });
  const { eventId: _dropped, ...noId } = payload;
  const bodyString = JSON.stringify(noId);
  return { bodyString, signature: signBody(bodyString) };
}

/** A built payload carrying a fixed `eventId`, signed over its bytes. */
function keyedBody(): { payload: PayoutWebhookPayload; signature: string } {
  const task = toPaid("task-require-event-id-keyed");
  return buildPayoutWebhook(task, SECRET, {
    now: new Date(NOW),
    eventId: "evt-require-event-id",
  });
}

test("requireEventId: string body without eventId fails closed", () => {
  const { bodyString, signature } = keylessBody();
  assert.equal(
    verifyPayoutWebhook(bodyString, signature, SECRET, {
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: object body without eventId fails closed", () => {
  const { bodyString, signature } = keylessBody();
  const parsed = JSON.parse(bodyString) as PayoutWebhookPayload;
  assert.equal(
    verifyPayoutWebhook(parsed, signature, SECRET, {
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: empty-string eventId fails closed", () => {
  const { payload } = keyedBody();
  const body = { ...payload, eventId: "" };
  const bodyString = JSON.stringify(body);
  assert.equal(
    verifyPayoutWebhook(bodyString, signBody(bodyString), SECRET, {
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: non-string eventId fails closed", () => {
  const { payload } = keyedBody();
  const body = { ...payload, eventId: 42 } as unknown as PayoutWebhookPayload;
  const bodyString = JSON.stringify(body);
  assert.equal(
    verifyPayoutWebhook(bodyString, signBody(bodyString), SECRET, {
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: payload with eventId verifies (string and object)", () => {
  const { payload, signature } = keyedBody();
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET, {
      requireEventId: true,
    }),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(payload, signature, SECRET, {
      requireEventId: true,
    }),
    true,
  );
});

test("requireEventId off (default): keyless payload still verifies (legacy)", () => {
  const { bodyString, signature } = keylessBody();
  assert.equal(
    verifyPayoutWebhook(bodyString, signature, SECRET),
    true,
  );
  const parsed = JSON.parse(bodyString) as PayoutWebhookPayload;
  assert.equal(
    verifyPayoutWebhook(parsed, signature, SECRET, {
      requireEventId: false,
    }),
    true,
  );
});

test("requireEventId: forged signature fails on the signature, never reaches the gate", () => {
  const { bodyString } = keylessBody();
  // Signed with the wrong secret: the signature comparison fails first,
  // so the result is false for the forgery reason, not the missing key.
  assert.equal(
    verifyPayoutWebhook(bodyString, signBody(bodyString, "attacker-secret"), SECRET, {
      requireEventId: true,
    }),
    false,
  );
  // And a keyed payload under the wrong secret fails the same way.
  const { payload } = keyedBody();
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signBody(payload, "attacker-secret"), SECRET, {
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: wrong secret plus missing eventId still fails", () => {
  const { bodyString, signature } = keylessBody();
  assert.equal(
    verifyPayoutWebhook(bodyString, signature, "wrong-secret", {
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: composes with secret rotation", () => {
  const task = toPaid("task-require-event-id-rotation");
  const keyed = buildPayoutWebhook(task, OLD_SECRET, {
    now: new Date(NOW),
    eventId: "evt-require-event-id-rotation",
  });
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(keyed.payload), keyed.signature, undefined, {
      secrets: [SECRET, OLD_SECRET],
      requireEventId: true,
    }),
    true,
  );
  // Keyless body signed with the old secret fails the gate under rotation too.
  const { eventId: _dropped, ...noId } = keyed.payload;
  const keylessString = JSON.stringify(noId);
  assert.equal(
    verifyPayoutWebhook(keylessString, signBody(keylessString, OLD_SECRET), undefined, {
      secrets: [SECRET, OLD_SECRET],
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: unparseable string body fails closed, never throws", () => {
  const garbage = "{not json";
  assert.equal(
    verifyPayoutWebhook(garbage, signBody(garbage), SECRET, {
      requireEventId: true,
    }),
    false,
  );
  assert.equal(
    verifyPayoutWebhook("42", signBody("42"), SECRET, {
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: non-boolean value is a caller configuration error", () => {
  const { payload, signature } = keyedBody();
  for (const bad of ["yes", 1, null]) {
    assert.throws(
      () =>
        verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET, {
          requireEventId: bad as unknown as boolean,
        }),
      /cannot verify payout webhook: requireEventId must be a boolean, got /,
    );
  }
});

test("requireEventId: composes with the freshness window", () => {
  const { payload, signature } = keyedBody();
  // Fresh + keyed passes both gates.
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET, {
      requireEventId: true,
      maxAgeMs: ONE_HOUR,
      now: new Date(NOW),
    }),
    true,
  );
  // Stale + keyed fails on freshness (the eventId gate passed first).
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET, {
      requireEventId: true,
      maxAgeMs: ONE_HOUR,
      now: new Date(NOW + 2 * ONE_HOUR),
    }),
    false,
  );
  // Stale + keyless fails either way (the eventId gate fails first).
  const { bodyString, signature: keylessSignature } = keylessBody();
  assert.equal(
    verifyPayoutWebhook(bodyString, keylessSignature, SECRET, {
      requireEventId: true,
      maxAgeMs: ONE_HOUR,
      now: new Date(NOW + 2 * ONE_HOUR),
    }),
    false,
  );
});
