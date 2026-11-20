import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, diffTaskSnapshots } from "../src/index.js";
import type { TaskSnapshot } from "../src/index.js";

/** Deep clone a snapshot through JSON (snapshots are plain JSON). */
function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TaskSnapshot;
}

/** A valid PAID snapshot to mutate into malformed inputs. */
function validSnapshot(): TaskSnapshot {
  const t = new TaskLifecycle("t-shape");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 100 });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  return t.toJSON();
}

/** Mutate one field of a cloned snapshot, as an untyped caller would. */
function mutated(
  snapshot: TaskSnapshot,
  mutate: (draft: Record<string, unknown>) => void,
): TaskSnapshot {
  const draft = cloneSnapshot(snapshot) as unknown as Record<string, unknown>;
  mutate(draft);
  return draft as unknown as TaskSnapshot;
}

test("diffTaskSnapshots shape: an unknown state throws a shape error, not a phantom transition", () => {
  const good = validSnapshot();
  const bad = mutated(good, (d) => {
    d.state = "BOGUS";
  });
  assert.throws(
    () => diffTaskSnapshots(bad, good),
    /invalid snapshot diff: unknown state BOGUS/,
  );
  assert.throws(
    () => diffTaskSnapshots(good, bad),
    /invalid snapshot diff: unknown state BOGUS/,
  );
});

test("diffTaskSnapshots shape: an unknown SLA state key throws a shape error", () => {
  const good = validSnapshot();
  const bad = mutated(good, (d) => {
    d.slaDeadlines = { BOGUS: "2026-12-01T00:00:00.000Z" };
  });
  assert.throws(
    () => diffTaskSnapshots(bad, good),
    /invalid snapshot diff: unknown SLA state BOGUS/,
  );
});

test("diffTaskSnapshots shape: a string idempotencyKeys throws instead of diffing as a character set", () => {
  const good = validSnapshot();
  // The old code spread a string into [...new Set(keys)], so "abc"
  // compared equal to ["a", "b", "c"] — a phantom no-change.
  const stringKeys = mutated(good, (d) => {
    d.idempotencyKeys = "abc";
  });
  assert.throws(
    () => diffTaskSnapshots(stringKeys, good),
    /invalid snapshot diff: idempotencyKeys must be an array/,
  );
  const arrayKeys = mutated(good, (d) => {
    d.idempotencyKeys = ["a", "b", "c"];
  });
  assert.throws(
    () => diffTaskSnapshots(stringKeys, arrayKeys),
    /invalid snapshot diff: idempotencyKeys must be an array/,
  );
});

test("diffTaskSnapshots shape: a numeric idempotencyKeys throws a shape error, never a bare TypeError", () => {
  const good = validSnapshot();
  const bad = mutated(good, (d) => {
    d.idempotencyKeys = 123;
  });
  assert.throws(
    () => diffTaskSnapshots(bad, good),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.match(error.message, /^invalid snapshot diff: /);
      return true;
    },
  );
});

test("diffTaskSnapshots shape: a missing id throws a shape error", () => {
  const good = validSnapshot();
  const bad = mutated(good, (d) => {
    delete d.id;
  });
  assert.throws(
    () => diffTaskSnapshots(bad, good),
    /invalid snapshot diff: id must be a non-empty string/,
  );
});

test("diffTaskSnapshots shape: a missing state throws a shape error", () => {
  const good = validSnapshot();
  const bad = mutated(good, (d) => {
    delete d.state;
  });
  assert.throws(
    () => diffTaskSnapshots(bad, good),
    /invalid snapshot diff: unknown state undefined/,
  );
});

test("diffTaskSnapshots shape: a missing history throws a shape error", () => {
  const good = validSnapshot();
  const bad = mutated(good, (d) => {
    delete d.history;
  });
  assert.throws(
    () => diffTaskSnapshots(bad, good),
    /invalid snapshot diff: history must be an array/,
  );
});

test("diffTaskSnapshots shape: an unknown top-level field throws a shape error", () => {
  const good = validSnapshot();
  const bad = mutated(good, (d) => {
    d.deadlline = { PAID: "2026-12-01T00:00:00.000Z" };
  });
  assert.throws(
    () => diffTaskSnapshots(bad, good),
    /invalid snapshot diff: unknown field "deadlline"/,
  );
});

test("diffTaskSnapshots shape: an unsupported schema version throws a shape error", () => {
  const good = validSnapshot();
  const bad = mutated(good, (d) => {
    d.v = 2;
  });
  assert.throws(
    () => diffTaskSnapshots(bad, good),
    /invalid snapshot diff: unsupported snapshot version 2/,
  );
});

test("diffTaskSnapshots shape: a malformed history entry throws a shape error", () => {
  const good = validSnapshot();
  const badEvent = mutated(good, (d) => {
    (d.history as Record<string, unknown>[])[0].event = "BOGUS";
  });
  assert.throws(
    () => diffTaskSnapshots(badEvent, good),
    /invalid snapshot diff: entry\[0\]: unknown event BOGUS/,
  );
  const badAt = mutated(good, (d) => {
    (d.history as Record<string, unknown>[])[0].at = "2026-10-10 10:00:00";
  });
  assert.throws(
    () => diffTaskSnapshots(badAt, good),
    /invalid snapshot diff: entry\[0\]: at must be canonical ISO-8601/,
  );
  const badSeq = mutated(good, (d) => {
    (d.history as Record<string, unknown>[])[0].seq = "1";
  });
  assert.throws(
    () => diffTaskSnapshots(badSeq, good),
    /invalid snapshot diff: entry\[0\]: seq must be a positive integer/,
  );
  const badAmount = mutated(good, (d) => {
    const entries = d.history as Record<string, unknown>[];
    entries[entries.length - 1].payoutAmount = -5;
  });
  assert.throws(
    () => diffTaskSnapshots(badAmount, good),
    /invalid snapshot diff: entry\[\d+\]: payoutAmount must be a non-negative finite number/,
  );
});

test("diffTaskSnapshots shape: malformed config fields throw shape errors", () => {
  const good = validSnapshot();
  const badBudget = mutated(good, (d) => {
    d.maxResubmits = -1;
  });
  assert.throws(
    () => diffTaskSnapshots(badBudget, good),
    /invalid snapshot diff: maxResubmits must be a non-negative integer/,
  );
  const badGate = mutated(good, (d) => {
    d.requirePayoutRef = "yes";
  });
  assert.throws(
    () => diffTaskSnapshots(badGate, good),
    /invalid snapshot diff: requirePayoutRef must be a boolean/,
  );
  const badPolicy = mutated(good, (d) => {
    d.rolePolicy = { BOGUS: ["admin"] };
  });
  assert.throws(
    () => diffTaskSnapshots(badPolicy, good),
    /invalid snapshot diff: rolePolicy has unknown event BOGUS/,
  );
});

test("diffTaskSnapshots shape: legal snapshots still compare exactly as before", () => {
  const task = new TaskLifecycle("t-legal");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { actor: "researcher" });
  const after = task.toJSON();
  assert.deepEqual(diffTaskSnapshots(before, before), {});
  const diff = diffTaskSnapshots(before, after);
  assert.deepEqual(diff.stateChanged, { from: "DRAFT", to: "OPEN" });
  assert.equal(diff.historyAppended?.entries.length, 1);
});

test("diffTaskSnapshots shape: comparison, not validation — a broken chain and a state/history mismatch still diff", () => {
  const good = validSnapshot();
  // Both copies carry the same broken hash: the chain is not
  // re-verified, so the diff is {} rather than a tampering error.
  const brokenChain = mutated(good, (d) => {
    (d.history as Record<string, unknown>[])[0].hash = "0".repeat(64);
  });
  assert.deepEqual(diffTaskSnapshots(brokenChain, brokenChain), {});
  // History ends at PAID but the state field says OPEN: a
  // history/state mismatch is not the diff's job to reject — it
  // reports the state field as it stands, with no history append
  // (the histories are identical).
  const mismatched = mutated(good, (d) => {
    d.state = "OPEN";
  });
  const diff = diffTaskSnapshots(good, mismatched);
  assert.deepEqual(diff.stateChanged, { from: "PAID", to: "OPEN" });
  assert.equal(diff.historyAppended, undefined);
});
