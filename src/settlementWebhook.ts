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
 *   `maxRetryDelayMs`). Both delivery entry points also accept an
 *   external `AbortSignal`: aborting it stops an in-flight request or a
 *   pending backoff sleep, and the abort is reported in the delivery
 *   result object (never thrown), matching this module's convention
 *   that delivery outcomes are reported, not raised. Multi-endpoint
 *   fan-out is included too via
 *   {@link deliverPayoutWebhookToMany}: one settlement event delivered
 *   concurrently to many endpoints, each with its own secret/signature.
 *   There is still no durable queue or cross-process retry: if the
 *   process dies mid-fan-out, the caller reconciles by `eventId`.
 * - Secret distribution is the caller's responsibility. Whoever holds the
 *   secret can forge signatures; store it like any other API credential.
 * - `verifyPayoutWebhook` should run over the raw request body bytes. A
 *   parsed object is re-stringified (byte-identical in-process because the
 *   payload is built with a fixed literal key order), but raw bytes are
 *   the transport-safe path. Verification is signature-only by default;
 *   an opt-in `maxAgeMs` freshness window additionally bounds replays of
 *   legitimately-signed old payloads, and an opt-in `maxFutureSkewMs`
 *   bounds how far in the future a payload `at` may lie, but receivers
 *   must still deduplicate on `eventId`. During a secret rotation window the
 *   receiver can pass `secrets: [newSecret, oldSecret]` instead of a
 *   single secret (the two shapes are mutually exclusive) so in-flight
 *   notifications signed with either secret verify; signing always uses
 *   the single current secret.
 * - Receiver-side `eventId` deduplication is included via
 *   {@link PayoutEventDedupe}: a single-process in-memory TTL + LRU
 *   store receivers run after a successful verify. It is not shared
 *   between processes — a multi-process receiver must deduplicate over
 *   shared storage instead (see the class docs).
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
   * Future timestamps are not bounded by this field (a negative age
   * always passes); bound them separately with `maxFutureSkewMs`.
   */
  maxAgeMs?: number;
  /**
   * Maximum clock skew into the future tolerated for the payload, in
   * milliseconds, measured from `now` to the payload `at` timestamp.
   * When set, a payload whose signature verifies but whose `at` lies
   * further in the future than this window returns `false`
   * (fail-closed): a legitimately-signed payload issued far into the
   * future would otherwise gain a near-unbounded replay window under a
   * `maxAgeMs`-only check, and a sender clock set wrong (or fast) would
   * leave the receiver with no defense. Leave unset (the default) for
   * the legacy behavior, in which future timestamps pass however far
   * ahead they lie. Must be a finite non-negative number; illegal
   * values throw a caller configuration error, with the same style as
   * `maxAgeMs`. The boundary is inclusive: a future skew exactly equal
   * to `maxFutureSkewMs` still passes (`at - now > maxFutureSkewMs`
   * fails). Together, `maxAgeMs` and `maxFutureSkewMs` form a two-sided
   * freshness window; neither replaces deduplication on `eventId`.
   */
  maxFutureSkewMs?: number;
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
 * by `maxAgeMs` (a negative age always passes), tolerating sender clock
 * skew; the boundary is inclusive (`now - at > maxAgeMs` fails, exactly
 * `maxAgeMs` passes). Pass `maxFutureSkewMs` alongside (or instead) to
 * bound that future direction too: after the signature matches, a
 * payload with `at - now > maxFutureSkewMs` returns `false`, with the
 * same inclusive boundary, so the two fields together form a two-sided
 * window. When `maxFutureSkewMs` is unset, far-future timestamps still
 * pass exactly as before. Freshness is defense-in-depth only: receivers
 * MUST still deduplicate on `eventId`.
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
  const maxFutureSkewMs = opts.maxFutureSkewMs;
  if (
    maxFutureSkewMs !== undefined &&
    (typeof maxFutureSkewMs !== "number" ||
      !Number.isFinite(maxFutureSkewMs) ||
      maxFutureSkewMs < 0)
  ) {
    throw new Error(
      `cannot verify payout webhook: maxFutureSkewMs must be a finite non-negative number, got ${String(
        maxFutureSkewMs,
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
  if (maxAgeMs === undefined && maxFutureSkewMs === undefined) return true;
  return payloadFreshEnough(body, maxAgeMs, maxFutureSkewMs, nowMs);
}

/**
 * Fail-closed freshness gate over `payload.at`.
 *
 * String bodies are JSON-parsed to read `at`; unparseable bodies, missing
 * `at`, or non-parseable timestamps all return `false` (never throw)
 * whenever either window bound is configured.
 * Each boundary is inclusive: `now - at <= maxAgeMs` passes when
 * `maxAgeMs` is set, and `at - now <= maxFutureSkewMs` passes when
 * `maxFutureSkewMs` is set. An unset bound never rejects: with no
 * `maxFutureSkewMs`, a future `at` (negative age) always passes, and
 * with no `maxAgeMs`, an old `at` always passes.
 */
function payloadFreshEnough(
  body: string | PayoutWebhookPayload,
  maxAgeMs: number | undefined,
  maxFutureSkewMs: number | undefined,
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
  if (maxAgeMs !== undefined && nowMs - atMs > maxAgeMs) return false;
  if (maxFutureSkewMs !== undefined && atMs - nowMs > maxFutureSkewMs) {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Receiver-side eventId deduplication                                 */
/* ------------------------------------------------------------------ */

/** Options for {@link PayoutEventDedupe}. All fields optional. */
export interface PayoutEventDedupeOptions {
  /**
   * Milliseconds a recorded `eventId` stays deduplicated. An id seen
   * again while `now - firstSeenAt < ttlMs` is a duplicate; at exactly
   * `ttlMs` the record has expired and the id counts as unseen again
   * (the same boundary rule as the sibling rfc9421 `ReplayCache`).
   * Defaults to 3_600_000 (1 hour). Must be a finite number > 0.
   * Pick a TTL at least as long as the longest window in which the
   * sender (or a fan-out retry) can re-deliver the same event — the
   * delivery layer's retry horizon, not the freshness window.
   */
  ttlMs?: number;
  /**
   * Maximum number of `eventId`s tracked. When a new id needs room,
   * expired entries are reclaimed first, then the least recently seen
   * entry is evicted (LRU). Defaults to 10_000 (aligned with the
   * sibling `ReplayCache`). Must be a positive integer.
   */
  maxEntries?: number;
  /**
   * Clock source (milliseconds since the epoch). Defaults to
   * `Date.now`. Inject a fake clock for deterministic tests.
   */
  now?: () => number;
}

/**
 * Observability snapshot of a {@link PayoutEventDedupe}.
 *
 * - `size`: live (unexpired) entries tracked, computed against the
 *   dedupe's injected clock — same reading as the `size` getter.
 * - `hits`: `checkAndRecord` calls where the id was already seen
 *   within the TTL (i.e. duplicates).
 * - `misses`: `checkAndRecord` calls where the id was unseen and got
 *   recorded (including an id whose previous record had expired —
 *   expiry means "unseen").
 * - `evictions`: entries dropped while making room for a new entry —
 *   both expired-entry reclamation and LRU eviction count. The
 *   delete+re-record of an expired id inside `checkAndRecord` is part
 *   of the miss path and is *not* an eviction.
 *
 * Counters reset to zero on `clear()`.
 */
export interface PayoutEventDedupeStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * Receiver-side deduplication store for payout webhook `eventId`s.
 *
 * `verifyPayoutWebhook`'s freshness window is only defense-in-depth:
 * its docs require receivers to deduplicate on `eventId`, because a
 * retried (or fanned-out) delivery re-POSTs the same logical event
 * with the same `eventId`. This class is that deduplication step, so
 * receivers no longer hand-roll a `Map` with ad-hoc TTL/capacity/clock
 * choices. It follows the same paradigm as the sibling
 * rfc9421-signing-demo `ReplayCache` (TTL + LRU, injectable clock,
 * `hits`/`misses`/`evictions` observability).
 *
 * Usage — after the signature (and any freshness window) verifies:
 *
 * ```ts
 * const dedupe = new PayoutEventDedupe();
 * if (dedupe.checkAndRecord(payload.eventId)) {
 *   // duplicate delivery: acknowledge it, do not pay out twice
 * }
 * ```
 *
 * Honest scope: this is a single-process, in-memory store. Two
 * receiver processes each keep their own store and cannot see each
 * other's records, and a restart forgets every recorded id — a
 * deployment with multiple receiver processes (or one that must
 * survive restarts inside the TTL) must deduplicate over shared
 * storage (a database unique constraint, Redis, …) instead. Within
 * one process the store is exact: an id is a duplicate if and only if
 * it was recorded within the TTL and has not since been evicted.
 */
export class PayoutEventDedupe {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  /** eventId -> first-seen-at (ms). Insertion order = LRU order. */
  private readonly seenAt = new Map<string, number>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(opts: PayoutEventDedupeOptions = {}) {
    const ttlMs = opts.ttlMs ?? 3_600_000;
    const maxEntries = opts.maxEntries ?? 10_000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(
        "PayoutEventDedupe: ttlMs must be a positive finite number",
      );
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(
        "PayoutEventDedupe: maxEntries must be a positive integer",
      );
    }
    if (opts.now !== undefined && typeof opts.now !== "function") {
      throw new Error("PayoutEventDedupe: now must be a function");
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.clock = opts.now ?? Date.now;
  }

  /**
   * Atomically check-and-record an `eventId`: returns `true` when the
   * id was already recorded within the TTL — i.e. this delivery is a
   * duplicate/replay, the same "true = is a replay" contract as the
   * rfc9421 `NonceStore.check` — otherwise records the id and returns
   * `false` (first sighting; process the event).
   *
   * Expired entries are treated as unseen and re-recorded with a fresh
   * timestamp. On a duplicate hit the entry's LRU recency is refreshed
   * but its original first-seen timestamp is kept, so repeated
   * duplicates cannot extend the deduplication window.
   *
   * An empty or non-string `eventId` is a caller bug and throws —
   * silently accepting it would disable deduplication for exactly the
   * malformed deliveries that need it most.
   */
  checkAndRecord(eventId: string): boolean {
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new Error(
        "PayoutEventDedupe: eventId must be a non-empty string",
      );
    }
    const t = this.clock();
    const prev = this.seenAt.get(eventId);
    if (prev !== undefined) {
      if (t - prev < this.ttlMs) {
        // Refresh LRU recency (delete + re-insert moves it to the
        // tail) while keeping the original first-seen timestamp.
        this.seenAt.delete(eventId);
        this.seenAt.set(eventId, prev);
        this.hits++;
        return true; // duplicate
      }
      // Expired: drop and fall through to re-record with a fresh
      // timestamp. This is the miss path (an expired record means
      // "unseen"), not an eviction.
      this.seenAt.delete(eventId);
    }
    this.prune(t);
    this.seenAt.set(eventId, t);
    this.misses++;
    return false;
  }

  /**
   * Number of live (unexpired) entries tracked, computed against the
   * dedupe's injected clock.
   */
  get size(): number {
    const t = this.clock();
    let n = 0;
    for (const at of this.seenAt.values()) if (t - at < this.ttlMs) n++;
    return n;
  }

  /** Drop all tracked ids and reset the observability counters. */
  clear(): void {
    this.seenAt.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Point-in-time observability snapshot (see
   * {@link PayoutEventDedupeStats}). The returned object is a fresh
   * copy — mutating it does not affect the store.
   */
  stats(): PayoutEventDedupeStats {
    return {
      size: this.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  /**
   * Make room for one new entry: reclaim expired entries first, then
   * evict the least recently seen ones. Map iteration order is
   * insertion order, so the head is always the oldest entry. Every
   * entry dropped here counts as an eviction for observability.
   */
  private prune(t: number): void {
    if (this.seenAt.size < this.maxEntries) return;
    for (const [eventId, at] of this.seenAt) {
      if (t - at >= this.ttlMs) {
        this.seenAt.delete(eventId);
        this.evictions++;
      }
      if (this.seenAt.size < this.maxEntries) return;
    }
    while (this.seenAt.size >= this.maxEntries) {
      const oldest = this.seenAt.keys().next();
      if (oldest.done) break;
      this.seenAt.delete(oldest.value);
      this.evictions++;
    }
  }
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
   * `setTimeout` sleep. Inject a recorder in tests to assert the exact
   * delay schedule instead of really sleeping.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Optional external abort signal (the dataquest-side peer of escrow's
   * `DeliverWebhookOptions.signal`). Wired into both the in-flight
   * request and the backoff sleep between retries: aborting the signal
   * ends the whole delivery — no further attempts are made — and the
   * abort is reported as
   * `{ ok: false, attempts: <attempts actually made>, error: "payout webhook delivery aborted" }`
   * (a pre-aborted signal reports `attempts: 0` and makes zero fetch
   * calls). Unlike escrow, whose delivery throws, this module reports
   * delivery outcomes, so an abort is a reported outcome too; only a
   * non-`AbortSignal` value is a caller configuration error and throws
   * before any request is made. The per-attempt `timeoutMs` still
   * applies independently.
   */
  signal?: AbortSignal;
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
    // The timer deliberately stays ref'd: an awaited delivery must keep
    // the process alive until the backoff settles. With an unref'd timer
    // the event loop can drain mid-backoff (stubbed fetch, no live
    // sockets) and the delivery promise then never settles.
    setTimeout(resolve, ms);
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
 * - An external `opts.signal` aborts the in-flight request and any
 *   pending backoff sleep alike: no further attempts are made and the
 *   result is `{ ok: false, attempts: <attempts actually made>, error:
 *   "payout webhook delivery aborted" }` (a pre-aborted signal makes
 *   zero fetch calls and reports `attempts: 0`). An abort is a caller
 *   request to stop, never a retryable failure — and, per this module's
 *   convention, it is reported in the result, not thrown.
 *
 * Invalid URLs (including the empty string), non-http(s) protocols,
 * and invalid options throw a `cannot deliver payout webhook: …`
 * configuration error before any request is made (zero fetch calls).
 */
/** The one error text every abort path reports (pinned by tests). */
const PAYOUT_DELIVERY_ABORTED = "payout webhook delivery aborted";

/** Delivery options with defaults applied and configuration validated. */
interface ResolvedDeliverOptions {
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  maxRetryDelayMs: number;
  fetchImpl: PayoutWebhookFetchImpl;
  sleepImpl: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Apply delivery-option defaults and validate them. Invalid values are
 * caller configuration errors and throw `cannot deliver payout webhook:
 * …` before any request is made. Shared by {@link deliverPayoutWebhook}
 * and {@link deliverPayoutWebhookToMany} (which validates the caller's
 * global options once, up front, with the exact same rules).
 */
function resolveDeliverOptions(
  opts: DeliverPayoutWebhookOptions,
): ResolvedDeliverOptions {
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
  if (opts.signal !== undefined && !(opts.signal instanceof AbortSignal)) {
    throw new Error(
      `cannot deliver payout webhook: signal must be an AbortSignal, got ${String(
        opts.signal,
      )}`,
    );
  }
  return {
    timeoutMs,
    maxAttempts,
    backoffMs,
    maxRetryDelayMs,
    fetchImpl,
    sleepImpl,
    signal: opts.signal,
  };
}

/**
 * Sleep between retries via the (possibly injected) `sleepImpl`,
 * interruptible by an external abort signal. Resolves `false` when the
 * sleep ran to completion and `true` when the signal was already
 * aborted or aborted while the sleep was pending — in the aborted case
 * the underlying sleep may still be pending in the background, but the
 * caller stops immediately and makes no further attempt. Without a
 * signal this is exactly the injected sleep. (The sibling escrow
 * delivery rejects its sleep promise on abort; this module's
 * report-don't-throw convention turns the same event into a boolean
 * the delivery loop converts into an aborted result.)
 */
async function sleepWithSignal(
  ms: number,
  sleepImpl: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal === undefined) {
    await sleepImpl(ms);
    return false;
  }
  if (signal.aborted) return true;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(true);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      sleepImpl(ms).then(() => false),
      aborted,
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

export async function deliverPayoutWebhook(
  url: string,
  webhook: PayoutWebhook,
  opts: DeliverPayoutWebhookOptions = {},
): Promise<DeliverWebhookResult> {
  const {
    timeoutMs,
    maxAttempts,
    backoffMs,
    maxRetryDelayMs,
    fetchImpl,
    sleepImpl,
    signal,
  } = resolveDeliverOptions(opts);

  if (signal?.aborted) {
    // Pre-aborted: the caller asked to stop before we started. Zero
    // fetch calls, and the abort is reported (not thrown) with zero
    // attempts — the same early-exit position escrow's throwing
    // variant takes, adapted to this module's result convention.
    return { ok: false, attempts: 0, error: PAYOUT_DELIVERY_ABORTED };
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
    if (signal?.aborted) {
      // Aborted between attempts (e.g. the signal fired just as a
      // backoff sleep completed): start no new attempt and report the
      // attempts actually made so far (`attempt` is their count).
      return { ok: false, attempts: attempt, error: PAYOUT_DELIVERY_ABORTED };
    }
    const attempts = attempt + 1;
    let response: Response;
    try {
      response = await postOnce(
        fetchImpl,
        target,
        webhook.signature,
        body,
        timeoutMs,
        signal,
      );
    } catch (err) {
      if (signal?.aborted) {
        // The caller asked to stop: report the abort immediately,
        // never treat it as a retryable network failure.
        return { ok: false, attempts, error: PAYOUT_DELIVERY_ABORTED };
      }
      lastStatus = undefined;
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts - 1) {
        const aborted = await sleepWithSignal(
          backoffMs * 2 ** attempt,
          sleepImpl,
          signal,
        );
        if (aborted) {
          return { ok: false, attempts, error: PAYOUT_DELIVERY_ABORTED };
        }
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
        const aborted = await sleepWithSignal(
          retryDelayMs(response, attempt, backoffMs, maxRetryDelayMs),
          sleepImpl,
          signal,
        );
        if (aborted) {
          return {
            ok: false,
            attempts,
            status: lastStatus,
            error: PAYOUT_DELIVERY_ABORTED,
          };
        }
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

/* ------------------------------------------------------------------ */
/* Multi-endpoint fan-out delivery                                     */
/* ------------------------------------------------------------------ */

/**
 * One fan-out destination for {@link deliverPayoutWebhookToMany}. Each
 * endpoint has its OWN signing secret: the shared payload is signed
 * independently per endpoint, so one endpoint's secret can never verify
 * another endpoint's delivery. The delivery-option fields override the
 * call-level options of {@link deliverPayoutWebhookToMany} for this
 * endpoint only (retry counts are therefore counted per endpoint).
 */
export interface PayoutWebhookEndpoint {
  /** Destination URL (http/https), validated per endpoint. */
  url: string;
  /** This endpoint's signing secret (non-empty string or Buffer). */
  secret: string | Buffer;
  /** Per-endpoint fetch override; defaults to the call-level `fetchImpl`. */
  fetchImpl?: PayoutWebhookFetchImpl;
  /** Per-endpoint sleep override; defaults to the call-level `sleepImpl`. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Per-endpoint override of the call-level `timeoutMs`. */
  timeoutMs?: number;
  /** Per-endpoint override of the call-level `maxAttempts`. */
  maxAttempts?: number;
  /** Per-endpoint override of the call-level `backoffMs`. */
  backoffMs?: number;
  /** Per-endpoint override of the call-level `maxRetryDelayMs`. */
  maxRetryDelayMs?: number;
  /** Per-endpoint override of the call-level `signal`. */
  signal?: AbortSignal;
}

/** Options for {@link deliverPayoutWebhookToMany}. All fields optional. */
export interface DeliverPayoutWebhookToManyOptions
  extends DeliverPayoutWebhookOptions {
  /**
   * Payload `at` timestamp shared by every endpoint's copy of the
   * event. Resolved ONCE per call (defaults to the real clock) so all
   * endpoints receive the same logical event, not one event per
   * endpoint with drifting timestamps.
   */
  now?: Date | string;
  /**
   * Payload `eventId` shared by every endpoint (see the eventId
   * semantics on {@link deliverPayoutWebhookToMany}). Defaults to one
   * freshly generated `crypto.randomUUID()` per call; inject a fixed
   * value in tests for determinism. Must be a non-empty string.
   */
  eventId?: string;
}

/**
 * Aggregate outcome of {@link deliverPayoutWebhookToMany}. `results[i]`
 * always corresponds to `endpoints[i]` (input order is preserved even
 * though deliveries run concurrently), and `delivered + failed` always
 * equals `results.length`.
 */
export interface DeliverPayoutWebhookToManyResult {
  /** Per-endpoint results, in the same order as the input endpoints. */
  results: DeliverWebhookResult[];
  /** How many endpoints reported `ok: true`. */
  delivered: number;
  /** How many endpoints reported `ok: false`. */
  failed: number;
}

/**
 * Fan one PAID task's payout webhook out to many endpoints at once —
 * the marketplace-platform shape where a single settlement event must
 * notify billing, risk, notifications, and other systems, each holding
 * its own secret.
 *
 * Semantics:
 * - Each endpoint gets an independent {@link buildPayoutWebhook} signed
 *   with that endpoint's own secret, delivered via
 *   {@link deliverPayoutWebhook} with the endpoint's option overrides
 *   applied over the call-level options. Retry budgets are therefore
 *   per endpoint: one endpoint burning its retries never consumes
 *   another's.
 * - eventId semantics: ONE shared `eventId` (and one shared `at`) for
 *   the whole call. This is a single logical settlement event fanned
 *   out, not N distinct events — each receiver deduplicates on the
 *   `eventId` within its own endpoint, exactly as for a retried
 *   single-endpoint delivery. Two separate calls (two settlements, or
 *   a caller re-fan-out) get different `eventId`s unless the caller
 *   pins one via `opts.eventId`.
 * - The call-level `signal` is passed through to every endpoint's
 *   delivery, and an endpoint may override it with its own `signal`.
 *   Aborting stops that endpoint's delivery exactly as in a
 *   single-endpoint call (reported in its result, never thrown); the
 *   result array still carries one entry per endpoint, in input order.
 * - Deliveries run concurrently. One endpoint's failure — retries
 *   exhausted, network error, even a per-endpoint configuration problem
 *   such as an invalid URL or an empty secret — is reported as that
 *   endpoint's `{ ok: false, attempts: 0, error }` result and never
 *   blocks or fails the other endpoints.
 * - Call-level configuration errors DO throw before any request is
 *   made: a missing/empty/non-array `endpoints`, invalid global
 *   delivery options, an invalid shared `now`/`eventId`, or a non-PAID
 *   task are caller bugs, not per-endpoint outcomes.
 *
 * Honest limit: there is no durable queue and no cross-process retry.
 * If the process dies mid-fan-out, some endpoints may have received the
 * event and others not; the caller reconciles by re-delivering and
 * letting receivers deduplicate on the shared `eventId`.
 */
export async function deliverPayoutWebhookToMany(
  task: TaskLifecycle,
  endpoints: PayoutWebhookEndpoint[],
  opts: DeliverPayoutWebhookToManyOptions = {},
): Promise<DeliverPayoutWebhookToManyResult> {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new Error(
      "cannot deliver payout webhook to many endpoints: endpoints must be a non-empty array",
    );
  }
  // Global delivery options are call-level configuration: validate them
  // once, up front, with the same rules as a single delivery. (Per-
  // endpoint overrides are validated per endpoint, inside the fan-out,
  // so a bad override fails only its own endpoint.)
  resolveDeliverOptions(opts);
  // A non-PAID task cannot build any endpoint's webhook: also a
  // call-level configuration error, checked before any request.
  if (task.state !== "PAID") {
    throw new Error(
      `cannot build payout webhook: task ${task.id} is in state ${task.state}, only PAID tasks have a completed settlement to announce`,
    );
  }
  // One logical event: resolve the shared timestamp and eventId once.
  const now = opts.now ?? new Date();
  const eventId = opts.eventId ?? randomUUID();
  // The shared build inputs are call-level configuration too: validate
  // them up front (same rules/messages as buildPayoutWebhook) so a bad
  // `now`/`eventId` throws instead of failing every endpoint one by one.
  if (Number.isNaN(new Date(now).getTime())) {
    throw new Error(
      `cannot build payout webhook: invalid 'now' timestamp for task ${task.id}`,
    );
  }
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new Error(
      `cannot build payout webhook: 'eventId' must be a non-empty string for task ${task.id}`,
    );
  }

  const results = await Promise.all(
    endpoints.map(async (endpoint, index): Promise<DeliverWebhookResult> => {
      try {
        if (
          endpoint === null ||
          typeof endpoint !== "object" ||
          typeof endpoint.url !== "string"
        ) {
          throw new Error(
            `cannot deliver payout webhook to many endpoints: endpoints[${index}] must be an object with a string url and a secret`,
          );
        }
        const webhook = buildPayoutWebhook(task, endpoint.secret, {
          now,
          eventId,
        });
        return await deliverPayoutWebhook(endpoint.url, webhook, {
          timeoutMs: endpoint.timeoutMs ?? opts.timeoutMs,
          maxAttempts: endpoint.maxAttempts ?? opts.maxAttempts,
          backoffMs: endpoint.backoffMs ?? opts.backoffMs,
          maxRetryDelayMs: endpoint.maxRetryDelayMs ?? opts.maxRetryDelayMs,
          fetchImpl: endpoint.fetchImpl ?? opts.fetchImpl,
          sleepImpl: endpoint.sleepImpl ?? opts.sleepImpl,
          signal: endpoint.signal ?? opts.signal,
        });
      } catch (err) {
        // Per-endpoint pre-flight failures (invalid URL, empty secret,
        // invalid per-endpoint override) fail only this endpoint.
        return {
          ok: false,
          attempts: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  const delivered = results.filter((r) => r.ok).length;
  return { results, delivered, failed: results.length - delivered };
}

/**
 * One POST attempt with a per-attempt timeout. The timeout aborts the
 * attempt's `AbortController`; a fetch rejection caused by that abort
 * is translated into a clear timeout error. Network errors propagate
 * unchanged so the caller's `error` field names the real cause.
 *
 * Signal composition: the per-attempt timeout and the caller's
 * external `signal` both feed the SAME attempt `AbortController` —
 * the timeout via its timer, the external signal via an `abort`
 * listener forwarded into `controller.abort()` (an already-aborted
 * external signal aborts the attempt before the fetch starts). The
 * fetch only ever sees the composed controller signal, and the catch
 * below attributes the abort: timeout first, then external abort
 * (reported with the module's one abort error text), so the delivery
 * loop can tell "stop, the caller said so" apart from a retryable
 * network failure.
 */
async function postOnce(
  fetchImpl: PayoutWebhookFetchImpl,
  target: URL,
  signature: string,
  body: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, {
        once: true,
      });
    }
  }
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
    if (externalSignal?.aborted) {
      throw new Error(PAYOUT_DELIVERY_ABORTED);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
