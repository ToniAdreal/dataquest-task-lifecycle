/**
 * HMAC-signed snapshot envelopes for `TaskLifecycle` (backlog #1018),
 * mirroring the sibling escrow-state-machine-ts `Escrow` signed
 * snapshot (#1017) and this repo's `PayoutEventDedupe` signed snapshot
 * (#1011).
 *
 * The audit hash chain covers history entries only — the
 * snapshot-level fields (`state`, `slaDeadlines`, `maxResubmits`,
 * `maxDisputes`, `maxVisitsByState`, `rolePolicy`, `idempotencyKeys`)
 * sit outside it, so a rewritten persisted snapshot could push an SLA
 * deadline back, loosen a budget or a policy, or clear consumed
 * idempotency keys without breaking any history link. Rules under test:
 *  - `exportSignedSnapshot(secret)` returns `{ v: 1, snapshot, mac }`
 *    with `mac` = HMAC-SHA256 over the canonical JSON of the
 *    snapshot; the secret is never written into the envelope
 *  - `restoreSignedSnapshot(envelope, secret, opts)` (alias
 *    `fromSignedSnapshot`) rebuilds a working task whose
 *    snapshot-level configuration is intact and whose history
 *    chain continues unbroken on further dispatch
 *  - a tampered snapshot field (`state`/`slaDeadlines`/
 *    `maxResubmits`/`maxDisputes`/`maxVisitsByState`/`rolePolicy`/
 *    `idempotencyKeys`), a tampered history entry, a tampered `mac`,
 *    or a wrong secret is rejected fail-closed and produces no task
 *  - envelope shape is validated first (unknown field, version
 *    other than 1, malformed mac), and a MAC-valid envelope whose
 *    snapshot is itself malformed still fails snapshot validation
 *  - an empty (or wrongly typed) secret is rejected on both sides
 *  - the unsigned path is unchanged, and the two forms do not
 *    accept each other — a signed restore cannot silently
 *    downgrade to trusted configuration
 *  - a keyed history chain still needs its own `auditSecret` on
 *    restore (independent of the envelope secret), fail-closed
 *    both ways
 *  - honest scope stays single-process: a signed envelope bridges
 *    one process across its own restart, it is not shared storage
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { TaskLifecycle, verifyHistoryChain } from "../src/index.js";
import type {
  TaskLifecycleSignedSnapshotEnvelope,
  TaskSnapshot,
} from "../src/index.js";

const SECRET = "task-snapshot-signing-secret-for-tests";
const AUDIT_SECRET = "task-audit-secret-for-tests";
const WRONG_SECRET = "task-snapshot-signing-secret-WRONG";

/** Seeded task: CAPTURING, with every snapshot-level field set. */
function seededTask(): TaskLifecycle {
  const task = new TaskLifecycle("task-signed-1", {
    maxResubmits: 2,
    maxDisputes: 1,
    maxVisitsByState: { IN_REVIEW: 3 },
    rolePolicy: { SUBMIT: ["contributor-7"] },
    slaDeadlines: { IN_REVIEW: "2026-12-01T00:00:00.000Z" },
  });
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-11-09T00:00:00.000Z",
    idempotencyKey: "pub-1",
  });
  task.dispatch("ACCEPT", {
    actor: "contributor-7",
    at: "2026-11-09T00:01:00.000Z",
    idempotencyKey: "acc-1",
  });
  task.dispatch("START_CAPTURE", {
    actor: "contributor-7",
    at: "2026-11-09T00:02:00.000Z",
  });
  return task;
}

/** Deep-clone a value so tampering tests don't fight Object.freeze. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Independent canonical-JSON re-implementation (keys sorted
 * recursively, array order preserved) for the MAC-valid-but-malformed
 * test: the MAC there must be recomputed in the test, not trusted
 * from the implementation under test.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`test canonicalizer: non-JSON value ${typeof value}`);
}

// A signed snapshot restores with every snapshot-level field intact,
// and the restored task keeps dispatching with an unbroken chain.
test("signed snapshot round-trip restores config and continues dispatch", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(SECRET);
  assert.equal(envelope.v, 1);
  assert.match(envelope.mac, /^[0-9a-f]{64}$/);
  assert.equal(envelope.snapshot.id, "task-signed-1");
  assert.equal(envelope.snapshot.state, "CAPTURING");

  const restored = TaskLifecycle.restoreSignedSnapshot(envelope, SECRET);
  assert.equal(restored.id, "task-signed-1");
  assert.equal(restored.state, "CAPTURING");
  assert.deepEqual(restored.toJSON(), task.toJSON());
  assert.deepEqual(restored.toJSON().slaDeadlines, {
    IN_REVIEW: "2026-12-01T00:00:00.000Z",
  });
  assert.equal(restored.toJSON().maxResubmits, 2);
  assert.equal(restored.toJSON().maxDisputes, 1);
  assert.deepEqual(restored.toJSON().maxVisitsByState, { IN_REVIEW: 3 });
  assert.deepEqual(restored.toJSON().rolePolicy, {
    SUBMIT: ["contributor-7"],
  });
  assert.deepEqual(restored.toJSON().idempotencyKeys, ["pub-1", "acc-1"]);
  assert.deepEqual(restored.toJSON().history, task.toJSON().history);
  assert.equal(verifyHistoryChain(restored.history), true);

  // The chain continues unbroken: the next dispatch appends seq 4
  // with a correct prevHash link, and the role policy still gates.
  assert.throws(
    () =>
      restored.dispatch("SUBMIT", {
        actor: "mallory",
        at: "2026-11-09T00:03:00.000Z",
      }),
    /actor not authorized for SUBMIT: "mallory" is not in \[contributor-7\]/,
  );
  restored.dispatch("SUBMIT", {
    actor: "contributor-7",
    at: "2026-11-09T00:03:00.000Z",
  });
  assert.equal(restored.state, "SUBMITTED");
  assert.equal(restored.history.length, 4);
  assert.equal(restored.history[3].seq, 4);
  assert.equal(restored.history[3].prevHash, restored.history[2].hash);
  assert.equal(verifyHistoryChain(restored.history), true);
  // A replayed consumed key stays a no-op after the restore (the
  // dedupe returns the current state and appends nothing).
  assert.equal(
    restored.dispatch("SUBMIT", {
      actor: "contributor-7",
      at: "2026-11-09T00:04:00.000Z",
      idempotencyKey: "acc-1",
    }),
    "SUBMITTED",
  );
  assert.equal(restored.history.length, 4);
});

// The envelope is plain JSON: a string round-trip must not break it.
test("signed snapshot survives a JSON persistence round-trip", () => {
  const envelope = seededTask().exportSignedSnapshot(SECRET);
  const wire = JSON.parse(
    JSON.stringify(envelope),
  ) as TaskLifecycleSignedSnapshotEnvelope;
  const restored = TaskLifecycle.fromSignedSnapshot(wire, SECRET);
  assert.equal(restored.state, "CAPTURING");
  assert.deepEqual(restored.toJSON().slaDeadlines, {
    IN_REVIEW: "2026-12-01T00:00:00.000Z",
  });
  assert.equal(verifyHistoryChain(restored.history), true);
});

// The secret is caller configuration: it is never written into the
// envelope, so a persisted envelope leaks nothing about it.
test("envelope carries no secret", () => {
  const envelope = seededTask().exportSignedSnapshot(SECRET);
  assert.deepEqual(Object.keys(envelope).sort(), ["mac", "snapshot", "v"]);
  assert.equal(JSON.stringify(envelope).includes(SECRET), false);
  assert.equal(JSON.stringify(envelope).includes("secret"), false);
});

// Every snapshot-level field is covered by the MAC: rewriting any
// one of them without the secret fails closed, with no task
// produced.
test("tampered snapshot-level fields are rejected", () => {
  const cases: Array<{
    name: string;
    mutate: (snapshot: TaskSnapshot) => void;
  }> = [
    {
      name: "state",
      mutate: (s) => {
        s.state = "OPEN";
      },
    },
    {
      name: "slaDeadlines",
      mutate: (s) => {
        s.slaDeadlines = { IN_REVIEW: "2027-01-01T00:00:00.000Z" };
      },
    },
    {
      name: "maxResubmits",
      mutate: (s) => {
        s.maxResubmits = 99;
      },
    },
    {
      name: "maxDisputes",
      mutate: (s) => {
        s.maxDisputes = 99;
      },
    },
    {
      name: "maxVisitsByState",
      mutate: (s) => {
        s.maxVisitsByState = { IN_REVIEW: 99 };
      },
    },
    {
      name: "rolePolicy",
      mutate: (s) => {
        s.rolePolicy = {};
      },
    },
    {
      name: "idempotencyKeys",
      mutate: (s) => {
        s.idempotencyKeys = [];
      },
    },
    {
      name: "history entry actor",
      mutate: (s) => {
        s.history[0].actor = "mallory";
      },
    },
  ];
  for (const { name, mutate } of cases) {
    const envelope = seededTask().exportSignedSnapshot(SECRET);
    mutate(envelope.snapshot);
    assert.throws(
      () => TaskLifecycle.restoreSignedSnapshot(envelope, SECRET),
      /signed snapshot MAC mismatch/,
      `tampered ${name} must fail the MAC check`,
    );
  }
});

test("tampered mac and wrong secret are rejected", () => {
  const envelope = seededTask().exportSignedSnapshot(SECRET);
  const tampered = clone(envelope);
  tampered.mac = "0".repeat(64);
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(tampered, SECRET),
    /signed snapshot MAC mismatch/,
  );
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(envelope, WRONG_SECRET),
    /signed snapshot MAC mismatch/,
  );
  // A single flipped hex digit in the mac is enough.
  const flipped = clone(envelope);
  flipped.mac =
    (flipped.mac[0] === "0" ? "1" : "0") + flipped.mac.slice(1);
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(flipped, SECRET),
    /signed snapshot MAC mismatch/,
  );
});

// Envelope shape is checked before the MAC: a malformed envelope
// reports its own shape problem, never a misleading MAC failure.
test("envelope shape is validated before the MAC", () => {
  const envelope = seededTask().exportSignedSnapshot(SECRET);
  const smuggled = clone(envelope) as unknown as Record<string, unknown>;
  smuggled.secret = SECRET;
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(smuggled, SECRET),
    /invalid signed snapshot envelope: unknown field "secret"/,
  );
  for (const badVersion of [2, "1", null, undefined]) {
    const versioned = clone(envelope) as unknown as Record<string, unknown>;
    if (badVersion === undefined) delete versioned.v;
    else versioned.v = badVersion;
    assert.throws(
      () => TaskLifecycle.restoreSignedSnapshot(versioned, SECRET),
      /invalid signed snapshot envelope: unsupported envelope version/,
      `version ${String(badVersion)} must be rejected`,
    );
  }
  for (const badEnvelope of [null, "x", [envelope], 42]) {
    assert.throws(
      () => TaskLifecycle.restoreSignedSnapshot(badEnvelope, SECRET),
      /invalid signed snapshot envelope: expected an object of the form \{ v: 1, snapshot, mac \}/,
    );
  }
  const badSnapshot = clone(envelope) as unknown as Record<string, unknown>;
  badSnapshot.snapshot = "not-an-object";
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(badSnapshot, SECRET),
    /invalid signed snapshot envelope: "snapshot" must be an object/,
  );
  for (const badMac of [
    "A".repeat(64),
    "0".repeat(63),
    "0".repeat(65),
    "",
    123,
    null,
  ]) {
    const macced = clone(envelope) as unknown as Record<string, unknown>;
    macced.mac = badMac;
    assert.throws(
      () => TaskLifecycle.restoreSignedSnapshot(macced, SECRET),
      /invalid signed snapshot envelope: mac must be a 64-character lowercase hex HMAC-SHA256 digest/,
      `mac ${JSON.stringify(badMac)} must be rejected as malformed`,
    );
  }
});

test("empty or wrongly typed secret is rejected on both sides", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(SECRET);
  for (const badSecret of ["", Buffer.alloc(0), 123, null, undefined, {}]) {
    assert.throws(
      () =>
        task.exportSignedSnapshot(badSecret as unknown as string),
      /signed snapshot secret must not be empty|signed snapshot secret must be a non-empty string or Buffer/,
      `export with secret ${String(badSecret)} must throw`,
    );
    assert.throws(
      () =>
        TaskLifecycle.restoreSignedSnapshot(
          envelope,
          badSecret as unknown as string,
        ),
      /signed snapshot secret must not be empty|signed snapshot secret must be a non-empty string or Buffer/,
      `restore with secret ${String(badSecret)} must throw`,
    );
  }
});

test("MAC-valid envelope with a malformed snapshot still fails validation", () => {
  const badSnapshot = {
    v: 1,
    id: "task-signed-1",
    state: "OPEN",
    history: [
      {
        seq: 1,
        event: "PUBLISH",
        from: "DRAFT",
        to: "OPEN",
        at: "2026-11-09T00:00:00.000Z",
        prevHash: "GENESIS",
        hash: "0".repeat(64),
      },
    ],
    slaDeadlines: {},
  };
  const mac = createHmac("sha256", SECRET)
    .update(canonicalJson(badSnapshot), "utf8")
    .digest("hex");
  assert.throws(
    () =>
      TaskLifecycle.restoreSignedSnapshot(
        { v: 1, snapshot: badSnapshot, mac },
        SECRET,
      ),
    /invalid history: history hash chain is broken/,
  );
});

// The two forms do not accept each other: a signed restore cannot
// silently downgrade to the trusted-configuration path, and the
// unsigned path never mistakes an envelope for a snapshot.
test("signed and unsigned forms are mutually exclusive", () => {
  const task = seededTask();
  const envelope = task.exportSignedSnapshot(SECRET);
  assert.throws(
    () => TaskLifecycle.fromJSON(envelope),
    /invalid snapshot: unknown field "snapshot"/,
  );
  const unsigned = task.toJSON();
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(unsigned, SECRET),
    /invalid signed snapshot envelope: unknown field "id"/,
  );
  // Unsigned path regression: the old form still works untouched.
  const restoredUnsigned = TaskLifecycle.fromJSON(unsigned);
  assert.equal(restoredUnsigned.state, "CAPTURING");
  assert.deepEqual(restoredUnsigned.toJSON().slaDeadlines, {
    IN_REVIEW: "2026-12-01T00:00:00.000Z",
  });
});

// A Buffer secret and the same bytes as a string produce the same
// MAC, and either form restores the other's envelope.
test("string and Buffer secrets cross-restore with the same MAC", () => {
  const task = seededTask();
  const fromString = task.exportSignedSnapshot(SECRET);
  const fromBuffer = task.exportSignedSnapshot(Buffer.from(SECRET, "utf8"));
  assert.equal(fromString.mac, fromBuffer.mac);
  assert.deepEqual(
    TaskLifecycle.restoreSignedSnapshot(fromBuffer, SECRET).toJSON(),
    task.toJSON(),
  );
  assert.deepEqual(
    TaskLifecycle.restoreSignedSnapshot(
      fromString,
      Buffer.from(SECRET, "utf8"),
    ).toJSON(),
    task.toJSON(),
  );
  // The caller mutating their Buffer after export cannot change the
  // envelope: the MAC was computed synchronously at export time.
  const buf = Buffer.from(SECRET, "utf8");
  const envelope = task.exportSignedSnapshot(buf);
  buf.fill(0);
  assert.equal(
    TaskLifecycle.restoreSignedSnapshot(envelope, SECRET).state,
    "CAPTURING",
  );
});

// The envelope secret and the audit-chain secret are independent:
// a keyed chain still needs its own key on signed restore.
test("keyed history chain still needs its auditSecret on signed restore", () => {
  const keyed = new TaskLifecycle("task-signed-keyed", {
    auditSecret: AUDIT_SECRET,
  });
  keyed.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-11-09T00:00:00.000Z",
  });
  const envelope = keyed.exportSignedSnapshot(SECRET);
  assert.throws(
    () => TaskLifecycle.restoreSignedSnapshot(envelope, SECRET),
    /invalid history: history hash chain is broken/,
  );
  assert.throws(
    () =>
      TaskLifecycle.restoreSignedSnapshot(envelope, SECRET, {
        auditSecret: "wrong-audit-secret",
      }),
    /invalid history: history hash chain is broken/,
  );
  const restored = TaskLifecycle.restoreSignedSnapshot(envelope, SECRET, {
    auditSecret: AUDIT_SECRET,
  });
  assert.equal(restored.state, "OPEN");
  assert.equal(
    verifyHistoryChain(restored.history, { auditSecret: AUDIT_SECRET }),
    true,
  );
  // And the reverse direction is fail-closed too: an unkeyed chain
  // restored with a secret is rejected as broken.
  const plainEnvelope = seededTask().exportSignedSnapshot(SECRET);
  assert.throws(
    () =>
      TaskLifecycle.restoreSignedSnapshot(plainEnvelope, SECRET, {
        auditSecret: AUDIT_SECRET,
      }),
    /invalid history: history hash chain is broken/,
  );
});
