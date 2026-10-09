import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
  mismatchedPayouts,
  payoutMismatch,
  verifyHistoryChain,
} from "../src/index.js";

/**
 * `quotedAmount` + `payoutMismatch()` / `mismatchedPayouts()` (backlog #133):
 * the owed half of settlement reconciliation.
 *
 * `payoutAmount` (#105) records what actually settled; `totalPaidOut`
 * honestly sums "only what was recorded, not what was owed". Until now
 * "what was owed" had no field at all, so quoted-vs-settled comparison —
 * the core reconciliation action — was impossible. Rules under test:
 *  - dispatch-time validation mirrors payoutAmount: non-finite /
 *    negative / non-number values throw `invalid dispatch options: …`
 *    before anything mutates
 *  - a valid quote is recorded verbatim on the ACCEPT entry, survives
 *    toJSON()/fromJSON() and NDJSON round-trips, and commits into the
 *    hash chain (canonical key order appended after payoutAmount, so
 *    legacy entries without it keep their exact canonical bytes)
 *  - parseHistory (via fromJSON) rejects malformed quotedAmount values
 *  - payoutMismatch(task): last ACCEPT quote vs PAYOUT_COMPLETE amount;
 *    undefined when non-PAID, either amount missing, or quoted === paid
 *  - mismatchedPayouts(tasks): pure batch screening, mirroring
 *    unreconciledPayouts()
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

test("quoted amount lands verbatim on the ACCEPT entry", () => {
  const t = toOpen("quoted-lands");
  t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 10098.5 });
  const entry = t.history[t.history.length - 1];
  assert.equal(entry.event, "ACCEPT");
  assert.equal(entry.quotedAmount, 10098.5);
  // Entries that never carried a quote do not gain the field.
  assert.equal("quotedAmount" in t.history[0], false);
});

test("illegal quotedAmount values throw up front and leave no trace", () => {
  const illegal: unknown[] = [
    -0.01,
    -100,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "10630.50",
    null,
    {},
  ];
  for (const amount of illegal) {
    const t = toOpen(`bad-quote-${String(amount)}`);
    const before = t.history.length;
    assert.throws(
      () =>
        t.dispatch("ACCEPT", {
          actor: "contributor",
          quotedAmount: amount as number,
        }),
      /invalid dispatch options: quotedAmount must be a non-negative finite number/,
      `expected ${String(amount)} to be rejected`,
    );
    assert.equal(t.history.length, before);
    assert.equal(t.state, "OPEN");
    // A corrected retry with the same event still works.
    t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 10 });
    assert.equal(t.state, "ACCEPTED");
  }
});

test("zero is a legal quote (pro-bono task)", () => {
  const t = toOpen("free-quote");
  t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 0 });
  assert.equal(t.history[t.history.length - 1].quotedAmount, 0);
});

test("quote survives toJSON()/fromJSON() round-trips", () => {
  const t = toPaid("round-trip", { quoted: 120, paid: 100 });
  const revived = TaskLifecycle.fromJSON(t.toJSON());
  assert.deepEqual(revived.toJSON().history, t.toJSON().history);
  const accept = revived.history.find((e) => e.event === "ACCEPT");
  assert.equal(accept?.quotedAmount, 120);
  assert.deepEqual(payoutMismatch(revived), {
    quoted: 120,
    paid: 100,
    delta: -20,
  });
});

test("quote survives NDJSON round-trips", () => {
  const t = toPaid("ndjson", { quoted: 55.25, paid: 55.25 });
  const text = historyToNdjson(t);
  const entries = historyFromNdjson(text);
  assert.deepEqual(entries, [...t.history]);
  const accept = entries.find((e) => e.event === "ACCEPT");
  assert.equal(accept?.quotedAmount, 55.25);
  const revived = TaskLifecycle.fromHistory("ndjson", entries);
  assert.equal(revived.state, "PAID");
});

test("fromJSON rejects malformed quotedAmount in untrusted logs", () => {
  const t = toPaid("untrusted", { quoted: 10, paid: 10 });
  for (const bad of [-5, Number.NaN, "10", null]) {
    const snapshot = t.toJSON();
    const accept = snapshot.history.find((e) => e.event === "ACCEPT")!;
    accept.quotedAmount = bad as unknown as number;
    assert.throws(
      () => TaskLifecycle.fromJSON(snapshot),
      /quotedAmount must be a non-negative finite number/,
      `expected ${String(bad)} to be rejected`,
    );
  }
});

test("tampering with a recorded quote breaks the hash chain", () => {
  const t = toPaid("tamper", { quoted: 100, paid: 100 });
  assert.equal(verifyHistoryChain([...t.history]), true);
  const tampered = t.toJSON();
  const accept = tampered.history.find((e) => e.event === "ACCEPT")!;
  accept.quotedAmount = 1; // rewrite history: "we only ever owed 1"
  assert.equal(verifyHistoryChain(tampered.history), false);
  assert.throws(
    () => TaskLifecycle.fromJSON(tampered),
    /history hash chain is broken/,
  );
});

test("legacy histories without quotedAmount keep working unchanged", () => {
  const t = toPaid("legacy", { paid: 42 });
  // No entry carries the field, the chain still verifies, and the
  // snapshot round-trips byte-identically.
  assert.equal(
    t.history.every((e) => !("quotedAmount" in e)),
    true,
  );
  assert.equal(verifyHistoryChain([...t.history]), true);
  const revived = TaskLifecycle.fromJSON(t.toJSON());
  assert.deepEqual(revived.toJSON(), t.toJSON());
});

test("payoutMismatch: underpayment returns a negative delta", () => {
  const t = toPaid("underpaid", { quoted: 100, paid: 90 });
  assert.deepEqual(payoutMismatch(t), { quoted: 100, paid: 90, delta: -10 });
});

test("payoutMismatch: overpayment returns a positive delta", () => {
  const t = toPaid("overpaid", { quoted: 100, paid: 110.5 });
  assert.deepEqual(payoutMismatch(t), {
    quoted: 100,
    paid: 110.5,
    delta: 10.5,
  });
});

test("payoutMismatch: settled exactly as quoted returns undefined", () => {
  const t = toPaid("exact", { quoted: 10098.5, paid: 10098.5 });
  assert.equal(payoutMismatch(t), undefined);
});

test("payoutMismatch: missing quote or missing settled amount returns undefined", () => {
  const noQuote = toPaid("no-quote", { paid: 90 });
  assert.equal(payoutMismatch(noQuote), undefined);
  const noPaid = toPaid("no-paid", { quoted: 100 });
  assert.equal(payoutMismatch(noPaid), undefined);
  const neither = toPaid("neither", {});
  assert.equal(payoutMismatch(neither), undefined);
});

test("payoutMismatch: non-PAID tasks return undefined", () => {
  const inFlight = toOpen("in-flight");
  inFlight.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 100 });
  assert.equal(payoutMismatch(inFlight), undefined);
  const abandoned = toOpen("abandoned-quote");
  abandoned.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 100 });
  abandoned.dispatch("ABANDON", { actor: "contributor" });
  assert.equal(payoutMismatch(abandoned), undefined);
});

test("mismatchedPayouts screens a mixed batch and is pure", () => {
  const under = toPaid("batch-under", { quoted: 100, paid: 80 });
  const over = toPaid("batch-over", { quoted: 50, paid: 60 });
  const exact = toPaid("batch-exact", { quoted: 70, paid: 70 });
  const noQuote = toPaid("batch-no-quote", { paid: 10 });
  const inFlight = toOpen("batch-flight");
  inFlight.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 5 });
  const tasks = [under, over, exact, noQuote, inFlight];

  const before = tasks.map((t) => JSON.stringify(t.toJSON()));
  const out = mismatchedPayouts(tasks);
  assert.deepEqual(
    out.map((t) => t.id),
    ["batch-under", "batch-over"],
  );
  assert.notEqual(out, tasks);
  // Pure: no task state or history changed.
  assert.deepEqual(
    tasks.map((t) => JSON.stringify(t.toJSON())),
    before,
  );
  assert.deepEqual(mismatchedPayouts([]), []);
});
