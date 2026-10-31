import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
} from "../src/index.js";
import type { RolePolicy, TaskEvent } from "../src/index.js";

/**
 * NDJSON vs snapshot RBAC recovery asymmetry (backlog #764).
 *
 * The audit log is not a snapshot: `src/ndjson.ts` documents that it
 * carries no task id, no SLA deadlines, and no caller configuration —
 * retry budget and RBAC policy live in the snapshot envelope
 * (toJSON()/fromJSON()), not in the history. So:
 *
 * - a task restored from its JSON snapshot keeps its rolePolicy, and
 *   a non-listed actor is still refused the gated event;
 * - a task restored from NDJSON history alone via fromHistory()
 *   WITHOUT re-attaching a policy is unrestricted, even though the
 *   original task was gated — the log cannot restore what it never
 *   carried. Anyone treating NDJSON as a policy-restore channel would
 *   silently drop the gate, so this asymmetry is pinned explicitly;
 * - re-attaching the same policy via fromHistory(id, history,
 *   { rolePolicy }) gates again, proving the asymmetry is about the
 *   channel, not about fromHistory() being unable to carry a policy.
 */

const ARBITRATION_POLICY: RolePolicy = {
  ARBITRATE_APPROVE: ["senior-moderator"],
  ARBITRATE_REJECT: ["senior-moderator"],
};

const TO_DISPUTED: TaskEvent[] = [
  "PUBLISH",
  "ACCEPT",
  "START_CAPTURE",
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
  "DISPUTE",
];

/** Drive a fresh policy-gated task to DISPUTED without naming actors. */
function disputedTask(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id, { rolePolicy: ARBITRATION_POLICY });
  for (const event of TO_DISPUTED) task.dispatch(event);
  assert.equal(task.state, "DISPUTED");
  return task;
}

describe("NDJSON x snapshot RBAC recovery asymmetry", () => {
  it("JSON snapshot round-trip preserves the policy", () => {
    const task = disputedTask("ndjson-rbac-snap");
    const snapshot = task.toJSON();
    assert.deepEqual(snapshot.rolePolicy, ARBITRATION_POLICY);

    const restored = TaskLifecycle.fromJSON(
      JSON.parse(JSON.stringify(snapshot)),
    );
    assert.equal(restored.state, "DISPUTED");
    assert.deepEqual(restored.toJSON(), snapshot);

    assert.throws(
      () => restored.dispatch("ARBITRATE_APPROVE", { actor: "contributor" }),
      /actor not authorized for ARBITRATE_APPROVE: "contributor" is not in \[senior-moderator\]/,
    );
    assert.equal(restored.state, "DISPUTED");
    assert.equal(restored.history.length, task.history.length);
    assert.equal(
      restored.dispatch("ARBITRATE_APPROVE", { actor: "senior-moderator" }),
      "APPROVED",
    );
  });

  it("NDJSON history alone restores state and history but NOT the policy", () => {
    const task = disputedTask("ndjson-rbac-log");
    const text = historyToNdjson(task);
    // The gate itself never enters the log: no policy field, no
    // moderator name anywhere in the NDJSON text.
    assert.ok(!text.includes("rolePolicy"));
    assert.ok(!text.includes("senior-moderator"));

    const restored = TaskLifecycle.fromHistory(
      "ndjson-rbac-log-restored",
      historyFromNdjson(text),
    );
    assert.equal(restored.state, "DISPUTED");
    assert.deepEqual(restored.history, task.history);

    // Unrestricted by design: the contributor the original task would
    // have refused now arbitrates successfully, with no actor needed
    // at all. This is the asymmetry, pinned, not a bug to fix by
    // smuggling policy into the audit log.
    assert.equal(restored.dispatch("ARBITRATE_APPROVE"), "APPROVED");
    assert.equal(restored.history.length, task.history.length + 1);
    assert.equal(
      restored.history[restored.history.length - 1].seq,
      task.history.length + 1,
    );
  });

  it("NDJSON history with an explicitly re-attached policy gates again", () => {
    const task = disputedTask("ndjson-rbac-reattach");
    const text = historyToNdjson(task);

    const restored = TaskLifecycle.fromHistory(
      "ndjson-rbac-reattach-restored",
      historyFromNdjson(text),
      { rolePolicy: ARBITRATION_POLICY },
    );
    assert.equal(restored.state, "DISPUTED");

    assert.throws(
      () => restored.dispatch("ARBITRATE_REJECT", { actor: "contributor" }),
      /actor not authorized for ARBITRATE_REJECT/,
    );
    assert.equal(restored.state, "DISPUTED");
    assert.equal(
      restored.dispatch("ARBITRATE_REJECT", { actor: "senior-moderator" }),
      "REJECTED",
    );
  });

  it("the original task is still gated before any export", () => {
    const task = disputedTask("ndjson-rbac-original");
    assert.throws(
      () => task.dispatch("ARBITRATE_APPROVE", { actor: "contributor" }),
      /actor not authorized for ARBITRATE_APPROVE/,
    );
    assert.equal(task.state, "DISPUTED");
  });
});
