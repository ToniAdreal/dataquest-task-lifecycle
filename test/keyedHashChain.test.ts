import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
  parseHistory,
  verifyHistoryChain,
} from "../src/index.js";
import type { TaskHistoryEntry } from "../src/index.js";

const SECRET = "audit-secret-1";
const WRONG = "audit-secret-2";

/** A task whose audit chain is keyed, with pinned timestamps. */
function keyedTask(secret: string | Buffer = SECRET): TaskLifecycle {
  const task = new TaskLifecycle("keyed-1", { auditSecret: secret });
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-10-09T00:00:00.000Z",
  });
  task.dispatch("ACCEPT", {
    actor: "contributor-7",
    at: "2026-10-09T00:01:00.000Z",
  });
  task.dispatch("START_CAPTURE", {
    actor: "contributor-7",
    at: "2026-10-09T00:02:00.000Z",
  });
  task.dispatch("SUBMIT", {
    actor: "contributor-7",
    at: "2026-10-09T00:03:00.000Z",
  });
  return task;
}

/** The same dispatches on a default (unkeyed) task. */
function plainTask(): TaskLifecycle {
  const task = new TaskLifecycle("plain-1");
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-10-09T00:00:00.000Z",
  });
  task.dispatch("ACCEPT", {
    actor: "contributor-7",
    at: "2026-10-09T00:01:00.000Z",
  });
  task.dispatch("START_CAPTURE", {
    actor: "contributor-7",
    at: "2026-10-09T00:02:00.000Z",
  });
  task.dispatch("SUBMIT", {
    actor: "contributor-7",
    at: "2026-10-09T00:03:00.000Z",
  });
  return task;
}

function wireClone(entries: readonly TaskHistoryEntry[]): TaskHistoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as TaskHistoryEntry[];
}

function stripChain(entries: readonly TaskHistoryEntry[]): TaskHistoryEntry[] {
  return wireClone(entries).map(
    ({ prevHash, hash, ...rest }) => rest as TaskHistoryEntry,
  );
}

/**
 * The documented canonical serialization (fixed key order, `undefined`
 * omitted, `hash` excluded) — replicated here so the forgery test can
 * recompute a chain exactly the way an attacker with the source could.
 */
function canonical(entry: TaskHistoryEntry): string {
  const obj: Record<string, unknown> = {
    seq: entry.seq,
    event: entry.event,
    from: entry.from,
    to: entry.to,
    at: entry.at,
  };
  if (entry.actor !== undefined) obj.actor = entry.actor;
  if (entry.note !== undefined) obj.note = entry.note;
  if (entry.payoutRef !== undefined) obj.payoutRef = entry.payoutRef;
  if (entry.payoutAmount !== undefined) obj.payoutAmount = entry.payoutAmount;
  if (entry.quotedAmount !== undefined) obj.quotedAmount = entry.quotedAmount;
  if (entry.prevHash !== undefined) obj.prevHash = entry.prevHash;
  return JSON.stringify(obj);
}

/** Recompute a whole chain in HMAC mode under an arbitrary key. */
function rechainWith(
  entries: TaskHistoryEntry[],
  key: string,
): TaskHistoryEntry[] {
  let prevHash = "GENESIS";
  return entries.map((entry) => {
    const chained: TaskHistoryEntry = { ...entry, prevHash };
    chained.hash = createHmac("sha256", key)
      .update(canonical(chained) + prevHash, "utf8")
      .digest("hex");
    prevHash = chained.hash;
    return chained;
  });
}

describe("keyed hash chain: verification modes", () => {
  it("a keyed chain verifies with the correct secret", () => {
    const task = keyedTask();
    assert.equal(
      verifyHistoryChain(task.history, { auditSecret: SECRET }),
      true,
    );
    for (const e of task.history) {
      assert.match(e.hash!, /^[0-9a-f]{64}$/, "hash is HMAC-SHA256 hex");
    }
    assert.equal(task.history[0].prevHash, "GENESIS");
  });

  it("a keyed chain does not verify with the wrong secret", () => {
    assert.equal(
      verifyHistoryChain(keyedTask().history, { auditSecret: WRONG }),
      false,
    );
  });

  it("a keyed chain does not verify without a secret (fail-closed)", () => {
    assert.equal(verifyHistoryChain(keyedTask().history), false);
  });

  it("an unkeyed chain does not verify when a secret is supplied (fail-closed both ways), and is unchanged without one", () => {
    const task = plainTask();
    assert.equal(verifyHistoryChain(task.history), true);
    assert.equal(
      verifyHistoryChain(task.history, { auditSecret: SECRET }),
      false,
    );
  });

  it("keyed and unkeyed hashes differ for identical dispatches", () => {
    const keyed = keyedTask().history;
    const plain = plainTask().history;
    assert.equal(keyed.length, plain.length);
    for (let i = 0; i < keyed.length; i++) {
      const { hash: kh, prevHash: kp, ...kRest } = keyed[i];
      const { hash: ph, prevHash: pp, ...pRest } = plain[i];
      assert.deepEqual(kRest, pRest, "entry content is identical");
      assert.notEqual(kh, ph, "only the chain mode differs");
      if (i > 0) assert.equal(kp, keyed[i - 1].hash);
    }
  });

  it("string and Buffer secrets produce identical chains", () => {
    const fromString = keyedTask(SECRET).history;
    const fromBuffer = keyedTask(Buffer.from(SECRET, "utf8")).history;
    assert.deepEqual(wireClone(fromBuffer), wireClone(fromString));
  });

  it("mutating the caller's Buffer after construction does not change the chain", () => {
    const buf = Buffer.from(SECRET, "utf8");
    const task = new TaskLifecycle("keyed-buf", { auditSecret: buf });
    buf.fill(0x78); // caller overwrites its own copy with 'x' bytes
    task.dispatch("PUBLISH", { at: "2026-10-09T00:00:00.000Z" });
    assert.equal(
      verifyHistoryChain(task.history, { auditSecret: SECRET }),
      true,
    );
  });
});

describe("keyed hash chain: secret validation", () => {
  it("an empty or non-string/Buffer secret is a construction error", () => {
    assert.throws(
      () => new TaskLifecycle("x", { auditSecret: "" }),
      /auditSecret must not be empty/,
    );
    assert.throws(
      () => new TaskLifecycle("x", { auditSecret: Buffer.alloc(0) }),
      /auditSecret must not be empty/,
    );
    assert.throws(
      () =>
        new TaskLifecycle("x", {
          auditSecret: 42 as unknown as string,
        }),
      /auditSecret must be a non-empty string or Buffer/,
    );
  });

  it("an invalid secret passed to the chain functions is a configuration error, not a false", () => {
    const history = keyedTask().history;
    assert.throws(
      () => verifyHistoryChain(history, { auditSecret: "" }),
      /auditSecret must not be empty/,
    );
    assert.throws(
      () => parseHistory(wireClone(history), { auditSecret: "" }),
      /invalid history: auditSecret must not be empty/,
    );
  });
});

describe("keyed hash chain: tamper and forgery detection", () => {
  it("tampering with a keyed entry breaks verification and parsing", () => {
    const tampered = wireClone(keyedTask().history);
    tampered[1].actor = "mallory";
    assert.equal(
      verifyHistoryChain(tampered, { auditSecret: SECRET }),
      false,
    );
    assert.throws(
      () => parseHistory(tampered, { auditSecret: SECRET }),
      /history hash chain is broken/,
    );
  });

  it("parsing a keyed history without the secret rejects it as broken", () => {
    assert.throws(
      () => parseHistory(wireClone(keyedTask().history)),
      /history hash chain is broken/,
    );
  });

  it("a full-log rewrite recomputed with the wrong key is detected", () => {
    // The attacker rewrites an actor AND recomputes the whole chain —
    // self-consistent under the attacker's key, worthless under the real
    // one. This is exactly the forgery the unkeyed chain cannot catch.
    const forged = rechainWith(
      stripChain(keyedTask().history).map((e, i) =>
        i === 1 ? { ...e, actor: "mallory" } : e,
      ),
      WRONG,
    );
    assert.equal(verifyHistoryChain(forged, { auditSecret: WRONG }), true);
    assert.equal(verifyHistoryChain(forged, { auditSecret: SECRET }), false);
    assert.throws(
      () => parseHistory(forged, { auditSecret: SECRET }),
      /history hash chain is broken/,
    );
  });

  it("a keyed history with one entry's chain fields deleted is rejected as mixed", () => {
    const mixed = wireClone(keyedTask().history);
    delete mixed[2].hash;
    delete mixed[2].prevHash;
    assert.equal(verifyHistoryChain(mixed, { auditSecret: SECRET }), false);
    assert.throws(
      () => parseHistory(mixed, { auditSecret: SECRET }),
      /must not be mixed with hashless entries/,
    );
  });
});

describe("keyed hash chain: persistence", () => {
  it("toJSON() never contains the secret", () => {
    const task = keyedTask();
    const snapshot = task.toJSON();
    assert.equal(
      JSON.stringify(snapshot).includes(SECRET),
      false,
      "snapshot JSON must not leak the secret",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(snapshot, "auditSecret"),
      false,
    );
  });

  it("fromJSON restores a keyed snapshot with the secret, and dispatch continues the keyed chain", () => {
    const snapshot = JSON.parse(JSON.stringify(keyedTask().toJSON()));
    const restored = TaskLifecycle.fromJSON(snapshot, {
      auditSecret: SECRET,
    });
    assert.equal(restored.state, "SUBMITTED");
    assert.equal(
      verifyHistoryChain(restored.history, { auditSecret: SECRET }),
      true,
    );
    restored.dispatch("BEGIN_REVIEW", {
      actor: "reviewer",
      at: "2026-10-09T00:04:00.000Z",
    });
    assert.equal(restored.history[4].prevHash, restored.history[3].hash);
    assert.equal(
      verifyHistoryChain(restored.history, { auditSecret: SECRET }),
      true,
    );
    assert.equal(verifyHistoryChain(restored.history), false);
  });

  it("fromJSON rejects a keyed snapshot restored without the secret", () => {
    const snapshot = JSON.parse(JSON.stringify(keyedTask().toJSON()));
    assert.throws(
      () => TaskLifecycle.fromJSON(snapshot),
      /history hash chain is broken/,
    );
  });

  it("fromJSON rejects a keyed snapshot restored with the wrong secret", () => {
    const snapshot = JSON.parse(JSON.stringify(keyedTask().toJSON()));
    assert.throws(
      () => TaskLifecycle.fromJSON(snapshot, { auditSecret: WRONG }),
      /history hash chain is broken/,
    );
  });

  it("fromJSON rejects an unkeyed snapshot restored with a secret (fail-closed both ways)", () => {
    const snapshot = JSON.parse(JSON.stringify(plainTask().toJSON()));
    assert.throws(
      () => TaskLifecycle.fromJSON(snapshot, { auditSecret: SECRET }),
      /history hash chain is broken/,
    );
  });

  it("a legacy hashless snapshot restored with a secret is chained in keyed mode", () => {
    const snapshot = JSON.parse(JSON.stringify(plainTask().toJSON()));
    for (const e of snapshot.history as TaskHistoryEntry[]) {
      delete e.prevHash;
      delete e.hash;
    }
    const restored = TaskLifecycle.fromJSON(snapshot, {
      auditSecret: SECRET,
    });
    assert.equal(
      verifyHistoryChain(restored.history, { auditSecret: SECRET }),
      true,
    );
    assert.equal(verifyHistoryChain(restored.history), false);
    restored.dispatch("BEGIN_REVIEW", {
      actor: "reviewer",
      at: "2026-10-09T00:04:00.000Z",
    });
    assert.equal(
      verifyHistoryChain(restored.history, { auditSecret: SECRET }),
      true,
    );
  });

  it("fromHistory restores a keyed log with the secret and rejects it without", () => {
    const log = wireClone(keyedTask().history);
    const restored = TaskLifecycle.fromHistory("keyed-1", log, {
      auditSecret: SECRET,
    });
    assert.equal(restored.state, "SUBMITTED");
    restored.dispatch("BEGIN_REVIEW", {
      actor: "reviewer",
      at: "2026-10-09T00:04:00.000Z",
    });
    assert.equal(
      verifyHistoryChain(restored.history, { auditSecret: SECRET }),
      true,
    );
    assert.throws(
      () => TaskLifecycle.fromHistory("keyed-1", wireClone(log)),
      /history hash chain is broken/,
    );
  });

  it("NDJSON round-trip preserves the keyed chain, and the secret never enters the text", () => {
    const task = keyedTask();
    const text = historyToNdjson(task, { auditSecret: SECRET });
    assert.equal(text.includes(SECRET), false);
    const restored = historyFromNdjson(text, { auditSecret: SECRET });
    assert.deepEqual(restored, [...task.history]);
    assert.equal(verifyHistoryChain(restored, { auditSecret: SECRET }), true);
    // Fail-closed: the same text/tooling without the secret is rejected.
    assert.throws(() => historyFromNdjson(text), /hash chain is broken/);
    assert.throws(() => historyToNdjson(task), /hash chain is broken/);
  });
});
