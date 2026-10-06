import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  allowedEvents,
  transitionTable,
  type TaskEvent,
  type TaskHistoryEntry,
  type TaskState,
} from "../src/index.js";

/**
 * Deterministic property-style tests: fixed-seed random walks through the
 * task lifecycle must never break structural or behavioral invariants.
 *
 * Seed 20261005 is written down in the source so any run is byte-identical;
 * a second run of the same generator is asserted equal to the first.
 */

/** Fixed seed — change this and every expectation below is reproducible. */
const SEED = 20261005;
/** Number of random walks per run. */
const WALKS = 200;
/** Hard step cap per walk — a walk must terminate well before this. */
const MAX_STEPS = 100;

/** mulberry32: tiny, deterministic, good-enough PRNG for test walks. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every event the transition table ever names (for the terminal-lock test). */
const ALL_EVENTS: TaskEvent[] = [
  ...new Set(transitionTable().map((e) => e.event)),
];

const ACTORS = ["contributor", "reviewer", "moderator", "system", "admin"];

interface WalkResult {
  id: string;
  events: TaskEvent[];
  finalState: TaskState;
  historyLength: number;
}

/** One random walk over *legal* events only (from allowedEvents). */
function runWalk(id: string, rand: () => number): WalkResult {
  const task = new TaskLifecycle(id);
  const events: TaskEvent[] = [];
  let steps = 0;
  while (!task.isTerminal && steps < MAX_STEPS) {
    const allowed = allowedEvents(task.state);
    const event = allowed[Math.floor(rand() * allowed.length)];
    const opts: { actor: string; note?: string } = {
      actor: ACTORS[Math.floor(rand() * ACTORS.length)],
    };
    if (rand() < 0.5) opts.note = `walk ${id} step ${steps}`;
    task.dispatch(event, opts);
    events.push(event);
    steps++;
  }
  return { id, events, finalState: task.state, historyLength: task.history.length };
}

/** Structural invariants of the append-only audit history. */
function assertHistoryIntegrity(task: TaskLifecycle): void {
  const history: TaskHistoryEntry[] = [...task.history];
  assert.equal(history.length, task.history.length, "history readable");
  let prevTo: TaskState | null = null;
  let prevAt = -Infinity;
  for (const [i, e] of history.entries()) {
    assert.equal(e.seq, i + 1, `seq strictly increments (${task.id})`);
    if (prevTo === null) {
      assert.equal(e.from, "DRAFT", `walk starts at DRAFT (${task.id})`);
    } else {
      assert.equal(
        e.from,
        prevTo,
        `from/to chain is continuous (${task.id} seq ${e.seq})`,
      );
    }
    const ms = Date.parse(e.at);
    assert.ok(!Number.isNaN(ms), `timestamp is valid ISO (${task.id} seq ${e.seq})`);
    assert.equal(
      new Date(ms).toISOString(),
      e.at,
      `timestamp is canonical ISO (${task.id} seq ${e.seq})`,
    );
    assert.ok(ms >= prevAt, `timestamps are non-decreasing (${task.id} seq ${e.seq})`);
    prevAt = ms;
    prevTo = e.to;
  }
  if (prevTo !== null) {
    assert.equal(prevTo, task.state, `history ends at current state (${task.id})`);
  }
}

test("deterministic walks: no walk ever deadlocks, history stays intact", () => {
  const rand = mulberry32(SEED);
  const terminalStates = new Set<TaskState>();
  for (let i = 0; i < WALKS; i++) {
    const task = new TaskLifecycle(`walk-${i}`);
    let steps = 0;
    while (!task.isTerminal && steps < MAX_STEPS) {
      const allowed = allowedEvents(task.state);
      assert.ok(
        allowed.length > 0,
        `non-terminal state must offer events (${task.state})`,
      );
      const event = allowed[Math.floor(rand() * allowed.length)];
      task.dispatch(event, {
        actor: ACTORS[Math.floor(rand() * ACTORS.length)],
      });
      steps++;
    }
    assert.ok(
      task.isTerminal,
      `walk-${i} terminated instead of hitting the step cap`,
    );
    assert.ok(
      steps <= MAX_STEPS,
      `walk-${i} took ${steps} steps (cap ${MAX_STEPS})`,
    );
    terminalStates.add(task.state);
    assertHistoryIntegrity(task);
  }
  // Seed 20261005 covers all three terminal states: the walks are not
  // collapsing onto a single path.
  assert.deepEqual(
    [...terminalStates].sort(),
    ["ABANDONED", "EXPIRED", "PAID"],
    "walks reach every terminal state",
  );
});

test("deterministic walks: terminal states lock every event", () => {
  const rand = mulberry32(SEED);
  let locked = 0;
  for (let i = 0; i < WALKS; i++) {
    const task = new TaskLifecycle(`lock-${i}`);
    let steps = 0;
    while (!task.isTerminal && steps < MAX_STEPS) {
      const allowed = allowedEvents(task.state);
      task.dispatch(allowed[Math.floor(rand() * allowed.length)]);
      steps++;
    }
    assert.ok(task.isTerminal, `lock-${i} reached a terminal state`);
    for (const event of ALL_EVENTS) {
      assert.throws(
        () => task.dispatch(event),
        /invalid transition/,
        `${event} must be rejected in terminal ${task.state}`,
      );
    }
    locked++;
  }
  assert.equal(locked, WALKS, "every terminal task was locked");
});

test("deterministic walks: fromHistory replays to the same final state", () => {
  const rand = mulberry32(SEED);
  for (let i = 0; i < WALKS; i++) {
    const task = new TaskLifecycle(`replay-${i}`);
    let steps = 0;
    while (!task.isTerminal && steps < MAX_STEPS) {
      const allowed = allowedEvents(task.state);
      const event = allowed[Math.floor(rand() * allowed.length)];
      const opts: { actor: string; note?: string } = {
        actor: ACTORS[Math.floor(rand() * ACTORS.length)],
      };
      if (rand() < 0.5) opts.note = `replay ${i} step ${steps}`;
      task.dispatch(event, opts);
      steps++;
    }
    const rebuilt = TaskLifecycle.fromHistory(`replay-${i}`, task.history);
    assert.equal(
      rebuilt.state,
      task.state,
      `history is the source of truth (${task.id})`,
    );
    assert.deepEqual(
      [...rebuilt.history],
      [...task.history],
      `replayed history deep-equals live history (${task.id})`,
    );
  }
});

test("deterministic walks: same seed reproduces identical walks", () => {
  const a = mulberry32(SEED);
  const b = mulberry32(SEED);
  for (let i = 0; i < WALKS; i++) {
    const ra = runWalk(`repro-a-${i}`, a);
    const rb = runWalk(`repro-b-${i}`, b);
    assert.deepEqual(
      rb.events,
      ra.events,
      `identical event path with seed ${SEED}`,
    );
    assert.equal(
      rb.finalState,
      ra.finalState,
      `identical final state with seed ${SEED}`,
    );
    assert.equal(
      rb.historyLength,
      ra.historyLength,
      `identical history length with seed ${SEED}`,
    );
  }
});
