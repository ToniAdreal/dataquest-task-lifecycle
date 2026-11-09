import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/taskLifecycle.js";

/**
 * Unknown constructor option fields fail closed (backlog #1006).
 *
 * The constructor scans `TaskLifecycleOptions` against the
 * `TASK_OPTION_FIELDS` whitelist before any field is consumed, so a
 * typo'd key (e.g. `maxResubmit` for `maxResubmits`) throws
 * `invalid task options: unknown option "<name>"` instead of silently
 * running with the default. Mirrors the escrow state machine's guard
 * (backlog #548, `ESCROW_OPTION_FIELDS`).
 */

const TO_REJECTED: Array<
  "PUBLISH" | "ACCEPT" | "START_CAPTURE" | "SUBMIT" | "BEGIN_REVIEW" | "REJECT"
> = ["PUBLISH", "ACCEPT", "START_CAPTURE", "SUBMIT", "BEGIN_REVIEW", "REJECT"];

/** Drive a fresh task to REJECTED. */
function toRejected(task: TaskLifecycle, actor?: string): void {
  for (const event of TO_REJECTED) {
    task.dispatch(event, actor === undefined ? undefined : { actor });
  }
}

/** One RESUBMIT round: from REJECTED back to REJECTED. */
function resubmitRound(task: TaskLifecycle, actor?: string): void {
  const opts = actor === undefined ? undefined : { actor };
  task.dispatch("RESUBMIT", opts); // REJECTED -> CAPTURING
  task.dispatch("SUBMIT", opts);
  task.dispatch("BEGIN_REVIEW", opts);
  task.dispatch("REJECT", opts);
}

function throwsUnknownOption(opts: object, name: string): void {
  assert.throws(
    () => new TaskLifecycle("t-unknown-opt", opts as never),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `invalid task options: unknown option "${name}"`,
    `${name} must throw the explicit unknown-option error`,
  );
}

describe("TaskLifecycleOptions unknown fields fail closed", () => {
  it("all nine legal fields together construct, and the budget really applies", () => {
    const task = new TaskLifecycle("t-opts-all", {
      maxResubmits: 1,
      maxDisputes: 1,
      maxVisitsByState: { OPEN: 3 },
      rolePolicy: { EXPIRE: ["system"] },
      requirePayoutRef: true,
      requireActor: true,
      idempotencyKeys: ["k1"],
      auditSecret: "s3cr3t-not-a-real-secret",
      slaDeadlines: { OPEN: "2099-01-01T00:00:00.000Z" },
    });
    assert.equal(task.state, "DRAFT");
    assert.equal(task.getSlaDeadline("OPEN"), "2099-01-01T00:00:00.000Z");
    // The budget is not just accepted — it bites: one RESUBMIT allowed,
    // the second throws.
    toRejected(task, "researcher");
    resubmitRound(task, "researcher"); // used 1 of 1, back at REJECTED
    assert.throws(
      () => task.dispatch("RESUBMIT", { actor: "researcher" }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith("resubmit budget exhausted: 1 of 1"),
    );
  });

  it("maxResubmit (missing s) throws and names the field", () => {
    throwsUnknownOption({ maxResubmit: 3 }, "maxResubmit");
  });

  it("maxdispute (wrong case) throws and names the field", () => {
    throwsUnknownOption({ maxdispute: 1 }, "maxdispute");
  });

  it("MaxDisputes (capital M) throws and names the field", () => {
    throwsUnknownOption({ MaxDisputes: 1 }, "MaxDisputes");
  });

  it("debug (invented field) throws and names the field", () => {
    throwsUnknownOption({ debug: true }, "debug");
  });

  it("auditsecret (wrong case) throws and names the field", () => {
    throwsUnknownOption({ auditsecret: "x" }, "auditsecret");
  });

  it("legal + unknown mixed throws and produces no instance", () => {
    assert.throws(
      () => new TaskLifecycle("t-opts-mixed", { maxResubmits: 2, debug: true } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'invalid task options: unknown option "debug"',
    );
    // A legal sibling field does not rescue the unknown one, and the
    // throw happens before any field is consumed: a second attempt with
    // the typo fixed constructs normally with the budget intact.
    const fixed = new TaskLifecycle("t-opts-mixed", { maxResubmits: 0 });
    toRejected(fixed);
    assert.throws(() => fixed.dispatch("RESUBMIT"));
  });

  it("empty object and omitted opts both construct (no false positives)", () => {
    const a = new TaskLifecycle("t-opts-empty", {});
    const b = new TaskLifecycle("t-opts-none");
    assert.equal(a.state, "DRAFT");
    assert.equal(b.state, "DRAFT");
    // Explicitly passing undefined for a legal field is still legal.
    const c = new TaskLifecycle("t-opts-undef", { maxResubmits: undefined });
    assert.equal(c.state, "DRAFT");
  });

  it("fromHistory rejects an unknown key (same constructor path)", () => {
    const donor = new TaskLifecycle("t-opts-donor");
    toRejected(donor);
    assert.throws(
      () =>
        TaskLifecycle.fromHistory("t-opts-fh", donor.history, {
          maxResubmit: 3,
        } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'invalid task options: unknown option "maxResubmit"',
    );
  });

  it("fromHistory with legal opts works and the budget really applies", () => {
    const donor = new TaskLifecycle("t-opts-fh-legal", { maxResubmits: 1 });
    toRejected(donor);
    resubmitRound(donor); // one RESUBMIT already used in the log
    const revived = TaskLifecycle.fromHistory("t-opts-fh-legal", donor.history, {
      maxResubmits: 1,
    });
    assert.equal(revived.state, "REJECTED");
    assert.throws(
      () => revived.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith("resubmit budget exhausted: 1 of 1"),
    );
  });
});
