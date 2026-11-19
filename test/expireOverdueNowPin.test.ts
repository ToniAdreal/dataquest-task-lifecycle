/**
 * expireOverdueTasks pins the screening `now` as the audit timestamp
 * when no `at` is given (backlog #1252, mirrors escrow #552).
 *
 * Before this change the executor dispatched EXPIRE with no `at`
 * when the caller omitted it, so the audit entry carried the wall
 * clock — the same screening instant screened one batch at T and
 * stamped it at T+ε, breaking deterministic replay (and the demo's
 * byte-identical double run, which had to pass an explicit `at`
 * to work around it, backlog #1248). Now the pin defaults to the
 * screening `now`: every EXPIRE entry in the batch carries the
 * same timestamp as the screening decision, an explicit `at`
 * still wins, and the dry-run prediction uses the same resolved
 * pin — so a rehearsal can no longer disagree with the live run
 * about the clock check.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expireOverdueTasks,
} from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
const LATER_AT = new Date("2026-06-15T00:00:00.000Z");
// Fixture audit timestamps: pinned strictly before NOW, so the
// screening `now` never trips the non-decreasing-timestamp check.
const PUBLISH_AT = "2026-01-01T00:00:00.000Z";

/** OPEN task (has an EXPIRE edge), overdue, deterministic history. */
function openOverdueTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster", at: PUBLISH_AT });
  t.setSlaDeadline(PAST);
  return t;
}

/** Build an identical batch twice: same ids, same pinned history. */
function buildBatch(ids: string[]): TaskLifecycle[] {
  return ids.map((id) => openOverdueTask(id));
}

describe("expireOverdueTasks pins the screening now (#1252)", () => {
  it("omitted at: every EXPIRE entry's at is verbatim the screening now", () => {
    const batch = buildBatch(["a", "b", "c"]);
    const results = expireOverdueTasks(batch, NOW);

    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(result.expired, true);
      assert.equal(result.error, undefined);
      assert.equal(result.entry?.at, NOW.toISOString());
      assert.equal(result.task.history.at(-1)!.at, NOW.toISOString());
    }
    assert.deepEqual(
      batch.map((t) => t.state),
      ["EXPIRED", "EXPIRED", "EXPIRED"],
    );
  });

  it("two runs over identical batches produce byte-identical histories", () => {
    const first = buildBatch(["a", "b"]);
    const second = buildBatch(["a", "b"]);

    expireOverdueTasks(first, NOW);
    expireOverdueTasks(second, NOW);

    assert.equal(
      JSON.stringify(first.map((t) => t.history)),
      JSON.stringify(second.map((t) => t.history)),
    );
    // And the entries agree with the screening instant, not the
    // wall clock: re-running later must reproduce the same bytes.
    for (const task of [...first, ...second]) {
      assert.equal(task.history.at(-1)!.at, NOW.toISOString());
    }
  });

  it("an explicit at still wins over the screening now", () => {
    const task = openOverdueTask("pinned");
    const [result] = expireOverdueTasks([task], NOW, LATER_AT);

    assert.equal(result.expired, true);
    assert.equal(result.entry?.at, LATER_AT.toISOString());
    assert.equal(task.history.at(-1)!.at, LATER_AT.toISOString());
    assert.notEqual(task.history.at(-1)!.at, NOW.toISOString());
  });

  it("an explicit at as a canonical string still wins", () => {
    const task = openOverdueTask("pinned-string");
    const [result] = expireOverdueTasks(
      [task],
      NOW,
      "2026-06-20T08:30:00.000Z",
    );

    assert.equal(result.expired, true);
    assert.equal(result.entry?.at, "2026-06-20T08:30:00.000Z");
  });

  it("dry run predicts against the same pin: the landed entry matches the rehearsal", () => {
    const dryTask = openOverdueTask("rehearsed");
    const [dry] = expireOverdueTasks([dryTask], NOW, undefined, {
      dryRun: true,
    });
    assert.equal(dry.wouldExpire, true);
    assert.equal(dry.error, undefined);

    const liveTask = openOverdueTask("rehearsed");
    const [live] = expireOverdueTasks([liveTask], NOW);
    assert.equal(live.expired, true);
    assert.equal(live.entry?.at, NOW.toISOString());
    // The rehearsal agreed with the live run, and the live entry
    // carries exactly the timestamp the rehearsal predicted.
    assert.deepEqual(
      JSON.stringify(liveTask.history),
      JSON.stringify([
        ...dryTask.history,
        { ...live.entry! },
      ]),
    );
  });

  it("dry run now refuses a task whose last entry sits after the screening now, with the live run's exact wording", () => {
    const build = () => {
      const t = new TaskLifecycle("future-entry");
      t.dispatch("PUBLISH", { actor: "poster", at: "2027-01-01T00:00:00.000Z" });
      t.setSlaDeadline(PAST);
      return t;
    };
    const [dry] = expireOverdueTasks([build()], NOW, undefined, {
      dryRun: true,
    });
    assert.equal(dry.wouldExpire, false);
    assert.match(
      dry.error ?? "",
      /invalid dispatch options: at 2026-06-01T00:00:00\.000Z is earlier than the previous entry's at 2027-01-01T00:00:00\.000Z/,
    );

    const twin = build();
    const [live] = expireOverdueTasks([twin], NOW);
    assert.equal(live.expired, false);
    assert.equal(live.error, dry.error);
    assert.ok(!("entry" in live), "failed outcome must not carry an entry");
    assert.equal(twin.state, "OPEN");
  });

  it("an invalid now screens nothing and never throws a bare RangeError", () => {
    const task = openOverdueTask("invalid-now");
    const before = JSON.stringify(task.history);

    assert.deepEqual(expireOverdueTasks([task], new Date(Number.NaN)), []);
    assert.deepEqual(
      expireOverdueTasks([task], new Date(Number.NaN), undefined, {
        dryRun: true,
      }),
      [],
    );
    assert.deepEqual(expireOverdueTasks([], new Date(Number.NaN)), []);
    assert.equal(task.state, "OPEN");
    assert.equal(JSON.stringify(task.history), before);
  });

  it("an invalid now with an explicit at still screens nothing and does not throw", () => {
    const task = openOverdueTask("invalid-now-pinned");
    // The explicit pin short-circuits the now fallback, and the
    // invalid screening instant matches no deadline either way.
    assert.deepEqual(
      expireOverdueTasks([task], new Date(Number.NaN), LATER_AT),
      [],
    );
    assert.equal(task.state, "OPEN");
  });
});
