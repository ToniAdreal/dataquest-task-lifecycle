import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
  replay,
  totalPaidOut,
} from "../src/index.js";

/**
 * NDJSON history export x payout fields (backlog #674).
 *
 * NDJSON round-trips (`test/ndjson.test.ts`) and payout fields
 * (`test/payoutAmount.test.ts`, `test/requirePayoutRef.test.ts`) each
 * have coverage, but their combination did not: a history carrying
 * `payoutAmount`/`payoutRef` on its PAYOUT_COMPLETE entry, exported
 * to NDJSON and replayed via `fromHistory`, must keep the payout
 * fields verbatim and the terminal state intact — and a damaged
 * payout line must fail with the NDJSON line-number error
 * (`invalid ndjson: line N: …`), not silently drop the money.
 *
 * Rules under test:
 *  - PAID task -> NDJSON -> fromHistory: history deep-equal, state
 *    PAID, last entry's payoutRef/payoutAmount verbatim
 *  - the payout fields ride on the PAYOUT_COMPLETE NDJSON line
 *    itself (not on earlier lines, not in a side channel)
 *  - totalPaidOut agrees before and after the round-trip
 *  - zero amount, amount-without-ref, and ref-without-amount all
 *    round-trip (each is legal on its own; see payoutAmount tests)
 *  - a PAYOUT_PENDING history re-attached with requirePayoutRef
 *    keeps enforcement after the NDJSON hop, and the eventual
 *    PAYOUT_COMPLETE entry's payout fields survive a second export
 *  - damaged payout lines fail closed with a line number:
 *    negative / non-number payoutAmount, empty payoutRef
 *  - a payoutAmount rewritten to another *valid* number is caught
 *    by the hash chain instead (explicit error, no line number:
 *    the chain error carries no entry index, so retagging cannot
 *    apply — asserted as-is, not papered over)
 */

/** Drive a task from DRAFT to PAYOUT_PENDING. */
function toPayoutPending(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH", { actor: "researcher" });
  task.dispatch("ACCEPT", { actor: "contributor" });
  task.dispatch("START_CAPTURE", { actor: "contributor" });
  task.dispatch("SUBMIT", { actor: "contributor" });
  task.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  task.dispatch("APPROVE", { actor: "reviewer" });
  task.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  return task;
}

/** Drive a task all the way to PAID with the given payout fields. */
function toPaid(
  id: string,
  payout: { payoutRef?: string; payoutAmount?: number },
): TaskLifecycle {
  const task = toPayoutPending(id);
  task.dispatch("PAYOUT_COMPLETE", { actor: "system", ...payout });
  assert.equal(task.state, "PAID");
  return task;
}

/** Replace the PAYOUT_COMPLETE (last) NDJSON line with a mutated copy. */
function withMutatedLastLine(
  text: string,
  mutate: (entry: Record<string, unknown>) => void,
): string {
  const lines = text.trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  mutate(last);
  lines[lines.length - 1] = JSON.stringify(last);
  return lines.join("\n") + "\n";
}

describe("NDJSON x payout fields", () => {
  it("PAID task round-trips with payout fields and state intact", () => {
    const task = toPaid("ndjson-payout-1", {
      payoutRef: "xfer-ndjson-1",
      payoutAmount: 10098.5,
    });
    const text = historyToNdjson(task);
    const entries = historyFromNdjson(text);
    assert.deepEqual(entries, [...task.history]);
    assert.equal(replay(entries), "PAID");
    const rebuilt = TaskLifecycle.fromHistory("ndjson-payout-1b", entries);
    assert.equal(rebuilt.state, "PAID");
    assert.deepEqual([...rebuilt.history], [...task.history]);
    const last = rebuilt.history[rebuilt.history.length - 1];
    assert.equal(last.event, "PAYOUT_COMPLETE");
    assert.equal(last.payoutRef, "xfer-ndjson-1");
    assert.equal(last.payoutAmount, 10098.5);
  });

  it("payout fields ride on the PAYOUT_COMPLETE NDJSON line only", () => {
    const task = toPaid("ndjson-payout-2", {
      payoutRef: "xfer-ndjson-2",
      payoutAmount: 531.5,
    });
    const lines = historyToNdjson(task).trim().split("\n");
    assert.equal(lines.length, task.history.length);
    for (const line of lines.slice(0, -1)) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      assert.equal("payoutRef" in entry, false);
      assert.equal("payoutAmount" in entry, false);
    }
    const last = JSON.parse(lines[lines.length - 1]) as Record<
      string,
      unknown
    >;
    assert.equal(last.payoutRef, "xfer-ndjson-2");
    assert.equal(last.payoutAmount, 531.5);
  });

  it("totalPaidOut agrees before and after the NDJSON round-trip", () => {
    const task = toPaid("ndjson-payout-3", {
      payoutRef: "xfer-ndjson-3",
      payoutAmount: 10098.5,
    });
    assert.equal(totalPaidOut([task]), 10098.5);
    const rebuilt = TaskLifecycle.fromHistory(
      "ndjson-payout-3b",
      historyFromNdjson(historyToNdjson(task)),
    );
    assert.equal(totalPaidOut([rebuilt]), 10098.5);
    assert.equal(totalPaidOut([task, rebuilt]), 20197);
  });

  it("zero payout amount round-trips", () => {
    const task = toPaid("ndjson-payout-4", {
      payoutRef: "xfer-ndjson-4",
      payoutAmount: 0,
    });
    const rebuilt = TaskLifecycle.fromHistory(
      "ndjson-payout-4b",
      historyFromNdjson(historyToNdjson(task)),
    );
    assert.deepEqual([...rebuilt.history], [...task.history]);
    assert.equal(
      rebuilt.history[rebuilt.history.length - 1].payoutAmount,
      0,
    );
    assert.equal(totalPaidOut([rebuilt]), 0);
  });

  it("amount without a ref round-trips (advisory default)", () => {
    const task = toPaid("ndjson-payout-5", { payoutAmount: 2500 });
    const rebuilt = TaskLifecycle.fromHistory(
      "ndjson-payout-5b",
      historyFromNdjson(historyToNdjson(task)),
    );
    const last = rebuilt.history[rebuilt.history.length - 1];
    assert.equal(last.payoutAmount, 2500);
    assert.equal(last.payoutRef, undefined);
    assert.equal(rebuilt.state, "PAID");
  });

  it("ref without an amount round-trips", () => {
    const task = toPaid("ndjson-payout-6", { payoutRef: "xfer-ndjson-6" });
    const rebuilt = TaskLifecycle.fromHistory(
      "ndjson-payout-6b",
      historyFromNdjson(historyToNdjson(task)),
    );
    const last = rebuilt.history[rebuilt.history.length - 1];
    assert.equal(last.payoutRef, "xfer-ndjson-6");
    assert.equal(last.payoutAmount, undefined);
    assert.equal(rebuilt.state, "PAID");
  });

  it("requirePayoutRef enforcement survives the NDJSON hop", () => {
    const pending = toPayoutPending("ndjson-payout-7");
    const rebuilt = TaskLifecycle.fromHistory(
      "ndjson-payout-7b",
      historyFromNdjson(historyToNdjson(pending)),
      { requirePayoutRef: true },
    );
    assert.equal(rebuilt.state, "PAYOUT_PENDING");
    assert.throws(
      () => rebuilt.dispatch("PAYOUT_COMPLETE", { actor: "system" }),
      /payout reference required/,
    );
    rebuilt.dispatch("PAYOUT_COMPLETE", {
      actor: "system",
      payoutRef: "xfer-ndjson-7",
      payoutAmount: 3750.5,
    });
    assert.equal(rebuilt.state, "PAID");
    // The eventual completion entry survives a second NDJSON export.
    const again = TaskLifecycle.fromHistory(
      "ndjson-payout-7c",
      historyFromNdjson(historyToNdjson(rebuilt)),
    );
    const last = again.history[again.history.length - 1];
    assert.equal(last.payoutRef, "xfer-ndjson-7");
    assert.equal(last.payoutAmount, 3750.5);
    assert.equal(again.state, "PAID");
  });

  it("negative payoutAmount on the last line fails with its line number", () => {
    const task = toPaid("ndjson-payout-8", {
      payoutRef: "xfer-ndjson-8",
      payoutAmount: 100,
    });
    const bad = withMutatedLastLine(historyToNdjson(task), (entry) => {
      entry.payoutAmount = -5;
    });
    assert.throws(
      () => historyFromNdjson(bad),
      /invalid ndjson: line 8: payoutAmount must be a non-negative finite number, got -5/,
    );
  });

  it("empty payoutRef on the last line fails with its line number", () => {
    const task = toPaid("ndjson-payout-9", {
      payoutRef: "xfer-ndjson-9",
      payoutAmount: 100,
    });
    const bad = withMutatedLastLine(historyToNdjson(task), (entry) => {
      entry.payoutRef = "";
    });
    assert.throws(
      () => historyFromNdjson(bad),
      /invalid ndjson: line 8: payoutRef must be a non-empty string, got ""/,
    );
  });

  it("non-number payoutAmount on the last line fails with its line number", () => {
    const task = toPaid("ndjson-payout-10", {
      payoutRef: "xfer-ndjson-10",
      payoutAmount: 100,
    });
    const bad = withMutatedLastLine(historyToNdjson(task), (entry) => {
      entry.payoutAmount = "100";
    });
    assert.throws(
      () => historyFromNdjson(bad),
      /invalid ndjson: line 8: payoutAmount must be a non-negative finite number, got 100/,
    );
  });

  it("blank lines shift the reported payout line number to the physical line", () => {
    const task = toPaid("ndjson-payout-11", {
      payoutRef: "xfer-ndjson-11",
      payoutAmount: 100,
    });
    const bad = withMutatedLastLine(historyToNdjson(task), (entry) => {
      entry.payoutAmount = -5;
    });
    // Leading blank + blank between every line: the 8th entry sits
    // on physical line 16 (2, 4, …, 16).
    const shifted = "\n" + bad.trim().split("\n").join("\n\n") + "\n";
    assert.throws(
      () => historyFromNdjson(shifted),
      /invalid ndjson: line 16: payoutAmount must be a non-negative finite number, got -5/,
    );
  });

  it("payoutAmount rewritten to another valid number is caught by the hash chain", () => {
    const task = toPaid("ndjson-payout-12", {
      payoutRef: "xfer-ndjson-12",
      payoutAmount: 10098.5,
    });
    const tampered = withMutatedLastLine(
      historyToNdjson(task),
      (entry) => {
        entry.payoutAmount = 9999;
      },
    );
    // Field validation passes (9999 is a legal amount), so the
    // keyed/unkeyed hash chain is what catches it. The chain error
    // carries no entry index, so it is not retagged with a line
    // number — asserted exactly as the library reports it.
    assert.throws(
      () => historyFromNdjson(tampered),
      /history hash chain is broken/,
    );
  });
});
