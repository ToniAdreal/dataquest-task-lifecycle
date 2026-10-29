/**
 * SLA batch expiry x event-level RBAC combination (backlog #699).
 *
 * `expireOverdueTasks()` dispatches EXPIRE signed with the `system`
 * actor, and `rolePolicy` gates EXPIRE per task. Each half has its own
 * tests (`expireOverdueTasks.test.ts` pins the per-task executor,
 * `rbac.test.ts` pins the actor check), but the combination was
 * untested: a batch mixing a system-allowed task, a task whose EXPIRE
 * policy excludes `system`, and a policy-free task must expire exactly
 * the allowed ones, report the RBAC refusal as a per-task outcome
 * (never throw out of the batch), and leave the refused task untouched
 * and still usable by its allowed actor.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expireOverdueTasks,
} from "../src/index.js";
import type { ExpireOverdueResult, TaskLifecycleOptions } from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

function openOverdueTask(
  id: string,
  opts?: TaskLifecycleOptions,
): TaskLifecycle {
  const task = new TaskLifecycle(id, opts);
  task.dispatch("PUBLISH", { actor: "poster" });
  task.setSlaDeadline(PAST);
  return task; // OPEN — has an EXPIRE edge, past its SLA deadline
}

function byId(results: ExpireOverdueResult[], id: string): ExpireOverdueResult {
  const found = results.find((r) => r.task.id === id);
  assert.ok(found, `expected a result entry for task ${id}`);
  return found;
}

describe("expireOverdueTasks x rolePolicy", () => {
  it("expires only the tasks whose EXPIRE policy admits the system actor", () => {
    const allowed = openOverdueTask("allowed", {
      rolePolicy: { EXPIRE: ["system"] },
    });
    const refused = openOverdueTask("refused", {
      rolePolicy: { EXPIRE: ["ops-lead"] },
    });
    const free = openOverdueTask("free");

    const results = expireOverdueTasks([allowed, refused, free], NOW);
    assert.equal(results.length, 3);

    const ok = byId(results, "allowed");
    assert.equal(ok.expired, true);
    assert.equal(ok.error, undefined);
    assert.equal(ok.task.state, "EXPIRED");
    assert.equal(ok.entry?.event, "EXPIRE");
    assert.equal(ok.entry?.from, "OPEN");
    assert.equal(ok.entry?.to, "EXPIRED");
    assert.equal(ok.entry?.actor, "system");

    const blocked = byId(results, "refused");
    assert.equal(blocked.expired, false);
    assert.match(
      blocked.error ?? "",
      /actor not authorized for EXPIRE: "system" is not in \[ops-lead\]/,
    );
    assert.equal(blocked.entry, undefined);
    assert.equal(blocked.task.state, "OPEN");

    const plain = byId(results, "free");
    assert.equal(plain.expired, true);
    assert.equal(plain.task.state, "EXPIRED");
  });

  it("does not block the rest of the batch when the refused task comes first", () => {
    const refused = openOverdueTask("refused-first", {
      rolePolicy: { EXPIRE: ["ops-lead"] },
    });
    const allowed = openOverdueTask("allowed-second", {
      rolePolicy: { EXPIRE: ["system", "ops-lead"] },
    });

    const results = expireOverdueTasks([refused, allowed], NOW);
    assert.equal(results.length, 2);
    assert.equal(byId(results, "refused-first").expired, false);
    assert.equal(byId(results, "allowed-second").expired, true);
    assert.equal(byId(results, "allowed-second").task.state, "EXPIRED");
  });

  it("leaves the refused task untouched: state and history unchanged", () => {
    const refused = openOverdueTask("refused", {
      rolePolicy: { EXPIRE: ["ops-lead"] },
    });
    const before = JSON.stringify(refused.history);

    const results = expireOverdueTasks([refused], NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, false);
    assert.match(results[0].error ?? "", /actor not authorized for EXPIRE/);
    assert.equal(refused.state, "OPEN");
    assert.equal(JSON.stringify(refused.history), before);
  });

  it("a refused task stays usable: its allowed actor can still expire it", () => {
    const refused = openOverdueTask("refused", {
      rolePolicy: { EXPIRE: ["ops-lead"] },
    });
    const historyBefore = refused.history.length;

    const results = expireOverdueTasks([refused], NOW);
    assert.equal(results[0].expired, false);

    // The batch failure left no residue: the allowed actor's manual
    // EXPIRE appends exactly one entry, with no seq gap.
    assert.equal(refused.dispatch("EXPIRE", { actor: "ops-lead" }), "EXPIRED");
    assert.equal(refused.history.length, historyBefore + 1);
    const last = refused.history[refused.history.length - 1];
    assert.equal(last.event, "EXPIRE");
    assert.equal(last.actor, "ops-lead");
    assert.equal(last.seq, historyBefore + 1);
  });

  it("a policy listing system among other roles still lets the watchdog expire", () => {
    const task = openOverdueTask("shared", {
      rolePolicy: { EXPIRE: ["ops-lead", "system", "auditor"] },
    });

    const results = expireOverdueTasks([task], NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, true);
    assert.equal(task.state, "EXPIRED");
    assert.equal(
      task.history[task.history.length - 1].actor,
      "system",
    );
  });

  it("a policy covering only other events does not gate the watchdog EXPIRE", () => {
    // PUBLISH is gated to "poster" (satisfied at construction time);
    // EXPIRE is not listed, so it stays unrestricted for `system`.
    const task = openOverdueTask("other-event-only", {
      rolePolicy: { PUBLISH: ["poster"] },
    });

    const results = expireOverdueTasks([task], NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, true);
    assert.equal(task.state, "EXPIRED");
  });
});
