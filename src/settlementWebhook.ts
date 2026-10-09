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
 * - Delivery IS included via {@link deliverPayoutWebhook}: a single-endpoint
 *   HTTP POST of the signed payload with the `X-Hub-Signature-256` header, a
 *   per-attempt timeout, and exponential-backoff retries on 429, 5xx, and
 *   network errors (a 429 `Retry-After` hint is honored, clamped to
 *   `maxRetryDelayMs`). Fan-out to multiple endpoints stays the caller's
 *   job — call it once per endpoint.
 * - Secret distribution is the caller's responsibility. Whoever holds the
 *   secret can forge signatures; store it like any other API credential.
 * - `verifyPayoutWebhook` should run over the raw request body bytes. A
 *   parsed object is re-stringified (byte-identical in-process because the
 *   payload is built with a fixed literal key order), but raw bytes are
 *   the transport-safe path. Verification is signature-only by default;
 *   an opt-in `maxAgeMs` freshness window additionally bounds replays of
 *   legitimately-signed old payloads, but receivers must still
 *   deduplicate on `eventId`. During a secret rotation window the
 *   receiver can pass `secrets: [newSecret, oldSecret]` instead of a
 *   single secret (the two shapes are mutually exclusive) so in-flight
 *   notifications signed with either secret verify; signing always uses
 *   the single current secret.
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

/** Options for {@link verifyPayoutWebhook}. All fields optional. */
export interface VerifyPayoutWebhookOptions {
  /**
   * Candidate HMAC secrets for a secret-rotation window: pass
   * `[newSecret, oldSecret]` so notifications signed with either secret
   * verify while senders migrate to the new one (the dataquest-side peer
   * of escrow's `VerifyWebhookOptions.secrets`). Any one matching secret
   * authenticates; the array order is only a performance preference (put
   * the newest first), never a security one — all-mismatch fails closed
   * as `false`. Must be a non-empty array of non-empty secrets; an empty
   * array, a non-array value, or an empty/non-string entry is a caller
   * configuration error and throws. Mutually exclusive with the
   * positional `secret` argument: pass one shape or the other, never
   * both (passing both throws, mirroring the rfc9421-signing-demo
   * `key`/`keyResolver` rule). Rotation never relaxes freshness: a
   * `maxAgeMs` window, when also set, is still enforced after the
   * signature matches. How long the old secret stays in the list — the
   * rotation window length — is the caller's policy, not this library's.
   */
  secrets?: (string | Buffer)[];
  /**
   * Maximum age of the payload in milliseconds, measured from the
   * payload `at` timestamp to `now`. When set, a payload whose
   * signature verifies but whose `at` is older than this window returns
   * `false` (fail-closed): this bounds replays of legitimately-signed
   * old notifications (a signed payload would otherwise verify forever —
   * a signature has no expiry on its own). Leave unset (the default)
   * for signature-only verification (the pre-freshness-check behavior).
   * Must be a finite non-negative number; illegal values throw a caller
   * configuration error. The boundary is inclusive: an age exactly
   * equal to `maxAgeMs` still passes (`now - at > maxAgeMs` fails).
   * Future timestamps are not bounded (a negative age always passes).
   */
  maxAgeMs?: number;
  /**
   * "Now" for the freshness check. Defaults to the real clock; inject a
   * fixed value in tests for determinism. An invalid timestamp throws a
   * caller configuration error.
   */
  now?: Date | string;
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
 *
 * Freshness (opt-in replay bound): pass `{ maxAgeMs, now? }` as the
 * fourth argument. The signature is checked FIRST; only when it matches
 * does the payload `at` timestamp get checked against `now` — a forged
 * signature still fails on the signature comparison, and unauthenticated
 * input is never parsed for its timestamp. A legitimately-signed payload
 * older than the window returns `false` (a signature has no expiry on
 * its own, so without this check a captured webhook could be replayed
 * forever). An unparseable `at` — or an unparseable string body — fails
 * closed as `false`, not an exception. Future timestamps are not bounded
 * by this check (a negative age always passes), tolerating sender clock
 * skew; the boundary is inclusive (`now - at > maxAgeMs` fails, exactly
 * `maxAgeMs` passes). Freshness is defense-in-depth only: receivers MUST
 * still deduplicate on `eventId`.
 *
 * Secret rotation: pass `undefined` as the positional secret and
 * `{ secrets: [newSecret, oldSecret] }` in the options to accept either
 * secret during a rotation window. The positional secret and `secrets`
 * are mutually exclusive — passing both throws a configuration error —
 * and passing neither also throws (there is nothing to verify against).
 * Any candidate that matches authenticates; the freshness gate, when
 * configured, runs after a match exactly as in the single-secret shape,
 * so rotation does not widen the replay window.
 */
export function verifyPayoutWebhook(
  body: string | PayoutWebhookPayload,
  signature: string,
  secret: string | Buffer | undefined,
  opts: VerifyPayoutWebhookOptions = {},
): boolean {
  const hasPositional = secret !== undefined;
  const hasSecrets = opts.secrets !== undefined;
  if (hasPositional && hasSecrets) {
    throw new Error(
      "cannot verify payout webhook: pass either 'secret' or 'secrets', not both",
    );
  }
  let secrets: (string | Buffer)[];
  if (hasSecrets) {
    if (!Array.isArray(opts.secrets)) {
      throw new Error(
        "cannot verify payout webhook: secrets must be a non-empty array",
      );
    }
    if (opts.secrets.length === 0) {
      throw new Error(
        "cannot verify payout webhook: secrets must be a non-empty array",
      );
    }
    opts.secrets.forEach((candidate, i) => {
      if (
        (typeof candidate !== "string" && !Buffer.isBuffer(candidate)) ||
        candidate.length === 0
      ) {
        throw new Error(
          `cannot verify payout webhook: secrets[${i}] must not be empty`,
        );
      }
    });
    secrets = opts.secrets;
  } else if (hasPositional) {
    if (
      (typeof secret !== "string" && !Buffer.isBuffer(secret)) ||
      secret.length === 0
    ) {
      throw new Error(
        "cannot verify payout webhook: signing secret must not be empty",
      );
    }
    secrets = [secret];
  } else {
    throw new Error(
      "cannot verify payout webhook: a signing secret is required (pass 'secret' or 'secrets')",
    );
  }
  const maxAgeMs = opts.maxAgeMs;
  if (
    maxAgeMs !== undefined &&
    (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs < 0)
  ) {
    throw new Error(
      `cannot verify payout webhook: maxAgeMs must be a finite non-negative number, got ${String(
        maxAgeMs,
      )}`,
    );
  }
  let nowMs = Date.now();
  if (opts.now !== undefined) {
    nowMs = new Date(opts.now).getTime();
    if (Number.isNaN(nowMs)) {
      throw new Error(
        "cannot verify payout webhook: invalid 'now' timestamp",
      );
    }
  }
  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;
  const bodyString = typeof body === "string" ? body : canonicalJson(body);
  const actual = Buffer.from(match[1], "hex");
  // Each candidate is compared in constant time; the first match wins.
  // timingSafeEqual throws on length mismatch; a forged 64-hex string that
  // decodes short (never, given the regex) or long is simply a failure.
  let signatureMatches = false;
  for (const candidate of secrets) {
    const expected = Buffer.from(
      createHmac("sha256", candidate).update(bodyString, "utf8").digest(),
    );
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      signatureMatches = true;
      break;
    }
  }
  if (!signatureMatches) return false;
  // Freshness runs only after the signature matched: forgeries fail above,
  // never here, and unauthenticated bodies are never timestamp-parsed.
  if (maxAgeMs === undefined) return true;
  return payloadFreshEnough(body, maxAgeMs, nowMs);
}

/**
 * Fail-closed freshness gate over `payload.at`.
 *
 * String bodies are JSON-parsed to read `at`; unparseable bodies, missing
 * `at`, or non-parseable timestamps all return `false` (never throw).
 * The boundary is inclusive: `now - at <= maxAgeMs` passes, and a future
 * `at` (negative age) always passes.
 */
function payloadFreshEnough(
  body: string | PayoutWebhookPayload,
  maxAgeMs: number,
  nowMs: number,
): boolean {
  let at: unknown;
  if (typeof body === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
    // A JSON string's `.at` is String#at (a function); the `typeof` check
    // below rejects it before Date.parse ever sees it. Same for null.
    at = (parsed as { at?: unknown } | null)?.at;
  } else {
    at = body.at;
  }
  const atMs = typeof at === "string" ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(atMs)) return false;
  return nowMs - atMs <= maxAgeMs;
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

/**
 * Minimal `fetch` shape {@link deliverPayoutWebhook} depends on. The
 * global `fetch` satisfies it; inject a stub in tests so delivery can be
 * exercised with no network at all (the same testability seam the sibling
 * escrow delivery tests use).
 */
export type PayoutWebhookFetchImpl = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** Options for {@link deliverPayoutWebhook}. All fields optional. */
export interface DeliverPayoutWebhookOptions {
  /**
   * Per-attempt request timeout in milliseconds, enforced with an
   * `AbortController` whose signal is passed to the fetch
   * implementation. Default 5000. Must be a finite positive number.
   */
  timeoutMs?: number;
  /**
   * Total attempts including the initial one. Default 3. Must be a
   * positive integer; `1` disables retries entirely.
   */
  maxAttempts?: number;
  /**
   * Base backoff between retries in milliseconds. The wait before retry
   * n (1-based) is `backoffMs * 2^(n-1)`. Default 1000. May be 0.
   */
  backoffMs?: number;
  /**
   * Cap, in milliseconds, on the `Retry-After` wait honored on a 429. A
   * faulty or malicious server can answer `Retry-After: 31536000`;
   * without a cap the delivery promise would sleep for a year. The hint
   * is clamped with `Math.min(hinted, maxRetryDelayMs)` before sleeping;
   * default 60000. Only the 429 hint is clamped — the exponential
   * backoff used when the hint is absent or unparsable is unaffected.
   * Must be a finite non-negative number (`0` retries a hinted 429
   * immediately).
   */
  maxRetryDelayMs?: number;
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetchImpl?: PayoutWebhookFetchImpl;
  /**
   * Sleep implementation used between retries. Defaults to a real
   * `setTimeout` sleep (unref'd, so a pending backoff never holds the
   * process open). Inject a recorder in tests to assert the exact delay
   * schedule instead of really sleeping.
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Outcome of a {@link deliverPayoutWebhook} call. Delivery outcomes are
 * reported, never thrown: `ok` is `true` only on a 2xx response.
 * Caller configuration errors (invalid URL, invalid options) still
 * throw before any request is made — those are bugs, not outcomes.
 */
export interface DeliverWebhookResult {
  ok: boolean;
  /** Total HTTP attempts made, including the initial one. */
  attempts: number;
  /** HTTP status of the last attempt, when a response was received. */
  status?: number;
  /** Human-readable last failure cause, present when `ok` is `false`. */
  error?: string;
}

/**
 * Parse a `Retry-After` header value into a wait in milliseconds.
 * Accepts delay-seconds (a non-negative number) or an HTTP-date.
 * Returns `undefined` when the value is absent or unparsable, in which
 * case the caller falls back to exponential backoff. A past HTTP-date
 * yields 0 (retry immediately) rather than a negative sleep.
 */
export function parsePayoutRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    return undefined;
  }
  // "-5" is neither a legal delay-seconds value nor a date; Date.parse
  // would happily read it as a year, so reject signed numbers explicitly.
  if (/^[+-]/.test(trimmed)) return undefined;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - nowMs);
}

/**
 * Wait before the next retry: a 429 `Retry-After` hint wins over
 * backoff, clamped to `maxRetryDelayMs` so a runaway hint can never
 * stall delivery longer than the caller allows.
 */
function retryDelayMs(
  response: Response,
  attemptIndex: number,
  backoffMs: number,
  maxRetryDelayMs: number,
): number {
  if (response.status === 429) {
    const hinted = parsePayoutRetryAfter(response.headers.get("retry-after"));
    if (hinted !== undefined) return Math.min(hinted, maxRetryDelayMs);
  }
  return backoffMs * 2 ** attemptIndex;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending backoff must not hold the process open on its own.
    timer.unref();
  });
}

/**
 * POST a signed payout webhook to `url` as JSON with the
 * `X-Hub-Signature-256: <signature>` header. The request body is
 * byte-identical to what {@link buildPayoutWebhook} signed, so the
 * receiver can verify it over the raw bytes.
 *
 * Retry policy:
 * - 2xx → `{ ok: true, attempts, status }`.
 * - 429 and 5xx / network errors (including per-attempt timeouts) →
 *   retried with exponential backoff, up to `maxAttempts` total
 *   attempts. A 429 `Retry-After` header (delay-seconds or HTTP-date)
 *   takes precedence over the computed backoff and is clamped to
 *   `maxRetryDelayMs` (default 60s).
 * - Other 3xx/4xx (400, 404, …) → the request itself is at fault; the
 *   result is `{ ok: false, attempts: 1, status, error }` with no
 *   retry. Redirects are never followed (`redirect: "manual"`), so the
 *   signed payload is never re-posted to a redirect target.
 * - When every attempt fails, the result is
 *   `{ ok: false, attempts: maxAttempts, status?, error }` — delivery
 *   failure is reported, not thrown. A per-attempt timeout surfaces in
 *   `error` as `webhook delivery timed out after <timeoutMs>ms`.
 *
 * Invalid URLs (including the empty string), non-http(s) protocols,
 * and invalid options throw a `cannot deliver payout webhook: …`
 * configuration error before any request is made (zero fetch calls).
 */
export async function deliverPayoutWebhook(
  url: string,
  webhook: PayoutWebhook,
  opts: DeliverPayoutWebhookOptions = {},
): Promise<DeliverWebhookResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? 1000;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 60_000;
  const fetchImpl: PayoutWebhookFetchImpl =
    opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const sleepImpl = opts.sleepImpl ?? defaultSleep;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `cannot deliver payout webhook: timeoutMs must be a positive number, got ${String(
        opts.timeoutMs,
      )}`,
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `cannot deliver payout webhook: maxAttempts must be a positive integer, got ${String(
        opts.maxAttempts,
      )}`,
    );
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error(
      `cannot deliver payout webhook: backoffMs must be a non-negative number, got ${String(
        opts.backoffMs,
      )}`,
    );
  }
  if (!Number.isFinite(maxRetryDelayMs) || maxRetryDelayMs < 0) {
    throw new Error(
      `cannot deliver payout webhook: maxRetryDelayMs must be a non-negative number, got ${String(
        opts.maxRetryDelayMs,
      )}`,
    );
  }
  if (opts.fetchImpl !== undefined && typeof opts.fetchImpl !== "function") {
    throw new Error(
      "cannot deliver payout webhook: fetchImpl must be a function",
    );
  }
  if (opts.sleepImpl !== undefined && typeof opts.sleepImpl !== "function") {
    throw new Error(
      "cannot deliver payout webhook: sleepImpl must be a function",
    );
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(
      `cannot deliver payout webhook: invalid url ${JSON.stringify(url)}`,
    );
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(
      `cannot deliver payout webhook: unsupported protocol ${JSON.stringify(
        target.protocol,
      )} (http/https only)`,
    );
  }

  const body = canonicalJson(webhook.payload);
  let lastStatus: number | undefined;
  let lastError = "unknown error";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attempts = attempt + 1;
    let response: Response;
    try {
      response = await postOnce(fetchImpl, target, webhook.signature, body, timeoutMs);
    } catch (err) {
      lastStatus = undefined;
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts - 1) {
        await sleepImpl(backoffMs * 2 ** attempt);
        continue;
      }
      return { ok: false, attempts, error: lastError };
    }
    if (response.ok) {
      return { ok: true, attempts, status: response.status };
    }
    lastStatus = response.status;
    lastError = `server responded with status ${response.status}`;
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      if (attempt < maxAttempts - 1) {
        await sleepImpl(retryDelayMs(response, attempt, backoffMs, maxRetryDelayMs));
        continue;
      }
      return { ok: false, attempts, status: lastStatus, error: lastError };
    }
    // Other 3xx/4xx: retrying the identical signed request changes
    // nothing, and a redirect must never be followed with the payload.
    return {
      ok: false,
      attempts,
      status: response.status,
      error: `webhook delivery failed with status ${response.status} (not retried)`,
    };
  }
  // Unreachable (maxAttempts >= 1 guarantees a return inside the loop),
  // kept so the function has an explicit terminal result.
  return { ok: false, attempts: maxAttempts, status: lastStatus, error: lastError };
}

/**
 * One POST attempt with a per-attempt timeout. The timeout aborts the
 * attempt's `AbortController`; a fetch rejection caused by that abort
 * is translated into a clear timeout error. Network errors propagate
 * unchanged so the caller's `error` field names the real cause.
 */
async function postOnce(
  fetchImpl: PayoutWebhookFetchImpl,
  target: URL,
  signature: string,
  body: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  try {
    return await fetchImpl(target.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Hub-Signature-256": signature,
      },
      body,
      signal: controller.signal,
      // Never follow redirects: the signed payload must not be re-posted
      // to a redirect target (see the delivery policy above).
      redirect: "manual",
    });
  } catch (err) {
    if (timedOut) {
      throw new Error(`webhook delivery timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
