/**
 * Payout webhook: signed PAYOUT_COMPLETE settlement notifications.
 *
 * This repo previously had no out-of-process settlement notification:
 * `TaskLifecycle.subscribe()` is an in-process hook (see its docs and the
 * README Limitations section — "no durable notification fan-out"). This
 * module is the dataquest-side peer of the sibling
 * escrow-state-machine-ts `src/webhooks.ts` (backlog #40): it derives a
 * compact notification payload from a PAID task's audit history and signs
 * it with HMAC-SHA256, using the same `sha256=<hex>` header convention
 * GitHub webhooks use.
 *
 * Scope honesty (what this is NOT):
 * - Delivery is NOT included: this module builds and verifies, it does
 *   not HTTP POST anything. Retries/fan-out to multiple endpoints stay
 *   the caller's job (escrow has `deliverSettlementWebhook`; this repo
 *   does not, yet).
 * - Secret distribution is the caller's responsibility. Whoever holds the
 *   secret can forge signatures; store it like any other API credential.
 * - `verifyPayoutWebhook` should run over the raw request body bytes. A
 *   parsed object is re-stringified (byte-identical in-process because the
 *   payload is built with a fixed literal key order), but raw bytes are
 *   the transport-safe path.
 * - Only PAID tasks build a webhook. A PAID task whose PAYOUT_COMPLETE
 *   entry carries no `payoutRef`/`payoutAmount` still builds (the payload
 *   just omits those fields) — consistent with the advisory semantics of
 *   both fields: the library cannot observe the external payment, so a
 *   missing reference is unevidenced, not a build-time failure.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { TaskHistoryEntry, TaskLifecycle } from "./taskLifecycle.js";

/**
 * Compact machine-readable payout notification. Every figure is derived
 * from the task's audit history (the PAYOUT_COMPLETE entry that moved it
 * to PAID): nothing is invented here.
 */
export interface PayoutWebhookPayload {
  event: "PAYOUT_COMPLETE";
  taskId: string;
  /** External payment reference from the PAYOUT_COMPLETE entry; omitted when absent. */
  payoutRef?: string;
  /** Settled payout amount from the PAYOUT_COMPLETE entry; omitted when absent. */
  payoutAmount?: number;
  /** ISO-8601 timestamp of when the payload was built. */
  at: string;
  /**
   * Unique delivery ID for this notification. Receivers MUST deduplicate on
   * `eventId`: a future delivery layer with retries would re-POST the same
   * logical event more than once, and two independent payouts always get
   * different `eventId`s.
   */
  eventId: string;
}

/** A signed payout webhook: payload + `sha256=<hex>` signature. */
export interface PayoutWebhook {
  payload: PayoutWebhookPayload;
  /** `sha256=<hex>` — same shape as the X-Hub-Signature-256 header. */
  signature: string;
}

/** Options for {@link buildPayoutWebhook}. All fields optional. */
export interface BuildPayoutWebhookOptions {
  /**
   * Payload `at` timestamp. Defaults to the real clock; inject a fixed
   * value in tests to make signatures deterministic.
   */
  now?: Date | string;
  /**
   * Payload `eventId`. Defaults to `crypto.randomUUID()`; inject a fixed
   * value in tests to make signatures deterministic. Must be a non-empty
   * string when provided.
   */
  eventId?: string;
}

function assertSecret(secret: string | Buffer): void {
  if (secret.length === 0) {
    throw new Error(
      "cannot build payout webhook: signing secret must not be empty",
    );
  }
}

/**
 * Fixed-literal-key-order serialization. The payload object is constructed
 * below with one literal key order (`event`, `taskId`, `payoutRef`,
 * `payoutAmount`, `at`, `eventId`), so `JSON.stringify` is deterministic;
 * the same deterministic serialization is what the signature covers.
 */
function canonicalJson(payload: PayoutWebhookPayload): string {
  return JSON.stringify(payload);
}

function sign(body: string, secret: string | Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Find the PAYOUT_COMPLETE entry that moved the task to PAID (same
 * "the entry that evidences the settlement" rule as `unreconciledPayouts`
 * and `totalPaidOut`). Defensive: unreachable through dispatch/fromJSON/
 * fromHistory without one, but a missing entry is not a build failure —
 * the ref/amount fields are advisory and simply omitted.
 */
function completionEntry(task: TaskLifecycle): TaskHistoryEntry | undefined {
  let complete: TaskHistoryEntry | undefined;
  for (const entry of task.history) {
    if (entry.event === "PAYOUT_COMPLETE") complete = entry;
  }
  return complete;
}

/**
 * Build the signed payout webhook for a PAID task.
 *
 * Throws when the task is not PAID, the secret is empty, `now` is not a
 * valid timestamp, or an injected `eventId` is not a non-empty string.
 */
export function buildPayoutWebhook(
  task: TaskLifecycle,
  secret: string | Buffer,
  options: BuildPayoutWebhookOptions = {},
): PayoutWebhook {
  if (task.state !== "PAID") {
    throw new Error(
      `cannot build payout webhook: task ${task.id} is in state ${task.state}, only PAID tasks have a completed settlement to announce`,
    );
  }
  assertSecret(secret);

  const when = options.now === undefined ? new Date() : new Date(options.now);
  if (Number.isNaN(when.getTime())) {
    throw new Error(
      `cannot build payout webhook: invalid 'now' timestamp for task ${task.id}`,
    );
  }
  const at = when.toISOString();

  if (
    options.eventId !== undefined &&
    (typeof options.eventId !== "string" || options.eventId.length === 0)
  ) {
    throw new Error(
      `cannot build payout webhook: 'eventId' must be a non-empty string for task ${task.id}`,
    );
  }
  const eventId = options.eventId ?? randomUUID();

  const complete = completionEntry(task);
  // Fixed literal key order — this order IS the signed serialization.
  const payload: PayoutWebhookPayload = {
    event: "PAYOUT_COMPLETE",
    taskId: task.id,
    ...(complete?.payoutRef !== undefined ? { payoutRef: complete.payoutRef } : {}),
    ...(complete?.payoutAmount !== undefined
      ? { payoutAmount: complete.payoutAmount }
      : {}),
    at,
    eventId,
  };
  const signature = sign(canonicalJson(payload), secret);
  return { payload, signature };
}

/**
 * Verify a payout webhook signature. Returns `true` only when the
 * signature matches the HMAC-SHA256 of the given body under the secret.
 *
 * Prefer passing the raw body `string`; a parsed object is re-stringified
 * (fine in-process, but raw bytes are the safe transport path).
 * Malformed signatures return `false` rather than throwing, so a hostile
 * input can never turn verification into an unhandled exception. The
 * comparison runs in constant time (`timingSafeEqual`).
 *
 * Note: `eventId` is not validated separately — it is part of the signed
 * body, so any tampering with it breaks the signature check above.
 */
export function verifyPayoutWebhook(
  body: string | PayoutWebhookPayload,
  signature: string,
  secret: string | Buffer,
): boolean {
  if (secret.length === 0) {
    throw new Error(
      "cannot verify payout webhook: signing secret must not be empty",
    );
  }
  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;
  const bodyString = typeof body === "string" ? body : canonicalJson(body);
  const actual = Buffer.from(match[1], "hex");
  const expected = Buffer.from(
    createHmac("sha256", secret).update(bodyString, "utf8").digest(),
  );
  // timingSafeEqual throws on length mismatch; a forged 64-hex string that
  // decodes short (never, given the regex) or long is simply a failure.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
