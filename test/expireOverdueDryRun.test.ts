/**
 * expireOverdueTasks dry run (backlog #1051, mirrors escrow #1050).
 *
 * An operator about to expire a batch has no safe rehearsal port: the
 * executor dispatches EXPIRE the moment it runs, writing history and
 * notifying subscribers. `expireOverdueTasks(tasks, now, at,
 * { dryRun: true })` predicts instead — same screened set, same order,
 * zero dispatch — and each result carries `wouldExpire` plus, when
 * false, the same-wording `error` the live run would have reported.
 *
 * The wording pins are the point of this file: for every failure mode
 * (no EXPIRE edge, a backdated audit timestamp, a `rolePolicy` that
 * does not admit `system`) a twin task is built identically, the live
 * run is executed on the twin, and the dry-run error must equal the
 * live error byte for byte — a rehearsal that disagrees with the real
 * run about WHY a task would not expire is worse than no rehearsal.
 *
 * One deliberate difference from the escrow mirror: this executor
 * takes a separate `at` pin for the audit timestamp, while escrow pins
 * the screening `now` as its audit timestamp. The prediction therefore
 * checks the `at` pin when given — and skips the clock check entirely
 * when no pin is given, because dispatch stamps the wall clock
 * unchecked in that case (its non-decreasing-timestamp check only
 * covers an explicitly provided `at`). The screening `now` is never
 * consulted: it only selects the batch. The "audit timestamp, not
 * screening instant" test pins that: a backdated screening `now` with
 * a valid later `at` still predicts expiry, exactly as the live run
 * expires it — and the "no at pin, last entry in the future" test
 * pins the other side: with no pin, the live run expires the task
 * (stamping a wall-clock entry earlier than the last entry), so the
 * dry run must predict expiry too.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expireOverdueTasks,
  ExpireOverdueResult,
} from "../src/index.js";
import type { TaskLifecycleOptions } from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
// Fixture audit timestamps: pinned strictly before NOW, because a
// pinned `at` must not move the audit clock backwards.
const PUBLISH_AT = "2026-01-01T00:00:00.000Z";
const ACCEPT_AT = "2026-02-01T00:00:00.000Z";
const CAPTURE_AT = "2026-02-15T00:00:00.000Z";
const SUBMIT_AT = "2026-03-01T00:00:00.000Z";
const REVIEW_AT = "2026-03-15T00:00:00.000Z";
// Backdated-clock fixture: the last history entry (PUBLISH) sits after
// the backdated `at` pin, while the deadline is already past at `now`.
const LATE_PUBLISH_AT = "2026-05-01T00:00:00.000Z";
const BACKDATED_NOW = new Date("2026-02-01T00:00:00.000Z");
const BACKDATED_AT = new Date("2026-02-01T00:00:00.000Z");
// Audit-timestamp-vs-screening fixture: the last entry sits after the
// screening `now` but before the `at` pin — the live run stamps `at`,
// so it must expire despite the backdated screening instant.
const LATER_AT = new Date("2026-06-15T00:00:00.000Z");

function openOverdueTask(
  id: string,
  opts?: TaskLifecycleOptions,
): TaskLifecycle {
  const task = new TaskLifecycle(id, opts);
  task.dispatch("PUBLISH", { actor: "poster" });
  task.setSlaDeadline(PAST);
  return task; // OPEN — has an EXPIRE edge
}

function openOverdueTaskAt(
  id: string,
  publishAt: string,
  deadline: Date = PAST,
): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH", { actor: "poster", at: publishAt });
  task.setSlaDeadline(deadline);
  return task; // OPEN, deterministic audit timestamps
}

function inReviewOverdueTask(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH", { actor: "poster", at: PUBLISH_AT });
  task.dispatch("ACCEPT", { actor: "contributor", at: ACCEPT_AT });
  task.dispatch("START_CAPTURE", { actor: "contributor", at: CAPTURE_AT });
  task.dispatch("SUBMIT", { actor: "contributor", at: SUBMIT_AT });
  task.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: REVIEW_AT });
  task.setSlaDeadline(PAST);
  return task; // IN_REVIEW — no EXPIRE edge
}

/** Overdue at BACKDATED_NOW, but its last history entry is after the `at` pin. */
function backdatedTask(id: string): TaskLifecycle {
  return openOverdueTaskAt(
    id,
    LATE_PUBLISH_AT,
    new Date("2026-01-15T00:00:00.000Z"),
  );
}

/** Overdue, last entry in the future relative to the wall clock. */
function futureEntryTask(id: string): TaskLifecycle {
  return openOverdueTaskAt(id, "2027-01-01T00:00:00.000Z");
}

function byId(results: ExpireOverdueResult[], id: string): ExpireOverdueResult {
  const found = results.find((r) => r.task.id === id);
  assert.ok(found, `expected a result entry for task ${id}`);
  return found;
}

/** The live run's error for a twin task, for exact-wording pins. */
function liveError(
  build: () => TaskLifecycle,
  now: Date,
  at?: Date | string,
): string {
  const twin = build();
  const [result] = expireOverdueTasks([twin], now, at);
  assert.equal(result.expired, false);
  assert.equal(typeof result.error, "string");
  return result.error as string;
}

describe("expireOverdueTasks dryRun", () => {
  it("dry run changes nothing: state and history frozen for the whole batch", () => {
    const expirable = openOverdueTask("expirable");
    const stuck = inReviewOverdueTask("stuck");
    const notOverdue = openOverdueTask("not-overdue");
    notOverdue.setSlaDeadline(FUTURE);
    const noDeadline = new TaskLifecycle("no-deadline");
    noDeadline.dispatch("PUBLISH", { actor: "poster" });
    const batch = [expirable, stuck, notOverdue, noDeadline];
    const before = batch.map((t) => ({
      id: t.id,
      state: t.state,
      history: t.history,
    }));

    const results = expireOverdueTasks(batch, NOW, undefined, {
      dryRun: true,
    });

    assert.deepEqual(
      batch.map((t) => ({ id: t.id, state: t.state, history: t.history })),
      before,
    );
    // Only the screened (overdue) tasks are reported, in batch order.
    assert.deepEqual(
      results.map((r) => r.task.id),
      ["expirable", "stuck"],
    );
  });

  it("dry run selects the same set as the live run, in batch order", () => {
    const buildBatch = () => [
      openOverdueTask("a"),
      openOverdueTask("b"),
      inReviewOverdueTask("c"),
      new TaskLifecycle("d"),
      openOverdueTask("e"),
    ];
    // "b" is not overdue: push its deadline into the future.
    const dryBatch = buildBatch();
    dryBatch[1].setSlaDeadline(FUTURE);
    const dryIds = expireOverdueTasks(dryBatch, NOW, undefined, {
      dryRun: true,
    }).map((r) => r.task.id);
    const liveBatch = buildBatch();
    liveBatch[1].setSlaDeadline(FUTURE);
    const liveIds = expireOverdueTasks(liveBatch, NOW).map(
      (r) => r.task.id,
    );
    assert.deepEqual(dryIds, liveIds);
    assert.deepEqual(dryIds, ["a", "c", "e"]);
  });

  it("expirable tasks report wouldExpire true, expired false, no entry, no error", () => {
    const task = openOverdueTask("expirable");
    const [result] = expireOverdueTasks([task], NOW, undefined, {
      dryRun: true,
    });
    assert.equal(result.wouldExpire, true);
    assert.equal(result.expired, false);
    assert.equal(result.error, undefined);
    assert.equal("entry" in result, false);
    assert.equal("wouldExpire" in result, true);
    assert.equal(task.state, "OPEN");
  });

  it("IN_REVIEW overdue: wouldExpire false with the live run's exact error wording", () => {
    const build = () => inReviewOverdueTask("stuck");
    const [dry] = expireOverdueTasks([build()], NOW, undefined, {
      dryRun: true,
    });
    assert.equal(dry.wouldExpire, false);
    assert.equal(dry.expired, false);
    assert.equal("entry" in dry, false);
    assert.equal(dry.error, liveError(build, NOW));
    assert.match(dry.error ?? "", /invalid transition: EXPIRE from IN_REVIEW/);
  });

  it("backdated at pin: wouldExpire false with the live run's exact error wording", () => {
    const build = () => backdatedTask("backdated");
    const [dry] = expireOverdueTasks([build()], BACKDATED_NOW, BACKDATED_AT, {
      dryRun: true,
    });
    assert.equal(dry.wouldExpire, false);
    assert.equal(dry.error, liveError(build, BACKDATED_NOW, BACKDATED_AT));
    assert.match(
      dry.error ?? "",
      /invalid dispatch options: at 2026-02-01T00:00:00\.000Z is earlier than the previous entry's at 2026-05-01T00:00:00\.000Z/,
    );
  });

  it("audit timestamp, not screening instant: backdated now with a valid later at still predicts expiry", () => {
    const build = () => backdatedTask("audit-clock");
    const [dry] = expireOverdueTasks([build()], BACKDATED_NOW, LATER_AT, {
      dryRun: true,
    });
    assert.equal(dry.wouldExpire, true);
    assert.equal(dry.error, undefined);
    // The live twin agrees: it stamps the `at` pin, not the screening `now`.
    const twin = build();
    const [live] = expireOverdueTasks([twin], BACKDATED_NOW, LATER_AT);
    assert.equal(live.expired, true);
    assert.equal(live.entry?.at, "2026-06-15T00:00:00.000Z");
  });

  it("rolePolicy: excluding system predicts refusal verbatim; including system predicts expiry", () => {
    const excluded = () =>
      openOverdueTask("gated", { rolePolicy: { EXPIRE: ["ops"] } });
    const [dry] = expireOverdueTasks([excluded()], NOW, undefined, {
      dryRun: true,
    });
    assert.equal(dry.wouldExpire, false);
    assert.equal(dry.error, liveError(excluded, NOW));
    assert.match(
      dry.error ?? "",
      /actor not authorized for EXPIRE: "system" is not in \[ops\]/,
    );

    const admitted = openOverdueTask("admitted", {
      rolePolicy: { EXPIRE: ["ops", "system"] },
    });
    const [ok] = expireOverdueTasks([admitted], NOW, undefined, {
      dryRun: true,
    });
    assert.equal(ok.wouldExpire, true);
    assert.equal(ok.error, undefined);
  });

  it("dry run notifies no subscriber; the live run right after notifies once per expiry", () => {
    const a = openOverdueTask("a");
    const b = openOverdueTask("b");
    const stuck = inReviewOverdueTask("stuck");
    let notifications = 0;
    for (const task of [a, b, stuck]) {
      task.subscribe(() => {
        notifications += 1;
      });
    }

    const dry = expireOverdueTasks([a, b, stuck], NOW, undefined, {
      dryRun: true,
    });
    assert.equal(notifications, 0);
    assert.deepEqual(
      dry.map((r) => r.wouldExpire),
      [true, true, false],
    );

    const live = expireOverdueTasks([a, b, stuck], NOW);
    assert.equal(notifications, 2);
    assert.deepEqual(
      live.map((r) => r.expired),
      [true, true, false],
    );
  });

  it("a dry run leaves no residue: the same batch then expires in full live", () => {
    const a = openOverdueTask("a");
    const b = openOverdueTask("b");
    const stuck = inReviewOverdueTask("stuck");
    const beforeLen = new Map([
      ["a", a.history.length],
      ["b", b.history.length],
      ["stuck", stuck.history.length],
    ]);
    const beforeLastAt = new Map([
      ["a", a.history[a.history.length - 1].at],
      ["b", b.history[b.history.length - 1].at],
    ]);

    const dry = expireOverdueTasks([a, b, stuck], NOW, undefined, {
      dryRun: true,
    });
    assert.deepEqual(
      dry.map((r) => r.wouldExpire),
      [true, true, false],
    );

    const live = expireOverdueTasks([a, b, stuck], NOW);
    assert.equal(byId(live, "a").expired, true);
    assert.equal(byId(live, "b").expired, true);
    assert.equal(byId(live, "stuck").expired, false);
    // Exactly one new EXPIRE entry per expirable task, none for the stuck one.
    assert.equal(a.history.length, (beforeLen.get("a") ?? 0) + 1);
    assert.equal(b.history.length, (beforeLen.get("b") ?? 0) + 1);
    assert.equal(stuck.history.length, beforeLen.get("stuck"));
    assert.equal(a.history[a.history.length - 1].event, "EXPIRE");
    assert.equal(a.history[a.history.length - 1].actor, "system");
    // The live entry stamps the wall clock: canonical ISO, never
    // earlier than the entry it follows.
    for (const [id, task] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const last = task.history[task.history.length - 1];
      assert.match(
        last.at,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      assert.ok(Date.parse(last.at) >= Date.parse(beforeLastAt.get(id) ?? ""));
    }
  });

  it("illegal opts throw fail-fast with zero calls", () => {
    const task = openOverdueTask("guarded");
    const historyLen = task.history.length;
    for (const badOpts of [
      { dryRun: "yes" },
      { dryRun: 1 },
      null,
      [],
    ] as unknown[]) {
      assert.throws(
        () =>
          expireOverdueTasks(
            [task],
            NOW,
            undefined,
            badOpts as { dryRun?: boolean },
          ),
        /invalid expireOverdueTasks options/,
      );
    }
    // Nothing was dispatched by any rejected call.
    assert.equal(task.state, "OPEN");
    assert.equal(task.history.length, historyLen);
  });

  it("dry run on an empty batch returns an empty array", () => {
    assert.deepEqual(
      expireOverdueTasks([], NOW, undefined, { dryRun: true }),
      [],
    );
  });

  it("live-run results carry no wouldExpire key", () => {
    const ok = openOverdueTask("ok");
    const stuck = inReviewOverdueTask("stuck2");
    const results = expireOverdueTasks([ok, stuck], NOW);
    for (const result of results) {
      assert.equal("wouldExpire" in result, false);
    }
  });

  it("no at pin, last entry in the future: the live run still expires, so the dry run predicts expiry", () => {
    // dispatch's non-decreasing-timestamp check only covers an
    // explicitly provided `at`: with no pin it stamps the wall clock
    // unchecked, even when the last entry sits in the future — so the
    // live run expires this task (leaving a wall-clock entry earlier
    // than the entry it follows), and the dry run must agree.
    // Tightening dispatch's wall-clock path is out of scope here; the
    // rehearsal's job is to match the live run, not to second-guess it.
    const build = () => futureEntryTask("future-entry");
    const [dry] = expireOverdueTasks([build()], NOW, undefined, {
      dryRun: true,
    });
    assert.equal(dry.wouldExpire, true);
    assert.equal(dry.error, undefined);
    const twin = build();
    const [live] = expireOverdueTasks([twin], NOW);
    assert.equal(live.expired, true);
    assert.equal(live.entry?.event, "EXPIRE");
    assert.ok(
      Date.parse(live.entry?.at ?? "") <
        Date.parse("2027-01-01T00:00:00.000Z"),
    );
  });
});
