import test from "node:test";
import assert from "node:assert/strict";
import {
  diffTaskSettlementsSummaries,
  type TaskSettlementsSummary,
} from "../src/index.js";

/**
 * `diffTaskSettlementsSummaries` shape gate (backlog #1276): the
 * diff is a comparison, not a validation — it never re-checks the
 * gap identity or the cross-field consistencies (backlog #1094) —
 * but both inputs must be summaries at all first. Before this
 * change the diff only checked "is it an object" and then read
 * eight fields straight off it, so `diffTaskSettlementsSummaries(
 * {}, {})` returned `{}` — a false "no change" between two
 * non-summaries — a missing field diffed as no move
 * (`undefined === undefined`), and a `NaN` field reported a
 * phantom move on every call (`NaN !== NaN`).
 *
 * Rules under test:
 *  - `{}` against `{}` throws, naming the first missing field
 *  - a missing field on either side throws; an unknown field on
 *    either side throws, naming the key
 *  - `NaN`, `Infinity`, beyond-safe-integer, and negative counts
 *    all throw; a negative `gap` is still legal (it may be
 *    negative — a batch that settled more than it was quoted)
 *  - the #1094 contract does not regress: a gap that disagrees
 *    with the totals still diffs (the gap identity is not
 *    re-checked), and a self-contradictory summary
 *    (`paid > tasks`) still diffs — shape only, no consistency
 *  - a legal diff is byte-for-byte the old behaviour
 *  - the `a` side is checked first: both sides broken, the error
 *    names `a`'s fault
 */

/** The demo-shaped golden summary the README pins. */
function golden(): TaskSettlementsSummary {
  return {
    tasks: 6,
    paid: 3,
    quotedTotal: 650000,
    paidTotal: 1634900,
    gap: -984900,
    mismatched: 1,
    unquotedPaid: 1,
    unquotedPaidTotal: 1009850,
  };
}

const PREFIX = "invalid task settlements summary diff";

test("empty objects no longer report a false 'no change'", () => {
  assert.throws(
    () =>
      diffTaskSettlementsSummaries(
        {} as unknown as TaskSettlementsSummary,
        {} as unknown as TaskSettlementsSummary,
      ),
    new RegExp(`${PREFIX}: missing field "tasks"`),
  );
});

test("a missing field on either side throws", () => {
  const { paid, ...missingPaid } = golden();
  void paid;
  assert.throws(
    () =>
      diffTaskSettlementsSummaries(
        missingPaid as unknown as TaskSettlementsSummary,
        golden(),
      ),
    new RegExp(`${PREFIX}: missing field "paid"`),
  );
  const { gap, ...missingGap } = golden();
  void gap;
  assert.throws(
    () =>
      diffTaskSettlementsSummaries(
        golden(),
        missingGap as unknown as TaskSettlementsSummary,
      ),
    new RegExp(`${PREFIX}: missing field "gap"`),
  );
});

test("an unknown field on either side throws, naming the key", () => {
  const extra = { ...golden(), batchId: "B-1" };
  assert.throws(
    () =>
      diffTaskSettlementsSummaries(
        extra as unknown as TaskSettlementsSummary,
        golden(),
      ),
    new RegExp(`${PREFIX}: unknown field "batchId"`),
  );
  assert.throws(
    () =>
      diffTaskSettlementsSummaries(
        golden(),
        extra as unknown as TaskSettlementsSummary,
      ),
    new RegExp(`${PREFIX}: unknown field "batchId"`),
  );
});

test("a NaN field throws instead of reporting a phantom move", () => {
  const bad = { ...golden(), paidTotal: NaN };
  assert.throws(
    () => diffTaskSettlementsSummaries(bad, golden()),
    new RegExp(`${PREFIX}: paidTotal must be a safe integer, got NaN`),
  );
  // The same NaN on both sides must not diff as "no change" either.
  assert.throws(
    () => diffTaskSettlementsSummaries(bad, { ...bad }),
    new RegExp(`${PREFIX}: paidTotal must be a safe integer, got NaN`),
  );
});

test("an Infinity field throws", () => {
  const bad = { ...golden(), quotedTotal: Infinity };
  assert.throws(
    () => diffTaskSettlementsSummaries(golden(), bad),
    new RegExp(
      `${PREFIX}: quotedTotal must be a safe integer, got Infinity`,
    ),
  );
});

test("a beyond-safe-integer field throws", () => {
  const bad = { ...golden(), paidTotal: Number.MAX_SAFE_INTEGER + 1 };
  assert.throws(
    () => diffTaskSettlementsSummaries(bad, golden()),
    /paidTotal must be a safe integer/,
  );
});

test("a negative count throws; a negative gap stays legal", () => {
  const negativeTasks = { ...golden(), tasks: -1 };
  assert.throws(
    () => diffTaskSettlementsSummaries(negativeTasks, golden()),
    new RegExp(`${PREFIX}: tasks must not be negative, got -1`),
  );
  const negativeMismatched = { ...golden(), mismatched: -1 };
  assert.throws(
    () => diffTaskSettlementsSummaries(golden(), negativeMismatched),
    new RegExp(`${PREFIX}: mismatched must not be negative, got -1`),
  );
  // gap may be negative — a batch that settled more than quoted.
  const moreNegativeGap = { ...golden(), gap: -2000000 };
  assert.deepEqual(
    diffTaskSettlementsSummaries(golden(), moreNegativeGap),
    { gapChanged: { from: -984900, to: -2000000 } },
  );
});

test("a non-number field throws", () => {
  const bad = { ...golden(), paid: "3" };
  assert.throws(
    () =>
      diffTaskSettlementsSummaries(
        bad as unknown as TaskSettlementsSummary,
        golden(),
      ),
    new RegExp(`${PREFIX}: paid must be a safe integer, got "3"`),
  );
});

test("gap identity mismatch still diffs (the #1094 contract holds)", () => {
  // Totals untouched, gap wildly inconsistent with them: the diff
  // reports the move instead of refusing it — the gap identity is
  // the renderers'/parsers' job, not the comparison's.
  const before = golden();
  const after = { ...before, gap: 999999 };
  assert.deepEqual(diffTaskSettlementsSummaries(before, after), {
    gapChanged: { from: -984900, to: 999999 },
  });
});

test("a self-contradictory summary still diffs (shape only, no consistency)", () => {
  // paid (9) exceeds tasks (6): the #1269 render/parse gate would
  // refuse this, but the diff compares figures, it does not
  // re-derive them.
  const before = golden();
  const after = { ...before, paid: 9 };
  assert.deepEqual(diffTaskSettlementsSummaries(before, after), {
    paidChanged: { from: 3, to: 9 },
  });
});

test("a legal diff is unchanged by the gate", () => {
  assert.deepEqual(diffTaskSettlementsSummaries(golden(), golden()), {});
  const after = { ...golden(), paidTotal: 1635000, gap: -985000 };
  assert.deepEqual(diffTaskSettlementsSummaries(golden(), after), {
    paidTotalChanged: { from: 1634900, to: 1635000 },
    gapChanged: { from: -984900, to: -985000 },
  });
});

test("the `a` side is checked first", () => {
  const badA = { ...golden(), tasks: -1 };
  const badB = { ...golden(), paid: NaN };
  assert.throws(
    () => diffTaskSettlementsSummaries(badA, badB),
    new RegExp(`${PREFIX}: tasks must not be negative, got -1`),
  );
});
