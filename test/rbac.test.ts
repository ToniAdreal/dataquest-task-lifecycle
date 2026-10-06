import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/taskLifecycle.js";
import type { RolePolicy, TaskEvent } from "../src/taskLifecycle.js";

/**
 * Event-level RBAC (TaskLifecycleOptions.rolePolicy).
 *
 * A policy maps events to the actor names allowed to dispatch them.
 * Events the policy does not cover are unrestricted; a task built
 * without a policy behaves exactly as before (no actor needed anywhere).
 * Violations throw `actor not authorized for …` and leave no trace in
 * the append-only history.
 */

const TO_DISPUTED: TaskEvent[] = [
  "PUBLISH",
  "ACCEPT",
  "START_CAPTURE",
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
  "DISPUTE",
];

/** Drive a fresh task to DISPUTED (first time). */
function toDisputed(task: TaskLifecycle): void {
  for (const event of TO_DISPUTED) task.dispatch(event);
}

describe("RBAC: moderator-only arbitration", () => {
  const arbitrationPolicy: RolePolicy = {
    ARBITRATE_APPROVE: ["senior-moderator"],
    ARBITRATE_REJECT: ["senior-moderator"],
  };

  it("lets the senior moderator arbitrate", () => {
    const task = new TaskLifecycle("t-arb-ok", { rolePolicy: arbitrationPolicy });
    toDisputed(task);
    assert.equal(
      task.dispatch("ARBITRATE_APPROVE", { actor: "senior-moderator" }),
      "APPROVED",
    );
  });

  it("rejects a contributor arbitrating", () => {
    const task = new TaskLifecycle("t-arb-no", { rolePolicy: arbitrationPolicy });
    toDisputed(task);
    assert.throws(
      () => task.dispatch("ARBITRATE_APPROVE", { actor: "contributor" }),
      /actor not authorized for ARBITRATE_APPROVE: "contributor" is not in \[senior-moderator\]/,
    );
    assert.equal(task.state, "DISPUTED");
  });

  it("rejects arbitration with no actor at all", () => {
    const task = new TaskLifecycle("t-arb-anon", { rolePolicy: arbitrationPolicy });
    toDisputed(task);
    assert.throws(
      () => task.dispatch("ARBITRATE_REJECT"),
      /actor not authorized for ARBITRATE_REJECT: policy requires an actor in \[senior-moderator\]/,
    );
  });

  it("matches actor names exactly (case-sensitive)", () => {
    const task = new TaskLifecycle("t-arb-case", { rolePolicy: arbitrationPolicy });
    toDisputed(task);
    assert.throws(
      () => task.dispatch("ARBITRATE_APPROVE", { actor: "Senior-Moderator" }),
      /actor not authorized for ARBITRATE_APPROVE/,
    );
  });

  it("a failed dispatch leaves no history trace", () => {
    const task = new TaskLifecycle("t-arb-trace", { rolePolicy: arbitrationPolicy });
    toDisputed(task);
    const before = task.history.length;
    assert.throws(() =>
      task.dispatch("ARBITRATE_APPROVE", { actor: "contributor" }),
    );
    assert.equal(task.history.length, before);
    assert.equal(task.state, "DISPUTED");
    // The task is still usable: the moderator can arbitrate afterwards.
    task.dispatch("ARBITRATE_REJECT", { actor: "senior-moderator" });
    assert.equal(task.state, "REJECTED");
    assert.equal(task.history[task.history.length - 1].seq, before + 1);
  });
});

describe("RBAC: partial policies only gate the listed events", () => {
  it("rejects contributor PUBLISH when the policy lists PUBLISH", () => {
    const task = new TaskLifecycle("t-pub", {
      rolePolicy: { PUBLISH: ["researcher", "admin"] },
    });
    assert.throws(
      () => task.dispatch("PUBLISH", { actor: "contributor" }),
      /actor not authorized for PUBLISH: "contributor" is not in \[researcher, admin\]/,
    );
    assert.equal(task.dispatch("PUBLISH", { actor: "researcher" }), "OPEN");
  });

  it("leaves unlisted events unrestricted (no actor needed)", () => {
    const task = new TaskLifecycle("t-partial", {
      rolePolicy: { ARBITRATE_APPROVE: ["senior-moderator"] },
    });
    // PUBLISH is not in the policy: dispatch without any actor works.
    assert.equal(task.dispatch("PUBLISH"), "OPEN");
    assert.equal(task.dispatch("ACCEPT"), "ACCEPTED");
  });

  it("a task without a policy needs no actor anywhere", () => {
    const task = new TaskLifecycle("t-nopolicy");
    toDisputed(task);
    assert.equal(task.dispatch("ARBITRATE_APPROVE"), "APPROVED");
  });
});

describe("RBAC: invalid policies are rejected fail-fast", () => {
  const bad: Array<[string, RolePolicy]> = [
    ["unknown event", { FLY: ["pilot"] } as unknown as RolePolicy],
    ["empty role list", { PUBLISH: [] }],
    ["non-string role", { PUBLISH: [42] } as unknown as RolePolicy],
    ["empty-string role", { PUBLISH: [""] }],
  ];
  for (const [name, policy] of bad) {
    it(`constructor rejects ${name}`, () => {
      assert.throws(
        () => new TaskLifecycle("t-bad", { rolePolicy: policy }),
        /invalid option: rolePolicy/,
      );
    });
  }

  it("constructor rejects a non-object policy", () => {
    assert.throws(
      () => new TaskLifecycle("t-bad", { rolePolicy: "senior-moderator" as unknown as RolePolicy }),
      /invalid option: rolePolicy must be an object/,
    );
  });

  it("duplicate roles are deduped, not rejected", () => {
    const task = new TaskLifecycle("t-dedupe", {
      rolePolicy: { PUBLISH: ["researcher", "researcher"] },
    });
    assert.equal(task.dispatch("PUBLISH", { actor: "researcher" }), "OPEN");
  });
});

describe("RBAC: persistence round-trips", () => {
  const policy: RolePolicy = { ARBITRATE_APPROVE: ["senior-moderator"] };

  it("toJSON/fromJSON preserves policy enforcement", () => {
    const task = new TaskLifecycle("t-rt", { rolePolicy: policy });
    toDisputed(task);
    const json = JSON.parse(JSON.stringify(task.toJSON()));
    assert.deepEqual(json.rolePolicy, policy);
    const restored = TaskLifecycle.fromJSON(json);
    assert.throws(
      () => restored.dispatch("ARBITRATE_APPROVE", { actor: "contributor" }),
      /actor not authorized for ARBITRATE_APPROVE/,
    );
    assert.equal(
      restored.dispatch("ARBITRATE_APPROVE", { actor: "senior-moderator" }),
      "APPROVED",
    );
  });

  it("a snapshot without rolePolicy rehydrates unrestricted", () => {
    const task = new TaskLifecycle("t-rt-free");
    toDisputed(task);
    const restored = TaskLifecycle.fromJSON(
      JSON.parse(JSON.stringify(task.toJSON())),
    );
    assert.equal(restored.dispatch("ARBITRATE_APPROVE"), "APPROVED");
  });

  it("fromJSON rejects a tampered policy in a stored snapshot", () => {
    const task = new TaskLifecycle("t-rt-tamper", { rolePolicy: policy });
    const json = JSON.parse(JSON.stringify(task.toJSON()));
    json.rolePolicy = { ARBITRATE_APPROVE: [] }; // tampered: empty allowlist
    assert.throws(
      () => TaskLifecycle.fromJSON(json),
      /invalid snapshot: rolePolicy\[ARBITRATE_APPROVE\] must be a non-empty array/,
    );
  });

  it("fromHistory re-attaches a policy via opts", () => {
    const task = new TaskLifecycle("t-fh");
    toDisputed(task);
    const log = JSON.parse(JSON.stringify(task.history));
    const withPolicy = TaskLifecycle.fromHistory("t-fh", log, {
      rolePolicy: { ARBITRATE_APPROVE: ["senior-moderator"] },
    });
    assert.throws(
      () => withPolicy.dispatch("ARBITRATE_APPROVE", { actor: "contributor" }),
      /actor not authorized for ARBITRATE_APPROVE/,
    );
    const withoutPolicy = TaskLifecycle.fromHistory("t-fh", log);
    assert.equal(withoutPolicy.dispatch("ARBITRATE_APPROVE"), "APPROVED");
  });
});
