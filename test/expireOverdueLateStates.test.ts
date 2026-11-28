/**
 * Overdue late-state expiry (backlog #1428).
 *
 * Decision recorded here and in the backlog entry: option (a) — the
 * transition table gains `EXPIRE: "EXPIRED"` edges on IN_REVIEW,
 * APPROVED and PAYOUT_PENDING. The watchdog used to screen those
 * tasks as overdue (`expiredTasks` listed them) and then fail every
 * one of them per batch (`invalid transition: EXPIRE from
 * IN_REVIEW`), so a stuck review, an approved-but-never-paid task
 * and an unfinished payout sat overdue forever with no executor
 * able to move them. There is no product rule here like escrow's
 * DISPUTED arbitration (which deliberately keeps no EXPIRE edge, see
 * backlog #1434): an SLA deadline passing on a late state means the
 * task timed out, so the watchdog may expire it. REJECTED and
 * DISPUTED keep no EXPIRE edge and stay the unexpirable cases.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  allowedEvents,
  expiredTasks,
  expireOverdueTasks,
  transition,
  verifyHistoryChain,
} from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
const PUBLISH_AT = "2026-01-01T00:00:00.000Z";
const ACCEPT_AT = "2026-02-01T00:00:00.000Z";
const CAPTURE_AT = "2026-02-15T00:00:00.000Z";
const SUBMIT_AT = "2026-03-01T00:00:00.000Z";
const REVIEW_AT = "2026-03-15T00:00:00.000Z";
const APPROVE_AT = "2026-03-20T00:00:00.000Z";
const PAYOUT_AT = "2026-03-25T00:00:00.000Z";

function openTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster", at: PUBLISH_AT });
  return t;
}

function inReviewTask(id: string): TaskLifecycle {
  const t = openTask(id);
  t.dispatch("ACCEPT", { actor: "contributor", at: ACCEPT_AT });
  t.dispatch("START_CAPTURE", { actor: "contributor", at: CAPTURE_AT });
  t.dispatch("SUBMIT", { actor: "contributor", at: SUBMIT_AT });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: REVIEW_AT });
  return t;
}

function approvedTask(id: string): TaskLifecycle {
  const t = inReviewTask(id);
  t.dispatch("APPROVE", { actor: "reviewer", at: APPROVE_AT });
  return t;
}

function payoutPendingTask(id: string): TaskLifecycle {
  const t = approvedTask(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor", at: PAYOUT_AT });
  return t;
}

function rejectedTask(id: string): TaskLifecycle {
  const t = inReviewTask(id);
  t.dispatch("REJECT", { actor: "reviewer", at: APPROVE_AT });
  return t;
}

function disputedTask(id: string): TaskLifecycle {
  const t = rejectedTask(id);
  t.dispatch("DISPUTE", { actor: "contributor", at: PAYOUT_AT });
  return t;
}

function overdue(task: TaskLifecycle): TaskLifecycle {
  task.setSlaDeadline(PAST);
  return task;
}

describe("expireOverdueTasks late states (#1428)", () => {
  it("expires an overdue IN_REVIEW task with a system-signed audit entry", () => {
    const t = overdue(inReviewTask("late-review"));
    const [result] = expireOverdueTasks([t], NOW);

    assert.equal(result.expired, true);
    assert.equal(result.error, undefined);
    assert.equal(t.state, "EXPIRED");
    assert.equal(result.entry?.event, "EXPIRE");
    assert.equal(result.entry?.from, "IN_REVIEW");
    assert.equal(result.entry?.to, "EXPIRED");
    assert.equal(result.entry?.actor, "system");
    assert.equal(result.entry?.at, NOW.toISOString());
    assert.equal(verifyHistoryChain(t.history), true);
  });

  it("expires an overdue APPROVED task", () => {
    const t = overdue(approvedTask("late-approved"));
    const [result] = expireOverdueTasks([t], NOW);

    assert.equal(result.expired, true);
    assert.equal(t.state, "EXPIRED");
    assert.equal(result.entry?.from, "APPROVED");
    assert.equal(result.entry?.to, "EXPIRED");
    assert.equal(verifyHistoryChain(t.history), true);
  });

  it("expires an overdue PAYOUT_PENDING task", () => {
    const t = overdue(payoutPendingTask("late-payout"));
    const [result] = expireOverdueTasks([t], NOW);

    assert.equal(result.expired, true);
    assert.equal(t.state, "EXPIRED");
    assert.equal(result.entry?.from, "PAYOUT_PENDING");
    assert.equal(result.entry?.to, "EXPIRED");
    assert.equal(verifyHistoryChain(t.history), true);
  });

  it("transition() and allowedEvents() carry the new EXPIRE edges", () => {
    assert.equal(transition("IN_REVIEW", "EXPIRE"), "EXPIRED");
    assert.equal(transition("APPROVED", "EXPIRE"), "EXPIRED");
    assert.equal(transition("PAYOUT_PENDING", "EXPIRE"), "EXPIRED");
    assert.ok(allowedEvents("IN_REVIEW").includes("EXPIRE"));
    assert.ok(allowedEvents("APPROVED").includes("EXPIRE"));
    assert.ok(allowedEvents("PAYOUT_PENDING").includes("EXPIRE"));
    // the old edges still win their own events
    assert.equal(transition("IN_REVIEW", "APPROVE"), "APPROVED");
    assert.equal(transition("APPROVED", "REQUEST_PAYOUT"), "PAYOUT_PENDING");
    assert.equal(transition("PAYOUT_PENDING", "PAYOUT_COMPLETE"), "PAID");
  });

  it("screening and execution agree: every screened task is expirable except REJECTED / DISPUTED", () => {
    const batch = [
      overdue(openTask("c-open")),
      overdue(inReviewTask("c-review")),
      overdue(approvedTask("c-approved")),
      overdue(payoutPendingTask("c-payout")),
      overdue(rejectedTask("c-rejected")),
      overdue(disputedTask("c-disputed")),
    ];
    // the pure filter still lists every overdue non-terminal task
    assert.deepEqual(
      expiredTasks(batch, NOW).map((t) => t.id),
      [
        "c-open",
        "c-review",
        "c-approved",
        "c-payout",
        "c-rejected",
        "c-disputed",
      ],
    );
    const results = expireOverdueTasks(batch, NOW);
    assert.deepEqual(
      results.map((r) => r.expired),
      [true, true, true, true, false, false],
    );
    // REJECTED / DISPUTED have no EXPIRE edge: classified
    // unexpirable, not failed (backlog #1440).
    assert.equal(results[4].unexpirable, true);
    assert.equal("error" in results[4], false);
    assert.equal(results[5].unexpirable, true);
    assert.equal("error" in results[5], false);
    assert.equal(results[4].task.state, "REJECTED");
    assert.equal(results[5].task.state, "DISPUTED");
  });

  it("IN_REVIEW -> EXPIRED history replays: stateAt and fromHistory agree", () => {
    const t = overdue(inReviewTask("late-replay"));
    const [result] = expireOverdueTasks([t], NOW);
    assert.equal(result.expired, true);

    // stateAt is inclusive on the entry timestamp
    assert.equal(t.stateAt("2026-05-31T23:59:59.999Z"), "IN_REVIEW");
    assert.equal(t.stateAt(NOW.toISOString()), "EXPIRED");
    assert.equal(t.stateAt(new Date("2026-07-01T00:00:00.000Z")), "EXPIRED");

    // event-sourced rebuild lands on the same state and history
    const rebuilt = TaskLifecycle.fromHistory(
      t.id,
      JSON.parse(JSON.stringify(t.history)),
    );
    assert.equal(rebuilt.state, "EXPIRED");
    assert.deepEqual(rebuilt.history, t.history);
    assert.equal(verifyHistoryChain(rebuilt.history), true);
  });

  it("dry run predicts the live run for all three late states", () => {
    const build = () => [
      overdue(inReviewTask("dry-review")),
      overdue(approvedTask("dry-approved")),
      overdue(payoutPendingTask("dry-payout")),
    ];
    const dry = expireOverdueTasks(build(), NOW, undefined, {
      dryRun: true,
    });
    assert.deepEqual(
      dry.map((r) => r.wouldExpire),
      [true, true, true],
    );
    assert.ok(dry.every((r) => r.expired === false));
    assert.ok(dry.every((r) => !("entry" in r)));

    const live = expireOverdueTasks(build(), NOW);
    assert.deepEqual(
      live.map((r) => r.expired),
      [true, true, true],
    );
    assert.deepEqual(
      live.map((r) => r.task.state),
      ["EXPIRED", "EXPIRED", "EXPIRED"],
    );
  });

  it("the previously expirable states are unchanged", () => {
    const open = overdue(openTask("old-open"));
    const accepted = openTask("old-accepted");
    accepted.dispatch("ACCEPT", { actor: "contributor", at: ACCEPT_AT });
    overdue(accepted);
    const capturing = openTask("old-capturing");
    capturing.dispatch("ACCEPT", { actor: "contributor", at: ACCEPT_AT });
    capturing.dispatch("START_CAPTURE", {
      actor: "contributor",
      at: CAPTURE_AT,
    });
    overdue(capturing);
    const submitted = openTask("old-submitted");
    submitted.dispatch("ACCEPT", { actor: "contributor", at: ACCEPT_AT });
    submitted.dispatch("START_CAPTURE", {
      actor: "contributor",
      at: CAPTURE_AT,
    });
    submitted.dispatch("SUBMIT", { actor: "contributor", at: SUBMIT_AT });
    overdue(submitted);

    const results = expireOverdueTasks(
      [open, accepted, capturing, submitted],
      NOW,
    );
    assert.deepEqual(
      results.map((r) => r.expired),
      [true, true, true, true],
    );
    assert.ok(results.every((r) => r.task.state === "EXPIRED"));
  });
});
