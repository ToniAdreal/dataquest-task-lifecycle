import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
  type PayoutWebhookPayload,
  type TaskHistoryEntry,
} from "../src/index.js";

/**
 * Payout webhook field-set audit (backlog #211): is the payload
 * self-contained, and how does it compare to escrow's?
 *
 * Audit conclusion (field level, against the #202 baseline that added
 * `quotedAmount`): every identifier/settlement field deterministically
 * derivable from the same audit history is ALREADY carried —
 * `taskId` (the task's own id, escrow's `escrowId` counterpart),
 * `payoutRef`/`payoutAmount` (from the PAYOUT_COMPLETE entry), and
 * `quotedAmount` (from the last ACCEPT entry). The remaining history
 * fields are deliberately NOT carried: `actor` is a caller-asserted
 * role label ("contributor" / "reviewer" / "system"), not a unique
 * payee identity; `note` is free-text annotation, not settlement
 * data; `seq`/`from`/`to`/`prevHash`/`hash` are audit-chain
 * internals. Escrow's `deposit`/`parties` ledger has no dataquest
 * counterpart to derive from — the history records no per-party
 * inflow/outflow — so none is invented here.
 *
 * Per the backlog's fallback branch ("if the audit finds the field
 * set complete, pin it instead of inventing a field"), this file
 * pins the exact field set and canonical key order as a snapshot:
 *  - maximal and minimal payloads have exact, byte-level shapes
 *  - every field is signature-covered (tampering any one fails)
 *  - the field SET is signed too (stripping or adding a key fails)
 *  - absent source entries omit whole keys and still verify
 *  - raw-body and parsed-object verification agree
 */

interface PaidOpts {
  quoted?: number;
  payoutRef?: string;
  payoutAmount?: number;
}

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(id: string, opts: PaidOpts = {}): TaskLifecycle {
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
    ...(opts.payoutRef !== undefined ? { payoutRef: opts.payoutRef } : {}),
    ...(opts.payoutAmount !== undefined
      ? { payoutAmount: opts.payoutAmount }
      : {}),
  });
  assert.equal(t.state, "PAID");
  return t;
}

const FIXED = {
  eventId: "evt-fieldset-1",
  now: new Date("2026-10-12T10:58:00.000Z"),
};

test("maximal payload: exact field set, canonical order, and signed bytes (snapshot)", () => {
  const task = toPaid("task-fieldset", {
    quoted: 120,
    payoutRef: "xfer-fs1",
    payoutAmount: 100,
  });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  assert.deepEqual(Object.keys(payload), [
    "event",
    "taskId",
    "payoutRef",
    "payoutAmount",
    "quotedAmount",
    "at",
    "eventId",
  ]);
  assert.deepEqual(payload, {
    event: "PAYOUT_COMPLETE",
    taskId: "task-fieldset",
    payoutRef: "xfer-fs1",
    payoutAmount: 100,
    quotedAmount: 120,
    at: "2026-10-12T10:58:00.000Z",
    eventId: "evt-fieldset-1",
  });
  // The canonical serialization IS the signed byte string: pin it
  // byte-for-byte so any future field addition/removal/reorder is a
  // deliberate, test-visible change.
  assert.equal(
    JSON.stringify(payload),
    '{"event":"PAYOUT_COMPLETE","taskId":"task-fieldset","payoutRef":"xfer-fs1","payoutAmount":100,"quotedAmount":120,"at":"2026-10-12T10:58:00.000Z","eventId":"evt-fieldset-1"}',
  );
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
});

test("minimal payload: exact field set when no history field is recorded", () => {
  const task = toPaid("task-fieldset-bare");
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  assert.deepEqual(Object.keys(payload), ["event", "taskId", "at", "eventId"]);
  assert.equal(
    JSON.stringify(payload),
    '{"event":"PAYOUT_COMPLETE","taskId":"task-fieldset-bare","at":"2026-10-12T10:58:00.000Z","eventId":"evt-fieldset-1"}',
  );
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
});

test("partial payloads: each optional field alone lands in its canonical slot", () => {
  const refOnly = buildPayoutWebhook(
    toPaid("task-fs-ref", { payoutRef: "xfer-only" }),
    "s3cr3t",
    FIXED,
  ).payload;
  assert.deepEqual(Object.keys(refOnly), [
    "event",
    "taskId",
    "payoutRef",
    "at",
    "eventId",
  ]);
  const amountOnly = buildPayoutWebhook(
    toPaid("task-fs-amount", { payoutAmount: 7 }),
    "s3cr3t",
    FIXED,
  ).payload;
  assert.deepEqual(Object.keys(amountOnly), [
    "event",
    "taskId",
    "payoutAmount",
    "at",
    "eventId",
  ]);
  const quoteOnly = buildPayoutWebhook(
    toPaid("task-fs-quote", { quoted: 9 }),
    "s3cr3t",
    FIXED,
  ).payload;
  assert.deepEqual(Object.keys(quoteOnly), [
    "event",
    "taskId",
    "quotedAmount",
    "at",
    "eventId",
  ]);
});

test("every field is signature-covered: tampering any single field fails verification", () => {
  const task = toPaid("task-fieldset-tamper", {
    quoted: 120,
    payoutRef: "xfer-fs1",
    payoutAmount: 100,
  });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  const raw = JSON.stringify(payload);
  const tampers: Array<[string, Record<string, unknown>]> = [
    ["event", { event: "PAYOUT_REFUNDED" }],
    ["taskId", { taskId: "task-other" }],
    ["payoutRef", { payoutRef: "xfer-evil" }],
    ["payoutAmount", { payoutAmount: 101 }],
    ["quotedAmount", { quotedAmount: 119 }],
    ["at", { at: "2026-10-12T10:59:00.000Z" }],
    ["eventId", { eventId: "evt-other" }],
  ];
  for (const [field, patch] of tampers) {
    const mutated = { ...JSON.parse(raw), ...patch } as PayoutWebhookPayload;
    assert.equal(
      verifyPayoutWebhook(mutated, signature, "s3cr3t"),
      false,
      `tampered ${field} (object body)`,
    );
    assert.equal(
      verifyPayoutWebhook(JSON.stringify(mutated), signature, "s3cr3t"),
      false,
      `tampered ${field} (raw body)`,
    );
  }
});

test("the field set itself is signed: stripping or adding a key fails verification", () => {
  const task = toPaid("task-fieldset-set", {
    quoted: 120,
    payoutRef: "xfer-fs1",
    payoutAmount: 100,
  });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  const raw = JSON.stringify(payload);
  // Strip a signed field (object path: an undefined value drops the
  // key on re-stringification, changing the signed bytes).
  assert.equal(
    verifyPayoutWebhook(
      { ...payload, payoutRef: undefined },
      signature,
      "s3cr3t",
    ),
    false,
    "payoutRef stripped (object body)",
  );
  assert.equal(
    verifyPayoutWebhook(
      raw.replace('"quotedAmount":120,', ""),
      signature,
      "s3cr3t",
    ),
    false,
    "quotedAmount stripped (raw body)",
  );
  // Add an unsigned field: the payload carries no smuggled extras.
  assert.equal(
    verifyPayoutWebhook(
      { ...payload, extra: "x" } as PayoutWebhookPayload,
      signature,
      "s3cr3t",
    ),
    false,
    "extra field added (object body)",
  );
  assert.equal(
    verifyPayoutWebhook(
      raw.replace('{"event"', '{"extra":"x","event"'),
      signature,
      "s3cr3t",
    ),
    false,
    "extra field added (raw body)",
  );
});

test("omission rule: a quote-only history omits the settled keys and still verifies", () => {
  // Stub history (the #202 pattern): an ACCEPT quote with a
  // PAYOUT_COMPLETE entry carrying neither ref nor amount. Only the
  // derivable field is carried; the others omit as whole keys.
  const entry = (
    seq: number,
    event: TaskHistoryEntry["event"],
    extra: Partial<TaskHistoryEntry> = {},
  ): TaskHistoryEntry => ({
    seq,
    event,
    from: "OPEN",
    to: "PAID",
    at: "2026-10-12T00:00:00.000Z",
    ...extra,
  });
  const stub = {
    id: "task-fieldset-stub",
    state: "PAID",
    history: [
      entry(1, "ACCEPT", { quotedAmount: 55 }),
      entry(2, "PAYOUT_COMPLETE", {}),
    ],
  } as unknown as TaskLifecycle;
  const { payload, signature } = buildPayoutWebhook(stub, "s3cr3t", FIXED);
  assert.deepEqual(Object.keys(payload), [
    "event",
    "taskId",
    "quotedAmount",
    "at",
    "eventId",
  ]);
  assert.ok(!("payoutRef" in payload) && !("payoutAmount" in payload));
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
  assert.equal(verifyPayoutWebhook(payload, signature, "s3cr3t"), true);
});

test("raw-body and object verification agree on maximal and minimal payloads", () => {
  for (const task of [
    toPaid("task-fs-dual-full", {
      quoted: 120,
      payoutRef: "xfer-fs1",
      payoutAmount: 100,
    }),
    toPaid("task-fs-dual-bare"),
  ]) {
    const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", FIXED);
    assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
    assert.equal(verifyPayoutWebhook(payload, signature, "s3cr3t"), true);
    const forged = { ...payload, taskId: "task-forged" };
    assert.equal(verifyPayoutWebhook(JSON.stringify(forged), signature, "s3cr3t"), false);
    assert.equal(verifyPayoutWebhook(forged, signature, "s3cr3t"), false);
  }
});

test("no escrow-only or history-internal fields leak into the payload", () => {
  const task = toPaid("task-fieldset-leak", {
    quoted: 120,
    payoutRef: "xfer-fs1",
    payoutAmount: 100,
  });
  const { payload } = buildPayoutWebhook(task, "s3cr3t", FIXED);
  // Escrow's payload shape belongs to escrow's ledger model; the
  // audit found no dataquest source data for any of these.
  for (const key of ["escrowId", "outcome", "releasePath", "deposit", "parties"]) {
    assert.ok(!(key in payload), `escrow-only field ${key} must not appear`);
  }
  // History internals stay in the audit log: `actor` is a role label,
  // not a payee identity, and the hash chain is sender-side evidence.
  for (const key of ["actor", "note", "seq", "from", "to", "prevHash", "hash"]) {
    assert.ok(!(key in payload), `history-internal field ${key} must not appear`);
  }
});
