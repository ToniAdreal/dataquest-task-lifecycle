/**
 * actOnStaleTasks x event-level RBAC combination (backlog #707).
 *
 * `actOnStaleTasks()`'s default action dispatches ABANDON signed with the
 * `system` actor, and `rolePolicy` gates ABANDON per task. Each half has
 * its own tests (`actOnStaleTasks.test.ts` pins the per-task executor,
 * `rbac.test.ts` pins the actor check), but the combination was
 * untested: a batch mixing a task whose ABANDON policy admits `system`,
 * a task whose ABANDON policy excludes `system`, and a policy-free task
 * must abandon exactly the admitted ones, report the RBAC refusal as a
 * per-task outcome (never throw out of the batch), and leave the
 * refused task untouched and still usable by its allowed actor. A
 * caller-supplied custom action is not the default action, so it is not
 * gated by the default `system` actor either. This is the stale-action
 * counterpart of the SLA batch-expiry x RBAC combination (#699), with a
 * different executor and a different default actor path — its
 * conclusions are pinned here, not borrowed from #699.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  actOnStaleTasks,
} from "../src/index.js";
import type {
  StaleActionResult,
  TaskEvent,
  TaskHistoryEntry,
  TaskLifecycleOptions,
  TaskState,
} from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

type Step = [TaskEvent, TaskState, TaskState, string];

/** Deterministic task builder, same pattern as actOnStaleTasks.test.ts. */
function taskAt(
  id: string,
  steps: Step[],
  opts?: TaskLifecycleOptions,
): TaskLifecycle {
  const history: TaskHistoryEntry[] = steps.map(([event, from, to, at], i) => ({
    seq: i + 1,
    event,
    from,
    to,
    at,
    actor: "system",
  }));
  return TaskLifecycle.fromHistory(id, history, opts);
}

function acceptedStale(
  id: string,
  opts?: TaskLifecycleOptions,
): TaskLifecycle {
  return taskAt(
    id,
    [
      ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
      ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(20)], // 20d in ACCEPTED > 7d
    ],
    opts,
  );
}

function capturingStale(
  id: string,
  opts?: TaskLifecycleOptions,
): TaskLifecycle {
  return taskAt(
    id,
    [
      ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
      ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(25)],
      ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(15)], // 15d > 7d
    ],
    opts,
  );
}

const BUDGET = {
  ACCEPTED: 7 * DAY,
  CAPTURING: 7 * DAY,
};

function byId(results: StaleActionResult[], id: string): StaleActionResult {
  const found = results.find((r) => r.task.id === id);
  assert.ok(found, `expected a result entry for task ${id}`);
  return found;
}

describe("actOnStaleTasks x rolePolicy", () => {
  it("abandons only the tasks whose ABANDON policy admits the system actor", () => {
    const allowed = acceptedStale("allowed", {
      rolePolicy: { ABANDON: ["system"] },
    });
    const refused = acceptedStale("refused", {
      rolePolicy: { ABANDON: ["ops-lead"] },
    });
    const free = capturingStale("free");

    const results = actOnStaleTasks(
      [allowed, refused, free],
      undefined,
      BUDGET,
      NOW,
    );
    assert.equal(results.length, 3);

    const ok = byId(results, "allowed");
    assert.equal(ok.acted, true);
    assert.equal(ok.error, undefined);
    assert.equal(ok.task.state, "ABANDONED");
    assert.equal(ok.entry?.event, "ABANDON");
    assert.equal(ok.entry?.from, "ACCEPTED");
    assert.equal(ok.entry?.to, "ABANDONED");
    assert.equal(ok.entry?.actor, "system");

    const blocked = byId(results, "refused");
    assert.equal(blocked.acted, false);
    assert.equal(
      blocked.error,
      'actor not authorized for ABANDON: "system" is not in [ops-lead]',
    );
    assert.equal(blocked.entry, undefined);
    assert.equal(blocked.task.state, "ACCEPTED");
    // Zero residue: no audit entry was appended, seq chain untouched.
    assert.equal(blocked.task.history.length, 2);
    assert.deepEqual(
      blocked.task.history.map((e) => e.seq),
      [1, 2],
    );

    const plain = byId(results, "free");
    assert.equal(plain.acted, true);
    assert.equal(plain.task.state, "ABANDONED");
    assert.equal(plain.entry?.event, "ABANDON");
    assert.equal(plain.entry?.from, "CAPTURING");
    assert.equal(plain.entry?.to, "ABANDONED");
  });

  it("does not block the rest of the batch when the refused task comes first", () => {
    const refused = acceptedStale("refused-first", {
      rolePolicy: { ABANDON: ["ops-lead"] },
    });
    const allowed = acceptedStale("allowed-after", {
      rolePolicy: { ABANDON: ["system"] },
    });
    const free = capturingStale("free-after");

    const results = actOnStaleTasks(
      [refused, allowed, free],
      undefined,
      BUDGET,
      NOW,
    );
    assert.equal(results.length, 3);

    const blocked = byId(results, "refused-first");
    assert.equal(blocked.acted, false);
    assert.match(
      blocked.error ?? "",
      /actor not authorized for ABANDON: "system" is not in \[ops-lead\]/,
    );
    assert.equal(blocked.task.state, "ACCEPTED");

    assert.equal(byId(results, "allowed-after").acted, true);
    assert.equal(byId(results, "allowed-after").task.state, "ABANDONED");
    assert.equal(byId(results, "free-after").acted, true);
    assert.equal(byId(results, "free-after").task.state, "ABANDONED");
  });

  it("leaves the refused task usable by its allowed actor, with no seq gap", () => {
    const refused = acceptedStale("refused", {
      rolePolicy: { ABANDON: ["ops-lead"] },
    });

    const results = actOnStaleTasks([refused], undefined, BUDGET, NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].acted, false);
    assert.equal(refused.history.length, 2);

    // The allowlisted actor abandons it manually afterwards; the
    // refused attempt consumed nothing, so the new entry is seq 3.
    refused.dispatch("ABANDON", { actor: "ops-lead" });
    assert.equal(refused.state, "ABANDONED");
    assert.equal(refused.history.length, 3);
    const last = refused.history[refused.history.length - 1];
    assert.equal(last.seq, 3);
    assert.equal(last.event, "ABANDON");
    assert.equal(last.from, "ACCEPTED");
    assert.equal(last.to, "ABANDONED");
    assert.equal(last.actor, "ops-lead");
  });

  it("custom actions are not gated by the default system actor", () => {
    const byAllowlistedActor = capturingStale("by-allowlisted-actor", {
      rolePolicy: { ABANDON: ["ops-lead"] },
    });
    const notifyOnly = acceptedStale("notify-only", {
      rolePolicy: { ABANDON: ["ops-lead"] },
    });

    // A custom action that dispatches as the allowlisted actor succeeds
    // on a task the default system action would be refused on.
    const dispatched = actOnStaleTasks(
      [byAllowlistedActor],
      (task) => task.dispatch("ABANDON", { actor: "ops-lead" }),
      BUDGET,
      NOW,
    );
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].acted, true);
    assert.equal(dispatched[0].task.state, "ABANDONED");
    assert.equal(dispatched[0].entry?.actor, "ops-lead");

    // A notify-only custom action appends nothing, so it succeeds with
    // no entry even though the default action would be refused.
    const notified: string[] = [];
    const results = actOnStaleTasks(
      [notifyOnly],
      (task) => {
        notified.push(task.id);
      },
      BUDGET,
      NOW,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].acted, true);
    assert.equal(results[0].error, undefined);
    assert.equal(results[0].entry, undefined);
    assert.equal(results[0].task.state, "ACCEPTED");
    assert.equal(results[0].task.history.length, 2);
    assert.deepEqual(notified, ["notify-only"]);
  });
});
