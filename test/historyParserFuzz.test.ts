import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
  parseHistory,
  replay,
  type TaskHistoryEntry,
  type TaskSnapshot,
} from "../src/index.js";

/**
 * History / NDJSON / snapshot parser fuzz (backlog #178): `parseHistory()`,
 * `historyFromNdjson()` and `TaskLifecycle.fromJSON()` all eat untrusted
 * input on the persistence-restore path, but until now they were only
 * covered by hand-written corrupt samples. Following the rfc9421
 * parserFuzz paradigm, this file subjects them to deterministic seeded
 * structural mutations (fixed seed 20261010, mulberry32 — same generator
 * as the sibling fuzz corpora):
 *
 *   - parseHistory:  600 mutations of a chained golden history
 *                    + 600 mutations of a hashless (legacy) golden history
 *   - NDJSON text:   400 mutations of the golden NDJSON export
 *   - fromJSON:      300 mutations of the golden snapshot envelope
 *
 * The contract under fuzz is deliberately either/or, exactly as the
 * backlog item states: a mutated input is either accepted AND round-trips
 * consistently (re-parsing the sanitized output is a fixed point, the
 * seq/from-to chain is intact), or it is rejected with a plain `Error`
 * whose message starts with the parser's documented `invalid …` prefix.
 * A TypeError / ReferenceError / SyntaxError escaping, or a silently
 * accepted chain break, fails the run. A 50ms per-call budget (the
 * rfc9421 paradigm's bound) guards against pathological slowdowns.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20261010;
const MAX_MS = 50;
const PARSE_HISTORY_CASES = 600; // per golden variant (chained + hashless)
const NDJSON_CASES = 400;
const SNAPSHOT_CASES = 300;

/** Deterministic golden task: full DRAFT→PAID chain, injected timestamps. */
function goldenTask(): TaskLifecycle {
  const t = new TaskLifecycle("fuzz-golden");
  const at = (h: number) =>
    `2026-03-01T${String(10 + h).padStart(2, "0")}:00:00.000Z`;
  t.dispatch("PUBLISH", { actor: "researcher", note: "spec v2", at: at(0) });
  t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 1200, at: at(1) });
  t.dispatch("START_CAPTURE", { actor: "contributor", at: at(2) });
  t.dispatch("SUBMIT", { actor: "contributor", note: "100 images", at: at(3) });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: at(4) });
  t.dispatch("APPROVE", { actor: "reviewer", at: at(5) });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", at: at(6) });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-fuzz-1",
    payoutAmount: 1200,
    at: at(7),
  });
  return t;
}

const GOLDEN = goldenTask();
const GOLDEN_CHAINED: TaskHistoryEntry[] = structuredClone([...GOLDEN.history]);
const GOLDEN_HASHLESS: TaskHistoryEntry[] = GOLDEN_CHAINED.map((e) => {
  const copy: Record<string, unknown> = { ...e };
  delete copy.prevHash;
  delete copy.hash;
  return copy as unknown as TaskHistoryEntry;
});
const GOLDEN_NDJSON = historyToNdjson(GOLDEN);
const GOLDEN_SNAPSHOT = GOLDEN.toJSON();

type Rand = () => number;

function makePicker(rand: Rand) {
  const int = (n: number): number => Math.floor(rand() * n);
  const pick = <T>(arr: readonly T[]): T => arr[int(arr.length)];
  return { int, pick };
}

const WRONG_VALUES: readonly unknown[] = [
  null,
  42,
  "x",
  true,
  {},
  [],
  Number.NaN,
];

/** One structural mutation of an entries array (input is not modified). */
function mutateEntries(input: readonly unknown[], rand: Rand): unknown[] {
  const { int, pick } = makePicker(rand);
  const entries = structuredClone(input) as unknown[];
  if (entries.length === 0) return entries;
  const idx = int(entries.length);
  const entry = entries[idx] as Record<string, unknown>;
  const op = int(9);
  switch (op) {
    case 0: {
      // delete a random present field
      const keys = Object.keys(entry);
      delete entry[pick(keys)];
      break;
    }
    case 1: {
      // retype a random present field
      const keys = Object.keys(entry);
      entry[pick(keys)] = pick(WRONG_VALUES);
      break;
    }
    case 2: {
      // corrupt a field with a same-shaped but invalid value
      const field = pick([
        "seq",
        "event",
        "from",
        "to",
        "at",
        "actor",
        "note",
        "payoutRef",
        "payoutAmount",
        "quotedAmount",
        "prevHash",
        "hash",
      ] as const);
      switch (field) {
        case "seq":
          entry.seq = pick([0, 999, 1.5, -3]);
          break;
        case "event":
          entry.event = pick(["NOPE", "publish", "PAID", ""]);
          break;
        case "from":
        case "to":
          entry[field] = pick(["NOPE", "DRAFT", "PAID", ""]);
          break;
        case "at":
          entry.at = pick([
            "not-a-date",
            "2020-01-01T00:00:00.000Z",
            "2026-03-01",
            "2026-03-01T10:00:00Z",
          ]);
          break;
        case "actor":
        case "payoutRef":
          entry[field] = pick(["", 0]);
          break;
        case "note":
          entry.note = pick(["x".repeat(100_000), 7]);
          break;
        case "payoutAmount":
        case "quotedAmount":
          entry[field] = pick([-1, Number.NaN, Number.POSITIVE_INFINITY]);
          break;
        case "prevHash":
        case "hash": {
          const cur = entry[field];
          entry[field] =
            typeof cur === "string" && cur.length > 0
              ? (cur[0] === "0" ? "1" : "0") + cur.slice(1)
              : pick(["", "deadbeef"]);
          break;
        }
      }
      break;
    }
    case 3: {
      // reorder: swap two entries (chain/seq break unless identical spots)
      const j = int(entries.length);
      [entries[idx], entries[j]] = [entries[j], entries[idx]];
      break;
    }
    case 4: {
      // duplicate an entry in place (seq gap / chain break)
      entries.splice(idx, 0, structuredClone(entry));
      break;
    }
    case 5: {
      // truncate (possibly to empty — an empty history is legitimately valid)
      entries.length = int(entries.length);
      break;
    }
    case 6: {
      // inject an unknown field (fail-closed parsers must reject or, for
      // a field the sanitizer owns, never silently keep it)
      entry[pick(["bogus", "deadlline", "hashh", "extra"])] = pick([
        1,
        "x",
        null,
      ]);
      break;
    }
    case 7: {
      // replace an entry with a non-object
      entries[idx] = pick([null, 42, "x", [], true]);
      break;
    }
    case 8: {
      // hash-chain tampering: strip the chain from one entry (mixed
      // chain) or graft chain fields onto one hashless entry
      if ("hash" in entry || "prevHash" in entry) {
        delete entry.prevHash;
        delete entry.hash;
      } else {
        entry.prevHash = "GENESIS";
        entry.hash = "deadbeef";
      }
      break;
    }
  }
  return entries;
}

/** One mutation of NDJSON text. */
function mutateNdjson(text: string, rand: Rand): string {
  const { int, pick } = makePicker(rand);
  const lines = text.split("\n").filter((l) => l !== "");
  const op = int(8);
  switch (op) {
    case 0:
      lines.splice(int(lines.length), 1);
      break;
    case 1: {
      const i = int(lines.length);
      lines.splice(i, 0, lines[i]);
      break;
    }
    case 2: {
      const i = int(lines.length);
      const j = int(lines.length);
      [lines[i], lines[j]] = [lines[j], lines[i]];
      break;
    }
    case 3: {
      const joined = lines.join("\n") + "\n";
      return joined.slice(0, int(joined.length));
    }
    case 4: {
      const i = int(lines.length);
      const line = lines[i];
      if (line.length > 0) {
        const pos = int(line.length);
        const ch = pick('{}[]",:0123456789abz\\'.split(""));
        lines[i] = line.slice(0, pos) + ch + line.slice(pos + 1);
      }
      break;
    }
    case 5: {
      const i = int(lines.length);
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      const mutated = mutateEntries([parsed], rand)[0] as Record<
        string,
        unknown
      >;
      lines[i] = JSON.stringify(mutated);
      break;
    }
    case 6: {
      const i = int(lines.length);
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      parsed[pick(["bogus", "extra", "hashh"])] = 1;
      lines[i] = JSON.stringify(parsed);
      break;
    }
    case 7:
      lines[int(lines.length)] = pick(["not json {", "{", "[1,2", "null", "42"]);
      break;
  }
  return lines.join("\n") + "\n";
}

/** One mutation of a snapshot envelope. */
function mutateSnapshot(input: TaskSnapshot, rand: Rand): unknown {
  const { int, pick } = makePicker(rand);
  const snap = structuredClone(input) as unknown as Record<string, unknown>;
  const op = int(6);
  switch (op) {
    case 0: {
      const keys = Object.keys(snap);
      delete snap[pick(keys)];
      break;
    }
    case 1: {
      const keys = Object.keys(snap);
      snap[pick(keys)] = pick(WRONG_VALUES);
      break;
    }
    case 2:
      snap[pick(["bogus", "historyy", "statee"])] = pick([1, "x"]);
      break;
    case 3:
      snap.history = mutateEntries(
        snap.history as unknown[],
        rand,
      );
      break;
    case 4: {
      const field = pick(["v", "id", "state"] as const);
      if (field === "v") snap.v = pick([2, "1", null, 0]);
      else if (field === "id") snap.id = pick(["", 42, null]);
      else snap.state = pick(["NOPE", "DRAFT", "OPEN", "", 42]);
      break;
    }
    case 5:
      snap.slaDeadlines = pick([
        { NOPE: "2026-03-01T10:00:00.000Z" },
        { OPEN: "not-a-date" },
        42,
        "x",
      ]);
      break;
  }
  return snap;
}

function assertPlainInvalid(err: unknown, prefixes: readonly string[]): void {
  assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
  assert.equal(
    (err as Error).constructor,
    Error,
    `expected a plain Error, got ${(err as Error).constructor?.name}: ${(err as Error).message}`,
  );
  assert.ok(
    prefixes.some((p) => (err as Error).message.startsWith(p)),
    `error message ${JSON.stringify((err as Error).message)} must start with one of ${prefixes.join(", ")}`,
  );
}

/** Accepted histories must be sanitized fixed points with an intact chain. */
function assertHistoryFixedPoint(entries: TaskHistoryEntry[]): void {
  assert.deepEqual(parseHistory(entries), entries);
  assert.deepEqual(
    parseHistory(JSON.parse(JSON.stringify(entries))),
    entries,
  );
  entries.forEach((e, i) => {
    assert.equal(e.seq, i + 1);
    if (i === 0) assert.equal(e.from, "DRAFT");
    else assert.equal(e.from, entries[i - 1].to);
  });
  assert.equal(replay(entries), entries.length ? entries[entries.length - 1].to : "DRAFT");
}

function buildCorpora() {
  const randH = mulberry32(SEED);
  const chained = Array.from({ length: PARSE_HISTORY_CASES }, () =>
    mutateEntries(GOLDEN_CHAINED, randH),
  );
  const randL = mulberry32(SEED);
  const hashless = Array.from({ length: PARSE_HISTORY_CASES }, () =>
    mutateEntries(GOLDEN_HASHLESS, randL),
  );
  const randN = mulberry32(SEED);
  const ndjson = Array.from({ length: NDJSON_CASES }, () =>
    mutateNdjson(GOLDEN_NDJSON, randN),
  );
  const randS = mulberry32(SEED);
  const snapshots = Array.from({ length: SNAPSHOT_CASES }, () =>
    mutateSnapshot(GOLDEN_SNAPSHOT, randS),
  );
  return { chained, hashless, ndjson, snapshots };
}

test("fuzz: golden controls parse cleanly through every restore path", () => {
  assertHistoryFixedPoint(parseHistory(structuredClone(GOLDEN_CHAINED)));
  assertHistoryFixedPoint(parseHistory(structuredClone(GOLDEN_HASHLESS)));
  assert.deepEqual(historyFromNdjson(GOLDEN_NDJSON), parseHistory(GOLDEN_CHAINED));
  assert.equal(replay(GOLDEN_CHAINED), "PAID");
  const restored = TaskLifecycle.fromJSON(structuredClone(GOLDEN_SNAPSHOT));
  assert.equal(restored.state, "PAID");
  assert.deepEqual(restored.toJSON(), GOLDEN_SNAPSHOT);
});

test("fuzz: corpora are deterministic for the fixed seed and sized as documented", () => {
  const a = buildCorpora();
  const b = buildCorpora();
  const total =
    a.chained.length + a.hashless.length + a.ndjson.length + a.snapshots.length;
  assert.equal(total, PARSE_HISTORY_CASES * 2 + NDJSON_CASES + SNAPSHOT_CASES);
  assert.ok(total >= 1000, `only ${total} cases`);
  // JSON fingerprints (NaN/Infinity collapse identically on both runs).
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("fuzz: parseHistory never throws a non-Error and never accepts a broken chain (chained golden)", () => {
  const { chained } = buildCorpora();
  let accepted = 0;
  let rejected = 0;
  let worst = 0;
  for (const mutated of chained) {
    const t0 = performance.now();
    try {
      const out = parseHistory(mutated);
      accepted++;
      assertHistoryFixedPoint(out);
    } catch (err) {
      rejected++;
      assertPlainInvalid(err, ["invalid history:"]);
    }
    const dt = performance.now() - t0;
    if (dt > worst) worst = dt;
    assert.ok(dt < MAX_MS, `parseHistory took ${dt.toFixed(1)}ms`);
  }
  assert.ok(accepted > 0 && rejected > 0, `accepted=${accepted} rejected=${rejected}`);
  console.log(
    `fuzz parseHistory(chained): ${chained.length} cases, ${accepted} accepted, ${rejected} rejected, worst ${worst.toFixed(1)}ms`,
  );
});

test("fuzz: parseHistory never throws a non-Error and never accepts a broken chain (hashless golden)", () => {
  const { hashless } = buildCorpora();
  let accepted = 0;
  let rejected = 0;
  for (const mutated of hashless) {
    try {
      const out = parseHistory(mutated);
      accepted++;
      assertHistoryFixedPoint(out);
    } catch (err) {
      rejected++;
      assertPlainInvalid(err, ["invalid history:"]);
    }
  }
  assert.ok(accepted > 0 && rejected > 0, `accepted=${accepted} rejected=${rejected}`);
  console.log(
    `fuzz parseHistory(hashless): ${hashless.length} cases, ${accepted} accepted, ${rejected} rejected`,
  );
});

test("fuzz: parseHistory rejects non-container inputs with a plain invalid-history Error", () => {
  for (const bad of [null, undefined, 42, "x", true, {}, Number.NaN]) {
    assert.throws(
      () => parseHistory(bad),
      (err: unknown) => {
        assertPlainInvalid(err, ["invalid history:"]);
        return true;
      },
    );
  }
});

test("fuzz: historyFromNdjson never throws a non-Error and never accepts a broken chain", () => {
  const { ndjson } = buildCorpora();
  let accepted = 0;
  let rejected = 0;
  let worst = 0;
  for (const mutated of ndjson) {
    const t0 = performance.now();
    try {
      const out = historyFromNdjson(mutated);
      accepted++;
      assertHistoryFixedPoint(out);
      // Re-export and re-import is a fixed point too.
      assert.deepEqual(historyFromNdjson(historyToNdjson(out)), out);
    } catch (err) {
      rejected++;
      assertPlainInvalid(err, ["invalid ndjson:", "invalid history:"]);
    }
    const dt = performance.now() - t0;
    if (dt > worst) worst = dt;
    assert.ok(dt < MAX_MS, `historyFromNdjson took ${dt.toFixed(1)}ms`);
  }
  assert.ok(accepted > 0 && rejected > 0, `accepted=${accepted} rejected=${rejected}`);
  console.log(
    `fuzz historyFromNdjson: ${ndjson.length} cases, ${accepted} accepted, ${rejected} rejected, worst ${worst.toFixed(1)}ms`,
  );
});

test("fuzz: historyFromNdjson benign text variants still parse", () => {
  const expected = parseHistory(GOLDEN_CHAINED);
  assert.deepEqual(historyFromNdjson(""), []);
  assert.deepEqual(historyFromNdjson("\n\n  \n"), []);
  assert.deepEqual(historyFromNdjson(GOLDEN_NDJSON.replace(/\n$/, "")), expected);
  assert.deepEqual(historyFromNdjson(GOLDEN_NDJSON.replace(/\n/g, "\r\n")), expected);
  const withBlanks = GOLDEN_NDJSON.split("\n").join("\n\n");
  assert.deepEqual(historyFromNdjson(withBlanks), expected);
  assert.throws(
    () => historyFromNdjson(42 as unknown as string),
    (err: unknown) => {
      assertPlainInvalid(err, ["invalid ndjson:"]);
      return true;
    },
  );
});

test("fuzz: TaskLifecycle.fromJSON never throws a non-Error and accepted snapshots round-trip", () => {
  const { snapshots } = buildCorpora();
  let accepted = 0;
  let rejected = 0;
  let worst = 0;
  for (const mutated of snapshots) {
    const t0 = performance.now();
    try {
      const restored = TaskLifecycle.fromJSON(mutated);
      accepted++;
      // Idempotent round-trip: re-restoring the restored snapshot is a
      // fixed point (snapshot equality, not object identity).
      const again = TaskLifecycle.fromJSON(restored.toJSON());
      assert.deepEqual(again.toJSON(), restored.toJSON());
      assertHistoryFixedPoint([...restored.history]);
    } catch (err) {
      rejected++;
      assertPlainInvalid(err, ["invalid snapshot:", "invalid history:"]);
    }
    const dt = performance.now() - t0;
    if (dt > worst) worst = dt;
    assert.ok(dt < MAX_MS, `fromJSON took ${dt.toFixed(1)}ms`);
  }
  assert.ok(accepted > 0 && rejected > 0, `accepted=${accepted} rejected=${rejected}`);
  console.log(
    `fuzz fromJSON: ${snapshots.length} cases, ${accepted} accepted, ${rejected} rejected, worst ${worst.toFixed(1)}ms`,
  );
});
