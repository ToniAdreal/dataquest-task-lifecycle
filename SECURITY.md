# Security policy and trust boundaries

> This is a demo/state-machine library, not a production payment system.
> Every claim below is verifiable against the source in `src/`.

## Scope

`dataquest-task-lifecycle` models the rules of a two-sided human-data
marketplace task lifecycle reproduced from the DataQuest portfolio case
study: state transitions from `DRAFT` to `PAID`, an append-only audit
history, and payout webhook signing. It is an off-chain reproduction —
it holds no real money, runs no on-chain code, and moves no payment.
Its only cryptography is in `node:crypto`: SHA-256 / HMAC-SHA256 for the
audit hash chain (`src/taskLifecycle.ts`) and HMAC-SHA256 for payout
webhook signatures (`src/settlementWebhook.ts`).

## Trust model

### Caller-trust decisions (NOT enforced by this library)

- **The RBAC actor is a caller assertion, NOT identity.**
  `TaskLifecycleOptions.rolePolicy` maps events to allowed actor names
  and `dispatch(..., { actor })` checks the supplied string against that
  allowlist (`src/taskLifecycle.ts`; README "Event-level RBAC") — but
  the caller *asserts* the actor string and nothing verifies who the
  caller is. Anyone who can call `dispatch` can claim to be
  `"senior-moderator"`. The policy guarantees only that dispatches
  violating the *declared* allowlist do not happen and that the audit
  trail records the actor string it was given. Real identity
  authentication — sessions, signatures, verified credentials —
  remains entirely the caller's responsibility.
- **`auditSecret` management is the caller's responsibility.**
  The optional keyed audit chain (see below) is only as strong as the
  secret behind it. The library never generates, stores, or transmits
  the secret, and the secret is never written into a snapshot
  (`src/taskLifecycle.ts`: `toJSON()` excludes it; a restored task must
  be handed the secret again via `fromJSON(snapshot, { auditSecret })`).
  A `Buffer` secret is defensively copied at construction so later
  caller mutation cannot change it. Anyone who obtains the secret can
  rewrite the log and re-MAC it.
- **Payout webhook secret distribution is the caller's responsibility.**
  `src/settlementWebhook.ts` documents this in its header comment and
  the README repeats it: whoever holds the secret can forge
  `sha256=<hex>` signatures. This library does not generate, store, or
  distribute secrets — store the secret like any other API credential.
  What the library *does* offer is rotation support on the verify side:
  `verifyPayoutWebhook` accepts a `{ secrets: [...] }` candidate set, so
  during the caller's own rotation window signatures made with either
  the old or the new secret verify (any-match wins, all-mismatch fails
  closed). Signing always uses the single current secret given to
  `buildPayoutWebhook`; the rotation schedule itself stays entirely
  with the caller.
- **Receiver-side trust.** `buildPayoutWebhook` derives every payload
  field from the audit-backed `PAYOUT_COMPLETE` history entry (nothing
  is invented), but the receiver must verify the signature over the raw
  body bytes and deduplicate on `eventId`; an unverified receiver is
  trusting the network, not the library. That deduplication step is
  included as `PayoutEventDedupe` (`src/settlementWebhook.ts`): a
  receiver-side TTL + LRU store run after a successful verify. It is
  single-process and in-memory only — a multi-process receiver must
  deduplicate over shared storage instead.
- **SLA deadlines do not expire tasks by themselves.** A deadline set
  with `setSlaDeadline` is advisory only (README "SLA deadlines"): the
  library provides no scheduler or timer. Expiry stays an explicit
  `EXPIRE` dispatch by the caller (for example via the `expiredTasks` /
  `actOnStaleTasks` watchdog helpers), so it lands in the audit history.
- **`payoutRef` / `payoutAmount` are advisory and unevidenced.**
  `dispatch(..., { payoutRef, payoutAmount })` records what the caller
  claims an external payment system did; the library cannot observe
  that payment, so a `PAID` task whose `PAYOUT_COMPLETE` entry carries
  neither field still builds a webhook (the payload simply omits them)
  — a missing reference is unevidenced, not a build failure. The opt-in
  `requirePayoutRef: true` constructor flag tightens this for callers
  who want it: a `PAYOUT_COMPLETE` dispatch without a `payoutRef` then
  throws. `quotedAmount` has the same advisory status on the quote side.

### Enforced by the library (verifiable in `src/`)

- **Audit hash chain: tamper evidence by default, a MAC when keyed.**
  Every history entry carries `prevHash`/`hash` over a canonical
  serialization (genesis `prevHash` is `"GENESIS"`).
  `verifyHistoryChain(history)` (`src/taskLifecycle.ts`) recomputes the
  chain and returns `false` on tampering, deletion, or reordering.
  The default chain is **unkeyed** SHA-256 — tamper *evidence*, not a
  MAC: it catches edits made without recomputing the hashes, not a
  full-log rewrite by someone who recomputes them. With an
  `auditSecret`, every link becomes HMAC-SHA256 over the same canonical
  input, and verification is fail-closed across modes: a keyed chain
  does not verify without the secret or with the wrong one, and an
  unkeyed chain does not verify when a secret is supplied. An empty or
  non-string/non-`Buffer` secret is a configuration error
  (`assertAuditSecret` in `src/taskLifecycle.ts`).
- **Strict snapshot and history validation.** `TaskLifecycle.fromJSON`
  runs `parseSnapshot` (`src/taskLifecycle.ts`) on untrusted input:
  the schema-version gate (`v`, when present, must be exactly
  `SNAPSHOT_VERSION` = 1; any other value is rejected before structural
  checks), unknown fields are rejected fail-closed at both the snapshot
  and history-entry level (never silently dropped), `seq` runs from 1
  with no gaps, the from/to chain is continuous, and the hash chain is
  re-verified on rehydration.
- **Payout webhook verification is constant-time and fail-closed.**
  `verifyPayoutWebhook` (`src/settlementWebhook.ts`) compares with
  `timingSafeEqual`; malformed signatures return `false` rather than
  throwing, so hostile input cannot turn verification into an
  unhandled exception. Verify over the raw body bytes — the object
  overload re-stringifies with a fixed key order for in-process
  convenience, but raw bytes are the transport-safe path. An empty
  secret (positional, or any entry of `secrets`) is a caller
  configuration error and throws; passing both the positional secret
  and `secrets` also throws. **Signatures do not expire on their own:**
  without the opt-in `maxAgeMs`, a legitimately-signed payload from a
  year ago still verifies. Pass `VerifyPayoutWebhookOptions.maxAgeMs`
  to fail-closed reject payloads older than the window, and the
  companion `maxFutureSkewMs` to also reject payloads whose `at` lies
  further in the future than the tolerated clock skew; both boundaries
  are inclusive, the signature is checked first, and an unparseable
  `at` returns `false`. Together the two form a two-sided freshness
  window. Neither bound replaces deduplication on `eventId`.
- **Event-level RBAC allowlist (when a policy is set).** A task
  constructed with `rolePolicy` rejects a dispatch of a listed event
  whose `actor` is missing or not in the allowlist with
  `actor not authorized for …`, before anything is appended — no
  history entry and no idempotency key is consumed. Events the policy
  does not list are unrestricted, and a task with no policy skips the
  check entirely. Invalid policies throw at construction. This enforces
  the *declared* allowlist only; it does not authenticate the actor
  (see the caller-trust section above).
- **Optimistic-concurrency guard (when `expectedSeq` is passed).**
  `dispatch` rejects a caller whose `expectedSeq` no longer equals the
  current history length with `dispatch conflict: …`, before any other
  check and with no side effects (no append, no idempotency key
  consumed, no listener notified) — two writers racing off the same
  snapshot cannot both advance the task in-process. It is not a
  distributed lock: separate processes hold separate histories and
  still need store-level compare-and-swap.
- **In-process history integrity.** `task.history` returns a frozen,
  detached copy on every call (array and entries), so consumers cannot
  rewrite the audit log at runtime; `dispatch()` remains the only
  append path.

## Money precision (known limitation)

Amounts are plain JavaScript numbers, not big-decimal arithmetic.
`payoutAmount` and `quotedAmount` are validated at dispatch (finite
number ≥ 0; anything else throws) and stored verbatim on the audit
entry with no rounding at write time (`src/taskLifecycle.ts`); only
aggregation helpers such as `totalPaidOut` round a summed total to
cents (`Math.round(x * 100) / 100`). This has **not** been audited.
Do not use for precision-critical accounting.

## Deliberately NOT here (production would need it)

- Real payment execution or any on-chain settlement
- Identity authentication (this repo's `rolePolicy` is only a
  caller-supplied actor allowlist — see above)
- Secret management, storage, or distribution for webhook secrets or
  the `auditSecret` (rotation-window *verification* accepts multiple
  candidate secrets, but the library never generates, stores, or
  schedules the rotation itself)
- A deadline scheduler (`EXPIRE` is dispatched by the caller; SLA
  deadlines are advisory only)
- Durable storage, a shared/distributed idempotency store (consumed
  dispatch keys persist only inside each task's own `toJSON()`
  snapshot, and `PayoutEventDedupe` is single-process in-memory), or
  concurrency control beyond the single-process `expectedSeq`
  optimistic guard on `dispatch`
- A durable notification fan-out: `subscribe()` listeners are
  in-memory and fire-and-forget, and webhook delivery is in-process
  with retries but no durable queue — if the process dies mid-delivery
  or mid-fan-out, the caller must reconcile and re-deliver, letting
  receivers deduplicate on `eventId`
- Big-decimal / precision-critical money arithmetic (see above)
- Reputation or quality scoring (out of scope for the case study)

## Reporting a security issue

If you find a security problem in this demo, please open an issue on
this repository describing it. Do not include secrets, private keys, or
any credentials in the report.

Reference and demo use only.
