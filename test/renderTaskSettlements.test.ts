import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  renderTaskSettlements,
  summarizeTaskSettlements,
  type TaskSettlementsSummary,
} from "../src/index.js";

/**
 * `renderTaskSettlements(summary)` (backlog #1096): the plain
 * human-readable text form of the batch settlement summary
 * `summarizeTaskSettlements()` returns — the dataquest-side mirror
 * of escrow's `renderReport`, for a log line or a terminal paste
 * during reconciliation, so a caller no longer has to hand-build
 * the string or paste a JSON document into a chat.
 *
 * Rules under test:
 *  - fixed line order: title, counts, quoted/paid/gap money lines,
 *    mismatched + unquoted rows, units line — amounts after counts
 *  - money figures go through `formatMinorUnits` (two decimals, no
 *    currency symbol); the gap carries its meaning in parentheses:
 *    negative is `(overpaid)`, positive is `(underpaid)`, zero is
 *    `(balanced)`
 *  - the golden texts pin the demo-shaped batch (6 tasks, 3 PAID,
 *    quoted 650000, paid 1634900, gap -984900, 1 mismatched,
 *    1 unquoted PAID task settled 1009850) and the positive-gap
 *    mirror of it
 *  - counts and exception rows are always present, even when zero
 *  - rendering is deterministic (same summary, byte-identical text)
 *    and pure (a frozen summary renders, the input is never mutated)
 *  - the shape check reuses `assertSummaryShape` with the prefix
 *    `cannot render task settlements summary: …`: a missing or
 *    unknown field, a non-integer or unsafe-integer figure, a
 *    negative count or total, or a `gap` that does not equal
 *    `quotedTotal - paidTotal` throws instead of emitting a
 *    plausible-looking document
 *  - the renderer works on a real `summarizeTaskSettlements` output,
 *    not only on hand-built fixtures
 */

/** The demo-shaped batch, the same fixture the CSV/JSON goldens pin. */
const DEMO_SUMMARY: TaskSettlementsSummary = {
  tasks: 6,
  paid: 3,
  quotedTotal: 650000,
  paidTotal: 1634900,
  gap: -984900,
  mismatched: 1,
  unquotedPaid: 1,
  unquotedPaidTotal: 1009850,
};

const DEMO_TEXT = [
  "Task settlements summary",
  "Tasks: 6 (paid: 3)",
  "Quoted total: 6500.00",
  "Paid total: 16349.00",
  "Gap: -9849.00 (overpaid)",
  "Mismatched payouts: 1",
  "Unquoted paid tasks: 1",
  "Unquoted paid total: 10098.50",
  "Amounts are integer minor units (cents).",
].join("\n");

/** DRAFT → … → PAID, quoting on ACCEPT and settling on PAYOUT_COMPLETE. */
function toPaid(
  id: string,
  opts: { quoted?: number; paid?: number },
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
    ...(opts.paid !== undefined ? { payoutAmount: opts.paid } : {}),
  });
  return t;
}

test("golden text: demo-shaped batch with a negative gap (overpaid)", () => {
  assert.equal(renderTaskSettlements(DEMO_SUMMARY), DEMO_TEXT);
});

test("golden text: positive gap reads (underpaid)", () => {
  const summary: TaskSettlementsSummary = {
    tasks: 4,
    paid: 2,
    quotedTotal: 100000,
    paidTotal: 75000,
    gap: 25000,
    mismatched: 1,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  };
  assert.equal(
    renderTaskSettlements(summary),
    [
      "Task settlements summary",
      "Tasks: 4 (paid: 2)",
      "Quoted total: 1000.00",
      "Paid total: 750.00",
      "Gap: 250.00 (underpaid)",
      "Mismatched payouts: 1",
      "Unquoted paid tasks: 0",
      "Unquoted paid total: 0.00",
      "Amounts are integer minor units (cents).",
    ].join("\n"),
  );
});

test("golden text: zero gap reads (balanced); zero batch is explicit", () => {
  assert.equal(
    renderTaskSettlements({
      tasks: 0,
      paid: 0,
      quotedTotal: 0,
      paidTotal: 0,
      gap: 0,
      mismatched: 0,
      unquotedPaid: 0,
      unquotedPaidTotal: 0,
    }),
    [
      "Task settlements summary",
      "Tasks: 0 (paid: 0)",
      "Quoted total: 0.00",
      "Paid total: 0.00",
      "Gap: 0.00 (balanced)",
      "Mismatched payouts: 0",
      "Unquoted paid tasks: 0",
      "Unquoted paid total: 0.00",
      "Amounts are integer minor units (cents).",
    ].join("\n"),
  );
});

test("line order is fixed: money lines come after the counts line", () => {
  const lines = renderTaskSettlements(DEMO_SUMMARY).split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines[0], "Task settlements summary");
  assert.equal(lines[1], "Tasks: 6 (paid: 3)");
  assert.ok(lines[2].startsWith("Quoted total: "));
  assert.ok(lines[3].startsWith("Paid total: "));
  assert.ok(lines[4].startsWith("Gap: "));
  assert.ok(lines[5].startsWith("Mismatched payouts: "));
  assert.ok(lines[6].startsWith("Unquoted paid tasks: "));
  assert.ok(lines[7].startsWith("Unquoted paid total: "));
  assert.equal(lines[8], "Amounts are integer minor units (cents).");
});

test("deterministic: the same summary renders byte-identically twice", () => {
  assert.equal(
    renderTaskSettlements(DEMO_SUMMARY),
    renderTaskSettlements(DEMO_SUMMARY),
  );
});

test("pure: a frozen summary renders and is never mutated", () => {
  const frozen = Object.freeze({ ...DEMO_SUMMARY });
  assert.equal(renderTaskSettlements(frozen), DEMO_TEXT);
  assert.deepEqual(frozen, DEMO_SUMMARY);
});

test("missing field throws with the render prefix", () => {
  const { gap, ...withoutGap } = DEMO_SUMMARY;
  assert.throws(
    () => renderTaskSettlements(withoutGap as TaskSettlementsSummary),
    /cannot render task settlements summary: missing field "gap"/,
  );
});

test("unknown field throws with the render prefix", () => {
  assert.throws(
    () =>
      renderTaskSettlements({
        ...DEMO_SUMMARY,
        currency: "USD",
      } as unknown as TaskSettlementsSummary),
    /cannot render task settlements summary: unknown field "currency"/,
  );
});

test("non-integer, unsafe-integer, and negative figures throw", () => {
  assert.throws(
    () =>
      renderTaskSettlements({ ...DEMO_SUMMARY, paidTotal: 1634900.5 }),
    /cannot render task settlements summary: paidTotal must be a safe integer/,
  );
  assert.throws(
    () =>
      renderTaskSettlements({
        ...DEMO_SUMMARY,
        quotedTotal: Number.MAX_SAFE_INTEGER + 1,
      }),
    /cannot render task settlements summary: quotedTotal must be a safe integer/,
  );
  assert.throws(
    () => renderTaskSettlements({ ...DEMO_SUMMARY, tasks: -1 }),
    /cannot render task settlements summary: tasks must not be negative/,
  );
  assert.throws(
    () => renderTaskSettlements({ ...DEMO_SUMMARY, paidTotal: -5, gap: 650005 }),
    /cannot render task settlements summary: paidTotal must not be negative/,
  );
});

test("inconsistent gap throws with the render prefix", () => {
  assert.throws(
    () => renderTaskSettlements({ ...DEMO_SUMMARY, gap: -984899 }),
    /cannot render task settlements summary: gap -984899 does not equal quotedTotal 650000 minus paidTotal 1634900/,
  );
});

test("non-object input throws with the render prefix", () => {
  assert.throws(
    () => renderTaskSettlements(null as unknown as TaskSettlementsSummary),
    /cannot render task settlements summary: summary must be an object/,
  );
  assert.throws(
    () => renderTaskSettlements([] as unknown as TaskSettlementsSummary),
    /cannot render task settlements summary: summary must be an object/,
  );
});

test("works on a real summarizeTaskSettlements output", () => {
  const quoted = toPaid("T-1", { quoted: 100, paid: 100 });
  const unquoted = toPaid("T-2", { paid: 50.5 });
  const summary = summarizeTaskSettlements([quoted, unquoted]);
  assert.deepEqual(summary, {
    tasks: 2,
    paid: 2,
    quotedTotal: 10000,
    paidTotal: 15050,
    gap: -5050,
    mismatched: 0,
    unquotedPaid: 1,
    unquotedPaidTotal: 5050,
  });
  assert.equal(
    renderTaskSettlements(summary),
    [
      "Task settlements summary",
      "Tasks: 2 (paid: 2)",
      "Quoted total: 100.00",
      "Paid total: 150.50",
      "Gap: -50.50 (overpaid)",
      "Mismatched payouts: 0",
      "Unquoted paid tasks: 1",
      "Unquoted paid total: 50.50",
      "Amounts are integer minor units (cents).",
    ].join("\n"),
  );
});
