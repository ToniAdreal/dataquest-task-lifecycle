import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PayoutWebhookOutbox } from "../src/index.js";
import type { PayoutWebhookOutboxSignedSnapshotEnvelope } from "../src/index.js";

/**
 * HMAC-signed snapshot envelopes for `PayoutWebhookOutbox`
 * (backlog #1031), mirroring the sibling `PayoutEventDedupe`
 * signed-snapshot paradigm (#1011) and the escrow
 * `SettlementWebhookOutbox` one (#1030).
 *
 * The unsigned snapshot (#1020) is trusted configuration: anyone
 * who can rewrite the persisted file can silently clear a dead
 * letter (a failed delivery is then retried forever, or a
 * dead-lettered pair is resurrected as pending) or inflate an
 * `attempts` count (a pair that still deserves retries is pushed
 * into the dead letter and never retried). Rules under test:
 *  - `exportSignedSnapshot(secret)` returns `{ v: 1, snapshot, mac }`
 *    with `mac` = HMAC-SHA256 over the canonical JSON of the
 *    snapshot; the secret is never written into the envelope
 *  - `restoreSignedSnapshot(envelope, secret, opts)` (alias
 *    `fromSignedSnapshot`) rebuilds an outbox whose pending counts
 *    and dead-letter status survive, and which keeps counting from
 *    where the snapshot left off
 *  - a tampered attempts count / lastError / lastAt / endpoint /
 *    eventId / mac, or a wrong secret, is rejected fail-closed and
 *    produces no outbox — the caller's existing outbox is untouched
 *  - envelope shape is validated first (unknown field, version
 *    other than 1, malformed mac), and a MAC-valid envelope whose
 *    snapshot is itself malformed still fails snapshot validation
 *  - an empty (or wrongly typed) secret is rejected on both sides
 *  - the unsigned path is unchanged, and the two forms do not
 *    accept each other — a signed restore cannot silently
 *    downgrade to trusted configuration
 *  - whether a restored entry reads as pending or dead-lettered is
 *    derived from its `attempts` against the restoring outbox's
 *    `maxAttempts`, exactly as on the unsigned path
 *  - honest scope stays single-process: a signed envelope bridges
 *    one process across its own restart, it is not shared storage
 */

const SECRET = "outbox-snapshot-signing-secret-for-tests";
const A = "https://books.example/hooks/settlement";
const B = "https://ledger.example/hooks/settlement";
const EVT_1 = "evt-0001";
const EVT_2 = "evt-0002";

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fail(
  outbox: PayoutWebhookOutbox,
  endpoint: string,
  eventId: string,
  error = "server responded with status 500",
  at?: number,
): void {
  outbox.recordAttempt({ endpoint, eventId, ok: false, error, at });
}

function seededOutbox(): {
  outbox: PayoutWebhookOutbox;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock();
  const outbox = new PayoutWebhookOutbox({ now: clock.now });
  fail(outbox, A, EVT_1, "first");
  clock.advance(1000);
  fail(outbox, A, EVT_1, "second");
  fail(outbox, B, EVT_2, "once");
  fail(outbox, B, EVT_2, "twice");
  fail(outbox, B, EVT_2, "thrice");
  return { outbox, clock };
}

// A signed snapshot survives a JSON round-trip and the restart does
// not forget which deliveries were already failing.
test("signed snapshot round-trip: counts and dead-letter status survive restore", () => {
  const { outbox, clock } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  assert.equal(envelope.v, 1);
  assert.deepEqual(envelope.snapshot, {
    v: 1,
    entries: [
      {
        endpoint: A,
        eventId: EVT_1,
        attempts: 2,
        lastError: "second",
        lastAt: 1_001_000,
      },
      {
        endpoint: B,
        eventId: EVT_2,
        attempts: 3,
        lastError: "thrice",
        lastAt: 1_001_000,
      },
    ],
  });
  assert.match(envelope.mac, /^[0-9a-f]{64}$/);

  // The envelope is plain JSON: a string round-trip must not break it.
  const wire = JSON.parse(
    JSON.stringify(envelope),
  ) as PayoutWebhookOutboxSignedSnapshotEnvelope;
  const restored = PayoutWebhookOutbox.restoreSignedSnapshot(wire, SECRET, {
    now: clock.now,
  });
  assert.deepEqual(restored.pending(), outbox.pending());
  assert.deepEqual(restored.deadLetter(), outbox.deadLetter());
  assert.equal(restored.size, outbox.size);
  // The restored ledger keeps counting from where the snapshot left off.
  restored.recordAttempt({
    endpoint: A,
    eventId: EVT_1,
    ok: false,
    error: "third",
  });
  assert.deepEqual(restored.pending(), []);
  assert.deepEqual(
    restored.deadLetter().map((e) => [e.endpoint, e.attempts]),
    [
      [A, 3],
      [B, 3],
    ],
  );
  // The original outbox is untouched by the restore.
  assert.deepEqual(outbox.pending(), [
    {
      endpoint: A,
      eventId: EVT_1,
      attempts: 2,
      lastError: "second",
      lastAt: 1_001_000,
    },
  ]);
  assert.equal(outbox.deadLetter().length, 1);
});

// The secret is caller configuration: it is never written into the
// envelope, so a persisted envelope leaks nothing about it.
test("envelope carries no secret", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  assert.deepEqual(Object.keys(envelope).sort(), ["mac", "snapshot", "v"]);
  assert.equal(JSON.stringify(envelope).includes(SECRET), false);
  assert.equal(JSON.stringify(envelope).includes("secret"), false);
});

// A rewritten attempts count is caught at restore: lowering it would
// otherwise resurrect a dead letter, raising it would kill retries.
test("tampered attempts count is rejected and no outbox is produced", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  envelope.snapshot.entries[0].attempts = 1;
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
        now: () => 1_001_000,
      }),
    /signed snapshot MAC mismatch/,
  );
  // The caller's existing outbox is untouched by the failed restore.
  assert.equal(outbox.size, 2);
  assert.deepEqual(
    outbox.pending().map((e) => [e.endpoint, e.attempts]),
    [[A, 2]],
  );
  assert.deepEqual(
    outbox.deadLetter().map((e) => [e.endpoint, e.attempts]),
    [[B, 3]],
  );
});

// Lowering a dead-lettered pair's count back under the cap is the
// same rewrite as above, seen from the dead-letter side.
test("tampered dead-letter attempts count is rejected", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  envelope.snapshot.entries[1].attempts = 2;
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
        now: () => 1_001_000,
      }),
    /signed snapshot MAC mismatch/,
  );
  assert.equal(outbox.deadLetter().length, 1);
});

test("tampered lastError is rejected", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  envelope.snapshot.entries[0].lastError = "forged reason";
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
        now: () => 1_001_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

test("tampered lastAt is rejected", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  envelope.snapshot.entries[0].lastAt = 1_000_001;
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
        now: () => 1_001_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

test("tampered endpoint is rejected", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  envelope.snapshot.entries[0].endpoint = "https://evil.example/hooks";
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
        now: () => 1_001_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

test("tampered eventId is rejected", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  envelope.snapshot.entries[0].eventId = "evt-forged";
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
        now: () => 1_001_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

test("tampered mac is rejected", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  const last = envelope.mac.slice(-1);
  envelope.mac = envelope.mac.slice(0, -1) + (last === "0" ? "1" : "0");
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
        now: () => 1_001_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

test("wrong secret is rejected", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, "wrong-secret", {
        now: () => 1_001_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

// Shape is validated before any MAC work: a smuggled field (notably
// a "secret") cannot ride past restore.
test("envelope unknown field is rejected, including a smuggled secret", () => {
  const { outbox } = seededOutbox();
  const withExtra = {
    ...outbox.exportSignedSnapshot(SECRET),
    secret: "smuggled-secret",
  };
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(withExtra, SECRET, {
        now: () => 1_001_000,
      }),
    /invalid signed snapshot envelope: unknown field "secret"/,
  );
});

test("non-object envelope is rejected", () => {
  const { outbox } = seededOutbox();
  for (const bad of [null, [], "envelope", 42]) {
    assert.throws(
      () =>
        PayoutWebhookOutbox.restoreSignedSnapshot(bad, SECRET, {
          now: () => 1_001_000,
        }),
      /invalid signed snapshot envelope: expected an object of the form \{ v: 1, snapshot, mac \}/,
    );
  }
  // The valid envelope still restores after the rejections.
  const envelope = outbox.exportSignedSnapshot(SECRET);
  const restored = PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
    now: () => 1_001_000,
  });
  assert.equal(restored.size, 2);
});

test("envelope version other than 1 is rejected", () => {
  const { outbox } = seededOutbox();
  const v2 = { ...outbox.exportSignedSnapshot(SECRET), v: 2 };
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(v2, SECRET, {
        now: () => 1_001_000,
      }),
    /invalid signed snapshot envelope: unsupported envelope version 2/,
  );
  const { v: _v, ...noVersion } = outbox.exportSignedSnapshot(SECRET);
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(noVersion, SECRET, {
        now: () => 1_001_000,
      }),
    /invalid signed snapshot envelope: unsupported envelope version/,
  );
});

test("malformed mac is rejected before comparison", () => {
  const { outbox } = seededOutbox();
  for (const badMac of [
    "ABCDEF0123456789".repeat(4), // uppercase hex
    "a".repeat(63), // one short
    "a".repeat(65), // one long
    "g".repeat(64), // non-hex
    1234,
    undefined,
  ]) {
    const envelope = outbox.exportSignedSnapshot(SECRET);
    (envelope as { mac: unknown }).mac = badMac;
    assert.throws(
      () =>
        PayoutWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
          now: () => 1_001_000,
        }),
      /mac must be a 64-character lowercase hex HMAC-SHA256 digest/,
    );
  }
});

test("empty secret is rejected on both sides; wrong type too", () => {
  const { outbox } = seededOutbox();
  assert.throws(
    () => outbox.exportSignedSnapshot(""),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () => outbox.exportSignedSnapshot(Buffer.alloc(0)),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () => outbox.exportSignedSnapshot(1234 as unknown as string),
    /signed snapshot secret must be a non-empty string or Buffer, got number/,
  );
  const envelope = outbox.exportSignedSnapshot(SECRET);
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, "", {
        now: () => 1_001_000,
      }),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(envelope, Buffer.alloc(0), {
        now: () => 1_001_000,
      }),
    /signed snapshot secret must not be empty/,
  );
});

// A string secret and the same bytes as a Buffer produce the same
// envelope, so callers can hold the secret either way.
test("Buffer secret round-trips and matches the string secret", () => {
  const { outbox } = seededOutbox();
  const fromString = outbox.exportSignedSnapshot(SECRET);
  const fromBuffer = outbox.exportSignedSnapshot(Buffer.from(SECRET, "utf8"));
  assert.equal(fromBuffer.mac, fromString.mac);
  const restored = PayoutWebhookOutbox.restoreSignedSnapshot(
    fromBuffer,
    Buffer.from(SECRET, "utf8"),
    { now: () => 1_001_000 },
  );
  assert.deepEqual(
    restored.pending().map((e) => [e.endpoint, e.attempts]),
    [[A, 2]],
  );
  const restoredCross = PayoutWebhookOutbox.fromSignedSnapshot(
    fromString,
    Buffer.from(SECRET, "utf8"),
    { now: () => 1_001_000 },
  );
  assert.equal(restoredCross.deadLetter().length, 1);
});

// The MAC only proves the snapshot was not rewritten — a snapshot
// that is itself malformed must still fail strict snapshot
// validation even when its MAC is valid (recomputed here with the
// real secret over the canonical JSON, keys sorted).
test("MAC-valid envelope with a malformed snapshot still fails validation", () => {
  const badSnapshot = {
    v: 1,
    entries: [{ endpoint: A, eventId: EVT_1, attempts: "one", lastAt: 0 }],
  };
  const canonical = `{"entries":[{"attempts":"one","endpoint":"${A}","eventId":"${EVT_1}","lastAt":0}],"v":1}`;
  const mac = createHmac("sha256", SECRET)
    .update(canonical, "utf8")
    .digest("hex");
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(
        { v: 1, snapshot: badSnapshot, mac },
        SECRET,
        { now: () => 1_001_000 },
      ),
    /invalid snapshot: entries\[0\]: attempts must be a non-negative integer/,
  );
});

// The two forms do not accept each other: a signed restore cannot
// silently downgrade to the trusted-configuration path, and the
// unsigned path never mistakes an envelope for a snapshot.
test("signed and unsigned forms are mutually exclusive", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);
  assert.throws(
    () => PayoutWebhookOutbox.restore(envelope),
    /invalid snapshot: unknown field "snapshot"/,
  );
  const unsigned = outbox.exportSnapshot();
  assert.throws(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(unsigned, SECRET, {
        now: () => 1_001_000,
      }),
    /invalid signed snapshot envelope: unknown field "entries"/,
  );
  // Unsigned path regression: the old form still works untouched.
  const restoredUnsigned = PayoutWebhookOutbox.fromSnapshot(unsigned, {
    now: () => 1_001_000,
  });
  assert.deepEqual(restoredUnsigned.pending(), outbox.pending());
  assert.deepEqual(restoredUnsigned.deadLetter(), outbox.deadLetter());
});

// Whether a restored entry reads as pending or dead-lettered is
// derived from its attempts against the restoring outbox's
// maxAttempts, exactly as on the unsigned path.
test("signed restore under a different maxAttempts re-derives the boundary", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(SECRET);

  const stricter = PayoutWebhookOutbox.restoreSignedSnapshot(
    JSON.parse(JSON.stringify(envelope)) as PayoutWebhookOutboxSignedSnapshotEnvelope,
    SECRET,
    { maxAttempts: 2, now: () => 1_001_000 },
  );
  assert.deepEqual(stricter.pending(), []);
  assert.equal(stricter.deadLetter().length, 2);

  const looser = PayoutWebhookOutbox.restoreSignedSnapshot(
    JSON.parse(JSON.stringify(envelope)) as PayoutWebhookOutboxSignedSnapshotEnvelope,
    SECRET,
    { maxAttempts: 5, now: () => 1_001_000 },
  );
  assert.equal(looser.pending().length, 2);
  assert.deepEqual(looser.deadLetter(), []);
});
