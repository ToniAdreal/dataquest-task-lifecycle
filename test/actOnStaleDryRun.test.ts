/**
 * actOnStaleTasks dry run (backlog #1086).
 *
 * `expireOverdueTasks` gained a dry-run rehearsal port in #1050 and
 * the sibling escrow `actOnStaleEscrows` gained the same port in
 * #1083; this is the dataquest-side mirror, so a caller can preview
 * a stale-task sweep before running a real action over it.
 * Semantics differ in one honest way: the executor takes an
 * arbitrary caller-supplied action (and its default ABANDON dispatch
 * is illegal from SUBMITTED, IN_REVIEW and OPEN), so `wouldAct`
 * answers only "in the stale selection", never "would succeed".
 * The live run keeps reporting the actual outcome via `acted` and
 * leaves `wouldAct` absent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, actOnStaleTasks } from "../src/index.js";
import type {
  StaleActionResult,
  TaskEvent,
  TaskHistoryEntry,
  TaskState,
} from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

type Step = [TaskEvent, TaskState, TaskState, string];

/** Deterministic task builder, same pattern as actOnStaleTasks.test.ts. */
function taskAt(id: string, steps: Step[]): TaskLifecycle {
  const history: TaskHistoryEntry[] = steps.map(([event, from, to, at], i) => ({
    seq: i + 1,
    event,
    from,
    to,
    at,
    actor: "system",
  }));
  return TaskLifecycle.fromHistory(id, history);
}

function acceptedStale(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(20)], // 20d in ACCEPTED > 7d
  ]);
}

function capturingStale(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(25)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(15)], // 15d > 7d
  ]);
}

function submittedStale(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(25)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(20)],
    ["SUBMIT", "CAPTURING", "SUBMITTED", daysAgo(12)], // 12d > 7d, no ABANDON edge
  ]);
}

function openStale(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(40)], // 40d open > 30d, no ABANDON edge
  ]);
}

function acceptedFresh(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(3)], // 3d < 7d
  ]);
}

function abandonedTerminal(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(40)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(35)],
    ["ABANDON", "ACCEPTED", "ABANDONED", daysAgo(30)], // terminal: never selected
  ]);
}

const BUDGET = {
  ACCEPTED: 7 * DAY,
  CAPTURING: 7 * DAY,
  SUBMITTED: 7 * DAY,
  OPEN: 30 * DAY,
  IN_REVIEW: 7 * DAY,
};

function byId(results: StaleActionResult[], id: string): StaleActionResult {
  const found = results.find((r) => r.task.id === id);
  assert.ok(found, `expected a result entry for task ${id}`);
  return found;
}

describe("actOnStaleTasks dry run", () => {
  it("dry run calls the action zero times and leaves state/history untouched", () => {
    const stale = acceptedStale("stale");
    const fresh = acceptedFresh("fresh");
    const beforeState = stale.state;
    const beforeHistory = stale.history;
    let calls = 0;
    const results = actOnStaleTasks(
      [stale, fresh],
      () => {
        calls += 1;
      },
      BUDGET,
      NOW,
      undefined,
      { dryRun: true },
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      results.map((r) => [r.task.id, r.acted, r.wouldAct]),
      [["stale", false, true]],
    );
    assert.equal("error" in results[0], false);
    assert.equal("entry" in results[0], false);
    assert.equal(stale.state, beforeState);
    assert.deepEqual(stale.history, beforeHistory);
  });

  it("wouldAct is exactly the stale set: fresh, terminal and unbudgeted tasks excluded", () => {
    const tasks = [
      acceptedStale("stale-accepted"),
      submittedStale("stale-submitted"),
      openStale("stale-open"),
      acceptedFresh("fresh"),
      abandonedTerminal("terminal"),
      new TaskLifecycle("draft"), // DRAFT has no budget: never selected
    ];
    let calls = 0;
    const results = actOnStaleTasks(
      tasks,
      () => {
        calls += 1;
      },
      BUDGET,
      NOW,
      undefined,
      { dryRun: true },
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      results.map((r) => r.task.id),
      ["stale-accepted", "stale-submitted", "stale-open"],
    );
    assert.ok(results.every((r) => r.acted === false && r.wouldAct === true));
    assert.ok(results.every((r) => !("error" in r) && !("entry" in r)));
  });

  it("dry run with the default action dispatches nothing", () => {
    const stale = acceptedStale("stale");
    const beforeHistory = stale.history;
    const results = actOnStaleTasks(
      [stale],
      undefined,
      BUDGET,
      NOW,
      undefined,
      { dryRun: true },
    );
    assert.deepEqual(
      results.map((r) => [r.task.id, r.acted, r.wouldAct]),
      [["stale", false, true]],
    );
    assert.equal(stale.state, "ACCEPTED");
    assert.deepEqual(stale.history, beforeHistory);
  });

  it("a dry run followed by a live run still executes, per-task outcomes intact", () => {
    const accepted = acceptedStale("accepted");
    const submitted = submittedStale("submitted");
    const dry = actOnStaleTasks(
      [accepted, submitted],
      undefined,
      BUDGET,
      NOW,
      undefined,
      { dryRun: true },
    );
    assert.deepEqual(
      dry.map((r) => [r.task.id, r.acted, r.wouldAct]),
      [
        ["accepted", false, true],
        ["submitted", false, true],
      ],
    );
    assert.equal(accepted.state, "ACCEPTED");
    assert.equal(submitted.state, "SUBMITTED");
    const live = actOnStaleTasks([accepted, submitted], undefined, BUDGET, NOW);
    const acceptedLive = byId(live, "accepted");
    assert.equal(acceptedLive.acted, true);
    assert.equal("wouldAct" in acceptedLive, false);
    assert.equal(acceptedLive.entry?.event, "ABANDON");
    assert.equal(accepted.state, "ABANDONED");
    const submittedLive = byId(live, "submitted");
    assert.equal(submittedLive.acted, false);
    assert.equal(submittedLive.error, "invalid transition: ABANDON from SUBMITTED");
    assert.equal("wouldAct" in submittedLive, false);
    assert.equal(submitted.state, "SUBMITTED");
  });

  it("illegal opts fail fast with zero action calls", () => {
    const stale = acceptedStale("stale");
    const cases: [unknown, RegExp][] = [
      ["yes", /invalid actOnStaleTasks options: opts must be an object/],
      [null, /invalid actOnStaleTasks options: opts must be an object/],
      [[], /invalid actOnStaleTasks options: opts must be an object/],
      [
        { dryRun: "yes" },
        /invalid actOnStaleTasks options: dryRun must be a boolean, got "yes"/,
      ],
      [
        { dryRun: 1 },
        /invalid actOnStaleTasks options: dryRun must be a boolean, got 1/,
      ],
      [
        { dryRun: null },
        /invalid actOnStaleTasks options: dryRun must be a boolean, got null/,
      ],
    ];
    for (const [opts, pattern] of cases) {
      let calls = 0;
      assert.throws(
        () =>
          actOnStaleTasks(
            [stale],
            () => {
              calls += 1;
            },
            BUDGET,
            NOW,
            undefined,
            opts as never,
          ),
        pattern,
      );
      assert.equal(calls, 0);
      assert.equal(stale.state, "ACCEPTED");
      assert.equal(stale.history.length, 2);
    }
  });

  it("a non-function action fails fast in a dry run too", () => {
    const stale = acceptedStale("stale");
    assert.throws(
      () =>
        actOnStaleTasks(
          [stale],
          "not-a-function" as never,
          BUDGET,
          NOW,
          undefined,
          { dryRun: true },
        ),
      /invalid action: expected a function \(task\) => void/,
    );
    assert.equal(stale.state, "ACCEPTED");
  });

  it("a bad maxAgeByState fails fast in a dry run with zero calls", () => {
    const stale = acceptedStale("stale");
    let calls = 0;
    assert.throws(
      () =>
        actOnStaleTasks(
          [stale],
          () => {
            calls += 1;
          },
          { ACCEPTED: -1 },
          NOW,
          undefined,
          { dryRun: true },
        ),
      /invalid maxAgeByState: budget for "ACCEPTED" must be a non-negative finite number/,
    );
    assert.equal(calls, 0);
    assert.equal(stale.state, "ACCEPTED");
  });

  it("a bad now fails fast in a dry run with zero calls", () => {
    const stale = acceptedStale("stale");
    let calls = 0;
    assert.throws(
      () =>
        actOnStaleTasks(
          [stale],
          () => {
            calls += 1;
          },
          BUDGET,
          new Date(Number.NaN),
          undefined,
          { dryRun: true },
        ),
      /invalid now: expected a valid Date/,
    );
    assert.equal(calls, 0);
    assert.equal(stale.state, "ACCEPTED");
  });

  it("a bad at pin fails fast in a dry run with zero calls", () => {
    const stale = acceptedStale("stale");
    let calls = 0;
    assert.throws(
      () =>
        actOnStaleTasks(
          [stale],
          () => {
            calls += 1;
          },
          BUDGET,
          NOW,
          "not-a-date",
          { dryRun: true },
        ),
      /invalid at: /,
    );
    assert.equal(calls, 0);
    assert.throws(
      () =>
        actOnStaleTasks(
          [stale],
          () => {
            calls += 1;
          },
          BUDGET,
          NOW,
          new Date(Number.NaN),
          { dryRun: true },
        ),
      /invalid at: expected a valid Date/,
    );
    assert.equal(calls, 0);
    assert.equal(stale.state, "ACCEPTED");
  });

  it("a throwing action is never invoked by a dry run, even where the live run would fail", () => {
    const submitted = submittedStale("submitted");
    const results = actOnStaleTasks(
      [submitted],
      () => {
        throw new Error("action exploded");
      },
      BUDGET,
      NOW,
      undefined,
      { dryRun: true },
    );
    assert.deepEqual(
      results.map((r) => [r.task.id, r.acted, r.wouldAct]),
      [["submitted", false, true]],
    );
    assert.equal("error" in results[0], false);
    assert.equal(submitted.state, "SUBMITTED");
    assert.equal(submitted.history.length, 4);
  });

  it("dry run over an empty batch returns an empty list", () => {
    let calls = 0;
    const results = actOnStaleTasks(
      [],
      () => {
        calls += 1;
      },
      BUDGET,
      NOW,
      undefined,
      { dryRun: true },
    );
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });

  it("dry run over an all-fresh batch returns an empty list", () => {
    let calls = 0;
    const results = actOnStaleTasks(
      [acceptedFresh("fresh-1"), acceptedFresh("fresh-2")],
      () => {
        calls += 1;
      },
      BUDGET,
      NOW,
      undefined,
      { dryRun: true },
    );
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });

  it("dryRun: false behaves exactly like the live run", () => {
    const stale = acceptedStale("stale");
    const seen: string[] = [];
    const results = actOnStaleTasks(
      [stale],
      (t) => {
        seen.push(t.id);
      },
      BUDGET,
      NOW,
      undefined,
      { dryRun: false },
    );
    assert.deepEqual(seen, ["stale"]);
    assert.equal(results[0].acted, true);
    assert.equal("wouldAct" in results[0], false);
  });

  it("{} opts behaves exactly like the live run", () => {
    const stale = acceptedStale("stale");
    const seen: string[] = [];
    const results = actOnStaleTasks(
      [stale],
      (t) => {
        seen.push(t.id);
      },
      BUDGET,
      NOW,
      undefined,
      {},
    );
    assert.deepEqual(seen, ["stale"]);
    assert.equal(results[0].acted, true);
    assert.equal("wouldAct" in results[0], false);
  });

  it("dry run sends zero subscription notifications; the live run notifies", () => {
    const stale = acceptedStale("stale");
    const notified: string[] = [];
    stale.subscribe((event) => {
      notified.push(event);
    });
    const dry = actOnStaleTasks(
      [stale],
      undefined,
      BUDGET,
      NOW,
      undefined,
      { dryRun: true },
    );
    assert.equal(dry[0].wouldAct, true);
    assert.deepEqual(notified, []);
    const live = actOnStaleTasks([stale], undefined, BUDGET, NOW);
    assert.equal(live[0].acted, true);
    assert.deepEqual(notified, ["ABANDON"]);
  });
});
