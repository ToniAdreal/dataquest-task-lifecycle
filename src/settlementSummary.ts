import { formatMinorUnits } from "./taskLifecycle.js";
import type { TaskSettlementsSummary } from "./taskLifecycle.js";

/**
 * The task settlements summary as carried by
 * {@link renderTaskSettlementsCsv} — the whole
 * {@link TaskSettlementsSummary}, nothing less. Unlike escrow's
 * `SettlementReportCsv`, which is a subset of its report (the CSV
 * drops the deposit breakdown, settlement parameters, and audit
 * window), the summary CSV carries all eight fields, so a parsed
 * value is the full summary and re-renders byte-identically; no
 * field is ever invented on import.
 */
export type TaskSettlementsSummaryCsv = TaskSettlementsSummary;

/**
 * The canonical field order for the CSV header and the JSON
 * rendering — the declaration order of
 * {@link TaskSettlementsSummary}. Both renderers write the fields
 * in this order and both parsers require them in this order, so a
 * summary rendered twice is byte-identical and a parsed summary
 * re-renders byte-identically.
 */
const SUMMARY_FIELDS = [
  "tasks",
  "paid",
  "quotedTotal",
  "paidTotal",
  "gap",
  "mismatched",
  "unquotedPaid",
  "unquotedPaidTotal",
] as const;

const CSV_HEADER = SUMMARY_FIELDS.join(",");

/**
 * Validate the structural shape of a task settlements summary
 * before it is serialized (or after it is parsed back). This is a
 * shape check plus the one self-consistency identity the summary
 * itself carries — `gap === quotedTotal - paidTotal` — not a
 * re-derivation of the accounting: the figures are trusted as the
 * caller's (normally {@link summarizeTaskSettlements}'s output
 * from `taskLifecycle.ts`), but a value that is not a summary at
 * all must fail loudly here rather than silently degrading in
 * transit.
 *
 * Every field must be a safe integer — `JSON.stringify` and
 * `Number` both lose precision past `Number.MAX_SAFE_INTEGER`, so
 * an unsafe integer would round-trip to a different number and
 * break the `parse(render(s)) === s` identity the renderers
 * promise. Every field must be non-negative except `gap`, which
 * may be negative (a batch that settled more than it was quoted).
 * Unknown or missing fields fail closed: a summary with a field
 * the renderers never write is not a summary this library can
 * carry, and a missing field would render as an empty column.
 * Every failure throws `<prefix>: …`, where the prefix names the
 * direction, so a failure's origin is unambiguous.
 */
function assertSummaryShape(summary: unknown, prefix: string): void {
  const fail = (reason: string): never => {
    throw new Error(`${prefix}: ${reason}`);
  };
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
    fail("summary must be an object");
  }
  const record = summary as Record<string, unknown>;
  for (const field of SUMMARY_FIELDS) {
    if (!(field in record)) {
      fail(`missing field ${JSON.stringify(field)}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!(SUMMARY_FIELDS as readonly string[]).includes(key)) {
      fail(`unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const field of SUMMARY_FIELDS) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      fail(
        `${field} must be a safe integer, got ${
          typeof value === "number" ? String(value) : JSON.stringify(value)
        }`,
      );
    }
    if (field !== "gap" && (value as number) < 0) {
      fail(`${field} must not be negative, got ${value}`);
    }
  }
  const typed = summary as TaskSettlementsSummary;
  if (typed.gap !== typed.quotedTotal - typed.paidTotal) {
    fail(
      `gap ${typed.gap} does not equal quotedTotal ${typed.quotedTotal} minus paidTotal ${typed.paidTotal}`,
    );
  }
}

/** Escape one CSV field following RFC 4180. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Render a task settlements summary as CSV — the text form of the
 * batch position {@link summarizeTaskSettlements} returns, for the
 * bookkeeping hop: a caller that exported a summary with this
 * function gets a row that pastes straight into a reconciliation
 * spreadsheet or a settlement statement.
 *
 * The output is a header row plus exactly one data row, in the
 * canonical field order:
 *
 * ```csv
 * tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal
 * 6,3,650000,1634900,-984900,1,1,1009850
 * ```
 *
 * All money figures are integer minor units (cents) — the same
 * convention as {@link summarizeTaskSettlements} — so no
 * binary-float error can leak into a reconciliation total, and no
 * field ever needs quoting: integers contain no comma, quote, or
 * line break. The renderer still runs every value through the
 * RFC 4180 escaper, so the escaping rule is stated once and holds
 * if a field ever stops being an integer.
 *
 * Before rendering, the summary is shape-checked with
 * {@link assertSummaryShape}: a non-object summary, a missing or
 * unknown field, a non-integer or unsafe-integer figure, a
 * negative count or total, or a `gap` that does not equal
 * `quotedTotal - paidTotal` throws
 * `cannot render task settlements summary as CSV: …` instead of
 * emitting a row that reads `Infinity` or `NaN`.
 *
 * Pure: the summary is only read, never mutated.
 */
export function renderTaskSettlementsCsv(
  summary: TaskSettlementsSummary,
): string {
  assertSummaryShape(summary, "cannot render task settlements summary as CSV");
  const row = SUMMARY_FIELDS.map((field) => csvField(String(summary[field]))).join(",");
  return `${CSV_HEADER}\n${row}`;
}

/**
 * Split CSV text into records, following RFC 4180: a field
 * containing a comma, a double quote, or a line break is wrapped in
 * double quotes, and each double quote inside it is doubled. A
 * quote anywhere else — a bare quote in the middle of an unquoted
 * field, a character other than a comma, a line break, or
 * end-of-input after a closing quote, or an unterminated quoted
 * field — is malformed and throws, because silently
 * re-interpreting a shifted column would corrupt a money import.
 * CRLF and LF line breaks are both accepted; a quoted field may
 * itself contain a line break, so records are parsed from the whole
 * text, not by splitting on newlines first. This is the same
 * parser shape escrow's `parseSettlementReportCsv` uses, adapted
 * to this module's error prefix.
 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterClosingQuote = false;
  let i = 0;
  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (afterClosingQuote) {
      if (c === ",") {
        pushField();
        afterClosingQuote = false;
        i += 1;
      } else if (c === "\r") {
        if (text[i + 1] === "\n") i += 1;
        pushRecord();
        afterClosingQuote = false;
        i += 1;
      } else if (c === "\n") {
        pushRecord();
        afterClosingQuote = false;
        i += 1;
      } else {
        throw new Error(
          `cannot parse task settlements CSV: unexpected character after a closing quote: ${JSON.stringify(c)}`,
        );
      }
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      i += 1;
    } else if (c === ",") {
      pushField();
      i += 1;
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRecord();
      i += 1;
    } else if (c === "\n") {
      pushRecord();
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (inQuotes) {
    throw new Error("cannot parse task settlements CSV: unterminated quoted field");
  }
  // A trailing newline already closed the last record; only push a final
  // record when the text ends mid-field or mid-record.
  if (afterClosingQuote || field !== "" || record.length > 0) {
    pushRecord();
  }
  return records;
}

/**
 * Canonical integer text: `0`, a positive integer with no leading
 * zeros, or a negative integer with no leading zeros. Anything else
 * — `5.0`, `1e3`, `007`, `-0`, `+5`, ` 5` — is rejected, so a
 * parsed summary re-renders byte-identically instead of silently
 * normalizing the spelling a caller wrote.
 */
const CSV_INTEGER = /^(0|-?[1-9]\d*)$/;

function parseCsvInteger(value: string, where: string): number {
  if (!CSV_INTEGER.test(value)) {
    throw new Error(
      `cannot parse task settlements CSV: ${where} must be a canonical integer, got ${JSON.stringify(value)}`,
    );
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `cannot parse task settlements CSV: ${where} must be a safe integer, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

/**
 * Parse a task settlements summary back from CSV — the inverse of
 * {@link renderTaskSettlementsCsv}, for the receiving end of the
 * bookkeeping hop: a caller that exported a summary with
 * `renderTaskSettlementsCsv` gets the summary back without
 * hand-writing a CSV parser for one row.
 *
 * The check is strict: the header must be exactly
 * `tasks,paid,quotedTotal,paidTotal,gap,mismatched,unquotedPaid,unquotedPaidTotal`;
 * there must be exactly one data row; every field must be a
 * canonical integer (see {@link CSV_INTEGER}); every field except
 * `gap` must be non-negative; and `gap` must equal
 * `quotedTotal - paidTotal`. Any violation throws
 * `cannot parse task settlements CSV: …` instead of returning a
 * plausible-looking half-summary. A UTF-8 byte-order mark is a
 * transport artifact, not a column, and is stripped; trailing
 * blank lines are line-ending noise, not extra rows.
 *
 * Honest limit, shared with `renderTaskSettlementsCsv`: this is
 * structural validation only. Importing a summary does not
 * re-verify the audit histories it claims to summarize — a
 * hand-built row with internally consistent fields parses, just
 * as it would render, and chain verification still belongs to
 * `verifyHistoryChain` over the tasks' own histories.
 *
 * Pure: the input string is only read, never mutated, and the
 * returned value is a fresh object (a second parse of the same
 * text yields an independent copy).
 */
export function parseTaskSettlementsCsv(text: string): TaskSettlementsSummary {
  if (typeof text !== "string") {
    throw new Error("cannot parse task settlements CSV: input must be a CSV string");
  }
  // A UTF-8 byte-order mark is a transport artifact, not a column.
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""));
  // Trailing blank lines are line-ending noise, not extra rows; a blank
  // record anywhere else changes the record count and fails below.
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === "") records.pop();
    else break;
  }
  const fail = (reason: string): never => {
    throw new Error(`cannot parse task settlements CSV: ${reason}`);
  };
  if (records.length !== 2) {
    fail(
      `expected 2 records (header + 1 data row), got ${records.length}`,
    );
  }
  const header = records[0];
  if (header.join(",") !== CSV_HEADER) {
    fail(`header must be exactly ${JSON.stringify(CSV_HEADER)}`);
  }
  const row = records[1];
  if (row.length !== SUMMARY_FIELDS.length) {
    fail(`data row must have ${SUMMARY_FIELDS.length} columns, got ${row.length}`);
  }
  const summary = {} as Record<string, number>;
  for (let i = 0; i < SUMMARY_FIELDS.length; i += 1) {
    const field = SUMMARY_FIELDS[i];
    summary[field] = parseCsvInteger(row[i], field);
  }
  const parsed = summary as unknown as TaskSettlementsSummary;
  assertSummaryShape(parsed, "cannot parse task settlements CSV");
  return parsed;
}

/**
 * Render a task settlements summary as JSON — the text form for the
 * API/storage hop: a caller that stored a summary with this
 * function gets a document whose fields are numbers, not strings,
 * so a consumer parsing it gets `650000`, not `"650000"`. The
 * fields are written in the canonical order, so rendering the same
 * summary twice is byte-identical.
 *
 * Before rendering, the summary is shape-checked with
 * {@link assertSummaryShape} (see there): a malformed object never
 * becomes a plausible-looking JSON document — `JSON.stringify`
 * turns `Infinity`/`NaN` into `null` without complaint, so a
 * non-finite figure would otherwise leave this function as a
 * plausible-looking `null` and corrupt a downstream import.
 *
 * Pure: the summary is only read, never mutated.
 */
export function renderTaskSettlementsJson(
  summary: TaskSettlementsSummary,
): string {
  assertSummaryShape(summary, "cannot render task settlements summary as JSON");
  // Rebuild in canonical field order: a caller-built object may list
  // the keys in any order, but the rendered document is always the
  // same bytes for the same summary.
  const ordered = {} as Record<string, number>;
  for (const field of SUMMARY_FIELDS) {
    ordered[field] = summary[field];
  }
  return JSON.stringify(ordered);
}

/**
 * Parse a task settlements summary back from JSON — the inverse of
 * {@link renderTaskSettlementsJson}, for the receiving end of the
 * API/storage hop: a caller that stored a summary with
 * `renderTaskSettlementsJson` gets a typed summary back without
 * hand-writing a parser for each field.
 *
 * The check is exactly the shape check `renderTaskSettlementsJson`
 * applies, in the other direction: unparseable text, a JSON value
 * that is not a summary object, a missing or unknown field, a
 * non-integer or unsafe-integer figure (including `null`, which is
 * what a non-finite figure becomes after a plain `JSON.stringify`,
 * and `1e999`, which `JSON.parse` reads as `Infinity`), a
 * negative count or total, or a `gap` that does not equal
 * `quotedTotal - paidTotal` all throw
 * `cannot parse task settlements JSON: …` instead of returning a
 * plausible-looking half-summary. A parsed summary re-renders
 * byte-identically through `renderTaskSettlementsJson`.
 *
 * Honest limit, shared with `renderTaskSettlementsJson`: this is
 * structural validation only. Importing a summary does not
 * re-verify the audit histories it claims to summarize.
 *
 * Pure: the input string is only read, never mutated, and the
 * returned value is a fresh object (a second parse of the same
 * text yields an independent copy).
 */
export function parseTaskSettlementsJson(text: string): TaskSettlementsSummary {
  if (typeof text !== "string") {
    throw new Error("cannot parse task settlements JSON: input must be a JSON string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `cannot parse task settlements JSON: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assertSummaryShape(parsed, "cannot parse task settlements JSON");
  return parsed as TaskSettlementsSummary;
}

/**
 * Render a task settlements summary as plain human-readable text — the
 * form for a log line or a terminal paste during reconciliation: a
 * caller that wants to eyeball a batch's quoted-vs-settled position
 * no longer has to hand-build the string or paste a JSON document
 * into a chat.
 *
 * The layout is the dataquest-side mirror of escrow's `renderReport`
 * (backlog #1096): a title line, a counts line, the three money
 * lines, the two exception rows, and a units line, in that fixed
 * order — so the same summary always renders the same bytes, and a
 * reader scanning two batches can compare line by line:
 *
 * ```text
 * Task settlements summary
 * Tasks: 6 (paid: 3)
 * Quoted total: 6500.00
 * Paid total: 16349.00
 * Gap: -9849.00 (overpaid)
 * Mismatched payouts: 1
 * Unquoted paid tasks: 1
 * Unquoted paid total: 10098.50
 * Amounts are integer minor units (cents).
 * ```
 *
 * Money figures go through {@link formatMinorUnits}, so `650000`
 * reads `6500.00` and `-984900` reads `-9849.00`; the gap carries its
 * meaning in parentheses — `(overpaid)` when the batch settled more
 * than it was quoted, `(underpaid)` when it settled less, `(balanced)`
 * when the two totals agree — because a bare negative gap is easy to
 * read backwards at 2 a.m. The counts and the exception rows are
 * always present, even when zero, so a zero batch reads as an
 * explicit all-zero position rather than a missing section.
 *
 * Before rendering, the summary is shape-checked with
 * {@link assertSummaryShape}: a non-object summary, a missing or
 * unknown field, a non-integer or unsafe-integer figure, a negative
 * count or total, or a `gap` that does not equal
 * `quotedTotal - paidTotal` throws
 * `cannot render task settlements summary: …` instead of emitting a
 * plausible-looking document.
 *
 * Honest limit, shared with the CSV/JSON renderers' import note but
 * stronger here: this is a display form, not an interchange form.
 * There is no parser back — the CSV and JSON renderers are the
 * round-trippable text forms — and reading figures off this text
 * does not re-verify the audit histories the summary claims to
 * summarize.
 *
 * Pure: the summary is only read, never mutated.
 */
export function renderTaskSettlements(
  summary: TaskSettlementsSummary,
): string {
  assertSummaryShape(summary, "cannot render task settlements summary");
  const gapNote =
    summary.gap < 0 ? "overpaid" : summary.gap > 0 ? "underpaid" : "balanced";
  return [
    "Task settlements summary",
    `Tasks: ${summary.tasks} (paid: ${summary.paid})`,
    `Quoted total: ${formatMinorUnits(summary.quotedTotal)}`,
    `Paid total: ${formatMinorUnits(summary.paidTotal)}`,
    `Gap: ${formatMinorUnits(summary.gap)} (${gapNote})`,
    `Mismatched payouts: ${summary.mismatched}`,
    `Unquoted paid tasks: ${summary.unquotedPaid}`,
    `Unquoted paid total: ${formatMinorUnits(summary.unquotedPaidTotal)}`,
    "Amounts are integer minor units (cents).",
  ].join("\n");
}

/**
 * Field-level difference between two task settlements summaries.
 * Only fields that moved are present: two identical summaries diff
 * to `{}`. Every comparison is an exact integer comparison — all
 * eight fields are integer minor units or counts (see
 * {@link TaskSettlementsSummary}), so there is no float tolerance
 * to disagree about, unlike escrow's `diffSettlementReports`, which
 * compares money at integer-cent precision because its figures are
 * raw floats. `gap` is its own entry, reported separately from
 * `quotedTotal` / `paidTotal`: a re-run that moves both totals by
 * the same amount leaves `gap` untouched and reports no
 * `gapChanged`, while a move in the gap alone — the summary's own
 * figures disagreeing with each other — is still visible.
 */
export interface TaskSettlementsSummaryDiff {
  tasksChanged?: { from: number; to: number };
  paidChanged?: { from: number; to: number };
  quotedTotalChanged?: { from: number; to: number };
  paidTotalChanged?: { from: number; to: number };
  gapChanged?: { from: number; to: number };
  mismatchedChanged?: { from: number; to: number };
  unquotedPaidChanged?: { from: number; to: number };
  unquotedPaidTotalChanged?: { from: number; to: number };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One field's move, or `undefined` when the field did not move. */
function fieldDiff(
  from: number,
  to: number,
): { from: number; to: number } | undefined {
  return from === to ? undefined : { from, to };
}

/**
 * Compare two task settlements summaries and report what changed
 * between them — the reconciliation question ("what moved since the
 * summary I stored last night?") without hand-written field compares
 * that disagree about the gap. This is the dataquest-side mirror of
 * escrow's `diffSettlementReports` (backlog #1092), with the same
 * diff shape — `{ <field>Changed: { from, to } }` per moved field,
 * `{}` when nothing moved — and the same contract: a comparison,
 * not a validation.
 *
 * Two deliberate differences from the escrow mirror, both forced by
 * what the summary carries:
 *  - There is no identity guard. A `SettlementReport` carries an
 *    `escrowId` the escrow diff refuses to cross; a
 *    `TaskSettlementsSummary` carries no batch id at all, so there
 *    is nothing to compare identity on. Diffing summaries of two
 *    different batches is the caller's responsibility — the diff
 *    answers "what moved", never "are these the same batch".
 *  - There is no float tolerance. Every field is already an integer
 *    (minor units or a count), so exact comparison is the rule and
 *    a sub-cent noise entry can never appear.
 *
 * Pure: reads both summaries, never mutates them, and the diff is a
 * fresh object (its entries hold numbers, so there is nothing to
 * detach). This is a comparison, not a validation — it does not
 * re-check that either summary's `gap` equals
 * `quotedTotal - paidTotal`, that its fields are safe integers, or
 * that its figures match any audit history; run an untrusted input
 * through the renderers/parsers when the input itself is untrusted.
 *
 *   const before = { tasks: 6, paid: 3, quotedTotal: 650000,
 *     paidTotal: 1634900, gap: -984900, mismatched: 1,
 *     unquotedPaid: 1, unquotedPaidTotal: 1009850 };
 *   const after = { ...before, paidTotal: 1635000, gap: -985000 };
 *   diffTaskSettlementsSummaries(before, after);
 *   // { paidTotalChanged: { from: 1634900, to: 1635000 },
 *   //   gapChanged: { from: -984900, to: -985000 } }
 *   // (The gap entry is the gap's own move: 650000 - 1635000 is
 *   // -985000, and no other field moved.)
 */
export function diffTaskSettlementsSummaries(
  a: TaskSettlementsSummary,
  b: TaskSettlementsSummary,
): TaskSettlementsSummaryDiff {
  if (!isRecord(a) || !isRecord(b)) {
    throw new Error(
      "invalid task settlements summary diff: both summaries must be objects",
    );
  }
  const diff: TaskSettlementsSummaryDiff = {};
  const tasks = fieldDiff(a.tasks, b.tasks);
  if (tasks !== undefined) diff.tasksChanged = tasks;
  const paid = fieldDiff(a.paid, b.paid);
  if (paid !== undefined) diff.paidChanged = paid;
  const quotedTotal = fieldDiff(a.quotedTotal, b.quotedTotal);
  if (quotedTotal !== undefined) diff.quotedTotalChanged = quotedTotal;
  const paidTotal = fieldDiff(a.paidTotal, b.paidTotal);
  if (paidTotal !== undefined) diff.paidTotalChanged = paidTotal;
  const gap = fieldDiff(a.gap, b.gap);
  if (gap !== undefined) diff.gapChanged = gap;
  const mismatched = fieldDiff(a.mismatched, b.mismatched);
  if (mismatched !== undefined) diff.mismatchedChanged = mismatched;
  const unquotedPaid = fieldDiff(a.unquotedPaid, b.unquotedPaid);
  if (unquotedPaid !== undefined) diff.unquotedPaidChanged = unquotedPaid;
  const unquotedPaidTotal = fieldDiff(
    a.unquotedPaidTotal,
    b.unquotedPaidTotal,
  );
  if (unquotedPaidTotal !== undefined) {
    diff.unquotedPaidTotalChanged = unquotedPaidTotal;
  }
  return diff;
}
