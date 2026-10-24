import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { TaskLifecycle, verifyHistoryChain } from "../src/index.js";
import type { TaskHistoryEntry } from "../src/index.js";

const SECRET = "audit-secret-timing-safe";
const WRONG = "audit-secret-wrong";

function keyedTask(): TaskLifecycle {
  const task = new TaskLifecycle("chain-ts-1", { auditSecret: SECRET });
  task.dispatch("PUBLISH", { actor: "researcher", at: "2026-10-20T00:00:00.000Z" });
  task.dispatch("ACCEPT", { actor: "contributor-7", at: "2026-10-20T00:01:00.000Z" });
  task.dispatch("START_CAPTURE", { actor: "contributor-7", at: "2026-10-20T00:02:00.000Z" });
  return task;
}

function plainTask(): TaskLifecycle {
  const task = new TaskLifecycle("chain-ts-2");
  task.dispatch("PUBLISH", { actor: "researcher", at: "2026-10-20T00:00:00.000Z" });
  task.dispatch("ACCEPT", { actor: "contributor-7", at: "2026-10-20T00:01:00.000Z" });
  task.dispatch("START_CAPTURE", { actor: "contributor-7", at: "2026-10-20T00:02:00.000Z" });
  return task;
}

function wireClone(entries: readonly TaskHistoryEntry[]): TaskHistoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as TaskHistoryEntry[];
}

describe("history chain: constant-time MAC comparison", () => {
  it("a keyed chain verifies with the correct secret", () => {
    assert.equal(verifyHistoryChain(keyedTask().history, { auditSecret: SECRET }), true);
  });

  it("tampering with a keyed entry is detected", () => {
    const tampered = wireClone(keyedTask().history);
    tampered[1].actor = "mallory";
    assert.equal(verifyHistoryChain(tampered, { auditSecret: SECRET }), false);
  });

  it("a forged hash of the wrong length is a false, not a throw", () => {
    // parseHistory only requires hash to be a non-empty string; the
    // length guard in the constant-time comparison must turn a short
    // (or otherwise undecodable) digest into a mismatch rather than
    // letting timingSafeEqual throw.
    const forged = wireClone(keyedTask().history);
    forged[2].hash = "deadbeef"; // 4 bytes decoded, not 32
    assert.equal(verifyHistoryChain(forged, { auditSecret: SECRET }), false);

    const nonHex = wireClone(keyedTask().history);
    nonHex[0].hash = "z".repeat(64); // valid length, undecodable as hex
    assert.equal(verifyHistoryChain(nonHex, { auditSecret: SECRET }), false);

    const swapped = wireClone(keyedTask().history);
    const tmp = swapped[0].hash;
    swapped[0].hash = swapped[1].hash;
    swapped[1].hash = tmp; // both 64-hex, both well-formed, still wrong links
    assert.equal(verifyHistoryChain(swapped, { auditSecret: SECRET }), false);
  });

  it("adversarial chain shapes never throw out of verification", () => {
    const base = wireClone(keyedTask().history);
    const shapes: TaskHistoryEntry[][] = [
      // hash deleted on one entry (carried[] mix → fail closed, no throw)
      base.map((e, i) =>
        i === 1 ? { ...e, hash: undefined } : e,
      ),
      // empty-string hash (parseHistory would reject; verify must not throw)
      base.map((e) => ({ ...e, hash: "" })),
      // absurdly long forged hash
      base.map((e) => ({ ...e, hash: "ab".repeat(10_000) })),
    ];
    for (const shape of shapes) {
      assert.equal(verifyHistoryChain(shape, { auditSecret: SECRET }), false);
    }
  });

  it("wrong secret and missing secret both fail closed (regression)", () => {
    const history = keyedTask().history;
    assert.equal(verifyHistoryChain(history, { auditSecret: WRONG }), false);
    assert.equal(verifyHistoryChain(history), false);
    assert.equal(
      verifyHistoryChain(plainTask().history, { auditSecret: SECRET }),
      false,
    );
  });

  it("unkeyed chain behavior is unchanged (regression)", () => {
    const task = plainTask();
    assert.equal(verifyHistoryChain(task.history), true);
    const tampered = wireClone(task.history);
    tampered[1].actor = "mallory";
    assert.equal(verifyHistoryChain(tampered), false);
    // legacy hashless histories still pass through
    const hashless = wireClone(task.history).map(
      ({ prevHash, hash, ...rest }) => rest as TaskHistoryEntry,
    );
    assert.equal(verifyHistoryChain(hashless), true);
  });
});
