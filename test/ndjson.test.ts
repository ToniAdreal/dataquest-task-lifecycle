import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
  replay,
} from "../src/index.js";

function liveTask(): TaskLifecycle {
  const task = new TaskLifecycle("ndjson-1");
  task.dispatch("PUBLISH", { actor: "researcher", note: "data spec v2" });
  task.dispatch("ACCEPT", { actor: "contributor-7" });
  task.dispatch("START_CAPTURE", { actor: "contributor-7" });
  return task;
}

describe("historyToNdjson", () => {
  it("exports one canonical JSON line per entry, trailing newline", () => {
    const task = liveTask();
    const text = historyToNdjson(task);
    const lines = text.split("\n");
    assert.equal(lines.length, task.history.length + 1); // + trailing empty
    assert.equal(lines[lines.length - 1], "");
    for (const line of lines.slice(0, -1)) {
      const entry = JSON.parse(line);
      // canonical key order on every line: fixed fields first, then
      // optional fields in parseHistory insertion order
      assert.deepEqual(Object.keys(entry).slice(0, 5), [
        "seq",
        "event",
        "from",
        "to",
        "at",
      ]);
      for (const key of Object.keys(entry)) {
        assert.ok(
          [
            "seq",
            "event",
            "from",
            "to",
            "at",
            "actor",
            "note",
            "payoutRef",
            "prevHash",
            "hash",
          ].includes(key),
          `unexpected key ${key}`,
        );
      }
    }
    const first = JSON.parse(lines[0]);
    // hash-chain fields ride along on every exported line (the chain is
    // part of the entry, so a tampered NDJSON line fails re-import)
    assert.deepEqual(Object.keys(first), [
      "seq",
      "event",
      "from",
      "to",
      "at",
      "actor",
      "note",
      "prevHash",
      "hash",
    ]);
    assert.equal(first.prevHash, "GENESIS");
    assert.equal(first.seq, 1);
    assert.equal(first.event, "PUBLISH");
    assert.equal(first.from, "DRAFT");
    assert.equal(first.to, "OPEN");
    assert.equal(first.actor, "researcher");
    assert.equal(first.note, "data spec v2");
  });

  it("accepts a raw entries array and emits identical bytes to the live export", () => {
    const task = liveTask();
    assert.equal(
      historyToNdjson([...task.history]),
      historyToNdjson(task),
    );
  });

  it("canonicalizes scrambled key order on the way out", () => {
    const task = liveTask();
    const scrambled = task.history.map((e) => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(e).reverse()) out[key] = (e as any)[key];
      return out;
    });
    assert.equal(historyToNdjson(scrambled as any), historyToNdjson(task));
  });

  it("exports an empty history to the empty string", () => {
    assert.equal(historyToNdjson(new TaskLifecycle("empty")), "");
    assert.equal(historyToNdjson([]), "");
  });

  it("refuses to export a broken history instead of writing unreadable NDJSON", () => {
    const bad = [
      {
        seq: 1,
        event: "PUBLISH",
        from: "OPEN",
        to: "OPEN",
        at: "2026-10-06T00:00:00.000Z",
      },
    ];
    assert.throws(
      () => historyToNdjson(bad as any),
      /invalid history: entry\[0\]: chain must start at DRAFT/,
    );
  });
});

describe("historyFromNdjson", () => {
  it("round-trips: task -> ndjson -> history -> same state and entries", () => {
    const task = liveTask();
    const text = historyToNdjson(task);
    const entries = historyFromNdjson(text);
    assert.deepEqual(entries, [...task.history]);
    assert.equal(replay(entries), task.state);
    const rebuilt = TaskLifecycle.fromHistory("ndjson-2", entries);
    assert.deepEqual([...rebuilt.history], [...task.history]);
  });

  it("tolerates blank lines and a trailing newline anywhere", () => {
    const task = liveTask();
    const text = "\n\n" + historyToNdjson(task).replace("\n", "\n\n") + "\n";
    const entries = historyFromNdjson(text);
    assert.deepEqual(entries, [...task.history]);
  });

  it("handles CRLF line endings", () => {
    const task = liveTask();
    const crlf = historyToNdjson(task).replaceAll("\n", "\r\n");
    assert.deepEqual(historyFromNdjson(crlf), [...task.history]);
  });

  it("reports the exact line number for a non-JSON line", () => {
    const good = JSON.stringify({
      seq: 1,
      event: "PUBLISH",
      from: "DRAFT",
      to: "OPEN",
      at: "2026-10-06T00:00:00.000Z",
    });
    // physical lines: 1 blank, 2 good, 3 blank, 4 CLAIM-shaped, 5 bad.
    // (the CLAIM line never gets validated — the JSON parse error on
    // line 5 fires first)
    const text = `\n${good}\n\n${good.replace("PUBLISH", "CLAIM")}\nnot json at all\n`;
    assert.throws(() => historyFromNdjson(text), /invalid ndjson: line 5/);
  });

  it("attributes a broken entry to its NDJSON line number", () => {
    const line1 = JSON.stringify({
      seq: 1,
      event: "PUBLISH",
      from: "DRAFT",
      to: "OPEN",
      at: "2026-10-06T00:00:00.000Z",
    });
    // line 2 claims a from-state that breaks the chain (should be OPEN)
    const line2 = JSON.stringify({
      seq: 2,
      event: "ACCEPT",
      from: "DRAFT",
      to: "ACCEPTED",
      at: "2026-10-06T00:01:00.000Z",
    });
    assert.throws(
      () => historyFromNdjson(`${line1}\n${line2}\n`),
      /invalid ndjson: line 2: .*does not continue previous to/,
    );
  });

  it("keeps entry-level errors meaningful when blank lines shift numbering", () => {
    const line1 = JSON.stringify({
      seq: 1,
      event: "PUBLISH",
      from: "DRAFT",
      to: "OPEN",
      at: "2026-10-06T00:00:00.000Z",
    });
    const broken = JSON.stringify({
      seq: 2,
      event: "ACCEPT",
      from: "DRAFT",
      to: "ACCEPTED",
      at: "2026-10-06T00:01:00.000Z",
    });
    // entry[1] sits on physical line 3 because of the blank line
    assert.throws(
      () => historyFromNdjson(`\n${line1}\n${broken}\n`),
      /invalid ndjson: line 3: .*does not continue previous to/,
    );
  });

  it("round-trips an empty history", () => {
    assert.deepEqual(historyFromNdjson(""), []);
    assert.deepEqual(historyFromNdjson("\n\n"), []);
  });

  it("rejects a non-string input with a clear error", () => {
    assert.throws(
      () => historyFromNdjson(null as any),
      /invalid ndjson: input must be a string/,
    );
  });

  it("returns fresh copies that stay detached from the source text", () => {
    const task = liveTask();
    const entries = historyFromNdjson(historyToNdjson(task));
    (entries[0] as any).event = "MUTATED";
    assert.equal(task.history[0].event, "PUBLISH");
    assert.equal(historyFromNdjson(historyToNdjson(task))[0].event, "PUBLISH");
  });
});
