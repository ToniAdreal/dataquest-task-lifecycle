import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
  type BuildPayoutWebhookOptions,
  type VerifyPayoutWebhookOptions,
} from "../src/index.js";

/**
 * Unknown options keys on the payout-webhook sign/verify pair
 * (backlog #1273): both entry points read only their documented
 * fields, so a typo'd key was silently dropped — a typo'd
 * `requirePayoutAmout` left the "no reference, no notification" gate
 * off while the caller believed it was on, and a typo'd `maxAge`
 * left the replay window unset. Both now fail closed with the
 * misspelled key in the message, before any signing or verification
 * work happens.
 *
 * Rules under test:
 * - build: `requirePayoutAmout` / `webhookUrl` / `EventId` each throw
 *   `cannot build payout webhook: unknown option "<key>"`
 * - verify: `maxAge` / `secret` / `MaxAgeMs` each throw
 *   `cannot verify payout webhook: unknown option "<key>"`
 * - the scan runs first: an unknown key is reported even on a
 *   non-PAID task (build) and even with a forged signature (verify),
 *   and no signature is produced or checked in those cases
 * - every documented key still works, in full combination, on both
 *   sides; `{}` is a valid control on both sides
 * - `null` / array options keep their pre-#1273 behavior (a bare
 *   `TypeError` for `null`, empty-options behavior for an array)
 */

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(
  id: string,
  opts: { payoutRef?: string; payoutAmount?: number } = {},
): TaskLifecycle {
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
    ...(opts.payoutRef !== undefined ? { payoutRef: opts.payoutRef } : {}),
    ...(opts.payoutAmount !== undefined
      ? { payoutAmount: opts.payoutAmount }
      : {}),
  });
  assert.equal(t.state, "PAID");
  return t;
}

/** A task that has left DRAFT but is not PAID. */
function toOpen(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(t.state, "OPEN");
  return t;
}

const SECRET = "s3cr3t";
const FIXED_NOW = new Date("2026-11-20T01:00:00.000Z");
const FIXED_EVENT_ID = "evt-1273-1";

function signedWebhook(task: TaskLifecycle): {
  body: string;
  signature: string;
} {
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  return { body: JSON.stringify(payload), signature };
}

test("build: near-miss requirePayoutAmout throws with the key named", () => {
  const task = toPaid("task-build-typo-gate", {
    payoutRef: "xfer-1",
    payoutAmount: 5000,
  });
  assert.throws(
    () =>
      buildPayoutWebhook(task, SECRET, {
        requirePayoutAmout: true,
      } as unknown as BuildPayoutWebhookOptions),
    /cannot build payout webhook: unknown option "requirePayoutAmout"/,
  );
});

test("build: fully unknown webhookUrl throws with the key named", () => {
  const task = toPaid("task-build-unknown", {
    payoutRef: "xfer-2",
    payoutAmount: 5000,
  });
  assert.throws(
    () =>
      buildPayoutWebhook(task, SECRET, {
        webhookUrl: "https://example.invalid/hook",
      } as unknown as BuildPayoutWebhookOptions),
    /cannot build payout webhook: unknown option "webhookUrl"/,
  );
});

test("build: case-variant EventId throws (keys are case-sensitive)", () => {
  const task = toPaid("task-build-case", {
    payoutRef: "xfer-3",
    payoutAmount: 5000,
  });
  assert.throws(
    () =>
      buildPayoutWebhook(task, SECRET, {
        EventId: FIXED_EVENT_ID,
      } as unknown as BuildPayoutWebhookOptions),
    /cannot build payout webhook: unknown option "EventId"/,
  );
});

test("build: empty object is a valid control, builds and verifies", () => {
  const task = toPaid("task-build-empty", {
    payoutRef: "xfer-4",
    payoutAmount: 5000,
  });
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {});
  assert.equal(payload.event, "PAYOUT_COMPLETE");
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET),
    true,
  );
});

test("build: all three documented keys together still build and verify", () => {
  const task = toPaid("task-build-all-keys", {
    payoutRef: "xfer-5",
    payoutAmount: 5000,
  });
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
    requirePayoutRef: true,
  });
  assert.equal(payload.at, "2026-11-20T01:00:00.000Z");
  assert.equal(payload.eventId, FIXED_EVENT_ID);
  assert.equal(payload.payoutRef, "xfer-5");
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET),
    true,
  );
});

test("build: unknown key is reported before the non-PAID state error", () => {
  const task = toOpen("task-build-open");
  assert.throws(
    () =>
      buildPayoutWebhook(task, SECRET, {
        requirePayoutAmout: true,
      } as unknown as BuildPayoutWebhookOptions),
    /cannot build payout webhook: unknown option "requirePayoutAmout"/,
  );
});

test("build: null options keep the pre-#1273 bare TypeError", () => {
  const task = toPaid("task-build-null", {
    payoutRef: "xfer-6",
    payoutAmount: 5000,
  });
  assert.throws(
    () =>
      buildPayoutWebhook(
        task,
        SECRET,
        null as unknown as BuildPayoutWebhookOptions,
      ),
    TypeError,
  );
});

test("build: array options behave like empty options", () => {
  const task = toPaid("task-build-array", {
    payoutRef: "xfer-7",
    payoutAmount: 5000,
  });
  const { payload, signature } = buildPayoutWebhook(
    task,
    SECRET,
    [] as unknown as BuildPayoutWebhookOptions,
  );
  assert.equal(payload.event, "PAYOUT_COMPLETE");
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET),
    true,
  );
});

test("verify: near-miss maxAge throws with the key named", () => {
  const task = toPaid("task-verify-typo-age", {
    payoutRef: "xfer-8",
    payoutAmount: 5000,
  });
  const { body, signature } = signedWebhook(task);
  assert.throws(
    () =>
      verifyPayoutWebhook(body, signature, SECRET, {
        maxAge: 1000,
      } as unknown as VerifyPayoutWebhookOptions),
    /cannot verify payout webhook: unknown option "maxAge"/,
  );
});

test("verify: fully unknown secret key throws with the key named", () => {
  const task = toPaid("task-verify-unknown", {
    payoutRef: "xfer-9",
    payoutAmount: 5000,
  });
  const { body, signature } = signedWebhook(task);
  assert.throws(
    () =>
      verifyPayoutWebhook(body, signature, SECRET, {
        secret: "s3cr3t",
      } as unknown as VerifyPayoutWebhookOptions),
    /cannot verify payout webhook: unknown option "secret"/,
  );
});

test("verify: case-variant MaxAgeMs throws (keys are case-sensitive)", () => {
  const task = toPaid("task-verify-case", {
    payoutRef: "xfer-10",
    payoutAmount: 5000,
  });
  const { body, signature } = signedWebhook(task);
  assert.throws(
    () =>
      verifyPayoutWebhook(body, signature, SECRET, {
        MaxAgeMs: 1000,
      } as unknown as VerifyPayoutWebhookOptions),
    /cannot verify payout webhook: unknown option "MaxAgeMs"/,
  );
});

test("verify: empty object is a valid control, signature verifies", () => {
  const task = toPaid("task-verify-empty", {
    payoutRef: "xfer-11",
    payoutAmount: 5000,
  });
  const { body, signature } = signedWebhook(task);
  assert.equal(verifyPayoutWebhook(body, signature, SECRET, {}), true);
});

test("verify: all five documented keys together still verify", () => {
  const task = toPaid("task-verify-all-keys", {
    payoutRef: "xfer-12",
    payoutAmount: 5000,
  });
  const { body, signature } = signedWebhook(task);
  assert.equal(
    verifyPayoutWebhook(body, signature, undefined, {
      secrets: [SECRET],
      maxAgeMs: 60_000,
      maxFutureSkewMs: 60_000,
      requireEventId: true,
      now: FIXED_NOW,
    }),
    true,
  );
});

test("verify: unknown key throws even with a forged signature (never false)", () => {
  const task = toPaid("task-verify-forged", {
    payoutRef: "xfer-13",
    payoutAmount: 5000,
  });
  const { body } = signedWebhook(task);
  const forged =
    "sha256=" +
    "00".repeat(32);
  assert.throws(
    () =>
      verifyPayoutWebhook(body, forged, SECRET, {
        maxAge: 1000,
      } as unknown as VerifyPayoutWebhookOptions),
    /cannot verify payout webhook: unknown option "maxAge"/,
  );
});

test("verify: null opts keep the pre-#1273 bare TypeError", () => {
  const task = toPaid("task-verify-null", {
    payoutRef: "xfer-14",
    payoutAmount: 5000,
  });
  const { body, signature } = signedWebhook(task);
  assert.throws(
    () =>
      verifyPayoutWebhook(
        body,
        signature,
        SECRET,
        null as unknown as VerifyPayoutWebhookOptions,
      ),
    TypeError,
  );
});

test("verify: array opts behave like empty options", () => {
  const task = toPaid("task-verify-array", {
    payoutRef: "xfer-15",
    payoutAmount: 5000,
  });
  const { body, signature } = signedWebhook(task);
  assert.equal(
    verifyPayoutWebhook(
      body,
      signature,
      SECRET,
      [] as unknown as VerifyPayoutWebhookOptions,
    ),
    true,
  );
});
