import {
  AuditChainOptions,
  TaskHistoryEntry,
  TaskLifecycle,
  parseHistory,
} from "./taskLifecycle.js";

/**
 * NDJSON audit-log export / import.
 *
 * The append-only audit history is plain JSON, so it also travels well as
 * NDJSON (one canonical JSON object per line) — the format log shippers,
 * event streams, and batch forwarders already speak. Each line is a single
 * {@link TaskHistoryEntry}; the file ends with a trailing newline.
 *
 * Export (`historyToNdjson`) runs the entries through the same strict
 * `parseHistory` validation the audit tests enforce, so a malformed
 * history fails loudly instead of producing an NDJSON file that could
 * never be re-imported. Import (`historyFromNdjson`) tolerates blank
 * lines (leading, interleaved, trailing — including a trailing newline)
 * and attributes every failure to its 1-based line number:
 * `invalid ndjson: line 7: …`.
 *
 * Note: the audit log carries no task id, no SLA deadlines, and no
 * caller configuration (retry budget, RBAC policy) — those live in the
 * snapshot envelope (see toJSON()/fromJSON()), not in the history. An
 * NDJSON round-trip restores the full entry sequence; replay() or
 * fromHistory() derives the state from it.
 *
 * Keyed histories (produced by a task constructed with
 * `auditSecret`) travel as-is — every line carries its `prevHash`/`hash`
 * HMAC links — but the validation on both export and import is keyed
 * too: pass the same secret as `opts.auditSecret`, or the chain check
 * fails closed with a broken-chain error. The secret itself is never
 * written into the NDJSON text.
 */

/**
 * Export an audit history as NDJSON: one canonical JSON entry per line,
 * terminated by a trailing newline. Accepts either a live TaskLifecycle
 * (exports its current history) or a raw entries array (validated
 * exactly like parseHistory before serializing).
 *
 * An empty history exports to the empty string.
 */
export function historyToNdjson(
  source: TaskLifecycle | readonly TaskHistoryEntry[],
  opts?: AuditChainOptions,
): string {
  const raw: unknown = source instanceof TaskLifecycle
    ? [...source.history]
    : source;
  const entries = parseHistory(raw, opts);
  if (entries.length === 0) return "";
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/**
 * Parse NDJSON text into a validated audit history. Blank lines are
 * skipped; anything else that is not valid JSON, or that fails the
 * parseHistory integrity checks, throws an error naming its 1-based
 * line number (`invalid ndjson: line 7: …`).
 *
 * The returned entries are fresh, sanitized copies — safe to hand to
 * replay() or TaskLifecycle.fromHistory(id, …).
 */
export function historyFromNdjson(
  text: string,
  opts?: AuditChainOptions,
): TaskHistoryEntry[] {
  if (typeof text !== "string") {
    throw new Error("invalid ndjson: input must be a string");
  }
  const values: unknown[] = [];
  const lineOf: number[] = []; // lineOf[entryIndex] = 1-based line number
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").trim();
    if (line === "") continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid ndjson: line ${i + 1}: not valid JSON`);
    }
    lineOf.push(i + 1);
  }
  try {
    return parseHistory(values, opts);
  } catch (err) {
    throw retagLine(err, lineOf);
  }
}

/**
 * Rewrite a parseHistory `entry[N]` error to point at the NDJSON source
 * line that carried the offending entry (blank lines make the two
 * numbering schemes diverge). Errors that do not reference an entry —
 * e.g. "history must be an array", which cannot occur here anyway —
 * pass through unchanged.
 */
function retagLine(err: unknown, lineOf: number[]): Error {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^invalid history: entry\[(\d+)\]: ([\s\S]*)$/.exec(message);
  if (match !== null) {
    const entryIndex = Number(match[1]);
    const line = lineOf[entryIndex];
    if (line !== undefined) {
      return new Error(`invalid ndjson: line ${line}: ${match[2]}`);
    }
  }
  return err instanceof Error ? err : new Error(message);
}
