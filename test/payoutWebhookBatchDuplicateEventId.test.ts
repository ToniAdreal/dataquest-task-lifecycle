import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Batch payout webhook building rejects a duplicate eventId
 * (backlog #998): the dataquest-side peer of escrow's
 * buildSettlementWebhooks issuedEventIds guard. A factory bug
 * (counter reset, fixed value) must never ship two signed webhooks
 * under one eventId — a receiver deduplicating on eventId would drop
 * the second payout as an apparent duplicate while the sender
 * believes it delivered.
 *
 * Rules under test:
 *  - a repeated eventId fails only that entry as { taskId, error }
 *    (never signed), while the first entry builds normally
 *  - later entries are still attempted after a duplicate
 *  - a failed build never claims its eventId, so a later task may
 *    legitimately reuse that value
 *  - a normal (distinct-id) factory is unaffected
 *  - the duplicate error names the repeated id verbatim
 *  - non-string/empty factory values keep their single-build
 *    validation error and are never masked as duplicates
 *  - the single build is unaffected: calling it twice with the same
 *    eventId is legitimate
 */

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(t.state, "PAID");
  return t;
}

function toOpen(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(t.state, "OPEN");
  return t;
}

const NOW = new Date("2026-10-12T08:00:00.000Z");
const SECRET = "batch-secret";
const DUPLICATE_ERROR =
  'duplicate eventId "evt-fixed" in batch: eventIds must be unique within a batch';

test("a fixed-value factory signs only the first entry; the second is a per-entry duplicate error", () => {
  const results = buildPayoutWebhooks(
    [toPaid("task-1"), toPaid("task-2")],
    SECRET,
    { now: NOW, eventIdFactory: () => "evt-fixed" },
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].taskId, "task-1");
  assert.ok(results[0].webhook);
  assert.equal(results[0].webhook.payload.eventId, "evt-fixed");
  assert.equal(
    verifyPayoutWebhook(
      results[0].webhook.payload,
      results[0].webhook.signature,
      SECRET,
    ),
    true,
  );
  // The duplicate is never signed: no webhook, only the error.
  assert.equal(results[1].taskId, "task-2");
  assert.equal(results[1].webhook, undefined);
  assert.equal(results[1].error, DUPLICATE_ERROR);
});

test("later entries are still attempted after a duplicate", () => {
  let factoryCalls = 0;
  const results = buildPayoutWebhooks(
    [toPaid("task-a"), toPaid("task-b"), toPaid("task-c")],
    SECRET,
    {
      now: NOW,
      eventIdFactory: () => {
        factoryCalls += 1;
        return factoryCalls === 3 ? "evt-third" : "evt-fixed";
      },
    },
  );
  assert.equal(factoryCalls, 3);
  assert.equal(results.length, 3);
  assert.ok(results[0].webhook);
  assert.equal(results[1].error, DUPLICATE_ERROR);
  assert.ok(results[2].webhook);
  assert.equal(results[2].webhook.payload.eventId, "evt-third");
  assert.equal(
    verifyPayoutWebhook(
      results[2].webhook.payload,
      results[2].webhook.signature,
      SECRET,
    ),
    true,
  );
});

test("a failed build never claims its eventId, so a later task may reuse it", () => {
  const results = buildPayoutWebhooks(
    [toOpen("task-open"), toPaid("task-paid")],
    SECRET,
    { now: NOW, eventIdFactory: () => "evt-reused" },
  );
  assert.equal(results.length, 2);
  // The OPEN task fails on its own state, not on the eventId.
  assert.equal(results[0].taskId, "task-open");
  assert.equal(results[0].webhook, undefined);
  assert.match(
    results[0].error ?? "",
    /cannot build payout webhook: task task-open is in state OPEN/,
  );
  assert.doesNotMatch(results[0].error ?? "", /duplicate eventId/);
  // The id was never claimed, so the PAID task builds under it.
  assert.equal(results[1].taskId, "task-paid");
  assert.ok(results[1].webhook);
  assert.equal(results[1].webhook.payload.eventId, "evt-reused");
  assert.equal(
    verifyPayoutWebhook(
      results[1].webhook.payload,
      results[1].webhook.signature,
      SECRET,
    ),
    true,
  );
});

test("a normal factory with distinct ids is unaffected", () => {
  let factoryCalls = 0;
  const results = buildPayoutWebhooks(
    [toPaid("task-1"), toPaid("task-2"), toPaid("task-3")],
    SECRET,
    {
      now: NOW,
      eventIdFactory: () => {
        factoryCalls += 1;
        return `evt-${factoryCalls}`;
      },
    },
  );
  assert.equal(results.length, 3);
  const ids = new Set<string>();
  for (const r of results) {
    assert.ok(r.webhook);
    assert.equal(
      verifyPayoutWebhook(r.webhook.payload, r.webhook.signature, SECRET),
      true,
    );
    ids.add(r.webhook.payload.eventId);
  }
  assert.equal(ids.size, 3);
});

test("the duplicate error names the repeated id verbatim", () => {
  const results = buildPayoutWebhooks(
    [toPaid("task-1"), toPaid("task-2")],
    SECRET,
    { now: NOW, eventIdFactory: () => "evt-9f3a" },
  );
  assert.equal(
    results[1].error,
    'duplicate eventId "evt-9f3a" in batch: eventIds must be unique within a batch',
  );
});

test("an empty factory value keeps its validation error and is never a duplicate", () => {
  const results = buildPayoutWebhooks(
    [toPaid("task-1"), toPaid("task-2")],
    SECRET,
    { now: NOW, eventIdFactory: () => "" },
  );
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.webhook, undefined);
    assert.match(
      r.error ?? "",
      /cannot build payout webhook: 'eventId' must be a non-empty string/,
    );
    assert.doesNotMatch(r.error ?? "", /duplicate eventId/);
  }
});

test("a non-string factory value keeps its validation error and is never a duplicate", () => {
  const results = buildPayoutWebhooks(
    [toPaid("task-1"), toPaid("task-2")],
    SECRET,
    {
      now: NOW,
      eventIdFactory: () => 42 as unknown as string,
    },
  );
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.webhook, undefined);
    assert.match(
      r.error ?? "",
      /cannot build payout webhook: 'eventId' must be a non-empty string/,
    );
    assert.doesNotMatch(r.error ?? "", /duplicate eventId/);
  }
});

test("the single build is unaffected: calling it twice with one eventId is legitimate", () => {
  const task = toPaid("task-solo");
  const first = buildPayoutWebhook(task, SECRET, { now: NOW, eventId: "evt-1" });
  const second = buildPayoutWebhook(task, SECRET, { now: NOW, eventId: "evt-1" });
  assert.equal(first.payload.eventId, "evt-1");
  assert.equal(second.payload.eventId, "evt-1");
  assert.equal(verifyPayoutWebhook(first.payload, first.signature, SECRET), true);
  assert.equal(verifyPayoutWebhook(second.payload, second.signature, SECRET), true);
});
