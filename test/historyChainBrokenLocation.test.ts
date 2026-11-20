import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
  parseHistory,
  verifyHistoryChain,
} from "../src/index.js";
import type { TaskHistoryEntry } from "../src/index.js";

// Backlog #1285: parseHistory used to reject a broken hash chain with
// one generic sentence ("history hash chain is broken …") that named
// no entry, so a 200-entry audit log gave the caller nowhere to look —
// and historyFromNdjson could not retag it with a line number, unlike
// every structural error. The chain error now names the first entry
// whose link or hash fails, in the same `entry[N]` form the structural
// errors already use, with its seq appended:
//   invalid history: entry[2]: history hash chain is broken (…) at entry seq 3
// The `entry[N]` form is what lets retagLine map it to the NDJSON
// physical line number with zero changes on the NDJSON side.

const SECRET = "audit-secret-for-location-tests";

function chainedTask(): TaskLifecycle {
  const task = new TaskLifecycle("chain-loc-1");
  task.dispatch("PUBLISH", { actor: "researcher", note: "data spec v2" });
  task.dispatch("ACCEPT", { actor: "contributor-7" });
  task.dispatch("START_CAPTURE", { actor: "contributor-7" });
  task.dispatch("SUBMIT", {
    actor: "contributor-7",
    note: "batch-42",
  });
  return task;
}

function keyedTask(): TaskLifecycle {
  const task = new TaskLifecycle("chain-loc-keyed", {
    auditSecret: SECRET,
  });
  task.dispatch("PUBLISH", { actor: "researcher", note: "data spec v2" });
  task.dispatch("ACCEPT", { actor: "contributor-7" });
  task.dispatch("START_CAPTURE", { actor: "contributor-7" });
  task.dispatch("SUBMIT", {
    actor: "contributor-7",
    note: "batch-42",
  });
  return task;
}

function wireClone(entries: readonly TaskHistoryEntry[]): TaskHistoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as TaskHistoryEntry[];
}

const BROKEN =
  /invalid history: entry\[(\d+)\]: history hash chain is broken \(an entry was tampered with, deleted, or reordered\) at entry seq (\d+)/;

function assertNamesSeq(
  fn: () => unknown,
  entryIndex: number,
  seq: number,
): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, "expected an Error");
    const match = BROKEN.exec(err.message);
    assert.ok(match, `message must carry the located form, got: ${err.message}`);
    assert.equal(Number(match[1]), entryIndex, "entry[N] index");
    assert.equal(Number(match[2]), seq, "entry seq");
    assert.equal(seq, entryIndex + 1, "seq is the 1-based entry index");
    return true;
  });
}

describe("parseHistory names the first broken chain entry", () => {
  it("a tampered middle entry names its seq", () => {
    const tampered = wireClone(chainedTask().history);
    tampered[2].actor = "mallory";
    assert.equal(verifyHistoryChain(tampered), false);
    assertNamesSeq(() => parseHistory(tampered), 2, 3);
  });

  it("a tampered first entry names seq 1", () => {
    const tampered = wireClone(chainedTask().history);
    tampered[0].note = "forged spec";
    assertNamesSeq(() => parseHistory(tampered), 0, 1);
  });

  it("a forged stored hash names the entry carrying it", () => {
    const forged = wireClone(chainedTask().history);
    forged[3].hash = "0".repeat(64);
    assertNamesSeq(() => parseHistory(forged), 3, 4);
  });

  it("a forged prevHash names the entry carrying it", () => {
    const forged = wireClone(chainedTask().history);
    forged[1].prevHash = "f".repeat(64);
    assertNamesSeq(() => parseHistory(forged), 1, 2);
  });

  it("a deleted middle entry names the break-point seq", () => {
    const original = wireClone(chainedTask().history);
    // Drop the seq-2 entry and re-sequence: the seq-3 entry now sits
    // at index 1, so the from/to continuity check — which runs before
    // the chain check — rejects it and names entry[1] (seq 2), the
    // first entry after the gap. The chain detector agrees.
    const shortened = [original[0], ...original.slice(2)].map((e, i) => ({
      ...e,
      seq: i + 1,
    }));
    assert.equal(verifyHistoryChain(shortened), false);
    assert.throws(
      () => parseHistory(shortened),
      /invalid history: entry\[1\]: from ACCEPTED does not continue previous to OPEN/,
    );
  });

  it("a deletion patched to look structurally valid is caught by the chain at the patched entry", () => {
    const original = wireClone(chainedTask().history);
    // The attacker deletes the seq-2 ACCEPT and rewrites the next
    // entry into a legal ACCEPT edge (OPEN -> ACCEPTED) so the
    // structural checks pass — the hash chain is what catches the
    // rewrite, at the patched entry (seq 2): its prevHash still
    // points at the deleted entry's hash.
    const patched = [original[0], ...original.slice(2)].map((e, i) => ({
      ...e,
      seq: i + 1,
    }));
    patched[1] = {
      ...patched[1],
      event: "ACCEPT",
      from: "OPEN",
      to: "ACCEPTED",
    };
    // The tail must be patched too, or the from/to continuity check
    // fires first: the last entry becomes the START_CAPTURE the new
    // ACCEPTED state legally leads to.
    patched[2] = {
      ...patched[2],
      event: "START_CAPTURE",
      from: "ACCEPTED",
      to: "CAPTURING",
    };
    assert.equal(verifyHistoryChain(patched), false);
    assertNamesSeq(() => parseHistory(patched), 1, 2);
  });

  it("reordered entries name the first entry out of place", () => {
    const original = wireClone(chainedTask().history);
    // Swapping the first two entries breaks the "must start at
    // DRAFT" structural check, which runs before the chain check and
    // names entry[0] (seq 1). The chain detector agrees.
    const reordered = [original[1], original[0], ...original.slice(2)].map(
      (e, i) => ({ ...e, seq: i + 1 }),
    );
    assert.equal(verifyHistoryChain(reordered), false);
    assert.throws(
      () => parseHistory(reordered),
      /invalid history: entry\[0\]: chain must start at DRAFT, got OPEN/,
    );
  });

  it("a keyed history tampered with names its seq under the secret", () => {
    const tampered = wireClone(keyedTask().history);
    tampered[1].actor = "mallory";
    assert.equal(
      verifyHistoryChain(tampered, { auditSecret: SECRET }),
      false,
    );
    assertNamesSeq(
      () => parseHistory(tampered, { auditSecret: SECRET }),
      1,
      2,
    );
  });

  it("a keyed history parsed without the secret breaks at seq 1", () => {
    // Every stored link is an HMAC; recomputing unkeyed fails on the
    // very first entry, so the locator must say seq 1, not just "broken".
    assertNamesSeq(() => parseHistory(wireClone(keyedTask().history)), 0, 1);
  });
});

describe("parseHistory names the first entry in a mixed log", () => {
  it("a hashless middle entry names its seq", () => {
    const mixed = wireClone(chainedTask().history);
    delete mixed[2].hash;
    delete mixed[2].prevHash;
    assert.equal(verifyHistoryChain(mixed), false);
    assert.throws(
      () => parseHistory(mixed),
      /invalid history: entry\[2\]: hash-chain entries must not be mixed with hashless entries at entry seq 3/,
    );
  });

  it("a hashless-first log names the first chained entry", () => {
    const mixed = wireClone(chainedTask().history);
    delete mixed[0].hash;
    delete mixed[0].prevHash;
    assert.throws(
      () => parseHistory(mixed),
      /invalid history: entry\[1\]: hash-chain entries must not be mixed with hashless entries at entry seq 2/,
    );
  });
});

describe("NDJSON import retags the located chain error with its line", () => {
  it("a tampered line reports its physical line number and seq", () => {
    const task = chainedTask();
    const tampered = historyToNdjson(task).replace(
      '"actor":"contributor-7"',
      '"actor":"mallory"',
    );
    // The tampered actor first appears on the seq-2 ACCEPT line, so
    // the chain breaks at entry seq 2 on NDJSON line 2.
    assert.throws(
      () => historyFromNdjson(tampered),
      /invalid ndjson: line 2: history hash chain is broken \(an entry was tampered with, deleted, or reordered\) at entry seq 2/,
    );
  });

  it("blank lines shift the line number but not the seq", () => {
    const task = chainedTask();
    const lines = historyToNdjson(task).split("\n");
    // Tamper the seq-3 START_CAPTURE line (index 2), then pad the
    // text with blank lines so the physical line is 5, not 3.
    const tamperedLine = lines[2].replace(
      '"actor":"contributor-7"',
      '"actor":"mallory"',
    );
    const text = `\n${lines[0]}\n\n${lines[1]}\n${tamperedLine}\n${lines[3]}\n`;
    assert.throws(
      () => historyFromNdjson(text),
      /invalid ndjson: line 5: history hash chain is broken \(an entry was tampered with, deleted, or reordered\) at entry seq 3/,
    );
  });

  it("a mixed log imported from NDJSON reports its line and seq", () => {
    const task = chainedTask();
    const lines = historyToNdjson(task).split("\n");
    const stripped = JSON.parse(lines[2]) as Record<string, unknown>;
    delete stripped.hash;
    delete stripped.prevHash;
    lines[2] = JSON.stringify(stripped);
    assert.throws(
      () => historyFromNdjson(lines.join("\n")),
      /invalid ndjson: line 3: hash-chain entries must not be mixed with hashless entries at entry seq 3/,
    );
  });
});

describe("legal chains and legacy logs are unchanged", () => {
  it("an intact chained history still parses and verifies", () => {
    const history = wireClone(chainedTask().history);
    assert.equal(verifyHistoryChain(history), true);
    assert.deepEqual(parseHistory(history), history);
  });

  it("a fully hashless legacy history still passes through", () => {
    const legacy = wireClone(chainedTask().history).map(
      ({ prevHash, hash, ...rest }) => rest as TaskHistoryEntry,
    );
    assert.equal(verifyHistoryChain(legacy), true);
    const parsed = parseHistory(legacy);
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].hash, undefined);
  });

  it("an empty history still parses and verifies", () => {
    assert.equal(verifyHistoryChain([]), true);
    assert.deepEqual(parseHistory([]), []);
  });
});
