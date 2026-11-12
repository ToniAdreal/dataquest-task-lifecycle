/**
 * Optional expiry (`expiresAt`) on the three HMAC-signed snapshot
 * envelopes (backlog #1076): `TaskLifecycle`,
 * `PayoutEventDedupe`, and `PayoutWebhookOutbox`.
 *
 * A MAC-valid envelope stolen or restored months later could
 * otherwise resurrect expired state (a revoked rolePolicy, cleared
 * idempotency keys, a dead letter cleared) — the webhook side
 * already has the opt-in `maxAgeMs` freshness window, but the
 * snapshot envelopes had no equivalent. Rules under test:
 *  - `exportSignedSnapshot(secret, { expiresAt })` /
 *    `{ maxAgeMs, now? }` writes the timestamp into the envelope
 *    and covers it with the MAC; without either option the
 *    envelope never expires, exactly as before
 *  - `restoreSignedSnapshot` (alias `fromSignedSnapshot`) rejects
 *    an expired envelope fail-closed before any snapshot parsing,
 *    and only when `now > Date.parse(expiresAt)` — restoring at
 *    exactly `expiresAt` still succeeds (the same inclusive
 *    boundary the payout webhook freshness window uses)
 *  - a tampered `expiresAt` fails as a MAC mismatch (the timestamp
 *    is inside the MAC coverage), never as an expiry
 *  - an invalid `expiresAt` (non-ISO, non-canonical, non-string)
 *    is rejected at export and at restore; `maxAgeMs` must be a
 *    positive finite number, `expiresAt` and `maxAgeMs` are
 *    mutually exclusive, and `now` without `maxAgeMs` is a
 *    configuration error
 *  - the restore clock is injectable (`opts.now`): a plain
 *    millisecond timestamp for `TaskLifecycle`, the options'
 *    `now` clock function for the dedupe and the outbox
 *  - envelopes exported without `expiresAt` verify unchanged, so
 *    envelopes written before this field existed still restore
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PayoutEventDedupe,
  PayoutWebhookOutbox,
  TaskLifecycle,
} from "../src/index.js";

const TASK_SECRET = "task-snapshot-signing-secret-for-tests";
const DEDUPE_SECRET = "payout-dedupe-snapshot-signing-secret-for-tests";
const OUTBOX_SECRET = "outbox-snapshot-signing-secret-for-tests";
const A = "https://books.example/hooks/settlement";
const B = "https://ledger.example/hooks/settlement";

/** Fixed "now" for the TaskLifecycle expiry tests (ms). */
const T0 = 1_700_000_000_000;
const EXPIRES_AT_T0 = new Date(T0 + 60_000).toISOString();
/** Far-future expiry, restorable against the real clock. */
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
/** Seed-clock epoch for the dedupe/outbox expiry tests (ms). */
const EPOCH = 1_000_000;
const EXPIRES_AT_EPOCH = new Date(EPOCH + 60_000).toISOString();

function seededTask(): TaskLifecycle {
  const task = new TaskLifecycle("task-expiry-1", { maxResubmits: 2 });
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-11-09T00:00:00.000Z",
    idempotencyKey: "pub-1",
  });
  return task;
}

function fakeClock(start = EPOCH) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function seededDedupe(ttlMs = 60_000): {
  dedupe: PayoutEventDedupe;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-2"), false);
  return { dedupe, clock };
}

function seededOutbox(): {
  outbox: PayoutWebhookOutbox;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  outbox.recordAttempt({
    endpoint: A,
    eventId: "evt-0001",
    ok: false,
    error: "first",
  });
  clock.advance(1000);
  outbox.recordAttempt({
    endpoint: A,
    eventId: "evt-0001",
    ok: false,
    error: "second",
  });
  outbox.recordAttempt({
    endpoint: B,
    eventId: "evt-0002",
    ok: false,
    error: "once",
  });
  outbox.recordAttempt({
    endpoint: B,
    eventId: "evt-0002",
    ok: false,
    error: "twice",
  });
  outbox.recordAttempt({
    endpoint: B,
    eventId: "evt-0002",
    ok: false,
    error: "thrice",
  });
  return { outbox, clock };
}

/** Deep-clone a value so tampering tests don't fight Object.freeze. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---- TaskLifecycle ----

test("task: envelope without expiresAt carries no expiry field and restores as before", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(TASK_SECRET);
  assert.equal("expiresAt" in envelope, false);
  const restored = TaskLifecycle.restoreSignedSnapshot(envelope, TASK_SECRET);
  assert.equal(restored.state, task.state);
  assert.deepEqual(restored.toJSON(), task.toJSON());
});

test("task: far-future expiresAt round-trips against the real clock", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(TASK_SECRET, {
    expiresAt: FAR_FUTURE,
  });
  assert.equal(envelope.expiresAt, FAR_FUTURE);
  const restored = TaskLifecycle.restoreSignedSnapshot(envelope, TASK_SECRET);
  assert.equal(restored.state, task.state);
  assert.deepEqual(restored.toJSON(), task.toJSON());
});

test("task: expired envelope throws and produces no task (both restore spellings)", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(TASK_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  assert.throws(
    () =>
      TaskLifecycle.restoreSignedSnapshot(envelope, TASK_SECRET, {
        now: T0 + 60_001,
      }),
    /signed snapshot envelope expired at 2023-11-14T22:14:20\.000Z/,
  );
  assert.throws(
    () =>
      TaskLifecycle.fromSignedSnapshot(envelope, TASK_SECRET, {
        now: T0 + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
  // Still restorable inside the window: the throw left nothing behind.
  const restored = TaskLifecycle.restoreSignedSnapshot(envelope, TASK_SECRET, {
    now: T0 + 30_000,
  });
  assert.equal(restored.state, task.state);
});

test("task: restoring at exactly expiresAt still succeeds (inclusive boundary)", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(TASK_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  const restored = TaskLifecycle.restoreSignedSnapshot(envelope, TASK_SECRET, {
    now: T0 + 60_000,
  });
  assert.equal(restored.state, task.state);
});

test("task: one millisecond past expiresAt throws", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(TASK_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  assert.throws(
    () =>
      TaskLifecycle.restoreSignedSnapshot(envelope, TASK_SECRET, {
        now: T0 + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
});

test("task: tampered expiresAt fails as a MAC mismatch, never as an expiry", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(TASK_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  const tampered = clone(envelope);
  tampered.expiresAt = FAR_FUTURE;
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(tampered, TASK_SECRET),
    /signed snapshot MAC mismatch/,
  );
  // The same tamper on an envelope without expiresAt also fails the MAC.
  const plain = task.exportSignedSnapshot(TASK_SECRET);
  const smuggled = clone(plain) as unknown as Record<string, unknown>;
  smuggled.expiresAt = FAR_FUTURE;
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(smuggled, TASK_SECRET),
    /signed snapshot MAC mismatch/,
  );
});

test("task: export rejects invalid expiresAt values", () => {
  const task = seededTask();
  assert.throws(
    () =>
      task.exportSignedSnapshot(TASK_SECRET, { expiresAt: "tomorrow" }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  // Non-canonical ISO (no milliseconds) is rejected, not normalized.
  assert.throws(
    () =>
      task.exportSignedSnapshot(TASK_SECRET, {
        expiresAt: "2026-11-12T00:00:00Z",
      }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  assert.throws(
    () =>
      task.exportSignedSnapshot(TASK_SECRET, {
        expiresAt: 123 as unknown as string,
      }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
});

test("task: restore rejects an invalid expiresAt inside the envelope", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(TASK_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  const badType = clone(envelope) as unknown as Record<string, unknown>;
  badType.expiresAt = 123;
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(badType, TASK_SECRET),
    /invalid signed snapshot envelope: expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  const badValue = clone(envelope) as unknown as Record<string, unknown>;
  badValue.expiresAt = "not-a-date";
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(badValue, TASK_SECRET),
    /invalid signed snapshot envelope: expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
});

test("task: maxAgeMs sets expiresAt from now and bounds the restore window", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(TASK_SECRET, {
    maxAgeMs: 60_000,
    now: T0,
  });
  assert.equal(envelope.expiresAt, EXPIRES_AT_T0);
  const inside = TaskLifecycle.restoreSignedSnapshot(envelope, TASK_SECRET, {
    now: T0 + 30_000,
  });
  assert.equal(inside.state, task.state);
  assert.throws(
    () =>
      TaskLifecycle.restoreSignedSnapshot(envelope, TASK_SECRET, {
        now: T0 + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
});

test("task: expiresAt and maxAgeMs are mutually exclusive", () => {
  const task = seededTask();
  assert.throws(
    () =>
      task.exportSignedSnapshot(TASK_SECRET, {
        expiresAt: EXPIRES_AT_T0,
        maxAgeMs: 60_000,
      }),
    /must not combine expiresAt and maxAgeMs/,
  );
});

test("task: invalid maxAgeMs, stray now, and non-finite restore now all throw", () => {
  const task = seededTask();
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => task.exportSignedSnapshot(TASK_SECRET, { maxAgeMs: bad }),
      /maxAgeMs must be a positive finite number/,
    );
  }
  assert.throws(
    () =>
      task.exportSignedSnapshot(TASK_SECRET, {
        maxAgeMs: "60000" as unknown as number,
      }),
    /maxAgeMs must be a positive finite number/,
  );
  assert.throws(
    () => task.exportSignedSnapshot(TASK_SECRET, { now: T0 }),
    /option now is only used with maxAgeMs/,
  );
  assert.throws(
    () =>
      task.exportSignedSnapshot(TASK_SECRET, {
        maxAgeMs: 60_000,
        now: Number.NaN,
      }),
    /option now must be a finite number/,
  );
  const envelope = task.exportSignedSnapshot(TASK_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  assert.throws(
    () =>
      TaskLifecycle.restoreSignedSnapshot(envelope, TASK_SECRET, {
        now: Number.NaN,
      }),
    /restore option now must be a finite number/,
  );
});

// ---- PayoutEventDedupe ----

test("dedupe: envelope without expiresAt restores as before, ids still dedupe", () => {
  const { dedupe, clock } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET);
  assert.equal("expiresAt" in envelope, false);
  const restored = PayoutEventDedupe.restoreSignedSnapshot(envelope, DEDUPE_SECRET, {
    now: clock.now,
  });
  assert.equal(restored.checkAndRecord("evt-1"), true);
  assert.equal(restored.checkAndRecord("evt-2"), true);
  assert.equal(restored.checkAndRecord("evt-3"), false);
});

test("dedupe: future expiresAt round-trips, ids still dedupe", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  assert.equal(envelope.expiresAt, EXPIRES_AT_EPOCH);
  const restored = PayoutEventDedupe.restoreSignedSnapshot(envelope, DEDUPE_SECRET, {
    now: () => EPOCH + 30_000,
  });
  assert.equal(restored.checkAndRecord("evt-1"), true);
  assert.equal(restored.checkAndRecord("evt-2"), true);
});

test("dedupe: expired envelope throws and produces no dedupe", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(envelope, DEDUPE_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at 1970-01-01T00:17:40\.000Z/,
  );
  assert.throws(
    () =>
      PayoutEventDedupe.fromSignedSnapshot(envelope, DEDUPE_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
});

test("dedupe: restoring at exactly expiresAt still succeeds (inclusive boundary)", () => {
  // A longer entry TTL than the envelope window, so the boundary
  // being tested is the envelope's — at exactly expiresAt the
  // entries are still live (entry TTL is exclusive at its own
  // boundary, so a 60_000 ms entry TTL would drop them here).
  const { dedupe } = seededDedupe(120_000);
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  const restored = PayoutEventDedupe.restoreSignedSnapshot(envelope, DEDUPE_SECRET, {
    now: () => EPOCH + 60_000,
  });
  assert.equal(restored.checkAndRecord("evt-1"), true);
});

test("dedupe: tampered expiresAt fails as a MAC mismatch", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  const tampered = clone(envelope);
  tampered.expiresAt = FAR_FUTURE;
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(tampered, DEDUPE_SECRET, {
        now: () => EPOCH + 30_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

test("dedupe: maxAgeMs sets expiresAt; invalid expiresAt at export throws", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    maxAgeMs: 60_000,
    now: EPOCH,
  });
  assert.equal(envelope.expiresAt, EXPIRES_AT_EPOCH);
  const restored = PayoutEventDedupe.restoreSignedSnapshot(envelope, DEDUPE_SECRET, {
    now: () => EPOCH + 30_000,
  });
  assert.equal(restored.checkAndRecord("evt-1"), true);
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(envelope, DEDUPE_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
  assert.throws(
    () =>
      dedupe.exportSignedSnapshot(DEDUPE_SECRET, { expiresAt: "tomorrow" }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  assert.throws(
    () =>
      dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
        expiresAt: EXPIRES_AT_EPOCH,
        maxAgeMs: 60_000,
      }),
    /must not combine expiresAt and maxAgeMs/,
  );
});

// ---- PayoutWebhookOutbox ----

test("outbox: envelope without expiresAt restores as before, ledger intact", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET);
  assert.equal("expiresAt" in envelope, false);
  const restored = PayoutWebhookOutbox.restoreSignedSnapshot(
    envelope,
    OUTBOX_SECRET,
  );
  assert.equal(restored.pending().length, 1);
  assert.equal(restored.pending()[0]?.eventId, "evt-0001");
  assert.equal(restored.deadLetter().length, 1);
  assert.equal(restored.deadLetter()[0]?.eventId, "evt-0002");
});

test("outbox: future expiresAt round-trips, ledger intact", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  assert.equal(envelope.expiresAt, EXPIRES_AT_EPOCH);
  const restored = PayoutWebhookOutbox.restoreSignedSnapshot(
    envelope,
    OUTBOX_SECRET,
    { now: () => EPOCH + 30_000 },
  );
  assert.equal(restored.pending().length, 1);
  assert.equal(restored.deadLetter().length, 1);
});

test("outbox: expired envelope throws and produces no outbox", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, OUTBOX_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at 1970-01-01T00:17:40\.000Z/,
  );
  assert.throws(
    () =>
      PayoutWebhookOutbox.fromSignedSnapshot(envelope, OUTBOX_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
});

test("outbox: restoring at exactly expiresAt still succeeds (inclusive boundary)", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  const restored = PayoutWebhookOutbox.restoreSignedSnapshot(
    envelope,
    OUTBOX_SECRET,
    { now: () => EPOCH + 60_000 },
  );
  assert.equal(restored.pending().length, 1);
  assert.equal(restored.deadLetter().length, 1);
});

test("outbox: tampered expiresAt fails as a MAC mismatch; invalid expiresAt at restore throws", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  const tampered = clone(envelope);
  tampered.expiresAt = FAR_FUTURE;
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(tampered, OUTBOX_SECRET, {
        now: () => EPOCH + 30_000,
      }),
    /signed snapshot MAC mismatch/,
  );
  const badValue = clone(envelope) as unknown as Record<string, unknown>;
  badValue.expiresAt = "not-a-date";
  assert.throws(
    () => PayoutWebhookOutbox.restoreSignedSnapshot(badValue, OUTBOX_SECRET),
    /invalid signed snapshot envelope: expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
});
