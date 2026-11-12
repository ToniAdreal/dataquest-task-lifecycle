import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  parseTaskSettlementsCsv,
  parseTaskSettlementsJson,
  payoutMismatch,
  renderTaskSettlementsCsv,
  renderTaskSettlementsJson,
  summarizeTaskSettlements,
  type TaskSettlementsSummary,
} from "../src/index.js";

/**
 * `renderTaskSettlementsCsv` / `parseTaskSettlementsCsv` /
 * `renderTaskSettlementsJson` / `parseTaskSettlementsJson`
 * (backlog #1079): the text forms of the batch settlement summary
 * `summarizeTaskSettlements()` returns — the escrow
 * `renderReportCsv` / `parseSettlementReportCsv` /
 * `renderReportJson` / `parseSettlementReportJson` paradigm, for the
 * dataquest summary. Until now a caller doing batch reconciliation
 * had to hand-write the export of a summary, and there was no
 * canonical text form to paste into a settlement statement or
 * re-import.
 *
 * Rules under test:
 *  - CSV is a header row plus exactly one data row, in canonical
 *    field order, all money figures integer minor units
 *  - JSON writes the same eight fields as numbers, in canonical
 *    key order
 *  - round-trip is the identity: `parse(render(s))` deep-equals
 *    `s`, and re-rendering a parsed value is byte-identical
 *  - the golden CSV/JSON pin the demo-shaped batch: 6 tasks,
 *    3 PAID, quoted 650000, paid 1634900, gap -984900 (negative),
 *    1 mismatched, 1 unquoted PAID task settled 1009850
 *  - the gap identity (`gap + unquotedPaidTotal` is the negated
 *    sum of the per-task `payoutMismatch` deltas) survives both
 *    round-trips
 *  - both parsers are strict and fail closed: bad header, wrong
 *    column/field count, non-integer or non-canonical amounts,
 *    negative counts/totals, a `gap` that does not equal
 *    `quotedTotal - paidTotal`, missing/unknown fields, string
 *    amounts in JSON, non-string input — all throw with the
 *    direction's prefix instead of returning a half-summary
 *  - both renderers reject a malformed summary before emitting
 *    text: missing/unknown fields, non-integer or unsafe-integer
 *    figures, negative counts/totals, an inconsistent `gap`
 *  - CSV transport artifacts are tolerated: CRLF line endings, a
 *    trailing newline, trailing blank lines, a UTF-8 BOM, and
 *    RFC 4180 quoted fields — all re-render to the canonical bytes
 */

/** Drive a task to OPEN (one step before ACCEPT). */
function toOpen(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  return t;
}

interface PaidOpts {
  quoted?: number;
  paid?: number;
}

/** DRAFT → … → PAID, quoting on ACCEPT and settling on PAYOUT_COMPLETE. */
function toPaid(id: string, opts: PaidOpts): TaskLifecycle {
  const t = toOpen(id);
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

/** PUBLISH → EXPIRE: a non-PAID terminal task. */
function toExpired(id: string): TaskLifecycle {
  const t = toOpen(id);
  t.dispatch("EXPIRE", { actor: "system" });
  return t;
}

/**
 * The demo-shaped mixed batch: 6 tasks, 3 PAID — one quoteless
 * (settled 10098.5 with no recorded quote), one mismatched
 * (quoted 4300, settled 4050.5, delta -249.5), one settled exactly
 * as quoted (2200) — plus one OPEN, one EXPIRED, and one DRAFT
 * task that contribute only to the task count.
 */
function mixedBatch(): TaskLifecycle[] {
  return [
    toPaid("DEMO-001", { paid: 10098.5 }),
    toPaid("DEMO-005", { quoted: 4300, paid: 4050.5 }),
    toPaid("DEMO-003", { quoted: 2200, paid: 2200 }),
    toOpen("DEMO-OPEN"),
    toExpired("DEMO-EXPIRED"),
    new TaskLifecycle("DEMO-DRAFT"),
  ];
}

const MIXED_SUMMARY: TaskSettlementsSummary = {
  tasks: 6,
  paid: 3,
  quotedTotal: 650000,
  paidTotal: 1634900,
  gap: -984900,
  mismatched: 1,
  unquotedPaid: 1,
  unquotedPaidTotal: 1009850,
};

const MIXED_CSV =
  "tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n" +
  "6,3,650000,1634900,-984900,1,1,1009850";

const MIXED_JSON =
  '{"tasks":6,"paid":3,"quotedTotal":650000,"paidTotal":1634900,"gap":-984900,"mismatched":1,"unquotedPaid":1,"unquotedPaidTotal":1009850}';

const ZERO_SUMMARY: TaskSettlementsSummary = {
  tasks: 0,
  paid: 0,
  quotedTotal: 0,
  paidTotal: 0,
  gap: 0,
  mismatched: 0,
  unquotedPaid: 0,
  unquotedPaidTotal: 0,
};

test("summarizeTaskSettlements pins the mixed batch the golden rows describe", () => {
  assert.deepEqual(summarizeTaskSettlements(mixedBatch()), MIXED_SUMMARY);
});

test("golden CSV: mixed batch renders byte-exact, with unquotedPaid > 0 and a negative gap", () => {
  assert.equal(renderTaskSettlementsCsv(MIXED_SUMMARY), MIXED_CSV);
});

test("golden JSON: mixed batch renders byte-exact, amounts as numbers in canonical key order", () => {
  assert.equal(renderTaskSettlementsJson(MIXED_SUMMARY), MIXED_JSON);
});

test("CSV round-trip is the identity, on the mixed batch and on the all-zero summary", () => {
  assert.deepEqual(parseTaskSettlementsCsv(renderTaskSettlementsCsv(MIXED_SUMMARY)), MIXED_SUMMARY);
  assert.deepEqual(parseTaskSettlementsCsv(renderTaskSettlementsCsv(ZERO_SUMMARY)), ZERO_SUMMARY);
  assert.equal(
    renderTaskSettlementsCsv(parseTaskSettlementsCsv(MIXED_CSV)),
    MIXED_CSV,
  );
  assert.equal(
    renderTaskSettlementsCsv(ZERO_SUMMARY),
    "tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n0,0,0,0,0,0,0,0",
  );
});

test("JSON round-trip is the identity, on the mixed batch and on the all-zero summary", () => {
  assert.deepEqual(parseTaskSettlementsJson(renderTaskSettlementsJson(MIXED_SUMMARY)), MIXED_SUMMARY);
  assert.deepEqual(parseTaskSettlementsJson(renderTaskSettlementsJson(ZERO_SUMMARY)), ZERO_SUMMARY);
  assert.equal(
    renderTaskSettlementsJson(parseTaskSettlementsJson(MIXED_JSON)),
    MIXED_JSON,
  );
  assert.equal(
    renderTaskSettlementsJson(ZERO_SUMMARY),
    '{"tasks":0,"paid":0,"quotedTotal":0,"paidTotal":0,"gap":0,"mismatched":0,"unquotedPaid":0,"unquotedPaidTotal":0}',
  );
});

test("gap + unquotedPaidTotal identity survives both round-trips on the mixed batch", () => {
  const tasks = mixedBatch();
  const summary = summarizeTaskSettlements(tasks);
  const deltaSum = tasks.reduce(
    (acc, t) => acc + (payoutMismatch(t)?.delta ?? 0) * 100,
    0,
  );
  // The identity, in minor units: gap + unquotedPaidTotal is the
  // negated sum of the per-task deltas (here -(-249.5 * 100)).
  assert.equal(summary.gap + summary.unquotedPaidTotal, -deltaSum);
  for (const parsed of [
    parseTaskSettlementsCsv(renderTaskSettlementsCsv(summary)),
    parseTaskSettlementsJson(renderTaskSettlementsJson(summary)),
  ]) {
    assert.equal(parsed.gap + parsed.unquotedPaidTotal, -deltaSum);
    assert.equal(parsed.gap, -984900);
    assert.equal(parsed.unquotedPaidTotal, 1009850);
  }
});

test("CSV parser rejects malformed input, fail-closed", () => {
  const bad: Array<[string, string]> = [
    ["bad header", "task,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n6,3,650000,1634900,-984900,1,1,1009850"],
    ["extra column", `${MIXED_CSV},0`],
    ["missing column", "tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n6,3,650000,1634900,-984900,1,1"],
    ["non-integer amount", MIXED_CSV.replace("650000", "650000.5")],
    ["negative paidTotal", MIXED_CSV.replace("1634900", "-1634900")],
    ["negative tasks", MIXED_CSV.replace("\n6,", "\n-6,")],
    ["empty text", ""],
    ["header only", "tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n"],
    ["trailing extra row", `${MIXED_CSV}\n6,3,650000,1634900,-984900,1,1,1009850`],
    ["gap inconsistent with totals", MIXED_CSV.replace("-984900", "-984901")],
    ["leading-zero integer", MIXED_CSV.replace("650000", "0650000")],
    ["exponent integer", MIXED_CSV.replace("650000", "6.5e5")],
    ["unterminated quoted field", "tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n\"6,3,650000,1634900,-984900,1,1,1009850"],
  ];
  for (const [name, text] of bad) {
    assert.throws(
      () => parseTaskSettlementsCsv(text),
      /cannot parse task settlements CSV: /,
      name,
    );
  }
  assert.throws(
    () => parseTaskSettlementsCsv(42 as unknown as string),
    /cannot parse task settlements CSV: input must be a CSV string/,
  );
});

test("JSON parser rejects malformed input, fail-closed", () => {
  const bad: Array<[string, string]> = [
    ["invalid JSON", "{not json"],
    ["string amounts", MIXED_JSON.replace("650000", '"650000"')],
    ["missing field", '{"tasks":6,"paid":3,"quotedTotal":650000,"paidTotal":1634900,"gap":-984900,"mismatched":1,"unquotedPaid":1}'],
    ["unknown field", MIXED_JSON.replace("}", ',"currency":"USD"}')],
    ["negative paidTotal", MIXED_JSON.replace("1634900", "-1634900")],
    ["float gap", MIXED_JSON.replace("-984900", "-984900.5")],
    ["array input", "[6,3,650000]"],
    ["null input", "null"],
    ["gap inconsistent with totals", MIXED_JSON.replace("-984900", "-984901")],
    ["unsafe integer", MIXED_JSON.replace("650000", "9007199254740993")],
    ["non-finite via exponent", MIXED_JSON.replace("650000", "1e999")],
  ];
  for (const [name, text] of bad) {
    assert.throws(
      () => parseTaskSettlementsJson(text),
      /cannot parse task settlements JSON: /,
      name,
    );
  }
  assert.throws(
    () => parseTaskSettlementsJson(42 as unknown as string),
    /cannot parse task settlements JSON: input must be a JSON string/,
  );
});

test("renderers reject a malformed summary before emitting text", () => {
  const bad: Array<[string, unknown]> = [
    ["missing field", { ...MIXED_SUMMARY, gap: undefined }],
    ["unknown field", { ...MIXED_SUMMARY, currency: "USD" }],
    ["negative paidTotal", { ...MIXED_SUMMARY, paidTotal: -1 }],
    ["negative tasks", { ...MIXED_SUMMARY, tasks: -6 }],
    ["NaN amount", { ...MIXED_SUMMARY, quotedTotal: Number.NaN }],
    ["Infinity amount", { ...MIXED_SUMMARY, paidTotal: Number.POSITIVE_INFINITY }],
    ["unsafe integer", { ...MIXED_SUMMARY, quotedTotal: 2 ** 53 }],
    ["float amount", { ...MIXED_SUMMARY, quotedTotal: 650000.5 }],
    ["gap inconsistent with totals", { ...MIXED_SUMMARY, gap: -984901 }],
    ["null summary", null],
    ["array summary", [6, 3, 650000]],
  ];
  for (const [name, summary] of bad) {
    assert.throws(
      () => renderTaskSettlementsCsv(summary as TaskSettlementsSummary),
      /cannot render task settlements summary as CSV: /,
      `CSV: ${name}`,
    );
    assert.throws(
      () => renderTaskSettlementsJson(summary as TaskSettlementsSummary),
      /cannot render task settlements summary as JSON: /,
      `JSON: ${name}`,
    );
  }
});

test("CSV transport artifacts parse and re-render to the canonical bytes", () => {
  // CRLF line endings.
  assert.deepEqual(
    parseTaskSettlementsCsv(MIXED_CSV.replace("\n", "\r\n")),
    MIXED_SUMMARY,
  );
  // Trailing newline and trailing blank lines.
  assert.deepEqual(parseTaskSettlementsCsv(`${MIXED_CSV}\n`), MIXED_SUMMARY);
  assert.deepEqual(parseTaskSettlementsCsv(`${MIXED_CSV}\n\n\n`), MIXED_SUMMARY);
  // UTF-8 byte-order mark.
  assert.deepEqual(parseTaskSettlementsCsv(`\uFEFF${MIXED_CSV}`), MIXED_SUMMARY);
  // RFC 4180 quoted fields re-render unquoted.
  assert.deepEqual(
    parseTaskSettlementsCsv(
      'tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal\n"6",3,650000,1634900,-984900,1,1,1009850',
    ),
    MIXED_SUMMARY,
  );
  for (const text of [
    `${MIXED_CSV}\n`,
    MIXED_CSV.replace("\n", "\r\n"),
    `\uFEFF${MIXED_CSV}`,
  ]) {
    assert.equal(renderTaskSettlementsCsv(parseTaskSettlementsCsv(text)), MIXED_CSV);
  }
});

test("JSON accepts any key order and re-renders in canonical order", () => {
  const shuffled =
    '{"unquotedPaidTotal":1009850,"gap":-984900,"paidTotal":1634900,"tasks":6,"paid":3,"quotedTotal":650000,"mismatched":1,"unquotedPaid":1}';
  assert.deepEqual(parseTaskSettlementsJson(shuffled), MIXED_SUMMARY);
  assert.equal(renderTaskSettlementsJson(parseTaskSettlementsJson(shuffled)), MIXED_JSON);
});

test("rendering is deterministic and parses yield independent copies", () => {
  assert.equal(renderTaskSettlementsCsv(MIXED_SUMMARY), renderTaskSettlementsCsv(MIXED_SUMMARY));
  assert.equal(renderTaskSettlementsJson(MIXED_SUMMARY), renderTaskSettlementsJson(MIXED_SUMMARY));
  const a = parseTaskSettlementsCsv(MIXED_CSV);
  const b = parseTaskSettlementsCsv(MIXED_CSV);
  a.paidTotal = 0;
  assert.equal(b.paidTotal, 1634900);
  const c = parseTaskSettlementsJson(MIXED_JSON);
  const d = parseTaskSettlementsJson(MIXED_JSON);
  c.gap = 0;
  assert.equal(d.gap, -984900);
});

test("rendering never mutates the summary", () => {
  const summary = { ...MIXED_SUMMARY };
  renderTaskSettlementsCsv(summary);
  renderTaskSettlementsJson(summary);
  assert.deepEqual(summary, MIXED_SUMMARY);
});
