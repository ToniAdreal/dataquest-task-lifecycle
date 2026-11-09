import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PayoutEventDedupe } from "../src/index.js";
import type { PayoutEventDedupeSignedSnapshotEnvelope } from "../src/index.js";

/**
 * HMAC-signed snapshot envelopes for `PayoutEventDedupe`
 * (backlog #1011), mirroring the sibling escrow-state-machine-ts
 * `SettlementEventDedupe` signed-snapshot paradigm (#1010).
 *
 * The unsigned snapshot (#157) is trusted configuration: anyone
 * who can rewrite the persisted file can delete a consumed
 * `eventId` (a retried duplicate payout notification is then
 * processed a second time) or inject a forged one (a legitimate
 * payout notification is then dropped as an apparent duplicate).
 * Rules under test:
 *  - `exportSignedSnapshot(secret)` returns `{ v: 1, snapshot, mac }`
 *    with `mac` = HMAC-SHA256 over the canonical JSON of the
 *    snapshot; the secret is never written into the envelope
 *  - `restoreSignedSnapshot(envelope, secret, opts)` (alias
 *    `fromSignedSnapshot`) rebuilds a store whose ids still
 *    dedupe, with TTLs counting from the original `seenAtMs`
 *  - a tampered eventId / seenAtMs / mac, or a wrong secret, is
 *    rejected fail-closed and produces no store — the caller's
 *    existing dedupes and their stats are untouched
 *  - envelope shape is validated first (unknown field, version
 *    other than 1, malformed mac), and a MAC-valid envelope whose
 *    snapshot is itself malformed still fails snapshot validation
 *  - an empty (or wrongly typed) secret is rejected on both sides
 *  - the unsigned path is unchanged, and the two forms do not
 *    accept each other — a signed restore cannot silently
 *    downgrade to trusted configuration
 *  - a failed signed restore counts nothing: restored stores start
 *    their observability counters at zero
 *  - honest scope stays single-process: a signed envelope bridges
 *    one process across its own restart, it is not shared storage
 */

const SECRET = "payout-dedupe-snapshot-signing-secret-for-tests";
const TTL = 60_000;

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function seededDedupe(): {
  dedupe: PayoutEventDedupe;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-2"), false);
  return { dedupe, clock };
}

// A signed snapshot survives a JSON round-trip and the restart does
// not reopen the double-payout window.
test("signed snapshot round-trip: seen ids are still duplicates after restore", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(SECRET);
  assert.equal(envelope.v, 1);
  assert.deepEqual(envelope.snapshot, {
    v: 1,
    entries: [
      ["evt-1", 1_000_000],
      ["evt-2", 1_000_000],
    ],
  });
  assert.match(envelope.mac, /^[0-9a-f]{64}$/);

  // The envelope is plain JSON: a string round-trip must not break it.
  const wire = JSON.parse(
    JSON.stringify(envelope),
  ) as PayoutEventDedupeSignedSnapshotEnvelope;
  const restored = PayoutEventDedupe.restoreSignedSnapshot(wire, SECRET, {
    ttlMs: TTL,
    now: () => 1_000_000,
  });
  assert.equal(restored.size, 2);
  assert.equal(restored.checkAndRecord("evt-1"), true); // duplicate
  assert.equal(restored.checkAndRecord("evt-2"), true); // duplicate
  assert.equal(restored.checkAndRecord("evt-3"), false); // fresh id records
  // The original dedupe is untouched by the restore.
  assert.equal(dedupe.size, 2);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  // Counters start at zero on the restored store (2 duplicate hits
  // above are the only counts: 2 hits, 1 miss).
  assert.deepEqual(restored.stats(), {
    size: 3,
    hits: 2,
    misses: 1,
    evictions: 0,
  });
});

// The secret is caller configuration: it is never written into the
// envelope, so a persisted envelope leaks nothing about it.
test("envelope carries no secret", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(SECRET);
  assert.deepEqual(Object.keys(envelope).sort(), ["mac", "snapshot", "v"]);
  assert.equal(JSON.stringify(envelope).includes(SECRET), false);
  assert.equal(JSON.stringify(envelope).includes("secret"), false);
});

// A rewritten entry is caught at restore: deleting a consumed id
// would otherwise reopen the double-payout window.
test("tampered eventId is rejected and no store is produced", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(SECRET);
  envelope.snapshot.entries[0][0] = "evt-forged";
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(envelope, SECRET, {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /signed snapshot MAC mismatch/,
  );
  // The caller's existing dedupe is untouched by the failed restore.
  assert.equal(dedupe.size, 2);
  assert.deepEqual(dedupe.stats(), {
    size: 2,
    hits: 0,
    misses: 2,
    evictions: 0,
  });
});

test("tampered seenAtMs is rejected", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(SECRET);
  envelope.snapshot.entries[1][1] = 1_000_001;
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(envelope, SECRET, {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

test("tampered mac is rejected", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(SECRET);
  const last = envelope.mac.slice(-1);
  envelope.mac = envelope.mac.slice(0, -1) + (last === "0" ? "1" : "0");
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(envelope, SECRET, {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

test("wrong secret is rejected", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(SECRET);
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(envelope, "wrong-secret", {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

// Shape is validated before any MAC work: a smuggled field (notably
// a "secret") cannot ride past restore.
test("envelope unknown field is rejected, including a smuggled secret", () => {
  const { dedupe } = seededDedupe();
  const withExtra = {
    ...dedupe.exportSignedSnapshot(SECRET),
    secret: SECRET,
  };
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(withExtra, SECRET, {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /invalid signed snapshot envelope: unknown field "secret"/,
  );
});

test("envelope version other than 1 is rejected", () => {
  const { dedupe } = seededDedupe();
  const v2 = { ...dedupe.exportSignedSnapshot(SECRET), v: 2 };
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(v2, SECRET, {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /invalid signed snapshot envelope: unsupported envelope version 2/,
  );
  const { v: _v, ...noVersion } = dedupe.exportSignedSnapshot(SECRET);
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(noVersion, SECRET, {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /invalid signed snapshot envelope: unsupported envelope version/,
  );
});

test("malformed mac is rejected before comparison", () => {
  const { dedupe } = seededDedupe();
  for (const badMac of [
    "ABCDEF0123456789".repeat(4), // uppercase hex
    "a".repeat(63), // one short
    "a".repeat(65), // one long
    "g".repeat(64), // non-hex
    1234,
    undefined,
  ]) {
    const envelope = dedupe.exportSignedSnapshot(SECRET);
    (envelope as { mac: unknown }).mac = badMac;
    assert.throws(
      () =>
        PayoutEventDedupe.restoreSignedSnapshot(envelope, SECRET, {
          ttlMs: TTL,
          now: () => 1_000_000,
        }),
      /mac must be a 64-character lowercase hex HMAC-SHA256 digest/,
    );
  }
});

test("empty secret is rejected on both sides; wrong type too", () => {
  const { dedupe } = seededDedupe();
  assert.throws(
    () => dedupe.exportSignedSnapshot(""),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () => dedupe.exportSignedSnapshot(Buffer.alloc(0)),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () => dedupe.exportSignedSnapshot(1234 as unknown as string),
    /signed snapshot secret must be a non-empty string or Buffer, got number/,
  );
  const envelope = dedupe.exportSignedSnapshot(SECRET);
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(envelope, "", {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(envelope, Buffer.alloc(0), {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /signed snapshot secret must not be empty/,
  );
});

// A string secret and the same bytes as a Buffer produce the same
// envelope, so callers can hold the secret either way.
test("Buffer secret round-trips and matches the string secret", () => {
  const { dedupe } = seededDedupe();
  const fromString = dedupe.exportSignedSnapshot(SECRET);
  const fromBuffer = dedupe.exportSignedSnapshot(Buffer.from(SECRET, "utf8"));
  assert.equal(fromBuffer.mac, fromString.mac);
  const restored = PayoutEventDedupe.restoreSignedSnapshot(
    fromBuffer,
    Buffer.from(SECRET, "utf8"),
    { ttlMs: TTL, now: () => 1_000_000 },
  );
  assert.equal(restored.checkAndRecord("evt-1"), true);
  const restoredCross = PayoutEventDedupe.fromSignedSnapshot(
    fromString,
    Buffer.from(SECRET, "utf8"),
    { ttlMs: TTL, now: () => 1_000_000 },
  );
  assert.equal(restoredCross.checkAndRecord("evt-2"), true);
});

// The MAC only proves the snapshot was not rewritten — a snapshot
// that is itself malformed must still fail strict snapshot
// validation even when its MAC is valid (recomputed here with the
// real secret over the canonical JSON, keys sorted).
test("MAC-valid envelope with a malformed snapshot still fails validation", () => {
  const badSnapshot = {
    v: 1,
    entries: [["evt-1", "not-a-number"]],
  };
  const canonical = '{"entries":[["evt-1","not-a-number"]],"v":1}';
  const mac = createHmac("sha256", SECRET)
    .update(canonical, "utf8")
    .digest("hex");
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(
        { v: 1, snapshot: badSnapshot, mac },
        SECRET,
        { ttlMs: TTL, now: () => 1_000_000 },
      ),
    /invalid snapshot: entries\[0\]: seenAtMs must be a finite non-negative number/,
  );
});

// The two forms do not accept each other: a signed restore cannot
// silently downgrade to the trusted-configuration path, and the
// unsigned path never mistakes an envelope for a snapshot.
test("signed and unsigned forms are mutually exclusive", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(SECRET);
  assert.throws(
    () => PayoutEventDedupe.restore(envelope, { ttlMs: TTL }),
    /invalid snapshot: unknown field "snapshot"/,
  );
  const unsigned = dedupe.exportSnapshot();
  assert.throws(
    () =>
      PayoutEventDedupe.restoreSignedSnapshot(unsigned, SECRET, {
        ttlMs: TTL,
        now: () => 1_000_000,
      }),
    /invalid signed snapshot envelope: unknown field "entries"/,
  );
  // Unsigned path regression: the old form still works untouched.
  const restoredUnsigned = PayoutEventDedupe.fromSnapshot(unsigned, {
    ttlMs: TTL,
    now: () => 1_000_000,
  });
  assert.equal(restoredUnsigned.checkAndRecord("evt-1"), true);
});

// TTLs keep counting from each id's original first-seen time across
// a signed restore, and expired entries never enter the envelope.
test("signed restore preserves original TTLs; expired ids are excluded", () => {
  const clock = fakeClock();
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-old"), false);
  clock.advance(TTL - 1_000);
  assert.equal(dedupe.checkAndRecord("evt-new"), false);
  const envelope = dedupe.exportSignedSnapshot(SECRET);
  assert.deepEqual(envelope.snapshot.entries, [
    ["evt-old", 1_000_000],
    ["evt-new", 1_000_000 + TTL - 1_000],
  ]);
  // Restore 500ms later: the old id is 500ms from expiry, the new
  // one still has 500ms left on its original window.
  const restored = PayoutEventDedupe.restoreSignedSnapshot(
    JSON.parse(JSON.stringify(envelope)) as PayoutEventDedupeSignedSnapshotEnvelope,
    SECRET,
    { ttlMs: TTL, now: () => 1_000_000 + TTL - 500 },
  );
  assert.equal(restored.checkAndRecord("evt-old"), true);
  assert.equal(restored.checkAndRecord("evt-new"), true);
  clock.advance(1_000);
  // At 2*TTL - 1s both ids are past their original windows.
  const expired = PayoutEventDedupe.restoreSignedSnapshot(
    JSON.parse(JSON.stringify(envelope)) as PayoutEventDedupeSignedSnapshotEnvelope,
    SECRET,
    { ttlMs: TTL, now: () => 1_000_000 + 2 * TTL - 1_000 },
  );
  assert.equal(expired.size, 0);
  assert.equal(expired.checkAndRecord("evt-old"), false);

  // Expired ids never enter the envelope in the first place.
  const clock2 = fakeClock();
  const dedupe2 = new PayoutEventDedupe({ ttlMs: TTL, now: clock2.now });
  assert.equal(dedupe2.checkAndRecord("evt-gone"), false);
  clock2.advance(TTL);
  assert.deepEqual(dedupe2.exportSignedSnapshot(SECRET).snapshot.entries, []);
});
