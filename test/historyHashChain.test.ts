import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  GENESIS_PREV_HASH,
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
  parseHistory,
  replay,
  verifyHistoryChain,
} from "../src/index.js";
import type { TaskHistoryEntry } from "../src/index.js";

function chainedTask(): TaskLifecycle {
  const task = new TaskLifecycle("chain-1");
  task.dispatch("PUBLISH", { actor: "researcher", note: "data spec v2" });
  task.dispatch("ACCEPT", { actor: "contributor-7" });
  task.dispatch("START_CAPTURE", { actor: "contributor-7" });
  task.dispatch("SUBMIT", {
    actor: "contributor-7",
    payoutRef: undefined,
    note: "batch-42",
  });
  return task;
}

function wireClone(entries: readonly TaskHistoryEntry[]): TaskHistoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as TaskHistoryEntry[];
}

describe("hash chain: genesis and entry linkage", () => {
  it("exposes the GENESIS prev-hash constant", () => {
    assert.equal(GENESIS_PREV_HASH, "GENESIS");
  });

  it("dispatch appends chained entries: genesis links to GENESIS, each entry links to its predecessor", () => {
    const task = chainedTask();
    const history = task.history;
    assert.equal(history[0].prevHash, "GENESIS");
    for (let i = 1; i < history.length; i++) {
      assert.equal(history[i].prevHash, history[i - 1].hash);
    }
    for (const e of history) {
      assert.match(e.hash!, /^[0-9a-f]{64}$/, "hash is sha256 hex");
    }
  });

  it("verifyHistoryChain passes on a dispatch-built history", () => {
    assert.equal(verifyHistoryChain(chainedTask().history), true);
  });

  it("verifyHistoryChain returns true for an empty history", () => {
    assert.equal(verifyHistoryChain([]), true);
  });

  it("verifyHistoryChain passes on a fully hashless legacy history", () => {
    const legacy = wireClone(chainedTask().history).map(
      ({ prevHash, hash, ...rest }) => rest as TaskHistoryEntry,
    );
    assert.equal(verifyHistoryChain(legacy), true);
  });

  it("verifyHistoryChain fails closed on a mixed chained/hashless history", () => {
    const mixed = wireClone(chainedTask().history);
    delete mixed[1].hash;
    delete mixed[1].prevHash;
    assert.equal(verifyHistoryChain(mixed), false);
  });
});

describe("hash chain: tamper detection", () => {
  it("rewriting an actor breaks the chain", () => {
    const tampered = wireClone(chainedTask().history);
    tampered[1].actor = "attacker";
    assert.equal(verifyHistoryChain(tampered), false);
  });

  it("rewriting a payoutRef breaks the chain", () => {
    const task = new TaskLifecycle("chain-payout");
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE");
    task.dispatch("SUBMIT");
    task.dispatch("BEGIN_REVIEW");
    task.dispatch("APPROVE");
    task.dispatch("REQUEST_PAYOUT", { payoutRef: "batch-7" });
    task.dispatch("PAYOUT_COMPLETE", { payoutRef: "transfer-99" });
    const tampered = wireClone(task.history);
    tampered[tampered.length - 1].payoutRef = "transfer-evil";
    assert.equal(verifyHistoryChain(tampered), false);
  });

  it("rewriting a note breaks the chain", () => {
    const tampered = wireClone(chainedTask().history);
    tampered[0].note = "forged spec";
    assert.equal(verifyHistoryChain(tampered), false);
  });

  it("deleting a middle entry breaks the chain (prevHash no longer links)", () => {
    const original = wireClone(chainedTask().history);
    const shortened = [original[0], ...original.slice(2)].map((e, i) => ({
      ...e,
      seq: i + 1,
    }));
    assert.equal(verifyHistoryChain(shortened), false);
  });

  it("reordering entries breaks the chain", () => {
    const original = wireClone(chainedTask().history);
    const reordered = [original[1], original[0], ...original.slice(2)].map(
      (e, i) => ({ ...e, seq: i + 1 }),
    );
    assert.equal(verifyHistoryChain(reordered), false);
  });

  it("a forged hash is detected (hash does not recompute)", () => {
    const forged = wireClone(chainedTask().history);
    forged[2].hash = "0".repeat(64);
    assert.equal(verifyHistoryChain(forged), false);
  });

  it("a forged prevHash is detected (linkage mismatch)", () => {
    const forged = wireClone(chainedTask().history);
    forged[2].prevHash = "f".repeat(64);
    assert.equal(verifyHistoryChain(forged), false);
  });
});

describe("hash chain: parseHistory enforcement", () => {
  it("accepts a fully hashless legacy history (no chain to check)", () => {
    const legacy = wireClone(chainedTask().history).map(
      ({ prevHash, hash, ...rest }) => rest as TaskHistoryEntry,
    );
    const parsed = parseHistory(legacy);
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].hash, undefined);
  });

  it("rejects a history mixing chained and hashless entries", () => {
    const mixed = wireClone(chainedTask().history);
    delete mixed[2].hash;
    delete mixed[2].prevHash;
    assert.throws(
      () => parseHistory(mixed),
      /invalid history: hash-chain entries must not be mixed with hashless entries/,
    );
  });

  it("rejects an entry carrying hash without prevHash", () => {
    const bad = wireClone(chainedTask().history);
    delete bad[1].prevHash;
    assert.throws(
      () => parseHistory(bad),
      /invalid history: entry\[1\]: prevHash must be a non-empty string/,
    );
  });

  it("rejects an entry carrying prevHash without hash", () => {
    const bad = wireClone(chainedTask().history);
    delete bad[1].hash;
    assert.throws(
      () => parseHistory(bad),
      /invalid history: entry\[1\]: hash must be a non-empty string/,
    );
  });

  it("rejects a tampered chained history", () => {
    const tampered = wireClone(chainedTask().history);
    tampered[2].actor = "mallory";
    assert.throws(
      () => parseHistory(tampered),
      /invalid history: history hash chain is broken/,
    );
  });

  it("replay() throws on a chain-broken history via parseHistory", () => {
    const tampered = wireClone(chainedTask().history);
    tampered[1].note = "forged";
    assert.throws(
      () => replay(tampered),
      /invalid history: history hash chain is broken/,
    );
  });

  it("replay() still accepts a legacy hashless log", () => {
    const legacy = wireClone(chainedTask().history).map(
      ({ prevHash, hash, ...rest }) => rest as TaskHistoryEntry,
    );
    assert.equal(replay(legacy), "SUBMITTED");
  });
});

describe("hash chain: persistence round-trips", () => {
  it("NDJSON round-trip keeps the chain intact", () => {
    const task = chainedTask();
    const text = historyToNdjson(task);
    assert.match(text, /"prevHash":"GENESIS"/);
    const restored = historyFromNdjson(text);
    assert.equal(verifyHistoryChain(restored), true);
    assert.deepEqual(restored, [...task.history]);
  });

  it("NDJSON import rejects a tampered line", () => {
    const task = chainedTask();
    const tampered = historyToNdjson(task).replace(
      '"actor":"contributor-7"',
      '"actor":"mallory"',
    );
    assert.throws(
      () => historyFromNdjson(tampered),
      /hash chain is broken/,
    );
  });

  it("fromJSON accepts an old hashless snapshot and chains it deterministically", () => {
    const task = chainedTask();
    const snapshot = JSON.parse(JSON.stringify(task.toJSON()));
    for (const e of snapshot.history as TaskHistoryEntry[]) {
      delete e.prevHash;
      delete e.hash;
    }
    const restored = TaskLifecycle.fromJSON(snapshot);
    assert.equal(verifyHistoryChain(restored.history), true);
    assert.equal(restored.history[0].prevHash, "GENESIS");
  });

  it("fromJSON rejects a tampered chained snapshot", () => {
    const task = chainedTask();
    const snapshot = JSON.parse(JSON.stringify(task.toJSON()));
    snapshot.history[1].actor = "mallory";
    assert.throws(
      () => TaskLifecycle.fromJSON(snapshot),
      /invalid history: history hash chain is broken/,
    );
  });

  it("fromJSON rejects a mixed chained/hashless snapshot", () => {
    const task = chainedTask();
    const snapshot = JSON.parse(JSON.stringify(task.toJSON()));
    delete snapshot.history[1].hash;
    delete snapshot.history[1].prevHash;
    assert.throws(() => TaskLifecycle.fromJSON(snapshot), /must not be mixed/);
  });

  it("fromHistory throws on a chain-broken log", () => {
    const tampered = wireClone(chainedTask().history);
    tampered[0].note = "forged";
    assert.throws(
      () => TaskLifecycle.fromHistory("chain-x", tampered),
      /invalid history: history hash chain is broken/,
    );
  });

  it("dispatch after rehydration keeps the chain continuous", () => {
    const task = chainedTask();
    const restored = TaskLifecycle.fromJSON(
      JSON.parse(JSON.stringify(task.toJSON())),
    );
    restored.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
    assert.equal(verifyHistoryChain(restored.history), true);
    assert.equal(
      restored.history[4].prevHash,
      restored.history[3].hash,
    );
    // A second snapshot round-trip still verifies.
    const again = TaskLifecycle.fromJSON(
      JSON.parse(JSON.stringify(restored.toJSON())),
    );
    assert.equal(verifyHistoryChain(again.history), true);
  });

  it("dispatch after rehydrating a legacy snapshot starts a fresh valid chain", () => {
    const task = chainedTask();
    const snapshot = JSON.parse(JSON.stringify(task.toJSON()));
    for (const e of snapshot.history as TaskHistoryEntry[]) {
      delete e.prevHash;
      delete e.hash;
    }
    const restored = TaskLifecycle.fromJSON(snapshot);
    restored.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
    assert.equal(verifyHistoryChain(restored.history), true);
    assert.equal(restored.history.length, 5);
  });
});
