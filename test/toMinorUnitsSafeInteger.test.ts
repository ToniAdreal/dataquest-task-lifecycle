import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  parseMinorUnits,
  payoutMismatch,
  reconcilePayouts,
  renderTaskSettlementsCsv,
  renderTaskSettlementsJson,
  summarizeTaskSettlements,
  toMinorUnits,
  totalPaidOut,
  totalQuoted,
  type LedgerPayout,
  type TaskHistoryEntry,
} from "../src/index.js";

/**
 * `toMinorUnits` rejects non-safe-integer amounts (backlog #1423).
 *
 * The gap: the converter only checked finiteness, so
 * `toMinorUnits(90071992547409.93)` silently returned `9007199254740994`
 * cents — past `Number.MAX_SAFE_INTEGER`, a value no integer-cent sum
 * can represent exactly. The live `dispatch()` round-trip gate could
 * not catch it either (`9007199254740994 / 100 === 90071992547409.93`
 * in double arithmetic), so a live task could hold it; and two
 * individually safe entries could add up to a wrong-but-finite batch
 * total, which `summarizeTaskSettlements` then handed to renderers
 * whose own shape check rejects non-safe integers. Meanwhile the
 * sibling converter `parseMinorUnits` already threw past the same
 * ceiling, so the two converters disagreed at one boundary.
 *
 * The fix is one funnel plus explicit per-addition guards:
 * `toMinorUnits` throws `minor units conversion overflowed: … exceeds
 * Number.MAX_SAFE_INTEGER in minor units` for a non-safe result, and
 * `totalPaidOut`, `totalQuoted`, `summarizeTaskSettlements` (including
 * `gap` and `unquotedPaidTotal`) and the `reconcilePayouts` shared-ref
 * sum check `Number.isSafeInteger` after every addition, so an
 * accumulation-only overflow throws their own overflow error instead
 * of returning a rounded total. Legacy acceptance is deliberately
 * NOT tightened: an old snapshot carrying the amount still restores;
 * only converting or summing it fails, loudly.
 */

/** Drive a task from DRAFT to the payout request step. */
function toPayoutRequested(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  return t;
}

function paidTask(
  id: string,
  amount: number,
  opts: { quoted?: number; ref?: string } = {},
): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", {
    actor: "contributor",
    ...(opts.quoted !== undefined ? { quotedAmount: opts.quoted } : {}),
  });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutAmount: amount,
    payoutRef: opts.ref ?? `ref-${id}`,
  });
  return t;
}

/**
 * Rehydrate a PAID task whose `PAYOUT_COMPLETE` entry carries a legacy
 * amount `dispatch()` would reject, via the hashless-snapshot path.
 * The restore itself must succeed — the gate lives in the converters
 * and the readers, not in the snapshot reader.
 */
function legacyPaidViaSnapshot(
  id: string,
  amount: number,
  quote = 100,
): TaskLifecycle {
  const live = paidTask(id, 100, { quoted: quote });
  const snapshot = live.toJSON();
  for (const entry of snapshot.history) {
    delete (entry as Partial<TaskHistoryEntry>).prevHash;
    delete (entry as Partial<TaskHistoryEntry>).hash;
  }
  snapshot.history[snapshot.history.length - 1].payoutAmount = amount;
  const revived = TaskLifecycle.fromJSON(snapshot);
  assert.equal(revived.state, "PAID");
  return revived;
}

/** Same legacy shape, restored through `fromHistory` instead. */
function legacyPaidViaHistory(
  id: string,
  amount: number,
  quote = 100,
): TaskLifecycle {
  const live = paidTask(id, 100, { quoted: quote });
  const history: TaskHistoryEntry[] = live.history.map((entry) => {
    const { prevHash: _prevHash, hash: _hash, ...rest } = entry;
    return rest;
  });
  history[history.length - 1].payoutAmount = amount;
  const revived = TaskLifecycle.fromHistory(id, history);
  assert.equal(revived.state, "PAID");
  return revived;
}

/** Legacy task whose `ACCEPT` quote is the non-safe amount. */
function legacyQuotedViaSnapshot(id: string, quote: number): TaskLifecycle {
  const live = paidTask(id, 100, { quoted: 100 });
  const snapshot = live.toJSON();
  for (const entry of snapshot.history) {
    delete (entry as Partial<TaskHistoryEntry>).prevHash;
    delete (entry as Partial<TaskHistoryEntry>).hash;
  }
  snapshot.history.find((e) => e.event === "ACCEPT")!.quotedAmount = quote;
  const revived = TaskLifecycle.fromJSON(snapshot);
  assert.equal(revived.state, "PAID");
  return revived;
}

/** The amount the research round measured: 9007199254740994 cents. */
const NON_SAFE = 90071992547409.93;
/** The largest safe-side neighbour: 9007199254740990 cents. */
const SAFE_TOP = 90071992547409.91;

const CONVERSION_OVERFLOW =
  /minor units conversion overflowed: .* exceeds Number\.MAX_SAFE_INTEGER in minor units/;

test("toMinorUnits rejects a single amount past the safe-integer ceiling", () => {
  // Before the fix this converted silently to 9007199254740994
  // cents — past MAX_SAFE_INTEGER, a value no integer-cent sum can
  // represent exactly.
  assert.throws(() => toMinorUnits(NON_SAFE), CONVERSION_OVERFLOW);
  assert.throws(
    () => toMinorUnits(NON_SAFE),
    /minor units conversion overflowed: 90071992547409\.94 exceeds Number\.MAX_SAFE_INTEGER in minor units/,
  );
  // The adjacent boundary: 90071992547409.92 is 9007199254740992
  // cents, one past the ceiling, so it throws too.
  assert.throws(() => toMinorUnits(90071992547409.92), CONVERSION_OVERFLOW);
  // The negative mirror is rejected the same way.
  assert.throws(() => toMinorUnits(-NON_SAFE), CONVERSION_OVERFLOW);
  assert.throws(
    () => toMinorUnits(-NON_SAFE),
    /minor units conversion overflowed: -90071992547409\.94 exceeds Number\.MAX_SAFE_INTEGER in minor units/,
  );
});

test("the safe side of the boundary still converts exactly", () => {
  // The double nearest 90071992547409.91 prints as 90071992547409.9,
  // which is exactly 9007199254740990 cents, one below
  // MAX_SAFE_INTEGER, so the conversion is exact, not rounded off.
  assert.equal(toMinorUnits(SAFE_TOP), 9007199254740990);
  assert.ok(Number.isSafeInteger(toMinorUnits(SAFE_TOP)));
  assert.equal(toMinorUnits(90071992547409.9), 9007199254740990);
  // Ordinary large amounts inside the safe range are untouched.
  assert.equal(toMinorUnits(1e13), 1e15);
  assert.equal(toMinorUnits(-1e13), -1e15);
});

test("dispatch rejects a non-safe payoutAmount and leaves no trace", () => {
  const t = toPayoutRequested("live-nonsafe-payout");
  const historyLength = t.history.length;
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutAmount: NON_SAFE,
        payoutRef: "ref-x",
      }),
    CONVERSION_OVERFLOW,
  );
  assert.equal(t.state, "PAYOUT_PENDING");
  assert.equal(t.history.length, historyLength);
  // The failed dispatch consumed nothing: the same idempotency key
  // still works for the corrected retry.
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        payoutAmount: NON_SAFE,
        payoutRef: "ref-x",
        idempotencyKey: "retry-key",
      }),
    CONVERSION_OVERFLOW,
  );
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutAmount: 100,
    payoutRef: "ref-x",
    idempotencyKey: "retry-key",
  });
  assert.equal(t.state, "PAID");
  assert.equal(t.history.length, historyLength + 1);
});

test("dispatch rejects a non-safe quotedAmount and leaves no trace", () => {
  const t = new TaskLifecycle("live-nonsafe-quote");
  t.dispatch("PUBLISH", { actor: "researcher" });
  const historyLength = t.history.length;
  assert.throws(
    () =>
      t.dispatch("ACCEPT", {
        actor: "contributor",
        quotedAmount: NON_SAFE,
      }),
    CONVERSION_OVERFLOW,
  );
  assert.equal(t.state, "OPEN");
  assert.equal(t.history.length, historyLength);
});

test("legacy snapshots carrying the amount still restore, but every reader fails loudly", () => {
  const viaSnapshot = legacyPaidViaSnapshot("legacy-nonsafe", NON_SAFE);
  const viaHistory = legacyPaidViaHistory("legacy-nonsafe-hist", NON_SAFE);
  assert.equal(viaSnapshot.state, "PAID");
  assert.equal(viaHistory.state, "PAID");
  assert.throws(
    () => totalPaidOut([viaSnapshot]),
    /total paid out computation overflowed: inputs too large/,
  );
  assert.throws(
    () => totalPaidOut([viaHistory]),
    /total paid out computation overflowed: inputs too large/,
  );
  assert.throws(
    () => summarizeTaskSettlements([viaSnapshot]),
    /task settlements summary computation overflowed: inputs too large/,
  );
  assert.throws(
    () => payoutMismatch(viaSnapshot),
    /minor units conversion overflowed/,
  );
  const quoted = legacyQuotedViaSnapshot("legacy-nonsafe-quote", NON_SAFE);
  assert.throws(
    () => totalQuoted([quoted]),
    /total quoted computation overflowed: inputs too large/,
  );
  assert.throws(
    () => summarizeTaskSettlements([quoted]),
    /task settlements summary computation overflowed: inputs too large/,
  );
});

test("accumulation-only overflow throws: two individually safe entries whose sum passes the ceiling", () => {
  // Each entry converts to 9007199254740990 cents (safe); only their
  // sum (18014398509481980) passes MAX_SAFE_INTEGER. This pins the
  // per-addition safe-integer check, not just the single-entry
  // conversion.
  const a = paidTask("accum-a", SAFE_TOP, { quoted: SAFE_TOP });
  const b = paidTask("accum-b", SAFE_TOP, { quoted: SAFE_TOP });
  assert.equal(totalPaidOut([a]), SAFE_TOP);
  assert.equal(totalQuoted([a]), SAFE_TOP);
  assert.throws(
    () => totalPaidOut([a, b]),
    /total paid out computation overflowed: inputs too large/,
  );
  assert.throws(
    () => totalPaidOut([b, a]),
    /total paid out computation overflowed: inputs too large/,
  );
  assert.throws(
    () => totalQuoted([a, b]),
    /total quoted computation overflowed: inputs too large/,
  );
  assert.throws(
    () => summarizeTaskSettlements([a, b]),
    /task settlements summary computation overflowed: inputs too large/,
  );
});

test("unquoted accumulation-only overflow throws through unquotedPaidTotal", () => {
  // Both tasks settle with no recorded quote, so the overflowing sum
  // lands in `unquotedPaidTotal` rather than `paidTotal` — the guard
  // must cover that field too.
  const a = paidTask("unquoted-a", SAFE_TOP);
  const b = paidTask("unquoted-b", SAFE_TOP);
  assert.throws(
    () => summarizeTaskSettlements([a, b]),
    /task settlements summary computation overflowed: inputs too large/,
  );
});

test("a summary that lands exactly on MAX_SAFE_INTEGER still renders", () => {
  // 9007199254740990 + 1 cent = MAX_SAFE_INTEGER exactly: the
  // boundary is inclusive, so the summary must come out and pass
  // its own renderers' shape check.
  const a = paidTask("ceiling-a", SAFE_TOP, { quoted: SAFE_TOP });
  const penny = paidTask("ceiling-penny", 0.01, { quoted: 0.01 });
  const summary = summarizeTaskSettlements([a, penny]);
  assert.equal(summary.paidTotal, Number.MAX_SAFE_INTEGER);
  assert.equal(summary.quotedTotal, Number.MAX_SAFE_INTEGER);
  assert.equal(summary.gap, 0);
  const csv = renderTaskSettlementsCsv(summary);
  assert.match(csv, /9007199254740991/);
  const json = renderTaskSettlementsJson(summary);
  assert.match(json, /9007199254740991/);
});

test("summarizeTaskSettlements output always renders as CSV and JSON", () => {
  const tasks = [
    paidTask("render-a", 10098.5, { quoted: 10000 }),
    paidTask("render-b", 531.5, { quoted: 531.5 }),
    paidTask("render-c", 250, {}),
  ];
  const summary = summarizeTaskSettlements(tasks);
  assert.ok(Number.isSafeInteger(summary.paidTotal));
  assert.ok(Number.isSafeInteger(summary.quotedTotal));
  assert.ok(Number.isSafeInteger(summary.gap));
  assert.ok(Number.isSafeInteger(summary.unquotedPaidTotal));
  const csv = renderTaskSettlementsCsv(summary);
  assert.match(csv, /paidTotal/);
  const json = renderTaskSettlementsJson(summary);
  assert.match(json, /"paidTotal"/);
});

test("reconcilePayouts shared-ref sum past the ceiling throws", () => {
  const a = paidTask("shared-a", SAFE_TOP, { quoted: 100, ref: "shared-1" });
  const b = paidTask("shared-b", SAFE_TOP, { quoted: 100, ref: "shared-1" });
  const ledger: LedgerPayout[] = [{ payoutRef: "shared-1", payoutAmount: 100 }];
  assert.throws(
    () => reconcilePayouts([a, b], ledger),
    /invalid reconcilePayouts: shared payoutRef "shared-1" amounts overflow minor-unit representation/,
  );
  // The control: small amounts under one shared ref still pair.
  const smallA = paidTask("shared-small-a", 100, { quoted: 100, ref: "shared-2" });
  const smallB = paidTask("shared-small-b", 200, { quoted: 200, ref: "shared-2" });
  const smallLedger: LedgerPayout[] = [
    { payoutRef: "shared-2", payoutAmount: 300 },
  ];
  const result = reconcilePayouts([smallA, smallB], smallLedger);
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["shared-small-a", "shared-small-b"],
  );
});

test("toMinorUnits and parseMinorUnits now agree at the ceiling", () => {
  // The string parser already threw past MAX_SAFE_INTEGER; the
  // number converter now throws for the same decimal value.
  assert.throws(
    () => toMinorUnits(90071992547409.92),
    /minor units conversion overflowed: 90071992547409\.92 exceeds Number\.MAX_SAFE_INTEGER in minor units/,
  );
  assert.throws(
    () => parseMinorUnits("90071992547409.92"),
    /minor units conversion overflowed/,
  );
});
