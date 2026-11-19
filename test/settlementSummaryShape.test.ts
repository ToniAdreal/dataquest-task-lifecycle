import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTaskSettlementsCsv,
  parseTaskSettlementsJson,
  renderTaskSettlements,
  renderTaskSettlementsCsv,
  renderTaskSettlementsJson,
  type TaskSettlementsSummary,
} from "../src/index.js";

/**
 * `assertSummaryShape` cross-field consistency (backlog #1269):
 * a hand-built summary whose fields are each individually legal
 * and whose `gap` identity holds can still be self-contradictory
 * (`paid > tasks`, `mismatched > paid`, `unquotedPaid > paid`,
 * `unquotedPaidTotal > paidTotal`) — no real
 * `summarizeTaskSettlements` output ever looks like that. All
 * four render/parse entry points share `assertSummaryShape`, so
 * the contradictory summary must fail loudly at every entry
 * point instead of rendering into a plausible-looking
 * reconciliation document or parsing back into a trusted value.
 *
 * Rules under test:
 *  - each of the four violations is rejected by the CSV renderer
 *    and by the JSON parser, with the direction's prefix and a
 *    message naming the two fields
 *  - the backlog's verbatim contradictory summary
 *    (tasks 3, paid 5, mismatched 9, unquotedPaid 7,
 *    unquotedPaidTotal 999, gap 0) is rejected by the plain-text
 *    renderer and the CSV parser too
 *  - the boundary equalities (paid == tasks, mismatched == paid,
 *    unquotedPaid == paid, unquotedPaidTotal == paidTotal) still
 *    render and parse
 *  - the demo-shaped batch summary and the all-zero empty batch
 *    are unchanged by the new checks
 */

/** The backlog's verbatim contradictory summary: every field is a legal safe integer, gap holds, all four cross-field rules break. */
const CONTRADICTORY: TaskSettlementsSummary = {
  tasks: 3,
  paid: 5,
  quotedTotal: 0,
  paidTotal: 0,
  gap: 0,
  mismatched: 9,
  unquotedPaid: 7,
  unquotedPaidTotal: 999,
};

/** One rule broken at a time, gap identity intact, everything else legal. */
function oneViolation(
  field: keyof TaskSettlementsSummary,
  value: number,
): TaskSettlementsSummary {
  return {
    tasks: 3,
    paid: 2,
    quotedTotal: 100,
    paidTotal: 50,
    gap: 50,
    mismatched: 0,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
    [field]: value,
  };
}

const VIOLATIONS: Array<{
  field: keyof TaskSettlementsSummary;
  value: number;
  message: RegExp;
}> = [
  { field: "paid", value: 5, message: /paid 5 exceeds tasks 3/ },
  { field: "mismatched", value: 3, message: /mismatched 3 exceeds paid 2/ },
  { field: "unquotedPaid", value: 3, message: /unquotedPaid 3 exceeds paid 2/ },
  {
    field: "unquotedPaidTotal",
    value: 999,
    message: /unquotedPaidTotal 999 exceeds paidTotal 50/,
  },
];

for (const { field, value, message } of VIOLATIONS) {
  test(`assertSummaryShape rejects ${field} exceeding its ceiling at the CSV renderer`, () => {
    assert.throws(
      () => renderTaskSettlementsCsv(oneViolation(field, value)),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith("cannot render task settlements summary as CSV: ") &&
        message.test(err.message),
    );
  });

  test(`assertSummaryShape rejects ${field} exceeding its ceiling at the JSON parser`, () => {
    assert.throws(
      () => parseTaskSettlementsJson(JSON.stringify(oneViolation(field, value))),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith("cannot parse task settlements JSON: ") &&
        message.test(err.message),
    );
  });
}

test("the backlog's contradictory summary is rejected by the plain-text renderer", () => {
  assert.throws(
    () => renderTaskSettlements(CONTRADICTORY),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot render task settlements summary: ") &&
      /paid 5 exceeds tasks 3/.test(err.message),
  );
});

test("the backlog's contradictory summary is rejected by the CSV parser", () => {
  const csv =
    "tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n" +
    "3,5,0,0,0,9,7,999";
  assert.throws(
    () => parseTaskSettlementsCsv(csv),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot parse task settlements CSV: ") &&
      /paid 5 exceeds tasks 3/.test(err.message),
  );
});

test("the backlog's contradictory summary is rejected by the JSON renderer too", () => {
  assert.throws(
    () => renderTaskSettlementsJson(CONTRADICTORY),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot render task settlements summary as JSON: ") &&
      /paid 5 exceeds tasks 3/.test(err.message),
  );
});

test("boundary equalities still render and parse", () => {
  const boundary: TaskSettlementsSummary = {
    tasks: 3,
    paid: 3,
    quotedTotal: 100,
    paidTotal: 100,
    gap: 0,
    mismatched: 3,
    unquotedPaid: 3,
    unquotedPaidTotal: 100,
  };
  assert.equal(
    renderTaskSettlementsCsv(boundary),
    "tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n3,3,100,100,0,3,3,100",
  );
  assert.deepEqual(
    parseTaskSettlementsJson(renderTaskSettlementsJson(boundary)),
    boundary,
  );
  assert.match(renderTaskSettlements(boundary), /Tasks: 3 \(paid: 3\)/);
});

test("the demo-shaped batch summary renders and parses unchanged", () => {
  const demo: TaskSettlementsSummary = {
    tasks: 6,
    paid: 3,
    quotedTotal: 650000,
    paidTotal: 1634900,
    gap: -984900,
    mismatched: 1,
    unquotedPaid: 1,
    unquotedPaidTotal: 1009850,
  };
  assert.equal(
    renderTaskSettlementsCsv(demo),
    "tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n6,3,650000,1634900,-984900,1,1,1009850",
  );
  assert.deepEqual(parseTaskSettlementsCsv(renderTaskSettlementsCsv(demo)), demo);
  assert.deepEqual(parseTaskSettlementsJson(renderTaskSettlementsJson(demo)), demo);
});

test("the all-zero empty batch summary renders and parses unchanged", () => {
  const zero: TaskSettlementsSummary = {
    tasks: 0,
    paid: 0,
    quotedTotal: 0,
    paidTotal: 0,
    gap: 0,
    mismatched: 0,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  };
  assert.deepEqual(parseTaskSettlementsCsv(renderTaskSettlementsCsv(zero)), zero);
  assert.deepEqual(parseTaskSettlementsJson(renderTaskSettlementsJson(zero)), zero);
  assert.match(renderTaskSettlements(zero), /Tasks: 0 \(paid: 0\)/);
});
