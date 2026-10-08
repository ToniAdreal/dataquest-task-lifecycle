import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * PAYOUT_COMPLETE settlement webhook signing (backlog #111): the
 * dataquest-side peer of escrow's webhooks.ts (#40/#99/#100).
 *
 * Rules under test:
 *  - buildPayoutWebhook only accepts PAID tasks; the payload derives
 *    everything from the task's audit history (the PAYOUT_COMPLETE entry
 *    that moved it to PAID) — nothing is invented
 *  - payload has a fixed literal key order, eventId defaults to a UUID v4,
 *    and injected eventId/now values make signatures byte-deterministic
 *  - verifyPayoutWebhook returns true only for an exact HMAC-SHA256 match
 *    (`sha256=<hex>`, constant-time compare); tampering with any field or
 *    the secret fails; malformed signatures fail closed (false, no throw)
 *  - empty secrets and bad injected options are caller configuration
 *    errors that throw up front, never silently pass
 */

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(id: string, opts: { payoutRef?: string; payoutAmount?: number } = {}): TaskLifecycle {
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
    ...(opts.payoutAmount !== undefined ? { payoutAmount: opts.payoutAmount } : {}),
  });
  assert.equal(t.state, "PAID");
  return t;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("payload derives everything from the audit history, in fixed key order", () => {
  const task = toPaid("task-042", { payoutRef: "xfer-88f2", payoutAmount: 10098.5 });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t");
  assert.deepEqual(Object.keys(payload), [
    "event",
    "taskId",
    "payoutRef",
    "payoutAmount",
    "at",
    "eventId",
  ]);
  assert.equal(payload.event, "PAYOUT_COMPLETE");
  assert.equal(payload.taskId, "task-042");
  assert.equal(payload.payoutRef, "xfer-88f2");
  assert.equal(payload.payoutAmount, 10098.5);
  assert.ok(!Number.isNaN(Date.parse(payload.at)), "at is parseable ISO-8601");
  assert.match(payload.eventId, UUID_V4);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
});

test("default eventId is a unique UUID v4 per build", () => {
  const task = toPaid("task-uuid");
  const a = buildPayoutWebhook(task, "s3cr3t").payload.eventId;
  const b = buildPayoutWebhook(task, "s3cr3t").payload.eventId;
  assert.match(a, UUID_V4);
  assert.match(b, UUID_V4);
  assert.notEqual(a, b, "two independent builds get different eventIds");
});

test("injected eventId + now make the signature byte-deterministic", () => {
  const task = toPaid("task-det", { payoutRef: "xfer-1" });
  const opts = { eventId: "evt-123", now: new Date("2026-10-08T10:00:00.000Z") };
  const a = buildPayoutWebhook(task, "s3cr3t", opts);
  const b = buildPayoutWebhook(task, "s3cr3t", opts);
  assert.equal(a.signature, b.signature);
  assert.equal(a.payload.eventId, "evt-123");
  assert.equal(a.payload.at, "2026-10-08T10:00:00.000Z");
});

test("verify passes for raw-body string and object bodies", () => {
  const task = toPaid("task-verify");
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t");
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
  assert.equal(verifyPayoutWebhook(payload, signature, "s3cr3t"), true);
});

test("tampering with any payload field or the secret fails verification", () => {
  const task = toPaid("task-tamper", { payoutRef: "xfer-9", payoutAmount: 500 });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t");
  const raw = JSON.stringify(payload);
  assert.equal(
    verifyPayoutWebhook(raw.replace(payload.eventId, "00000000-0000-0000-0000-000000000000"), signature, "s3cr3t"),
    false,
    "tampered eventId",
  );
  assert.equal(
    verifyPayoutWebhook({ ...payload, payoutRef: "xfer-evil" }, signature, "s3cr3t"),
    false,
    "tampered payoutRef",
  );
  assert.equal(
    verifyPayoutWebhook({ ...payload, payoutAmount: 999999 }, signature, "s3cr3t"),
    false,
    "tampered payoutAmount",
  );
  assert.equal(
    verifyPayoutWebhook({ ...payload, taskId: "task-evil" }, signature, "s3cr3t"),
    false,
    "tampered taskId",
  );
  assert.equal(verifyPayoutWebhook(raw, signature, "wrong-secret"), false, "wrong secret");
  assert.equal(verifyPayoutWebhook(raw, signature, Buffer.from("wrong-secret")), false, "wrong Buffer secret");
});

test("Buffer secret works on both sides", () => {
  const task = toPaid("task-buf");
  const { payload, signature } = buildPayoutWebhook(task, Buffer.from("s3cr3t"), {
    eventId: "evt-buf",
  });
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, Buffer.from("s3cr3t")),
    true,
  );
});

test("malformed signatures fail closed, never throw", () => {
  const task = toPaid("task-malformed");
  const { payload } = buildPayoutWebhook(task, "s3cr3t");
  for (const bad of [
    "",
    "sha256=",
    "sha256=zzz",
    "md5=" + "0".repeat(32),
    "SHA256=" + "0".repeat(64),
    "sha256=" + "0".repeat(63),
    "sha256=" + "0".repeat(65),
    "sha256=" + "G".repeat(64),
  ]) {
    assert.equal(
      verifyPayoutWebhook(JSON.stringify(payload), bad, "s3cr3t"),
      false,
      `expected false for ${JSON.stringify(bad)}`,
    );
  }
});

test("non-PAID tasks cannot build a webhook", () => {
  const open = new TaskLifecycle("task-open");
  open.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(open.state, "OPEN");
  assert.throws(
    () => buildPayoutWebhook(open, "s3cr3t"),
    /cannot build payout webhook: task task-open is in state OPEN, only PAID tasks/,
  );
  // Sanity: a pending payout (PAYOUT_PENDING) is still not announced —
  // only the PAID terminal state has a settlement to report.
  const t = new TaskLifecycle("task-pending");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.equal(t.state, "PAYOUT_PENDING");
  assert.throws(
    () => buildPayoutWebhook(t, "s3cr3t"),
    /cannot build payout webhook: task task-pending is in state PAYOUT_PENDING/,
  );
});

test("empty secret is a caller configuration error on both sides", () => {
  const task = toPaid("task-secret");
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t");
  assert.throws(
    () => buildPayoutWebhook(task, ""),
    /cannot build payout webhook: signing secret must not be empty/,
  );
  assert.throws(
    () => buildPayoutWebhook(task, Buffer.alloc(0)),
    /cannot build payout webhook: signing secret must not be empty/,
  );
  assert.throws(
    () => verifyPayoutWebhook(JSON.stringify(payload), signature, ""),
    /cannot verify payout webhook: signing secret must not be empty/,
  );
});

test("bad injected options throw configuration errors", () => {
  const task = toPaid("task-opts");
  assert.throws(
    () => buildPayoutWebhook(task, "s3cr3t", { eventId: "" }),
    /cannot build payout webhook: 'eventId' must be a non-empty string/,
  );
  assert.throws(
    () => buildPayoutWebhook(task, "s3cr3t", { eventId: 123 as unknown as string }),
    /cannot build payout webhook: 'eventId' must be a non-empty string/,
  );
  assert.throws(
    () => buildPayoutWebhook(task, "s3cr3t", { now: "not-a-date" }),
    /cannot build payout webhook: invalid 'now' timestamp/,
  );
});

test("PAID task with no ref/amount still builds, fields omitted", () => {
  const task = toPaid("task-bare");
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t");
  assert.deepEqual(Object.keys(payload), ["event", "taskId", "at", "eventId"]);
  assert.ok(!("payoutRef" in payload) && !("payoutAmount" in payload));
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
});

test("signature is not accidentally cross-repo compatible with escrow's", () => {
  // The event namespace differs (PAYOUT_COMPLETE vs escrow.settled); this
  // just pins that the payload genuinely carries this repo's event name.
  const task = toPaid("task-ns");
  const { payload } = buildPayoutWebhook(task, "s3cr3t");
  assert.equal(payload.event, "PAYOUT_COMPLETE");
  assert.ok(!("escrowId" in payload));
});
