import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Batch payout webhook building rejects a repeated taskId
 * (backlog #997): the dataquest-side peer of escrow's
 * buildSettlementReports duplicate-escrowId guard (#993).
 *
 * Rules under test:
 *  - a repeated taskId throws for the whole batch, names the
 *    duplicate id, and no webhook is built at all
 *  - the guard runs before any per-task attempt, so a duplicate
 *    pair of non-PAID tasks still throws instead of recording
 *    per-task errors
 *  - the single build is unaffected: calling it twice for the same
 *    task is legitimate
 *  - entries with no string id keep their per-task failure — the
 *    guard only scans real taskIds
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

test("a repeated taskId throws for the whole batch and names the id", () => {
  let factoryCalls = 0;
  assert.throws(
    () =>
      buildPayoutWebhooks(
        [toPaid("task-dup"), toPaid("task-other"), toPaid("task-dup")],
        SECRET,
        {
          now: NOW,
          eventIdFactory: () => {
            factoryCalls += 1;
            return `evt-${factoryCalls}`;
          },
        },
      ),
    /buildPayoutWebhooks: duplicate taskId "task-dup" in batch: taskIds must be unique within a batch/,
  );
  // Fail-closed before building: the factory was never called, so no
  // webhook — signed or otherwise — was produced for any entry.
  assert.equal(factoryCalls, 0);
});

test("a duplicate pair of non-PAID tasks still throws instead of per-task errors", () => {
  assert.throws(
    () => buildPayoutWebhooks([toOpen("task-open"), toOpen("task-open")], SECRET, { now: NOW }),
    /duplicate taskId "task-open" in batch/,
  );
});

test("every distinct duplicated id is named, each once", () => {
  assert.throws(
    () =>
      buildPayoutWebhooks(
        [toPaid("task-a"), toPaid("task-b"), toPaid("task-a"), toPaid("task-b")],
        SECRET,
        { now: NOW },
      ),
    /duplicate taskId "task-a", "task-b" in batch/,
  );
});

test("three occurrences of one id are named once", () => {
  assert.throws(
    () =>
      buildPayoutWebhooks(
        [toPaid("task-triple"), toPaid("task-triple"), toPaid("task-triple")],
        SECRET,
        { now: NOW },
      ),
    /duplicate taskId "task-triple" in batch/,
  );
  assert.throws(
    () =>
      buildPayoutWebhooks(
        [toPaid("task-triple"), toPaid("task-triple"), toPaid("task-triple")],
        SECRET,
        { now: NOW },
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err.message.match(/"task-triple"/g) ?? []).length, 1);
      return true;
    },
  );
});

test("distinct taskIds still build normally", () => {
  const results = buildPayoutWebhooks([toPaid("task-1"), toPaid("task-2")], SECRET, {
    now: NOW,
  });
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.ok(r.webhook);
    assert.equal(
      verifyPayoutWebhook(r.webhook.payload, r.webhook.signature, SECRET),
      true,
    );
  }
  assert.notEqual(
    results[0].webhook?.payload.eventId,
    results[1].webhook?.payload.eventId,
  );
});

test("the single build is unaffected: calling it twice for one task is legitimate", () => {
  const task = toPaid("task-solo");
  const first = buildPayoutWebhook(task, SECRET, { now: NOW, eventId: "evt-1" });
  const second = buildPayoutWebhook(task, SECRET, { now: NOW, eventId: "evt-2" });
  assert.equal(first.payload.taskId, "task-solo");
  assert.equal(second.payload.taskId, "task-solo");
  assert.equal(verifyPayoutWebhook(first.payload, first.signature, SECRET), true);
  assert.equal(verifyPayoutWebhook(second.payload, second.signature, SECRET), true);
});

test("entries with no string id keep their per-task failure, not a duplicate throw", () => {
  const malformed = [{}, {}] as unknown as TaskLifecycle[];
  const results = buildPayoutWebhooks(malformed, SECRET, { now: NOW });
  assert.equal(results.length, 2);
  assert.equal(results[0].taskId, "unknown");
  assert.equal(results[0].webhook, undefined);
  assert.ok(results[0].error);
  assert.equal(results[1].taskId, "unknown");
  assert.equal(results[1].webhook, undefined);
  assert.ok(results[1].error);
});

test("the duplicate guard does not change call-level config errors", () => {
  // An empty secret still throws its own configuration error even
  // when the batch also repeats a taskId.
  assert.throws(
    () => buildPayoutWebhooks([toPaid("task-x"), toPaid("task-x")], ""),
    /signing secret must not be empty/,
  );
});
