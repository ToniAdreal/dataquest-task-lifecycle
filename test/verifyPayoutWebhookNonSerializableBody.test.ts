import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
} from "../src/index.js";
import type { PayoutWebhookPayload } from "../src/index.js";

// Backlog #1318: an object body that cannot be serialized (BigInt values,
// circular references, a throwing `toJSON`) must fail closed as `false`,
// never turn verification into an unhandled exception. The JSDoc promise
// is "a hostile input can never turn verification into an unhandled
// exception"; before this fix `canonicalJson` (bare `JSON.stringify`)
// threw a bare `TypeError` (or rethrew the `toJSON` error) out of
// `verifyPayoutWebhook`. The dataquest-side peer of escrow's
// `verifySettlementWebhook` fix (#1317).

const SECRET = "whsec_test_non_serializable_body_20261121";
const NOW = Date.parse("2026-11-21T10:00:00.000Z");

/** Any well-formed `sha256=<64 hex>` signature: passes the shape regex. */
const WELL_FORMED_SIGNATURE = "sha256=" + "ab".repeat(32);

/** Cast a hostile shape past the payload type: the runtime accepts any object. */
function hostileBody(value: unknown): PayoutWebhookPayload {
  return value as PayoutWebhookPayload;
}

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
    payoutRef: "xfer-non-serializable-body",
    payoutAmount: 10098.5,
  });
  assert.equal(t.state, "PAID");
  return t;
}

test("BigInt value in object body returns false, never throws", () => {
  const body = hostileBody({
    event: "PAYOUT_COMPLETE",
    taskId: "task-bigint",
    at: "2026-11-21T10:00:00.000Z",
    payoutAmount: 10n,
  });
  assert.equal(
    verifyPayoutWebhook(body, WELL_FORMED_SIGNATURE, SECRET),
    false,
  );
});

test("nested BigInt value in object body returns false, never throws", () => {
  const body = hostileBody({
    event: "PAYOUT_COMPLETE",
    taskId: "task-bigint-nested",
    at: "2026-11-21T10:00:00.000Z",
    quotedAmount: { amount: 10n },
  });
  assert.equal(
    verifyPayoutWebhook(body, WELL_FORMED_SIGNATURE, SECRET),
    false,
  );
});

test("circular reference in object body returns false, never throws", () => {
  const body = { event: "PAYOUT_COMPLETE", taskId: "task-circular" } as Record<
    string,
    unknown
  >;
  body.self = body;
  assert.equal(
    verifyPayoutWebhook(
      body as unknown as PayoutWebhookPayload,
      WELL_FORMED_SIGNATURE,
      SECRET,
    ),
    false,
  );
});

test("nested circular reference in object body returns false, never throws", () => {
  const inner = { taskId: "task-circular-nested" } as Record<string, unknown>;
  inner.parent = { child: inner };
  const body = hostileBody({
    event: "PAYOUT_COMPLETE",
    taskId: "task-circular-nested",
    at: "2026-11-21T10:00:00.000Z",
    nested: inner,
  });
  assert.equal(
    verifyPayoutWebhook(body, WELL_FORMED_SIGNATURE, SECRET),
    false,
  );
});

test("throwing toJSON in object body returns false, never throws", () => {
  const body = hostileBody({
    event: "PAYOUT_COMPLETE",
    taskId: "task-tojson-throws",
    at: "2026-11-21T10:00:00.000Z",
    toJSON() {
      throw new Error("hostile toJSON");
    },
  });
  assert.equal(
    verifyPayoutWebhook(body, WELL_FORMED_SIGNATURE, SECRET),
    false,
  );
});

test("malformed signature plus BigInt body still returns false, never throws", () => {
  const body = hostileBody({
    event: "PAYOUT_COMPLETE",
    taskId: "task-bigint-bad-sig",
    at: "2026-11-21T10:00:00.000Z",
    payoutAmount: 10n,
  });
  // The shape regex rejects this before serialization is ever attempted.
  assert.equal(verifyPayoutWebhook(body, "not-a-signature", SECRET), false);
  assert.equal(verifyPayoutWebhook(body, "sha256=zz", SECRET), false);
});

test("non-serializable body with options form returns false, never throws", () => {
  const body = hostileBody({
    event: "PAYOUT_COMPLETE",
    taskId: "task-bigint-options",
    at: "2026-11-21T10:00:00.000Z",
    payoutAmount: 10n,
  });
  assert.equal(
    verifyPayoutWebhook(body, WELL_FORMED_SIGNATURE, undefined, {
      secrets: [SECRET],
      requireEventId: true,
      maxAgeMs: 3_600_000,
      now: new Date(NOW),
    }),
    false,
  );
});

test("valid object body still verifies true (regression)", () => {
  const { payload, signature } = buildPayoutWebhook(
    toPaid("task-non-serializable-body-valid"),
    SECRET,
    {
      now: new Date(NOW),
      eventId: "evt-non-serializable-body-valid",
    },
  );
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
});

test("string body behavior is unchanged (regression)", () => {
  const { payload, signature } = buildPayoutWebhook(
    toPaid("task-non-serializable-body-string"),
    SECRET,
    {
      now: new Date(NOW),
      eventId: "evt-non-serializable-body-string",
    },
  );
  const bodyString = JSON.stringify(payload);
  assert.equal(verifyPayoutWebhook(bodyString, signature, SECRET), true);
  // A tampered string body still fails on the signature, never throws.
  assert.equal(
    verifyPayoutWebhook(bodyString + " ", signature, SECRET),
    false,
  );
});

test("configuration errors still throw (guard is verification-only)", () => {
  const body = hostileBody({
    event: "PAYOUT_COMPLETE",
    taskId: "task-bigint-config",
    at: "2026-11-21T10:00:00.000Z",
    payoutAmount: 10n,
  });
  assert.throws(
    () =>
      verifyPayoutWebhook(body, WELL_FORMED_SIGNATURE, undefined, {
        secrets: [],
      }),
    /secrets must be a non-empty array/,
  );
});
