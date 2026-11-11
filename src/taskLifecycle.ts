/**
 * Task lifecycle state machine for a two-sided human-data marketplace.
 *
 * Reproduced from the DataQuest portfolio case study ("State Machine: Task
 * Lifecycle"): a task moves from creation through contributor capture,
 * reviewer QA, and payout — with explicit handling of the edge cases the
 * case study calls out: abandonment, expiration, and dispute resolution.
 *
 * Roles (from the case study): Contributor (gig worker capturing data),
 * QA Specialist (reviewer), Senior Moderator (dispute arbitration),
 * Researcher/Admin (publishes tasks).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Maximum note length accepted by dispatch() and parseHistory().
 *
 * Rationale: the audit history is append-only and unbounded, and every
 * entry is serialized verbatim by toJSON() / historyToNdjson() when
 * snapshots and NDJSON logs are written to disk. A multi-megabyte note
 * would permanently inflate the persisted log on every export (and its
 * hash chain entry); a 32_768-character ceiling keeps a single note
 * well under ~128 KiB worst case while remaining generous for any
 * honest human annotation. Callers that need larger payloads should
 * store them out-of-band and reference them with a payoutRef/note.
 */
export const MAX_NOTE_LENGTH = 32_768;

export type TaskState =
  | "DRAFT"
  | "OPEN"
  | "ACCEPTED"
  | "CAPTURING"
  | "SUBMITTED"
  | "IN_REVIEW"
  | "APPROVED"
  | "PAYOUT_PENDING"
  | "PAID"
  | "REJECTED"
  | "DISPUTED"
  | "ABANDONED"
  | "EXPIRED";

export type TaskEvent =
  | "PUBLISH"
  | "ACCEPT"
  | "START_CAPTURE"
  | "SUBMIT"
  | "BEGIN_REVIEW"
  | "APPROVE"
  | "REJECT"
  | "RESUBMIT"
  | "REQUEST_PAYOUT"
  | "PAYOUT_COMPLETE"
  | "DISPUTE"
  | "ARBITRATE_APPROVE"
  | "ARBITRATE_REJECT"
  | "ABANDON"
  | "EXPIRE";

const TRANSITIONS: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  DRAFT: { PUBLISH: "OPEN" },
  OPEN: { ACCEPT: "ACCEPTED", EXPIRE: "EXPIRED" },
  ACCEPTED: {
    START_CAPTURE: "CAPTURING",
    ABANDON: "ABANDONED",
    EXPIRE: "EXPIRED",
  },
  CAPTURING: {
    SUBMIT: "SUBMITTED",
    ABANDON: "ABANDONED",
    EXPIRE: "EXPIRED",
  },
  SUBMITTED: { BEGIN_REVIEW: "IN_REVIEW", EXPIRE: "EXPIRED" },
  IN_REVIEW: { APPROVE: "APPROVED", REJECT: "REJECTED" },
  APPROVED: { REQUEST_PAYOUT: "PAYOUT_PENDING" },
  PAYOUT_PENDING: { PAYOUT_COMPLETE: "PAID" },
  PAID: {},
  REJECTED: { DISPUTE: "DISPUTED", RESUBMIT: "CAPTURING" },
  DISPUTED: { ARBITRATE_APPROVE: "APPROVED", ARBITRATE_REJECT: "REJECTED" },
  ABANDONED: {},
  EXPIRED: {},
};

const TERMINAL: ReadonlySet<TaskState> = new Set([
  "PAID",
  "ABANDONED",
  "EXPIRED",
]);

export interface TransitionEdge {
  from: TaskState;
  event: TaskEvent;
  to: TaskState;
}

/**
 * Full transition table: the single source of truth for docs and diagrams.
 * Edges are emitted in declaration order (state, then event within state).
 */
export function transitionTable(): TransitionEdge[] {
  const edges: TransitionEdge[] = [];
  for (const from of Object.keys(TRANSITIONS) as TaskState[]) {
    const events = TRANSITIONS[from];
    for (const event of Object.keys(events) as TaskEvent[]) {
      edges.push({ from, event, to: events[event]! });
    }
  }
  return edges;
}

/**
 * Transition table as canonical JSON (declaration order, 2-space indent).
 * Committed snapshot: test/__snapshots__/transitionTable.snapshot.json.
 */
export function transitionTableJson(): string {
  return JSON.stringify(transitionTable(), null, 2) + "\n";
}

/**
 * Render the transition table as a Mermaid stateDiagram-v2 block.
 * Paste the output into README.md verbatim; test/stateDiagram.test.ts
 * fails if the README copy drifts from this generated text.
 */
export function stateDiagram(): string {
  const lines = ["```mermaid", "stateDiagram-v2", "    direction LR", "    [*] --> DRAFT"];
  for (const { from, event, to } of transitionTable()) {
    lines.push(`    ${from} --> ${to} : ${event}`);
  }
  lines.push("```");
  return lines.join("\n");
}

/** Pure transition function: current state + event -> next state. */
export function transition(state: TaskState, event: TaskEvent): TaskState {
  const next = TRANSITIONS[state][event];
  if (!next) throw new Error(`invalid transition: ${event} from ${state}`);
  return next;
}

const STATES: ReadonlySet<TaskState> = new Set(
  Object.keys(TRANSITIONS) as TaskState[],
);
const EVENTS: ReadonlySet<TaskEvent> = new Set(
  (Object.values(TRANSITIONS) as Partial<Record<TaskEvent, TaskState>>[]).flatMap(
    (edges) => Object.keys(edges) as TaskEvent[],
  ),
);

/** Events allowed from a state (for UI gating). */
export function allowedEvents(state: TaskState): TaskEvent[] {
  return Object.keys(TRANSITIONS[state]) as TaskEvent[];
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

/**
 * Is the task currently past its SLA deadline?
 *
 * Reads the deadline attached to the task's CURRENT state (see
 * TaskLifecycle.setSlaDeadline). Returns false when no deadline is set,
 * and false for terminal states — a completed/abandoned/expired task is
 * no longer "overdue", even if its deadline passed. Advisory only: it
 * never transitions the task; a watchdog dispatches EXPIRE explicitly.
 */
export function isOverdue(task: TaskLifecycle, now: Date = new Date()): boolean {
  const deadline = task.getSlaDeadline(task.state);
  if (deadline === undefined) return false;
  if (task.isTerminal) return false;
  return now.getTime() >= Date.parse(deadline);
}

/**
 * Watchdog helper: from a batch of tasks, return the ones a watchdog
 * should expire right now — non-terminal AND past their SLA deadline.
 *
 * This is just `isOverdue()` over a list, but it captures the documented
 * watchdog pattern so callers do it in one line:
 *
 *   for (const task of expiredTasks(allTasks)) task.dispatch("EXPIRE", { actor: "system" });
 *
 * Pure: reads the tasks, never mutates or dispatches. The `now` default
 * is the real clock, so unit tests pin it to a fixed date.
 *
 * NOTE: this returns every overdue task, including ones `EXPIRE` cannot
 * legally fire on (see {@link expireOverdueTasks}).
 */
export function expiredTasks(
  tasks: readonly TaskLifecycle[],
  now: Date = new Date(),
): TaskLifecycle[] {
  return tasks.filter((task) => isOverdue(task, now));
}

/**
 * Watchdog helper: from a batch of tasks, return the ones whose SLA
 * deadline is coming up — non-terminal AND with a deadline inside the
 * half-open window `(now, now + withinMs]`.
 *
 * This is the "warn before it is too late" counterpart to
 * {@link expiredTasks}: an overdue task (deadline at or before `now`)
 * belongs to `expiredTasks`, not here — the window's lower bound is
 * exclusive, so a task that just crossed its deadline is never reported
 * twice, once by each helper. A task whose deadline lands exactly on
 * `now + withinMs` is included (the upper bound is inclusive: a
 * deadline "within 24 hours" includes one exactly 24 hours out).
 *
 * The deadline read is the one attached to the task's CURRENT state
 * (see {@link isOverdue}) — a deadline set for a state the task has
 * already left does not count, and a task with no deadline for its
 * current state is never selected. Terminal states are never selected,
 * even when a deadline for the terminal state falls inside the window.
 *
 * Pure: reads the tasks, never mutates or dispatches. The `now`
 * default is the real clock, so unit tests pin it to a fixed date.
 * `withinMs` must be a non-negative finite number of milliseconds;
 * an invalid value (or an invalid `now`) fails fast instead of
 * silently returning an empty list.
 *
 *   const atRisk = tasksApproachingDeadline(allTasks, 24 * 3600_000, now);
 *   // nudge the assignee / reassign, before the deadline passes
 */
export function tasksApproachingDeadline(
  tasks: readonly TaskLifecycle[],
  withinMs: number,
  now: Date = new Date(),
): TaskLifecycle[] {
  if (
    typeof withinMs !== "number" ||
    !Number.isFinite(withinMs) ||
    withinMs < 0
  ) {
    throw new Error(
      "invalid tasksApproachingDeadline: withinMs must be a non-negative finite number of milliseconds",
    );
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("invalid now: expected a valid Date");
  }
  return tasks.filter((task) => {
    if (task.isTerminal) return false;
    const deadline = task.getSlaDeadline(task.state);
    if (deadline === undefined) return false;
    const deadlineMs = Date.parse(deadline);
    if (!Number.isFinite(deadlineMs)) return false;
    return deadlineMs > nowMs && deadlineMs <= nowMs + withinMs;
  });
}

/** A task together with its next SLA deadline, as returned by {@link nextSlaDeadline}. */
export interface NextSlaDeadline {
  task: TaskLifecycle;
  /** Canonical ISO deadline attached to the task's current state. */
  deadline: string;
}

/**
 * Scheduler helper: from a batch of tasks, return the single task whose
 * SLA deadline comes next — the earliest current-state deadline strictly
 * after `now` — together with that deadline.
 *
 * This is the "when do I wake up next" counterpart to the watchdog
 * screens: `expiredTasks()` answers "past deadline", and
 * `tasksApproachingDeadline()` answers "inside a warning window", but a
 * scheduler that polls needs one concrete answer — which task expires
 * first, and when — without hand-rolling a min over the batch and
 * risking the same traps: a deadline set for a state the task has
 * already left, a terminal task's deadline, or an already-overdue task
 * that `expiredTasks()` already owns. All three are excluded here: only
 * non-terminal tasks with a deadline attached to their CURRENT state,
 * strictly after `now`, are candidates. A deadline exactly at `now` is
 * overdue, not next, and belongs to `expiredTasks()`.
 *
 * Ties keep input order: when two tasks share the earliest deadline,
 * the first one in the input array wins, so repeated calls over an
 * unchanged batch are stable. Returns undefined when no task qualifies
 * (empty input, no current-state deadlines, or every deadline at or
 * before `now`).
 *
 * Pure: reads the tasks, never mutates or dispatches. The returned
 * `task` is the same object from the input array, so the caller can act
 * on it directly; the returned `deadline` is the canonical ISO string
 * `getSlaDeadline()` already stores. This helper itself never
 * dispatches — when the deadline arrives, expiry still goes through
 * `expireOverdueTasks()`:
 *
 *   const next = nextSlaDeadline(allTasks, now);
 *   // schedule a wake-up at next.deadline, then run expireOverdueTasks()
 *
 * An invalid `now` fails fast instead of silently returning undefined.
 */
export function nextSlaDeadline(
  tasks: readonly TaskLifecycle[],
  now: Date = new Date(),
): NextSlaDeadline | undefined {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("invalid now: expected a valid Date");
  }
  let best: NextSlaDeadline | undefined;
  for (const task of tasks) {
    if (task.isTerminal) continue;
    const deadline = task.getSlaDeadline(task.state);
    if (deadline === undefined) continue;
    // getSlaDeadline() only ever returns canonical ISO (setSlaDeadline
    // normalizes on the way in, snapshot parsing rejects the rest),
    // so this parse cannot fail on library-produced tasks; the
    // finiteness guard is belt-and-braces against a hand-built one.
    const deadlineMs = Date.parse(deadline);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) continue;
    if (best !== undefined && deadlineMs >= Date.parse(best.deadline)) {
      continue;
    }
    best = { task, deadline };
  }
  return best;
}

/**
 * Batch filter: from a batch of tasks, return the ones currently in the
 * given state, in input order.
 *
 * This is the generic counterpart to the watchdog screens: `expiredTasks()`
 * answers "past an absolute SLA deadline" and `staleTasks()` answers
 * "stuck in this state too long", but a caller that simply wants to list
 * every IN_REVIEW task had to hand-write the same filter — and a
 * hand-written filter has no shared answer for an unknown state string.
 * This helper gives that listing one shared, pure entry point:
 *
 *   const inReview = tasksByState(allTasks, "IN_REVIEW");
 *
 * Pure: reads the tasks' current states, never mutates, dispatches, or
 * copies the tasks — the returned array holds the same task objects, in
 * input order, so callers can act on them directly. An unknown state
 * (anything outside the TaskState set) fails fast instead of silently
 * returning an empty list, so a typo ("in_review", "OPENN") cannot masquerade
 * as "no tasks in this state". Terminal states filter exactly like any
 * other state — unlike the watchdog screens, this helper has no
 * terminal exclusion to apply.
 */
export function tasksByState(
  tasks: readonly TaskLifecycle[],
  state: TaskState,
): TaskLifecycle[] {
  if (!STATES.has(state)) {
    throw new Error(`invalid tasksByState: unknown state "${String(state)}"`);
  }
  return tasks.filter((task) => task.state === state);
}

/**
 * Batch filter: from a batch of tasks, return the ones whose audit
 * history contains at least one entry signed by the given actor, in
 * input order.
 *
 * This is the actor counterpart to {@link tasksByState}: a caller that
 * wants to list every task a given moderator ever touched had to
 * hand-write the same history scan — and a hand-written scan has no
 * shared answer for an empty actor string (which dispatch itself
 * rejects: `undefined` is the anonymous form, an empty string is not
 * an actor at all). This helper gives that listing one shared, pure
 * entry point:
 *
 *   const moderated = tasksByActor(allTasks, "moderator");
 *
 * Pure: reads the tasks' histories, never mutates, dispatches, or
 * copies the tasks — the returned array holds the same task objects,
 * in input order, so callers can act on them directly. A task matches
 * as soon as any one history entry carries the actor, and matches only
 * once no matter how many of its entries do. Entries without an actor
 * never match, so anonymous work is never attributed to anyone. An
 * empty or non-string actor fails fast instead of silently returning
 * an empty list, so a typo or a missing variable cannot masquerade
 * as "this actor touched nothing".
 */
export function tasksByActor(
  tasks: readonly TaskLifecycle[],
  actor: string,
): TaskLifecycle[] {
  if (typeof actor !== "string" || actor.length === 0) {
    throw new Error(
      `invalid tasksByActor: actor must be a non-empty string, got ${JSON.stringify(actor)}`,
    );
  }
  return tasks.filter((task) =>
    task.history.some((entry) => entry.actor === actor),
  );
}

/**
 * Batch filter: from a batch of tasks, return the ones whose settlement
 * names the given external payout reference, in input order.
 *
 * This is the payout-reference counterpart to {@link tasksByActor}: a
 * caller that wants to list every task settled under one transfer id
 * (one payout batch, one bank transfer) had to hand-write the same
 * history scan — and a hand-written scan has no shared answer for an
 * empty reference string (which dispatch itself rejects: `undefined`
 * is the advisory form, an empty string is not a reference at all).
 * This helper gives that listing one shared, pure entry point:
 *
 *   const settled = tasksByPayoutRef(allTasks, "xfer-88f2");
 *
 * Only a `PAYOUT_COMPLETE` entry counts. That is the same evidence
 * rule {@link unreconciledPayouts} uses: a reference on
 * `REQUEST_PAYOUT` alone does not reconcile the task, because the
 * request is not the settlement — and a reference attached to any
 * other event (dispatch accepts `payoutRef` as generic audit
 * metadata, like actor/note) is not settlement evidence either. So a
 * task whose completion entry carries no reference never matches, no
 * matter what its request or earlier entries say, and a task whose
 * completion entry carries the reference matches exactly once.
 *
 * Pure: reads the tasks' histories, never mutates, dispatches, or
 * copies the tasks — the returned array holds the same task objects,
 * in input order, so callers can act on them directly. Matching is
 * exact and case-sensitive, like the stored reference itself. An
 * empty or non-string reference fails fast instead of silently
 * returning an empty list, so a typo or a missing variable cannot
 * masquerade as "no task settled under this transfer".
 */
export function tasksByPayoutRef(
  tasks: readonly TaskLifecycle[],
  payoutRef: string,
): TaskLifecycle[] {
  if (typeof payoutRef !== "string" || payoutRef.length === 0) {
    throw new Error(
      `invalid tasksByPayoutRef: payoutRef must be a non-empty string, got ${JSON.stringify(payoutRef)}`,
    );
  }
  return tasks.filter((task) =>
    task.history.some(
      (entry) =>
        entry.event === "PAYOUT_COMPLETE" && entry.payoutRef === payoutRef,
    ),
  );
}

/**
 * Batch filter: from a batch of tasks, return the ones whose audit
 * history contains at least one entry for the given event, in input
 * order.
 *
 * This is the event counterpart to {@link tasksByActor}: a caller
 * that wants to list every task ever disputed, or every task that
 * went through a resubmit round, had to hand-write the same history
 * scan — and a hand-written scan has no shared answer for an
 * unknown event string. This helper gives that listing one shared,
 * pure entry point:
 *
 *   const disputed = tasksByEvent(allTasks, "DISPUTE");
 *
 * Pure: reads the tasks' histories, never mutates, dispatches, or
 * copies the tasks — the returned array holds the same task objects,
 * in input order, so callers can act on them directly. A task
 * matches as soon as any one history entry carries the event, and
 * matches only once no matter how many of its entries do, so a task
 * that resubmitted twice is listed once. Terminal tasks match
 * exactly like any other task — an EXPIRED task still answers "was
 * it ever expired", because the question is about its history, not
 * its current state. An unknown event (anything outside the
 * TaskEvent set, including a state name such as "DISPUTED") fails
 * fast instead of silently returning an empty list, so a typo
 * ("DISPUT") cannot masquerade as "no task ever saw this event".
 */
export function tasksByEvent(
  tasks: readonly TaskLifecycle[],
  event: TaskEvent,
): TaskLifecycle[] {
  if (!EVENTS.has(event)) {
    throw new Error(
      `invalid tasksByEvent: unknown event "${String(event)}"`,
    );
  }
  return tasks.filter((task) =>
    task.history.some((entry) => entry.event === event),
  );
}

/**
 * Combined batch filter: which conditions a task must satisfy to be
 * selected, one per axis of the single-axis selectors.
 *
 * Every field is optional; a field left out (or the whole object left
 * empty) does not filter on that axis. Conditions combine with AND:
 * a task is selected only when it satisfies every condition given.
 */
export interface TasksByFiltersOptions {
  /** Current state the task must be in (same rule as {@link tasksByState}). */
  state?: TaskState;
  /** Actor whose name must appear on at least one history entry (same rule as {@link tasksByActor}). */
  actor?: string;
  /** Event that must appear at least once in the history (same rule as {@link tasksByEvent}). */
  event?: TaskEvent;
  /** Payout reference the `PAYOUT_COMPLETE` entry must carry (same rule as {@link tasksByPayoutRef}). */
  payoutRef?: string;
}

/**
 * Batch filter: from a batch of tasks, return the ones matching every
 * condition given, in input order.
 *
 * This is the combined counterpart to the single-axis selectors
 * {@link tasksByState}, {@link tasksByActor}, {@link tasksByEvent},
 * and {@link tasksByPayoutRef}: a board that wants "tasks the
 * moderator disputed while IN_REVIEW" had to chain the single-axis
 * filters and intersect the results — and each chained filter
 * re-scanned every task's history. This helper does the same
 * intersection in one pass:
 *
 *   const moderatedDisputes = tasksByFilters(allTasks, {
 *     state: "IN_REVIEW",
 *     actor: "moderator",
 *     event: "DISPUTE",
 *   });
 *
 * Pure: reads the tasks' current states and histories, never
 * mutates, dispatches, or copies the tasks — the returned array
 * holds the same task objects, in input order, so callers can act
 * on them directly. An empty condition object selects every task,
 * so the same call shape serves both "everything" and "exactly
 * this slice". Each condition uses its single-axis selector's
 * validation and matching rule, so `state` rejects unknown states,
 * `event` rejects unknown events, and an empty or non-string
 * `actor`/`payoutRef` fails fast instead of silently returning an
 * empty list — a typo in any axis cannot masquerade as "no task
 * matches this combination". The same fail-closed rule covers the
 * filter keys themselves: only `state`, `actor`, `event`, and
 * `payoutRef` are accepted, so a misspelled axis name such as
 * `states` throws `invalid tasksByFilters: unknown filter
 * "states"` instead of being silently ignored and returning the
 * unfiltered batch — and a non-object `filters` argument throws
 * instead of surfacing a `TypeError` from the first property read.
 * Mirrors the escrow state machine's `escrowsByFilters`, which has
 * three axes and no `payoutRef` counterpart.
 */
export function tasksByFilters(
  tasks: readonly TaskLifecycle[],
  filters: TasksByFiltersOptions,
): TaskLifecycle[] {
  if (
    typeof filters !== "object" ||
    filters === null ||
    Array.isArray(filters)
  ) {
    throw new Error(
      `invalid tasksByFilters: filters must be an object, got ${filters === null ? "null" : Array.isArray(filters) ? "array" : typeof filters}`,
    );
  }
  for (const key of Object.keys(filters)) {
    if (
      key !== "state" &&
      key !== "actor" &&
      key !== "event" &&
      key !== "payoutRef"
    ) {
      throw new Error(
        `invalid tasksByFilters: unknown filter "${key}"`,
      );
    }
  }
  if (filters.state !== undefined && !STATES.has(filters.state)) {
    throw new Error(
      `invalid tasksByFilters: unknown state "${String(filters.state)}"`,
    );
  }
  if (
    filters.actor !== undefined &&
    (typeof filters.actor !== "string" || filters.actor.length === 0)
  ) {
    throw new Error(
      `invalid tasksByFilters: actor must be a non-empty string, got ${JSON.stringify(filters.actor)}`,
    );
  }
  if (filters.event !== undefined && !EVENTS.has(filters.event)) {
    throw new Error(
      `invalid tasksByFilters: unknown event "${String(filters.event)}"`,
    );
  }
  if (
    filters.payoutRef !== undefined &&
    (typeof filters.payoutRef !== "string" ||
      filters.payoutRef.length === 0)
  ) {
    throw new Error(
      `invalid tasksByFilters: payoutRef must be a non-empty string, got ${JSON.stringify(filters.payoutRef)}`,
    );
  }
  return tasks.filter((task) => {
    if (filters.state !== undefined && task.state !== filters.state) {
      return false;
    }
    if (
      filters.actor !== undefined &&
      !task.history.some((entry) => entry.actor === filters.actor)
    ) {
      return false;
    }
    if (
      filters.event !== undefined &&
      !task.history.some((entry) => entry.event === filters.event)
    ) {
      return false;
    }
    if (
      filters.payoutRef !== undefined &&
      !task.history.some(
        (entry) =>
          entry.event === "PAYOUT_COMPLETE" &&
          entry.payoutRef === filters.payoutRef,
      )
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Per-task outcome of {@link expireOverdueTasks}.
 */
export interface ExpireOverdueResult {
  /** The task this outcome belongs to. */
  task: TaskLifecycle;
  /** True when the EXPIRE dispatch succeeded and the task is now EXPIRED. */
  expired: boolean;
  /** Set when the EXPIRE dispatch threw; the message of the caught error. */
  error?: string;
  /**
   * The EXPIRE audit entry that the successful dispatch appended — a
   * frozen, detached copy of the task's last history entry, so an SLA
   * operations report can cite it (task id, from/to state, timestamp)
   * without re-reading `task.history`. Present only when `expired` is
   * true; failed dispatches leave this absent.
   */
  entry?: TaskHistoryEntry;
}

/**
 * Fail-fast validation + normalization for the watchdog executors'
 * optional `at` timestamp ({@link expireOverdueTasks},
 * {@link actOnStaleTasks}).
 *
 * A `Date` is normalized with `toISOString()` (already canonical
 * form); a string must already be canonical ISO-8601 — dispatch's
 * own `at` bar (see {@link DispatchOptions}). Anything else — a
 * non-string/non-Date value, an invalid Date, a non-canonical
 * string — throws `invalid at: …` before any task is touched, so a
 * bad pin can never half-stamp a batch. `undefined` means "no pin":
 * the executor dispatches with no `at` and the audit entry carries
 * the wall clock, exactly as before.
 */
function resolveWatchdogAt(at: Date | string | undefined): string | undefined {
  if (at === undefined) return undefined;
  if (at instanceof Date) {
    if (!Number.isFinite(at.getTime())) {
      throw new Error("invalid at: expected a valid Date");
    }
    return at.toISOString();
  }
  if (typeof at === "string" && isCanonicalIso(at)) return at;
  throw new Error(
    `invalid at: expected a canonical ISO-8601 string or a valid Date, got ${
      typeof at === "string" ? JSON.stringify(at) : String(at)
    }`,
  );
}

/**
 * Watchdog executor: attempt an explicit `dispatch("EXPIRE")` for every
 * task that {@link isOverdue} reports as overdue, and report the
 * per-task outcome.
 *
 * This exists because a hand-written loop over `expiredTasks()` has a
 * real trap: `expiredTasks()` only checks the deadline and the terminal
 * flag, but `EXPIRE` is not a legal event from every non-terminal state.
 * `EXPIRE` edges exist only on OPEN, ACCEPTED, CAPTURING and SUBMITTED —
 * an overdue IN_REVIEW task (or any other state without the edge, when a
 * deadline was set for it) throws `invalid transition: EXPIRE from
 * IN_REVIEW`, aborting a naive loop on the first such task. This
 * executor catches the error per task (`expired: false, error:
 * <message>`) and keeps going, so one unexpirable task never blocks the
 * rest of the batch.
 *
 * Successful outcomes also carry `entry` — a frozen, detached copy of
 * the EXPIRE audit entry just appended — so a caller can write an SLA
 * operations report (which task, from which state, when) without
 * re-reading the task's history; failures omit it.
 *
 * Attribution: every successful EXPIRE dispatch is signed with the
 * `system` actor, exactly like {@link actOnStaleTasks}'s default ABANDON
 * action, so a later auditor can tell a watchdog-driven expiry apart
 * from a human-driven EXPIRE dispatch in the append-only history.
 *
 * The optional `at` pins the EXPIRE audit entry's timestamp — pass a
 * `Date` (normalized with `toISOString()`) or a canonical ISO-8601
 * string, and deterministic replays get deterministic watchdog
 * entries instead of wall-clock stamps. Omitted, the dispatch stamps
 * the wall clock, as before: a caller that passed a past `now` for
 * screening sees no silent change. An `at` earlier than a task's last
 * history entry trips dispatch's non-decreasing-timestamp check and
 * lands as a per-task `{ expired: false, error }` — the batch
 * continues, same isolation as an illegal transition. An invalid
 * `at` (a non-Date/non-string value, an invalid Date, a
 * non-canonical string) throws `invalid at: …` before any task is
 * screened or dispatched, so a bad pin can never half-stamp a batch.
 *
 * Same semantics as the manual pattern: nothing auto-migrates. Expiry
 * only happens through an explicit, auditable dispatch that lands in the
 * append-only history. Only overdue (non-terminal, past deadline) tasks
 * are attempted; the result has one entry per attempted task, in batch
 * order. The `now` default is the real clock, so unit tests pin it.
 */
export function expireOverdueTasks(
  tasks: readonly TaskLifecycle[],
  now: Date = new Date(),
  at?: Date | string,
): ExpireOverdueResult[] {
  // Fail fast on a bad `at` before screening or dispatching anything:
  // a malformed pin must never half-stamp a batch.
  const atIso = resolveWatchdogAt(at);
  return expiredTasks(tasks, now).map((task) => {
    try {
      // Attributed to the `system` actor, like actOnStaleTasks' default
      // action: watchdog-driven expiry must stay distinguishable from a
      // human-driven EXPIRE dispatch in the append-only audit trail.
      // `at` pins the audit timestamp (deterministic replay); omitted,
      // the dispatch stamps the wall clock as before.
      task.dispatch("EXPIRE", {
        actor: "system",
        ...(atIso !== undefined ? { at: atIso } : {}),
      });
      // The history getter returns frozen detached copies, so the last
      // entry is already the immutable audit record of this dispatch.
      const history = task.history;
      return { task, expired: true, entry: history[history.length - 1] };
    } catch (err) {
      return {
        task,
        expired: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * Fail-fast validation for `staleTasks()` configuration.
 *
 * Every key must be a known `TaskState`, every value a non-negative finite
 * number of milliseconds (0 is legal: "stale the instant it entered").
 */
function assertMaxAgeByState(
  value: unknown,
): asserts value is Partial<Record<TaskState, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "invalid maxAgeByState: expected an object mapping TaskState to a non-negative millisecond budget",
    );
  }
  for (const [state, maxAge] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!STATES.has(state as TaskState)) {
      throw new Error(`invalid maxAgeByState: unknown state "${state}"`);
    }
    if (
      typeof maxAge !== "number" ||
      !Number.isFinite(maxAge) ||
      maxAge < 0
    ) {
      throw new Error(
        `invalid maxAgeByState: budget for "${state}" must be a non-negative finite number of milliseconds`,
      );
    }
  }
}

/**
 * Watchdog helper: from a batch of tasks, return the ones that have been
 * sitting in their CURRENT non-terminal state longer than the per-state
 * budget — "stale" tasks a watchdog might want to nudge, page, or expire
 * explicitly.
 *
 * The dwell clock starts at the `at` timestamp of the task's most recent
 * history entry (the moment it entered its current state). A task is stale
 * when `now - enteredAt > maxAgeByState[state]` (strictly past the budget).
 * Terminal states are never selected — a completed task cannot be "stale";
 * states absent from the map are ignored (no budget = no staleness). A
 * task with no history yet has no measurable dwell time and is never
 * selected.
 *
 * This is the `expiredTasks()` companion: `expiredTasks()` answers
 * "past an absolute SLA deadline", `staleTasks()` answers "stuck in this
 * state too long" (e.g. nobody picked up an OPEN task, a review has been
 * pending for a week). Pure: reads the tasks, never mutates or dispatches.
 * The `now` default is the real clock, so unit tests pin it to a fixed
 * date.
 *
 *   const stale = staleTasks(allTasks, {
 *     IN_REVIEW: 7 * 24 * 3600_000, // a week
 *     OPEN: 30 * 24 * 3600_000,    // a month
 *   });
 *
 * Prefer {@link actOnStaleTasks} over acting on this list with a
 * hand-written loop: `ABANDON` (the usual stale action) is only a legal
 * event from ACCEPTED and CAPTURING, so a loop that dispatches it on
 * every stale task aborts on the first stale SUBMITTED / IN_REVIEW /
 * OPEN task. The hand-written loop is still the clearest way to see the
 * semantics:
 *
 *   for (const task of stale) {
 *     task.dispatch("ABANDON", { actor: "system" }); // or notify, not expire
 *   }
 */
export function staleTasks(
  tasks: readonly TaskLifecycle[],
  maxAgeByState: Partial<Record<TaskState, number>>,
  now: Date = new Date(),
): TaskLifecycle[] {
  assertMaxAgeByState(maxAgeByState);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("invalid now: expected a valid Date");
  }
  return tasks.filter((task) => {
    if (task.isTerminal) return false;
    const maxAgeMs = maxAgeByState[task.state];
    if (maxAgeMs === undefined) return false;
    const history = task.history;
    if (history.length === 0) return false;
    // parseHistory() validates canonical ISO on every append, so this
    // parse cannot fail on entries produced by dispatch()/fromJSON().
    const enteredAt = Date.parse(history[history.length - 1].at);
    if (!Number.isFinite(enteredAt)) return false;
    return nowMs - enteredAt > maxAgeMs;
  });
}

/** Action {@link actOnStaleTasks} runs for each stale task. */
export type StaleTaskAction = (task: TaskLifecycle) => void;

/**
 * Per-task outcome of {@link actOnStaleTasks}.
 */
export interface StaleActionResult {
  /** The task this outcome belongs to. */
  task: TaskLifecycle;
  /** True when the action ran for this task without throwing. */
  acted: boolean;
  /** Set when the action threw; the message of the caught error. */
  error?: string;
  /**
   * The audit entry the successful action appended — a frozen,
   * detached copy of the task's last history entry, so a stale-patrol
   * report can cite it (task id, from/to state, timestamp) without
   * re-reading `task.history`. Present only when the action ran
   * successfully AND appended to the history (the default ABANDON
   * dispatch does; a notify-only custom action does not). Failed
   * actions leave this absent.
   */
  entry?: TaskHistoryEntry;
}

/**
 * Watchdog executor: run an action for every task {@link staleTasks}
 * selects, and report the per-task outcome.
 *
 * This exists because a hand-written loop over `staleTasks()` has the
 * same trap {@link expireOverdueTasks} fixed for `expiredTasks()`:
 * `staleTasks()` only checks dwell time and the terminal flag, but the
 * usual stale action — `dispatch("ABANDON", { actor: "system" })`, the
 * default here — is not a legal event from every non-terminal state.
 * `ABANDON` edges exist only on ACCEPTED and CAPTURING, so a stale
 * SUBMITTED, IN_REVIEW or OPEN task throws
 * `invalid transition: ABANDON from SUBMITTED` (etc.), aborting a naive
 * loop on the first such task and leaving the rest of the batch
 * unprocessed. This executor catches the error per task
 * (`acted: false, error: <message>`) and keeps going, so one
 * unactionable task never blocks the rest of the batch.
 *
 * Only stale tasks are attempted; the result has one entry per
 * attempted task, in batch order. Non-stale and terminal tasks are
 * untouched and produce no entry. Successful outcomes also carry
 * `entry` — a frozen, detached copy of the audit entry the action
 * appended — when the action actually grew the history (the default
 * ABANDON dispatch does); a notify-only custom action appends
 * nothing, so its successful outcomes omit `entry`, and failed
 * actions omit it as well. Pass a custom `action` to do
 * something other than abandon — e.g. notify-only paging that leaves
 * the task in its current state:
 *
 *   actOnStaleTasks(tasks, (t) => pageOnCall(t.id), budgets);
 *
 * Configuration is validated fail-fast before any action runs:
 * an invalid `maxAgeByState` or `now` (via `staleTasks()`) or a
 * non-function `action` throws and no task is touched. The `now`
 * default is the real clock, so unit tests pin it.
 *
 * The optional `at` pins the default ABANDON dispatch's audit
 * timestamp — a `Date` (normalized with `toISOString()`) or a
 * canonical ISO-8601 string — so deterministic replays get
 * deterministic watchdog entries instead of wall-clock stamps.
 * Omitted, the default dispatch stamps the wall clock, as before.
 * A custom `action` manages its own timestamps: the executor cannot
 * stamp a dispatch it does not make, so `at` is ignored when one is
 * passed (it is still validated fail-fast, so a bad pin is never
 * silently accepted). An `at` earlier than a task's last history
 * entry trips dispatch's non-decreasing-timestamp check and lands
 * as a per-task `{ acted: false, error }` — the batch continues.
 * An invalid `at` throws `invalid at: …` before any action runs.
 */
export function actOnStaleTasks(
  tasks: readonly TaskLifecycle[],
  action: StaleTaskAction | undefined,
  maxAgeByState: Partial<Record<TaskState, number>>,
  now: Date = new Date(),
  at?: Date | string,
): StaleActionResult[] {
  if (action !== undefined && typeof action !== "function") {
    throw new Error("invalid action: expected a function (task) => void");
  }
  // Fail fast on a bad `at` before screening or acting on anything:
  // a malformed pin must never half-stamp a batch. A custom action
  // manages its own timestamps, so `at` only stamps the default
  // ABANDON dispatch below.
  const atIso = resolveWatchdogAt(at);
  const run: StaleTaskAction =
    action ??
    ((task) =>
      task.dispatch("ABANDON", {
        actor: "system",
        ...(atIso !== undefined ? { at: atIso } : {}),
      }));
  // staleTasks() validates maxAgeByState and now fail-fast, before any
  // action runs.
  return staleTasks(tasks, maxAgeByState, now).map((task) => {
    // History is append-only, so growth across the action is exactly
    // "the action appended an audit entry". The history getter returns
    // frozen detached copies, so the last entry is already the
    // immutable audit record of the action — same pattern as
    // expireOverdueTasks().
    const before = task.history.length;
    try {
      run(task);
      const history = task.history;
      return history.length > before
        ? { task, acted: true, entry: history[history.length - 1] }
        : { task, acted: true };
    } catch (err) {
      return {
        task,
        acted: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * Reconciliation helper: from a batch of tasks, return the ones whose
 * settlement lacks external payment evidence — currently PAID, but the
 * `PAYOUT_COMPLETE` audit entry carries no `payoutRef`.
 *
 * This is the reconciliation tooling the `dispatch()` docs point at: a
 * `PAYOUT_COMPLETE` without a `payoutRef` is legal (advisory only — the
 * library cannot verify whether an external payment really happened),
 * so finance ops need a one-liner to find the tasks that still need
 * chasing:
 *
 *   for (const task of unreconciledPayouts(allTasks)) {
 *     alertFinance(task.id, "paid but no payout reference recorded");
 *   }
 *
 * The check looks at the `PAYOUT_COMPLETE` entry (the one that moved the
 * task to PAID), not the `REQUEST_PAYOUT` entry: a reference on the
 * request but none on the completion still means the settlement itself
 * is unevidenced. Defensive: a PAID task with no `PAYOUT_COMPLETE` entry
 * at all is also returned — it cannot arise through the validated
 * construction paths (dispatch/fromJSON/fromHistory all guarantee the
 * entry), but if it ever did, missing completion evidence is exactly
 * what reconciliation should flag, not silently pass.
 *
 * Pure: reads the tasks, never mutates or dispatches. An empty input
 * returns an empty array.
 */
export function unreconciledPayouts(
  tasks: readonly TaskLifecycle[],
): TaskLifecycle[] {
  return tasks.filter((task) => {
    if (task.state !== "PAID") return false;
    let complete: TaskHistoryEntry | undefined;
    for (const entry of task.history) {
      if (entry.event === "PAYOUT_COMPLETE") complete = entry;
    }
    // Defensive: unreachable through dispatch/fromJSON/fromHistory, but
    // a PAID task with no completion entry is reconciliation-worthy too.
    if (complete === undefined) return true;
    return complete.payoutRef === undefined;
  });
}

/** One unreconciled payout together with its age, as returned by {@link payoutAging}. */
export interface PayoutAgingEntry {
  /** Task id of the unreconciled PAID task. */
  id: string;
  /**
   * Whole days from the `PAYOUT_COMPLETE` entry to `now` (floor of the
   * exact age). A completion timestamp in the future — clock skew, not
   * a real age — counts as 0 days, never negative.
   */
  ageDays: number;
}

/** An unreconciled payout with no usable completion timestamp, as returned by {@link payoutAging}. */
export interface UnknownPayoutAgingEntry {
  /** Task id of the unreconciled PAID task. */
  id: string;
}

/** The four-way result of {@link payoutAging}, in input order within each bucket. */
export interface PayoutAgingResult {
  /** Age under 7 whole days (`ageDays < 7`). */
  under7Days: PayoutAgingEntry[];
  /** Age from 7 up to (not including) 30 whole days (`7 <= ageDays < 30`). */
  days7To30: PayoutAgingEntry[];
  /** Age of 30 whole days or more (`ageDays >= 30`). */
  over30Days: PayoutAgingEntry[];
  /** No `PAYOUT_COMPLETE` entry (or no parseable timestamp on it): aged by nothing, dropped by nothing. */
  unknown: UnknownPayoutAgingEntry[];
}

/**
 * Aging helper: from a batch of tasks, bucket the
 * {@link unreconciledPayouts} population by how long its settlement has
 * sat unevidenced — the "how overdue is the chase" answer the bare
 * screen does not give, so finance ops can triage by staleness instead
 * of hand-computing a time difference per task with an ad-hoc origin.
 *
 * The age origin is fixed, not caller-chosen: the `PAYOUT_COMPLETE`
 * entry's `at` timestamp (the last such entry when a history carries
 * more than one, mirroring the entry {@link unreconciledPayouts}
 * reads). Buckets are on whole days, with pinned endpoints: exactly 7
 * days lands in `days7To30`, exactly 30 days lands in `over30Days`.
 * A task in the unreconciled population with no `PAYOUT_COMPLETE`
 * entry at all — unreachable through the validated construction paths,
 * but exactly what the screen's defensive branch flags — goes to
 * `unknown` rather than being silently dropped, as does a completion
 * entry whose timestamp does not parse. Reconciled tasks (a reference
 * on the completion entry) and non-PAID tasks never appear in any
 * bucket: this ages the unreconciled population only, it does not
 * re-screen the batch.
 *
 * Pure: reads the tasks, never mutates or dispatches. An invalid
 * `now` fails fast instead of returning an empty result. The `now`
 * default is the real clock, so unit tests pin it to a fixed date.
 *
 *   const aging = payoutAging(allTasks, now);
 *   // chase over30Days first, then days7To30, then under7Days
 */
export function payoutAging(
  tasks: readonly TaskLifecycle[],
  now: Date = new Date(),
): PayoutAgingResult {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("invalid now: expected a valid Date");
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  const result: PayoutAgingResult = {
    under7Days: [],
    days7To30: [],
    over30Days: [],
    unknown: [],
  };
  for (const task of unreconciledPayouts(tasks)) {
    let complete: TaskHistoryEntry | undefined;
    for (const entry of task.history) {
      if (entry.event === "PAYOUT_COMPLETE") complete = entry;
    }
    if (complete === undefined) {
      result.unknown.push({ id: task.id });
      continue;
    }
    const completedMs = Date.parse(complete.at);
    if (!Number.isFinite(completedMs)) {
      result.unknown.push({ id: task.id });
      continue;
    }
    const ageDays = Math.max(
      0,
      Math.floor((nowMs - completedMs) / DAY_MS),
    );
    const entry: PayoutAgingEntry = { id: task.id, ageDays };
    if (ageDays < 7) result.under7Days.push(entry);
    else if (ageDays < 30) result.days7To30.push(entry);
    else result.over30Days.push(entry);
  }
  return result;
}

/**
 * Convert a major-unit amount to integer minor units (cents), rounding
 * to the nearest cent. This is the single conversion the money helpers
 * use: amounts `dispatch()` writes are guaranteed to be exactly
 * representable in minor units (see {@link DispatchOptions}), so for
 * them the conversion is exact; for a legacy amount read from an old
 * snapshot (sub-cent precision, see {@link TaskHistoryEntry.payoutAmount})
 * it rounds to the nearest cent per entry, never at the batch total.
 *
 * Finite-only: a non-finite input (NaN, ±Infinity) is a caller error,
 * and a finite input whose minor-unit product overflows the double
 * range (`1e308` → `Infinity` cents) is rejected too — either way the
 * converter throws `minor units conversion overflowed: …` instead of
 * handing a silent `Infinity` downstream. `parseHistory`'s legacy
 * acceptance is deliberately untouched: an old log carrying `1e308`
 * still parses; only converting or summing it fails, loudly.
 */
export function toMinorUnits(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error(
      `minor units conversion overflowed: amount must be a finite number, got ${String(amount)}`,
    );
  }
  const minorUnits = Math.round(amount * 100);
  if (!Number.isFinite(minorUnits)) {
    throw new Error(
      `minor units conversion overflowed: ${String(amount)} is too large to represent in minor units`,
    );
  }
  return minorUnits;
}

/**
 * Convert integer minor units (cents) back to a major-unit amount. The
 * input must be an integer — a fractional "minor unit" is a caller
 * error, not a representable amount — so anything else throws.
 */
export function fromMinorUnits(minorUnits: number): number {
  if (!Number.isInteger(minorUnits)) {
    throw new Error(
      `minor units must be an integer, got ${String(minorUnits)}`,
    );
  }
  return minorUnits / 100;
}

/**
 * Format integer minor units (cents) as a fixed two-decimal string for
 * display on statements and reconciliation output: `10098` becomes
 * `"100.98"`, `0` becomes `"0.00"`, and a negative amount keeps its
 * leading minus (`-100` becomes `"-1.00"`). The format is deliberately
 * bare — exactly two decimal places, no thousands separator, no
 * currency symbol — because the currency is the caller's context (the
 * same no-currency convention as {@link toMinorUnits}), and a bare
 * string keeps statement text stable across callers instead of each
 * one inventing its own decimal/separator convention.
 *
 * The input must be an integer, with the same error as
 * {@link fromMinorUnits}; a fractional "minor unit" is a caller error,
 * not a representable amount. The split is done in integer arithmetic
 * (`whole = (abs - cents) / 100`), never through a float division
 * followed by rounding, so large amounts (including
 * `Number.MAX_SAFE_INTEGER`) format exactly, with no precision drift.
 */
export function formatMinorUnits(minorUnits: number): string {
  if (!Number.isInteger(minorUnits)) {
    throw new Error(
      `minor units must be an integer, got ${String(minorUnits)}`,
    );
  }
  const sign = minorUnits < 0 ? "-" : "";
  const abs = Math.abs(minorUnits);
  const cents = abs % 100;
  const whole = (abs - cents) / 100;
  return `${sign}${whole}.${String(cents).padStart(2, "0")}`;
}

/**
 * Parse a strict decimal amount string into integer minor units
 * (cents): `"12.34"` becomes `1234`, `"-0.50"` becomes `-50`. This is
 * the string counterpart to {@link toMinorUnits} for reconciliation
 * and CSV-import callers, who receive amounts as text and previously
 * had to go through `Number()` first — a step that silently accepted
 * `"12.345"` (sub-cent, then rounded by the converter), `"1,234.56"`
 * (thousands separator), and `"1.2e3"` (scientific notation) with no
 * single answer for any of them.
 *
 * The grammar is deliberately narrow: an optional minus sign, at
 * least one digit, and an optional fraction of one or two digits.
 * Surrounding whitespace is trimmed; anything else fails fast —
 * thousands separators, scientific notation, a leading `+`, a bare
 * decimal point (`".5"`), a trailing point (`"12."`), internal
 * whitespace, or any other impurity. An empty (or whitespace-only)
 * string and a non-string input fail fast too. The conversion itself
 * is exact integer arithmetic (via `BigInt`), never a float
 * multiply-and-round, so `"0.29"` is exactly `29` and a value whose
 * minor units exceed `Number.MAX_SAFE_INTEGER` throws instead of
 * returning a rounded-off integer. A zero result is always `0`,
 * never `-0`, so `parseMinorUnits("-0.00") === 0`.
 *
 * Round-trip: `parseMinorUnits(formatMinorUnits(n)) === n` for every
 * integer `n` in the safe range, including negatives.
 */
export function parseMinorUnits(text: string): number {
  if (typeof text !== "string") {
    throw new Error(
      `invalid minor units amount: expected a string, got ${JSON.stringify(text)}`,
    );
  }
  const trimmed = text.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (match === null) {
    throw new Error(
      `invalid minor units amount: ${JSON.stringify(text)} is not a strict decimal amount (optional minus, at most 2 decimal places, no thousands separator, no scientific notation)`,
    );
  }
  const fraction = (match[3] ?? "").padEnd(2, "0");
  const total =
    BigInt(match[2]) * 100n + BigInt(fraction === "" ? "0" : fraction);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `minor units conversion overflowed: ${JSON.stringify(text)} is too large to represent in minor units`,
    );
  }
  const minorUnits = Number(total);
  if (minorUnits === 0) return 0;
  return match[1] === "-" ? -minorUnits : minorUnits;
}

/**
 * Reconciliation helper: sum the actual settled payout amounts across a
 * batch of `PAID` tasks. For each task it reads the `payoutAmount`
 * recorded on its `PAYOUT_COMPLETE` entry (see {@link DispatchOptions})
 * and accumulates the sum in integer minor units
 * ({@link toMinorUnits}), returning the total in major units — so no
 * binary-float error can accumulate across the batch, however many
 * tasks it holds (the same money convention as the sibling
 * escrow-state-machine-ts, applied per entry instead of once at the
 * total).
 *
 * Honest accounting rules, all deliberate:
 *  - only `PAID` tasks contribute; in-flight or otherwise-terminated
 *    tasks are ignored;
 *  - a `PAID` task whose `PAYOUT_COMPLETE` entry carries no `payoutAmount`
 *    contributes 0 — the library cannot observe the external payment, so
 *    this sums only what was recorded, not what was owed;
 *  - per-entry amounts are stored verbatim after `dispatch()` validates
 *    them as minor-unit amounts (at most 2 decimal places); a legacy
 *    entry read from an old snapshot with sub-cent precision is rounded
 *    to the nearest cent per entry by {@link toMinorUnits} (see
 *    {@link TaskHistoryEntry.payoutAmount});
 *  - empty input returns 0.
 *
 * Overflow is fail-fast, not silent: `dispatch()` cannot write a giant
 * amount (its minor-unit round-trip gate rejects it), but a legacy
 * snapshot only checks that `payoutAmount` is finite and ≥ 0, so a
 * legacy `1e308` entry rehydrates fine and its minor-unit conversion
 * overflows to `Infinity`. Summing such a value — or a batch whose
 * individually finite minor-unit amounts sum past the finite range —
 * throws `total paid out computation overflowed: inputs too large`
 * instead of returning `Infinity` and poisoning a reconciliation
 * total. The check runs after every addition, so a single overflowing
 * entry is caught at its own addition rather than only at the return,
 * and no partial total is ever returned. Since backlog #844,
 * `toMinorUnits` itself fails fast on the conversion overflow, so the
 * single-entry case is translated back into this same message here —
 * the read-side error contract is unchanged; only the accumulation
 * case still relies on the per-addition check. This changes only the
 * read side: legacy snapshots stay readable (their acceptance is
 * unchanged); only summing them fails, loudly.
 *
 * Pure: reads the tasks, never mutates or dispatches.
 */
export function totalPaidOut(tasks: readonly TaskLifecycle[]): number {
  let totalMinorUnits = 0;
  for (const task of tasks) {
    if (task.state !== "PAID") continue;
    let complete: TaskHistoryEntry | undefined;
    for (const entry of task.history) {
      if (entry.event === "PAYOUT_COMPLETE") complete = entry;
    }
    if (complete?.payoutAmount !== undefined) {
      // The converter fails fast on a legacy giant (backlog #844); a
      // settled entry's conversion failure is this function's own
      // overflow error, so the #838 read-side contract is unchanged.
      let entryMinorUnits: number;
      try {
        entryMinorUnits = toMinorUnits(complete.payoutAmount);
      } catch {
        throw new Error("total paid out computation overflowed: inputs too large");
      }
      totalMinorUnits += entryMinorUnits;
      if (!Number.isFinite(totalMinorUnits)) {
        throw new Error("total paid out computation overflowed: inputs too large");
      }
    }
  }
  if (!Number.isFinite(totalMinorUnits)) {
    throw new Error("total paid out computation overflowed: inputs too large");
  }
  return totalMinorUnits / 100;
}

/**
 * Reconciliation helper: sum the quoted (owed) amounts across a batch
 * of `PAID` tasks — the batch form of the owed half that
 * {@link payoutMismatch} compares per task, and the pair of
 * {@link totalPaidOut}. For each task it reads the `quotedAmount`
 * recorded on its LAST `ACCEPT` entry (the same derivation
 * {@link payoutMismatch} uses) and accumulates the sum in integer
 * minor units ({@link toMinorUnits}), returning the total in major
 * units — so no binary-float error can accumulate across the batch,
 * however many tasks it holds.
 *
 * Honest accounting rules, all deliberate, aligned with
 * {@link totalPaidOut}:
 *  - only `PAID` tasks contribute; in-flight or otherwise-terminated
 *    tasks are ignored — even one that already carries an `ACCEPT`
 *    quote. A quote is a promise, not a settlement: the batch total
 *    answers "what was owed on the tasks that actually settled", so
 *    an in-flight quote never enters it. Callers that need the
 *    in-flight owed total read each task's `ACCEPT` entry directly.
 *  - a `PAID` task whose last `ACCEPT` entry carries no `quotedAmount`
 *    contributes 0 — the library cannot observe the agreed price, so
 *    this sums only what was recorded, not what was owed in the
 *    abstract;
 *  - the quote is read from the LAST `ACCEPT` entry: a re-quoted task
 *    contributes its latest agreed price, never an earlier one. (The
 *    live state machine permits only one `ACCEPT` per task —
 *    `parseHistory` enforces the transition table — so in practice
 *    the last entry is the only entry; the scan is written
 *    last-wins so the rule stays true for any history the reader
 *    accepts.)
 *  - per-entry amounts are stored verbatim after `dispatch()`
 *    validates them as minor-unit amounts (at most 2 decimal places);
 *    a legacy entry read from an old snapshot with sub-cent precision
 *    is rounded to the nearest cent per entry by {@link toMinorUnits}
 *    (see {@link TaskHistoryEntry.quotedAmount});
 *  - empty input returns 0.
 *
 * Overflow is fail-fast, not silent, with the same shape as
 * {@link totalPaidOut}: `dispatch()` cannot write a giant amount (its
 * minor-unit round-trip gate rejects it), but a legacy snapshot only
 * checks that `quotedAmount` is finite and ≥ 0, so a legacy `1e308`
 * entry rehydrates fine and its minor-unit conversion overflows to
 * `Infinity`. Summing such a value — or a batch whose individually
 * finite minor-unit amounts sum past the finite range — throws
 * `total quoted computation overflowed: inputs too large` instead of
 * returning `Infinity` and poisoning a reconciliation total. The
 * check runs after every addition, so a single overflowing entry is
 * caught at its own addition rather than only at the return, and no
 * partial total is ever returned. Since backlog #844,
 * `toMinorUnits` itself fails fast on the conversion overflow, so the
 * single-entry case is translated back into this same message here —
 * the read-side error contract mirrors `totalPaidOut`; only the
 * accumulation case still relies on the per-addition check. This
 * changes only the read side: legacy snapshots stay readable (their
 * acceptance is unchanged); only summing them fails, loudly.
 *
 * Together with {@link totalPaidOut} this closes the batch
 * quoted-vs-settled comparison: `totalQuoted(tasks) -
 * totalPaidOut(tasks)` is the batch's net owed-minus-settled gap.
 * That gap equals the sum of `quoted - paid` over the tasks
 * {@link mismatchedPayouts} flags — each {@link payoutMismatch}
 * `delta` is `paid - quoted`, so the batch gap is the negated sum of
 * the per-task deltas — if and only if every `PAID` task in the batch
 * carries a recorded quote. A `PAID` task with no quote contributes 0
 * to `totalQuoted` but its settled amount to `totalPaidOut`, so the
 * gap additionally absorbs that settled amount: with quoteless
 * settled tasks the gap is the negated delta sum minus the settled
 * amounts of the quoteless `PAID` tasks. The demo batch pins the
 * shape (backlog #954): gap -9849 against a -249.5 delta sum, the
 * -10098.5 difference being exactly DEMO-001's quoteless settlement.
 * Do not read the gap as a pure per-task mismatch sum on a batch that
 * may contain quoteless settled tasks.
 *
 * Pure: reads the tasks, never mutates or dispatches.
 */
export function totalQuoted(tasks: readonly TaskLifecycle[]): number {
  let totalMinorUnits = 0;
  for (const task of tasks) {
    if (task.state !== "PAID") continue;
    let accept: TaskHistoryEntry | undefined;
    for (const entry of task.history) {
      if (entry.event === "ACCEPT") accept = entry;
    }
    if (accept?.quotedAmount !== undefined) {
      // The converter fails fast on a legacy giant (backlog #844); a
      // quoted entry's conversion failure is this function's own
      // overflow error, mirroring totalPaidOut's #838 contract.
      let entryMinorUnits: number;
      try {
        entryMinorUnits = toMinorUnits(accept.quotedAmount);
      } catch {
        throw new Error("total quoted computation overflowed: inputs too large");
      }
      totalMinorUnits += entryMinorUnits;
      if (!Number.isFinite(totalMinorUnits)) {
        throw new Error("total quoted computation overflowed: inputs too large");
      }
    }
  }
  if (!Number.isFinite(totalMinorUnits)) {
    throw new Error("total quoted computation overflowed: inputs too large");
  }
  return totalMinorUnits / 100;
}

/**
 * One batch's quoted-vs-settled settlement summary, as returned by
 * {@link summarizeTaskSettlements}. All money figures are integer
 * minor units (cents) — the same {@link toMinorUnits} convention as
 * {@link totalQuoted} and {@link totalPaidOut} — so no binary-float
 * error can leak into a reconciliation total, however many tasks the
 * batch holds.
 */
export interface TaskSettlementsSummary {
  /** Number of tasks in the batch, of every state. */
  tasks: number;
  /** Number of `PAID` tasks in the batch. */
  paid: number;
  /** Sum of the last `ACCEPT` quotes across `PAID` tasks, in minor units. */
  quotedTotal: number;
  /** Sum of the recorded `PAYOUT_COMPLETE` amounts across `PAID` tasks, in minor units. */
  paidTotal: number;
  /**
   * `quotedTotal - paidTotal`, in minor units: the batch's net
   * owed-minus-settled gap. Negative means the batch settled more
   * than it was quoted.
   */
  gap: number;
  /**
   * Number of `PAID` tasks whose settled amount differs from their
   * quote — the {@link payoutMismatch} population, the same tasks
   * {@link mismatchedPayouts} returns.
   */
  mismatched: number;
  /**
   * Number of `PAID` tasks with no recorded quote on their last
   * `ACCEPT` entry (or no `ACCEPT` entry at all).
   */
  unquotedPaid: number;
  /**
   * Settled amount of the `unquotedPaid` tasks, in minor units — the
   * part of `paidTotal` the gap cannot attribute to a quote.
   */
  unquotedPaidTotal: number;
}

/**
 * Reconciliation helper: summarize a whole batch's quoted-vs-settled
 * position in one call — the one-call form of the
 * {@link totalQuoted} / {@link totalPaidOut} pair, plus the two
 * splits a caller otherwise has to hand-scan for: how many `PAID`
 * tasks actually mismatch their quote, and how much settled money
 * has no recorded quote behind it. Until now a caller doing batch
 * reconciliation had to run the three helpers and re-derive the
 * quoteless deviation itself, and the gap's identity premise (every
 * `PAID` task carries a quote) was scattered across
 * {@link totalQuoted}'s documentation instead of being visible in
 * the numbers.
 *
 * Honest accounting rules, all deliberate, aligned with
 * {@link totalQuoted} and {@link totalPaidOut}:
 *  - `tasks` counts every task in the batch, of every state; only
 *    `PAID` tasks contribute to any money figure or to `paid`,
 *    `mismatched`, or the `unquotedPaid*` counts — a quote on an
 *    in-flight or otherwise-terminated task is a promise, not a
 *    settlement, so it never enters a total;
 *  - `quotedTotal` reads the quote from the LAST `ACCEPT` entry and
 *    `paidTotal` from the `PAYOUT_COMPLETE` entry, the same
 *    derivations `totalQuoted` and `totalPaidOut` use; a `PAID` task
 *    with no recorded quote contributes 0 to `quotedTotal` and is
 *    counted in `unquotedPaid`, with its settled amount in
 *    `unquotedPaidTotal`;
 *  - `gap` is `quotedTotal - paidTotal`, so the demo batch's gap
 *    (-984900 minor units) is the same -9849 major units
 *    `totalQuoted(tasks) - totalPaidOut(tasks)` reports;
 *  - `mismatched` counts the tasks `payoutMismatch` flags — both
 *    amounts recorded and different — so a task settled exactly as
 *    quoted, or one missing either amount, is never counted.
 *
 * The gap identity, now visible in the numbers instead of only in
 * documentation: `gap + unquotedPaidTotal` equals the negated sum of
 * the per-task `payoutMismatch` deltas (in minor units), for every
 * batch — the quoteless settled money is the only thing that can
 * push the gap away from the mismatch sum. A batch where every
 * `PAID` task carries a quote has `unquotedPaidTotal === 0`, so the
 * gap is exactly the negated delta sum.
 *
 * Single-currency, by construction: tasks carry no currency field
 * (the same no-currency convention as {@link toMinorUnits}), so the
 * summary is a single-currency figure — a batch mixing currencies
 * must be grouped by currency by the caller first, or the totals
 * silently add unlike money.
 *
 * Overflow is fail-fast, not silent, with the same shape as
 * {@link totalQuoted} and {@link totalPaidOut}: a legacy snapshot
 * amount whose minor-unit conversion overflows, or a batch whose
 * individually finite minor-unit amounts sum past the finite range,
 * throws `task settlements summary computation overflowed: inputs
 * too large` instead of returning a poisoned summary. The check runs
 * after every addition, so a single overflowing entry is caught at
 * its own addition rather than only at the return, and no partial
 * summary is ever returned. This changes only the read side: legacy
 * snapshots stay readable (their acceptance is unchanged); only
 * summarizing them fails, loudly.
 *
 * Pure: reads the tasks, never mutates or dispatches. An empty input
 * returns an all-zero summary.
 */
export function summarizeTaskSettlements(
  tasks: readonly TaskLifecycle[],
): TaskSettlementsSummary {
  const overflow = (): Error =>
    new Error(
      "task settlements summary computation overflowed: inputs too large",
    );
  let paid = 0;
  let quotedTotal = 0;
  let paidTotal = 0;
  let mismatched = 0;
  let unquotedPaid = 0;
  let unquotedPaidTotal = 0;
  for (const task of tasks) {
    if (task.state !== "PAID") continue;
    paid += 1;
    let accept: TaskHistoryEntry | undefined;
    let complete: TaskHistoryEntry | undefined;
    for (const entry of task.history) {
      if (entry.event === "ACCEPT") accept = entry;
      if (entry.event === "PAYOUT_COMPLETE") complete = entry;
    }
    let quotedMinorUnits = 0;
    if (accept?.quotedAmount !== undefined) {
      // The converter fails fast on a legacy giant (backlog #844); a
      // quoted entry's conversion failure is this function's own
      // overflow error, mirroring totalQuoted's #838 contract.
      try {
        quotedMinorUnits = toMinorUnits(accept.quotedAmount);
      } catch {
        throw overflow();
      }
    } else {
      unquotedPaid += 1;
    }
    let paidMinorUnits = 0;
    if (complete?.payoutAmount !== undefined) {
      // Same fail-fast translation as the quoted half, mirroring
      // totalPaidOut's contract.
      try {
        paidMinorUnits = toMinorUnits(complete.payoutAmount);
      } catch {
        throw overflow();
      }
    }
    if (accept?.quotedAmount === undefined) {
      unquotedPaidTotal += paidMinorUnits;
      if (!Number.isFinite(unquotedPaidTotal)) throw overflow();
    }
    quotedTotal += quotedMinorUnits;
    if (!Number.isFinite(quotedTotal)) throw overflow();
    paidTotal += paidMinorUnits;
    if (!Number.isFinite(paidTotal)) throw overflow();
    if (payoutMismatch(task) !== undefined) mismatched += 1;
  }
  const gap = quotedTotal - paidTotal;
  if (!Number.isFinite(gap)) throw overflow();
  return {
    tasks: tasks.length,
    paid,
    quotedTotal,
    paidTotal,
    gap,
    mismatched,
    unquotedPaid,
    unquotedPaidTotal,
  };
}

/**
 * One task's quoted-vs-settled discrepancy, as returned by
 * {@link payoutMismatch}.
 */
export interface PayoutMismatch {
  /** Quoted (owed) amount from the last `ACCEPT` entry. */
  quoted: number;
  /** Actually settled amount from the `PAYOUT_COMPLETE` entry. */
  paid: number;
  /**
   * `paid - quoted`, rounded to cents (the same
   * `Math.round(x * 100) / 100` convention as {@link totalPaidOut}):
   * negative means the task was underpaid, positive overpaid.
   */
  delta: number;
}

/**
 * Reconciliation helper: compare what a `PAID` task was quoted (owed)
 * against what actually settled.
 *
 * The quote is the `quotedAmount` on the LAST `ACCEPT` entry; the
 * settled amount is the `payoutAmount` on the `PAYOUT_COMPLETE` entry
 * (the same entry {@link totalPaidOut} reads). Returns
 * `{ quoted, paid, delta }` with `delta = paid - quoted` rounded to
 * cents — negative is an underpayment, positive an overpayment.
 *
 * Returns `undefined` — "no mismatch to report" — when:
 *  - the task is not `PAID` (nothing has settled yet, or never will);
 *  - either amount was never recorded (no `ACCEPT` quote, or no
 *    `PAYOUT_COMPLETE` amount — the library cannot compare what it
 *    cannot observe);
 *  - `quoted === paid` exactly (settled as agreed).
 *
 * Pure: reads the task, never mutates or dispatches.
 */
export function payoutMismatch(task: TaskLifecycle): PayoutMismatch | undefined {
  if (task.state !== "PAID") return undefined;
  let quoted: number | undefined;
  let paid: number | undefined;
  for (const entry of task.history) {
    if (entry.event === "ACCEPT") {
      quoted = entry.quotedAmount;
    }
    if (entry.event === "PAYOUT_COMPLETE") {
      paid = entry.payoutAmount;
    }
  }
  if (quoted === undefined || paid === undefined) return undefined;
  if (quoted === paid) return undefined;
  const delta = Math.round((paid - quoted) * 100) / 100;
  return { quoted, paid, delta: delta === 0 ? 0 : delta };
}

/**
 * Reconciliation helper: from a batch of tasks, return the ones whose
 * settled payout differs from the quoted amount — the batch form of
 * {@link payoutMismatch}, mirroring {@link unreconciledPayouts}' pure
 * screening style:
 *
 *   for (const task of mismatchedPayouts(allTasks)) {
 *     const { quoted, paid, delta } = payoutMismatch(task)!;
 *     alertFinance(task.id, `quoted ${quoted}, paid ${paid} (delta ${delta})`);
 *   }
 *
 * Tasks that are not `PAID`, lack either recorded amount, or settled
 * exactly as quoted are never selected. Pure: reads the tasks, never
 * mutates or dispatches. An empty input returns an empty array.
 */
export function mismatchedPayouts(
  tasks: readonly TaskLifecycle[],
): TaskLifecycle[] {
  return tasks.filter((task) => payoutMismatch(task) !== undefined);
}

/**
 * One row of an external payout ledger, as handed to
 * {@link reconcilePayouts}. The shape is deliberately minimal: the
 * reference that pairs a ledger row with a task, and the amount the
 * ledger says was paid, in the same major-unit, at-most-2-decimal
 * convention as the `PAYOUT_COMPLETE` entry's `payoutAmount`. Extra
 * fields on a caller-supplied row are ignored, never compared.
 */
export interface LedgerPayout {
  /** External payment reference, pairing with a task's `payoutRef`. */
  payoutRef: string;
  /** Amount the ledger records for this reference, if recorded. */
  payoutAmount?: number;
}

/**
 * One amount disagreement found by {@link reconcilePayouts}: the task
 * and the ledger row agree on the reference but not on the amount.
 * Either side's amount is `undefined` only when it was never recorded,
 * which is not a disagreement (see {@link reconcilePayouts}).
 */
export interface ReconcileAmountMismatch {
  /** The task whose settled amount disagrees with the ledger. */
  task: TaskLifecycle;
  /** The ledger row carrying the same reference. */
  ledger: LedgerPayout;
  /** Settled amount from the task's `PAYOUT_COMPLETE` entry. */
  taskAmount: number;
  /** Amount recorded on the ledger row. */
  ledgerAmount: number;
}

/**
 * The five-way result of {@link reconcilePayouts}. Every group keeps
 * input order; task groups hold the same task objects, and
 * `ledgerOnly` holds the same ledger objects, so callers can act on
 * them directly.
 */
export interface ReconcilePayoutsResult {
  /** PAID tasks whose reference and (where both recorded) amount agree with a ledger row. */
  matched: TaskLifecycle[];
  /** PAID tasks with a reference no ledger row carries. */
  taskOnly: TaskLifecycle[];
  /** Ledger rows whose reference no PAID task carries. */
  ledgerOnly: LedgerPayout[];
  /** PAID tasks paired by reference but disagreeing on amount. */
  amountMismatch: ReconcileAmountMismatch[];
  /**
   * PAID tasks with no reference on their `PAYOUT_COMPLETE` entry —
   * the same population {@link unreconciledPayouts} returns. They
   * enter no pairing at all: without a reference there is nothing to
   * pair them against, and silently matching them to a ledger row
   * would invent evidence the audit log does not contain.
   */
  unreconciled: TaskLifecycle[];
}

/**
 * Reconciliation helper: pair a batch of tasks against an external
 * payout ledger, by `payoutRef`.
 *
 * This is the half of reconciliation the task-side screens cannot do:
 * {@link unreconciledPayouts} finds PAID tasks with no reference at
 * all, and {@link mismatchedPayouts} compares a task against its own
 * quote, but neither can see whether the money actually left the
 * external account. Pairing against the ledger closes that gap in
 * both directions — a task the ledger never paid, and a ledger
 * payment no task accounts for:
 *
 *   const { matched, taskOnly, ledgerOnly, amountMismatch, unreconciled } =
 *     reconcilePayouts(allTasks, ledgerRows);
 *
 * Pairing rules, all following the same evidence rule
 * {@link tasksByPayoutRef} uses:
 *  - only `PAID` tasks enter pairing, and only their `PAYOUT_COMPLETE`
 *    entry counts: a reference on `REQUEST_PAYOUT` or any other event
 *    is not settlement evidence, and a non-PAID task has not settled;
 *  - the task side's reference and amount are read from the last
 *    `PAYOUT_COMPLETE` entry, the same entry {@link totalPaidOut}
 *    reads (a PAID task with no such entry at all is defensive-only
 *    through the validated paths, and lands in `unreconciled`, as in
 *    {@link unreconciledPayouts});
 *  - several tasks may share one reference (one transfer settling a
 *    batch): each pairs against the same ledger row independently,
 *    and the row is consumed, never `ledgerOnly`;
 *  - an amount disagreement is reported only when both sides recorded
 *    an amount and they differ exactly. When either side recorded no
 *    amount, the library cannot compare what it cannot observe
 *    (the same rule {@link payoutMismatch} uses), so the task lands
 *    in `matched` on the reference alone — the missing amount is
 *    still visible to the caller, because `matched` holds the task
 *    itself, not a claim that amounts were verified.
 *
 * Fail-fast, before any pairing: a ledger row that is not an object,
 * carries an empty or non-string `payoutRef`, or carries a
 * non-finite or negative `payoutAmount` throws, and a reference
 * appearing twice in the ledger throws `duplicate ledger payoutRef`
 * — a duplicated ledger row would otherwise make "matched" ambiguous
 * (which row did the task pair with?). The task side needs no such
 * check: duplicate references across tasks are legitimate batch
 * settlements, as above.
 *
 * Pure: reads the tasks and the ledger rows, never mutates,
 * dispatches, or copies them. An empty task batch and an empty ledger
 * return five empty groups.
 */
export function reconcilePayouts(
  tasks: readonly TaskLifecycle[],
  ledger: readonly LedgerPayout[],
): ReconcilePayoutsResult {
  const ledgerByRef = new Map<string, LedgerPayout>();
  for (const row of ledger) {
    if (row === null || typeof row !== "object") {
      throw new Error(
        `invalid reconcilePayouts: ledger entry must be an object, got ${JSON.stringify(row)}`,
      );
    }
    if (typeof row.payoutRef !== "string" || row.payoutRef.length === 0) {
      throw new Error(
        `invalid reconcilePayouts: ledger payoutRef must be a non-empty string, got ${JSON.stringify(row.payoutRef)}`,
      );
    }
    if (
      row.payoutAmount !== undefined &&
      (typeof row.payoutAmount !== "number" ||
        !Number.isFinite(row.payoutAmount) ||
        row.payoutAmount < 0)
    ) {
      throw new Error(
        `invalid reconcilePayouts: ledger payoutAmount must be a non-negative finite number, got ${String(row.payoutAmount)}`,
      );
    }
    if (ledgerByRef.has(row.payoutRef)) {
      throw new Error(
        `invalid reconcilePayouts: duplicate ledger payoutRef: ${JSON.stringify(row.payoutRef)}`,
      );
    }
    ledgerByRef.set(row.payoutRef, row);
  }

  const result: ReconcilePayoutsResult = {
    matched: [],
    taskOnly: [],
    ledgerOnly: [],
    amountMismatch: [],
    unreconciled: [],
  };
  const seenRefs = new Set<string>();
  for (const task of tasks) {
    if (task.state !== "PAID") continue;
    let complete: TaskHistoryEntry | undefined;
    for (const entry of task.history) {
      if (entry.event === "PAYOUT_COMPLETE") complete = entry;
    }
    if (complete === undefined || complete.payoutRef === undefined) {
      result.unreconciled.push(task);
      continue;
    }
    const ref = complete.payoutRef;
    seenRefs.add(ref);
    const row = ledgerByRef.get(ref);
    if (row === undefined) {
      result.taskOnly.push(task);
      continue;
    }
    if (
      complete.payoutAmount !== undefined &&
      row.payoutAmount !== undefined &&
      complete.payoutAmount !== row.payoutAmount
    ) {
      result.amountMismatch.push({
        task,
        ledger: row,
        taskAmount: complete.payoutAmount,
        ledgerAmount: row.payoutAmount,
      });
      continue;
    }
    result.matched.push(task);
  }
  for (const row of ledger) {
    if (!seenRefs.has(row.payoutRef)) result.ledgerOnly.push(row);
  }
  return result;
}

export interface TaskHistoryEntry {
  seq: number;
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
  at: string; // ISO timestamp
  actor?: string; // contributor | reviewer | moderator | system
  note?: string;
  /**
   * External payment reference (payout batch id, transfer id, …) for
   * settlement reconciliation. Conventionally attached to
   * `REQUEST_PAYOUT` / `PAYOUT_COMPLETE` entries via
   * `dispatch(event, { payoutRef })`; unlike `note`, it is a typed,
   * queryable field instead of free text. A `PAYOUT_COMPLETE` entry
   * without one is allowed but discouraged (see dispatch) — the library
   * cannot know whether an external payment really happened.
   */
  payoutRef?: string;
  /**
   * Actual settled payout amount (in the currency the external payment
   * used) for settlement reconciliation. Conventionally attached to the
   * `PAYOUT_COMPLETE` entry via `dispatch(event, { payoutAmount })`:
   * `payoutRef` says *which transfer*, this says *how much*. A
   * `PAYOUT_COMPLETE` entry without one is legal — the library cannot
   * observe the external payment — and counts as 0 in
   * {@link totalPaidOut} (documented as "sums only what was recorded").
   *
   * Stored verbatim on the audit entry once `dispatch()` has validated
   * it as a minor-unit amount (at most 2 decimal places, see
   * {@link DispatchOptions}); the {@link totalPaidOut} helper
   * accumulates such amounts in integer minor units. A legacy entry
   * read from an old snapshot may still carry sub-cent precision —
   * `parseHistory` deliberately does not reject it, so old audit logs
   * stay readable; only new `dispatch()` writes are gated.
   */
  payoutAmount?: number;
  /**
   * Quoted (owed) payout amount — what the task was agreed to pay,
   * as opposed to {@link payoutAmount}, which records what actually
   * settled. Conventionally attached to the `ACCEPT` entry via
   * `dispatch("ACCEPT", { quotedAmount })`: acceptance is the moment
   * the price is agreed. A task without one simply has no recorded
   * quote — the library cannot invent what was owed.
   *
   * Stored verbatim on the audit entry once `dispatch()` has validated
   * it as a minor-unit amount (at most 2 decimal places), exactly like
   * `payoutAmount` — and, like `payoutAmount`, a legacy entry read from
   * an old snapshot may still carry sub-cent precision without being
   * rejected. The {@link payoutMismatch} helper compares the last
   * `ACCEPT` quote against the `PAYOUT_COMPLETE` settled amount for
   * settlement reconciliation.
   */
  quotedAmount?: number;
  /**
   * Hash-chain link to the previous audit entry (see the "Audit-history
   * hash chain" section). `dispatch()` writes both fields on every
   * entry: `prevHash` is the previous entry's `hash` (the genesis
   * entry's `prevHash` is the {@link GENESIS_PREV_HASH} constant), and
   * `hash = sha256(canonical(entry sans hash) + prevHash)` — or, when
   * the task was constructed with
   * {@link TaskLifecycleOptions.auditSecret},
   * `hash = hmac_sha256(secret, canonical(entry sans hash) + prevHash)`
   * (keyed mode; the canonical bytes are identical either way).
   *
   * Entries produced before this feature existed carry neither field —
   * they are legacy and still accepted everywhere (see
   * {@link parseHistory} and {@link verifyHistoryChain}); the two fields
   * are all-or-nothing per entry and per history. The `| undefined` is
   * deliberate: adversarial shapes handed to {@link verifyHistoryChain}
   * may set either field explicitly to `undefined` (a hash deleted on
   * one entry), and verification must answer `false`, never throw.
   */
  prevHash?: string | undefined;
  /**
   * Content hash of this entry within the audit-history hash chain.
   * Recomputed by {@link verifyHistoryChain} (and enforced by
   * {@link parseHistory}); rewriting any field of a chained entry
   * invalidates it. See `prevHash` for the chaining rule.
   */
  hash?: string | undefined;
}

/**
 * Event-level RBAC policy: which actor names may dispatch which events.
 *
 * The map is partial — an event absent from the policy is unrestricted
 * (any caller, with or without an actor). An event present in the policy
 * requires `dispatch` to carry an `actor` that exactly matches one of the
 * listed names (exact string equality, case-sensitive); anything else
 * throws `actor not authorized for …`.
 *
 * This is a caller-supplied allowlist, not identity: the library cannot
 * verify who "senior-moderator" really is. It only guarantees the audit
 * trail records the actor string it was given, and that dispatches
 * violating the declared policy never happen. Like `maxResubmits`, the
 * policy is task configuration: it survives `toJSON()`/`fromJSON()`
 * round-trips and can be re-attached on `fromHistory()`.
 */
export type RolePolicy = Partial<Record<TaskEvent, string[]>>;

/**
 * Constructor options for TaskLifecycle.
 *
 * `maxResubmits` caps how many times `dispatch("RESUBMIT")` may run on
 * this task — a retry budget, defaulting to `Infinity` (unlimited, exactly
 * the pre-budget behavior). Must be a non-negative integer or `Infinity`;
 * anything else throws `invalid option: …` at construction. The count of
 * used resubmits is derived from the append-only history (the entries are
 * the audit truth), so it survives `toJSON()`/`fromJSON()` round-trips
 * automatically: only the budget itself is stored in the snapshot
 * envelope.
 *
 * `maxDisputes` caps how many appeal rounds — `dispatch("DISPUTE")`
 * (REJECTED → DISPUTED → arbitration → back to REJECTED or on to
 * APPROVED) — a task may run. Same rules as `maxResubmits`: non-negative
 * integer or `Infinity` (default unlimited, exactly the pre-budget
 * behavior), used count derived from the history, only the finite budget
 * stored in the snapshot envelope. This is the task-level answer to the
 * "bound appeals" production habit.
 *
 * `maxVisitsByState` caps how many times the task may ENTER each listed
 * state — a per-state visit budget, for the "a task bouncing between
 * CAPTURING and REJECTED forever" shape that the event budgets cannot
 * express: `maxResubmits` counts RESUBMIT actions, but one resubmit can
 * carry the task through several states, and a task can re-enter a state
 * without any budgeted event at all. A visit is counted as 1 for the
 * task's initial state (the first history entry's `from`, or the current
 * state when the history is still empty) plus 1 per history entry whose
 * `to` is that state — so the count is derived from the append-only
 * history, exactly like the event budgets, and survives `toJSON()` /
 * `fromJSON()` round-trips without resetting. States absent from the map
 * are unlimited, and omitting the map disables the check entirely (the
 * pre-budget behavior). Each budget must be a positive integer — 0
 * would already be spent by the initial visit itself, so it is a
 * construction error, not a usable budget; anything else throws
 * `invalid option: …` at construction. Only a non-empty map is stored
 * in the snapshot envelope (an empty map is omitted, keeping legacy
 * snapshots byte-identical), and `fromHistory()` re-attaches it via
 * opts like the other budgets.
 *
 * `rolePolicy` is an optional {@link RolePolicy}: event → allowed actor
 * names. Events not listed are unrestricted; omitting the policy disables
 * the check entirely (the pre-policy behavior). Invalid policies throw
 * `invalid option: …` at construction.
 *
 * `idempotencyKeys` is an optional list of already-consumed dispatch
 * idempotency keys to seed the task with — the re-attachment path for
 * `fromHistory()`, whose audit log cannot carry the key set (keys are
 * dispatch configuration, not audit data). Each key must be a non-empty
 * string; duplicates are deduped. Keys restored this way (or via
 * `fromJSON()`, which reads them from the snapshot envelope) keep their
 * exactly-once effect: dispatching with one is a no-op. Invalid values
 * throw `invalid option: …` at construction.
 *
 * `requirePayoutRef` is an optional boolean (default `false`): when
 * `true`, `dispatch("PAYOUT_COMPLETE")` without a `payoutRef` throws
 * `payout reference required: …` and appends nothing. This is the
 * opt-in up-front counterpart to the advisory default and the
 * `unreconciledPayouts()` post-hoc reconciliation helper — for payout
 * flows where an external transfer reference always exists. The switch
 * is task configuration, not audit data: it is never written into the
 * `toJSON()` snapshot envelope (unlike `maxDisputes`/`maxResubmits`,
 * whose finite budgets are stored), so a rehydrated task must re-enable
 * it via `fromHistory(id, history, { requirePayoutRef: true })`. Invalid
 * values throw `invalid option: …` at construction.
 *
 * `requirePayoutAmount` is an optional boolean (default `false`): when
 * `true`, `dispatch("PAYOUT_COMPLETE")` without a `payoutAmount` throws
 * `payout amount required: …` and appends nothing. This is the
 * opt-in up-front counterpart to the advisory default and the
 * `unreconciledPayouts()` post-hoc reconciliation helper — for payout
 * flows where a settled amount is always known. The gate only checks
 * presence: a present amount still goes through the usual dispatch
 * validation (finite, non-negative, at most 2 decimal places), so
 * `NaN`/negative/sub-cent amounts are rejected with the same
 * `invalid dispatch options: …` error whether the switch is on or off,
 * and `0` is a legal amount (a zero-value settlement is still a
 * settlement). The switch is task configuration, not audit data: it is
 * never written into the `toJSON()` snapshot envelope, so a rehydrated
 * task must re-enable it via
 * `fromHistory(id, history, { requirePayoutAmount: true })`. Invalid
 * values throw `invalid option: …` at construction.
 *
 * `requireActor` is an optional boolean (default `false`): when `true`,
 * every `dispatch()` without an `actor` throws
 * `actor required: …` and appends nothing. This is the opt-in up-front
 * counterpart to the advisory default, under which an anonymous dispatch
 * is legal and the entry simply omits the actor — for audit regimes
 * where every state change must be attributable to a named actor. It
 * complements, rather than replaces, `rolePolicy`: a policy only
 * constrains the events it lists, while `requireActor` constrains all
 * of them (a listed event still needs a matching actor, not just any
 * actor). Like `requirePayoutRef`, the switch is task configuration,
 * not audit data: it is never written into the `toJSON()` snapshot
 * envelope, so a rehydrated task must re-enable it via
 * `fromHistory(id, history, { requireActor: true })`. Invalid values
 * throw `invalid option: …` at construction.
 *
 * `auditSecret` is an optional secret (string or Buffer) that upgrades
 * the audit-history hash chain from plain SHA-256 to HMAC-SHA256
 * (keyed mode): every entry's `hash` becomes
 * `hmac_sha256(secret, canonical(entry) + prevHash)`, with the
 * canonical byte format unchanged. Rewriting a persisted log then
 * requires the secret as well as the data, so a full-log rewrite with
 * recomputed hashes is detected without it. Verification is
 * fail-closed across modes: a keyed chain does not verify without the
 * secret or with the wrong one, and an unkeyed chain does not verify
 * when a secret is supplied. Must be non-empty when set (an empty
 * secret is a construction error — it would silently provide no MAC
 * security). Default: `undefined` (unkeyed chain, exactly the legacy
 * behavior). Like `requirePayoutRef`, the secret is task
 * configuration, not audit data: it is NEVER written into the
 * `toJSON()` snapshot, so a rehydrated task must be given it again —
 * `fromJSON(snapshot, { auditSecret })` or
 * `fromHistory(id, history, { auditSecret })` — and a keyed snapshot
 * restored without it (or with the wrong secret) is rejected as a
 * broken hash chain. Key generation, storage, and distribution are
 * the caller's responsibility.
 */
export interface TaskLifecycleOptions {
  maxResubmits?: number;
  maxDisputes?: number;
  maxVisitsByState?: Partial<Record<TaskState, number>>;
  rolePolicy?: RolePolicy;
  requirePayoutRef?: boolean;
  requirePayoutAmount?: boolean;
  requireActor?: boolean;
  idempotencyKeys?: string[];
  auditSecret?: AuditSecret;
  /**
   * Per-state advisory SLA deadlines, attached at construction. Keys
   * are states, values are `Date` or parseable date strings, stored
   * canonical-ISO exactly like `setSlaDeadline` stores them. This is
   * the only way to carry deadlines across a history-only rebuild:
   * `fromHistory(id, history, { slaDeadlines })` passes this option
   * through the constructor, because the audit log itself carries no
   * deadlines. Deadlines stay advisory (see `setSlaDeadline`): they
   * never move the task, and expiry still requires an explicit
   * `EXPIRE` dispatch. Like the other options, deadlines are task
   * configuration, not audit data — but unlike `auditSecret` they
   * ARE written into the `toJSON()` snapshot, so a snapshot restore
   * recovers them without this option.
   */
  slaDeadlines?: Partial<Record<TaskState, Date | string>>;
}

/**
 * Whitelist of `TaskLifecycleOptions` field names. A field outside this
 * set is rejected, never silently dropped: a typo'd `maxResubmits`
 * (e.g. `maxResubmit`) would otherwise parse as "no budget" and
 * quietly disable the resubmit retry control. Mirrors the escrow
 * state machine's `ESCROW_OPTION_FIELDS` guard (backlog #548) on the
 * same principle — constructor options are live risk controls
 * (budgets, RBAC, payout evidence, audit key), so a misspelled key is
 * worse here than in a snapshot. `TaskLifecycle.fromHistory` funnels
 * its `opts` through the same constructor, so the rebuild path gets
 * the same protection; `fromJSON` builds its own options object from
 * the parsed snapshot, so it can never carry an unknown field.
 */
const TASK_OPTION_FIELDS = new Set([
  "maxResubmits",
  "maxDisputes",
  "maxVisitsByState",
  "rolePolicy",
  "requirePayoutRef",
  "requirePayoutAmount",
  "requireActor",
  "idempotencyKeys",
  "auditSecret",
  "slaDeadlines",
]);

function assertRequirePayoutRef(value: unknown, tag: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(
      `${tag}: requirePayoutRef must be a boolean, got ${String(value)}`,
    );
  }
  return value;
}

function assertRequirePayoutAmount(value: unknown, tag: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(
      `${tag}: requirePayoutAmount must be a boolean, got ${String(value)}`,
    );
  }
  return value;
}

function assertRequireActor(value: unknown, tag: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(
      `${tag}: requireActor must be a boolean, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Validate a list of idempotency keys into a deduped set.
 *
 * `undefined` means "no keys" (the default). Otherwise the value must be
 * an array of non-empty strings — the same bar dispatch() applies to a
 * single key. Duplicates are harmless and deduped (first occurrence
 * wins, preserving insertion order for snapshot round-trips). Anything
 * else throws `<tag>: idempotencyKeys …`.
 */
function assertIdempotencyKeys(
  value: unknown,
  tag: string,
): Set<string> {
  const keys = new Set<string>();
  if (value === undefined) return keys;
  if (!Array.isArray(value)) {
    throw new Error(
      `${tag}: idempotencyKeys must be an array of non-empty strings, got ${typeof value}`,
    );
  }
  for (const key of value) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(
        `${tag}: idempotencyKeys entries must be non-empty strings, got ${JSON.stringify(key)}`,
      );
    }
    keys.add(key);
  }
  return keys;
}

/**
 * Validate a per-state SLA deadline map into normalized ISO strings.
 *
 * `undefined` means "no deadlines" (the default). Otherwise the value
 * must be a plain record whose keys are known states and whose values
 * are `Date` objects or parseable date strings — the same bar
 * `setSlaDeadline` applies to a single deadline, with the same
 * canonical-ISO normalization. Anything else throws
 * `<tag>: slaDeadlines …`, fail-fast at construction, so a bad map
 * can never produce a task that looks configured but is not.
 */
function assertSlaDeadlines(
  value: unknown,
  tag: string,
): Map<TaskState, string> {
  const deadlines = new Map<TaskState, string>();
  if (value === undefined) return deadlines;
  if (!isRecord(value)) {
    throw new Error(
      `${tag}: slaDeadlines must be an object, got ${typeof value}`,
    );
  }
  for (const [state, deadline] of Object.entries(value)) {
    if (!STATES.has(state as TaskState)) {
      throw new Error(`${tag}: slaDeadlines has unknown state ${state}`);
    }
    if (!(deadline instanceof Date) && typeof deadline !== "string") {
      throw new Error(
        `${tag}: slaDeadlines[${state}] must be a Date or string, got ${typeof deadline}`,
      );
    }
    const ms =
      deadline instanceof Date ? deadline.getTime() : Date.parse(deadline);
    if (Number.isNaN(ms)) {
      throw new Error(
        `${tag}: slaDeadlines[${state}] is not a parseable date: ${String(deadline)}`,
      );
    }
    deadlines.set(state as TaskState, new Date(ms).toISOString());
  }
  return deadlines;
}

function assertMaxResubmits(value: unknown, tag: string): number {
  if (value === undefined) return Infinity;
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !(value === Infinity || (Number.isInteger(value) && value >= 0))
  ) {
    throw new Error(
      `${tag}: maxResubmits must be a non-negative integer or Infinity, got ${String(value)}`,
    );
  }
  return value;
}

function assertMaxDisputes(value: unknown, tag: string): number {
  if (value === undefined) return Infinity;
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !(value === Infinity || (Number.isInteger(value) && value >= 0))
  ) {
    throw new Error(
      `${tag}: maxDisputes must be a non-negative integer or Infinity, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Validate a per-state visit-budget map into a normalized lookup map.
 *
 * `undefined` means "no budgets" (the default: every state unlimited).
 * Otherwise the value must be a plain record whose keys are known states
 * and whose values are positive integers — 0 is rejected, not just
 * non-integers: the task's initial state already counts as one visit,
 * so a 0 budget could never admit even the state the task starts in.
 * Anything else throws `<tag>: maxVisitsByState …`, fail-fast at
 * construction, so a bad map can never produce a task that looks
 * budgeted but is not. An empty map is legal and means "no budgets".
 */
function assertMaxVisitsByState(
  value: unknown,
  tag: string,
): Map<TaskState, number> {
  const budgets = new Map<TaskState, number>();
  if (value === undefined) return budgets;
  if (!isRecord(value)) {
    throw new Error(
      `${tag}: maxVisitsByState must be an object, got ${typeof value}`,
    );
  }
  for (const [state, budget] of Object.entries(value)) {
    if (!STATES.has(state as TaskState)) {
      throw new Error(
        `${tag}: maxVisitsByState has unknown state ${state}`,
      );
    }
    if (
      typeof budget !== "number" ||
      !Number.isInteger(budget) ||
      budget < 1
    ) {
      throw new Error(
        `${tag}: maxVisitsByState[${state}] must be a positive integer, got ${String(budget)}`,
      );
    }
    budgets.set(state as TaskState, budget);
  }
  return budgets;
}

/**
 * Validate an event-level RBAC policy into a normalized lookup map.
 *
 * `undefined` means "no policy" (the default: every event unrestricted).
 * Otherwise the value must be a plain record whose keys are known events
 * and whose values are non-empty arrays of non-empty role/actor strings.
 * Anything else throws `<tag>: rolePolicy …`. Duplicate role names are
 * harmless (deduped). The check order mirrors assertMaxResubmits — config
 * errors are fail-fast, never silent.
 */
function assertRolePolicy(
  value: unknown,
  tag: string,
): Map<TaskEvent, string[]> {
  const policy = new Map<TaskEvent, string[]>();
  if (value === undefined) return policy;
  if (!isRecord(value)) {
    throw new Error(`${tag}: rolePolicy must be an object, got ${typeof value}`);
  }
  for (const [event, roles] of Object.entries(value)) {
    if (!EVENTS.has(event as TaskEvent)) {
      throw new Error(`${tag}: rolePolicy has unknown event ${event}`);
    }
    if (!Array.isArray(roles) || roles.length === 0) {
      throw new Error(
        `${tag}: rolePolicy[${event}] must be a non-empty array of role names`,
      );
    }
    const seen: string[] = [];
    for (const role of roles) {
      if (typeof role !== "string" || role.length === 0) {
        throw new Error(
          `${tag}: rolePolicy[${event}] roles must be non-empty strings, got ${JSON.stringify(role)}`,
        );
      }
      if (!seen.includes(role)) seen.push(role);
    }
    policy.set(event as TaskEvent, seen);
  }
  return policy;
}

/**
 * Options for {@link TaskLifecycle.dispatch}.
 *
 * `idempotencyKey` is a retry-safety valve for payment-flavored flows:
 * the task remembers every key it has successfully consumed, and a
 * dispatch that repeats a known key returns the current state as a
 * no-op — no audit entry is appended, no listeners are notified, and the
 * transition is not even validated (a retried webhook that arrives after
 * the task already moved on is safe to replay: it will not throw
 * `invalid transition`). Keys are global to the task, not per-event:
 * reusing the same key for a different event still dedupes.
 *
 * Fail-fast ordering: the key's own shape (non-empty string) is
 * validated up front, like actor/note/at/payoutRef. The dedupe check
 * runs after option validation but BEFORE the transition, RBAC, and
 * budget checks. A dispatch that fails any check consumes nothing — the
 * key is recorded only when the dispatch actually succeeds, so fixing a
 * bad call and retrying with the same key works. Omitting the key
 * preserves the exact pre-idempotency behavior.
 *
 * Persistence: the consumed-key set IS part of the `toJSON()` snapshot
 * (written only when non-empty, so keyless tasks keep the legacy
 * snapshot shape), and `fromJSON()` restores it — a retry with a known
 * key after a snapshot restore is still a no-op. `fromHistory()` cannot
 * recover keys from the audit log (they are not audit data), so callers
 * re-attach them via `fromHistory(id, history, { idempotencyKeys })`.
 *
 * Honest limit: this preserves exactly-once across restarts that go
 * through the snapshot, within one process/store. It is not a
 * distributed lock: two processes restoring the same snapshot in
 * parallel can both execute the same key. For cross-process
 * exactly-once semantics, pair this with a durable store (e.g. a
 * UNIQUE constraint on the key column).
 *
 * `expectedSeq` is an optimistic-concurrency guard: the caller asserts
 * the sequence number it based its decision on — the current history
 * length, which is also the last entry's `seq` (`0` for a task with no
 * history yet). The guard is checked before every other dispatch
 * validation and before the idempotency dedupe, so a writer holding a
 * stale snapshot fails loudly with `dispatch conflict: …` instead of
 * silently advancing a state it never saw — or silently no-oping a
 * retry it expected to conflict. A mismatch changes nothing: no state
 * move, no history entry, no idempotency key consumed, no listener
 * notified, so re-reading the task and retrying with the fresh seq
 * works. A non-integer or negative value is a caller configuration
 * error and throws `invalid dispatch options: …`. Omitting
 * `expectedSeq` preserves the exact pre-guard behavior.
 *
 * Honest limit: this is a single-process optimistic lock — the
 * comparison is against the in-memory history. Two processes that each
 * restored the same snapshot can still race; cross-process writers
 * need compare-and-swap in the durable store itself (e.g. a
 * conditional update keyed on a version column). The sibling
 * escrow-state-machine-ts repo carries the paired guard with identical
 * semantics.
 */
export interface DispatchOptions {
  actor?: string;
  note?: string;
  at?: string;
  payoutRef?: string;
  /**
   * Actual settled amount recorded on the audit entry
   * ({@link TaskHistoryEntry.payoutAmount}). Must be a finite number ≥ 0
   * with at most 2 decimal places — exactly representable in integer
   * minor units (see {@link toMinorUnits}) — when provided; an invalid
   * value throws `invalid dispatch options: …` up front, before
   * anything mutates.
   */
  payoutAmount?: number;
  /**
   * Quoted (owed) amount recorded on the audit entry
   * ({@link TaskHistoryEntry.quotedAmount}). Must be a finite number ≥ 0
   * with at most 2 decimal places — exactly representable in integer
   * minor units (see {@link toMinorUnits}) — when provided; an invalid
   * value throws `invalid dispatch options: …` up front, before
   * anything mutates.
   * Conventionally attached to `ACCEPT`, the moment the price is agreed.
   */
  quotedAmount?: number;
  idempotencyKey?: string;
  /**
   * Optimistic-concurrency guard: the history length (last entry's
   * `seq`; `0` when the history is empty) the caller expects the task
   * to be at. When set, dispatch throws
   * `dispatch conflict: expected seq <n> but task is at seq <m>` if the
   * task has moved on, before any other check runs. Must be a
   * non-negative integer when provided; anything else throws
   * `invalid dispatch options: …`. See the {@link DispatchOptions}
   * remarks for the ordering and the single-process limit.
   */
  expectedSeq?: number;
}

/**
 * Listener for dispatch notifications: called with the event, the from/to
 * states, and the exact audit entry that was appended.
 *
 * The entry is a frozen, detached copy — mutating it never affects the
 * task's audit trail.
 */
export type TaskEventListener = (
  event: TaskEvent,
  from: TaskState,
  to: TaskState,
  entry: TaskHistoryEntry,
) => void;

/**
 * Context handed to a `subscribe()` `onError` hook when a listener throws:
 * the dispatch that was being notified.
 */
export interface ListenerErrorContext {
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
}

/**
 * Options for `subscribe()`.
 */
export interface SubscribeOptions {
  /**
   * Called when the listener throws, with the caught error and the
   * dispatch context. Isolation semantics are unchanged: the error is
   * still swallowed after `onError` runs, and a throwing `onError`
   * itself is swallowed too — no error hook can ever break dispatch
   * or corrupt the audit trail.
   */
  onError?: (err: unknown, context: ListenerErrorContext) => void;
}

/**
 * Serializable snapshot of a task: live state + append-only history +
 * per-state SLA deadlines. Plain JSON (no class instances, no Maps), safe
 * to store in any document store and feed back into fromJSON().
 *
 * `maxResubmits` is present only when the budget is finite (JSON cannot
 * represent `Infinity`; an absent field rehydrates to the unlimited
 * default). The count of already-used resubmits is NOT stored separately —
 * it is derived from the history on rehydration, so it can never drift
 * from the audit trail.
 *
 * `maxDisputes` follows the same convention for the DISPUTE appeal
 * budget (finite budgets only; used appeal rounds derived from history).
 *
 * `maxVisitsByState` is present only when the task carries at least one
 * per-state visit budget (an empty map is omitted, keeping legacy
 * snapshots byte-identical). The used visit counts are NOT stored
 * separately — they are derived from the history on rehydration, so
 * they can never drift from the audit trail.
 *
 * `rolePolicy` is present only when the task carries an RBAC policy; it
 * rehydrates through the same strict validation as the constructor, so a
 * tampered policy in a stored snapshot is rejected, not silently applied.
 *
 * `idempotencyKeys` is present only when the task has consumed at least
 * one dispatch idempotency key (an empty set is omitted, keeping legacy
 * snapshots byte-identical). It rehydrates through strict validation
 * (non-array / non-string / empty-string entries are rejected) with
 * duplicates deduped, so a consumed key keeps its no-op effect after a
 * snapshot restore.
 *
 * The parser is fail-closed about fields outside this shape: any
 * top-level field other than the ones listed here (and any history-entry
 * field outside {@link TaskHistoryEntry}) is rejected as an unknown
 * field instead of being silently dropped — see {@link parseSnapshot}.
 */
/**
 * Current snapshot schema version, written by `toJSON()` as the `v`
 * field. Snapshots produced before versioning existed carry no `v` and
 * are accepted as legacy; a snapshot carrying any other version is
 * rejected by the parser (see {@link TaskSnapshot.v}). The same
 * convention is used by the sibling escrow-state-machine-ts repo.
 */
export const SNAPSHOT_VERSION = 1;

export interface TaskSnapshot {
  /**
   * Snapshot schema version. `toJSON()` always writes the current
   * version ({@link SNAPSHOT_VERSION}). Optional in the type so legacy
   * (pre-versioning) snapshots stay representable: the parser accepts a
   * missing `v` as legacy, but a present `v` that is not exactly the
   * current version throws `unsupported snapshot version` — that is how
   * a future format evolution stays distinguishable from corruption.
   */
  v?: number;
  id: string;
  state: TaskState;
  history: TaskHistoryEntry[];
  slaDeadlines: Partial<Record<TaskState, string>>;
  maxResubmits?: number;
  maxDisputes?: number;
  maxVisitsByState?: Partial<Record<TaskState, number>>;
  rolePolicy?: RolePolicy;
  idempotencyKeys?: string[];
}

/**
 * Snapshot field whitelists for {@link parseSnapshot} / {@link parseHistory}
 * (fail-closed strict parsing). A field outside these sets is rejected,
 * never silently dropped: a typo'd `slaDeadlines` (e.g. `deadlline`) would
 * otherwise parse as "no deadlines" and the SLA configuration would vanish
 * without a trace, and a typo'd entry `payoutAmount` (`payoutAmout`) would
 * parse as a payout entry carrying no amount. The top-level set is exactly
 * the fields `toJSON()` can write (including the `v` schema version), and
 * the entry set is exactly the fields `parseHistory` recognizes, so
 * self-produced snapshots and histories always pass. The same convention
 * is used by the sibling escrow-state-machine-ts repo.
 */
const SNAPSHOT_FIELDS = new Set([
  "v",
  "id",
  "state",
  "history",
  "slaDeadlines",
  "maxResubmits",
  "maxDisputes",
  "maxVisitsByState",
  "rolePolicy",
  "idempotencyKeys",
]);

const HISTORY_ENTRY_FIELDS = new Set([
  "seq",
  "event",
  "from",
  "to",
  "at",
  "actor",
  "note",
  "payoutRef",
  "payoutAmount",
  "quotedAmount",
  "prevHash",
  "hash",
]);

/**
 * Integrity-protected form of a {@link TaskSnapshot}, produced by
 * `TaskLifecycle.exportSignedSnapshot(secret)` and consumed by
 * `TaskLifecycle.restoreSignedSnapshot(envelope, secret, opts?)` (see those
 * methods for the exact contract). Same envelope shape as the sibling
 * escrow-state-machine-ts `Escrow` signed snapshot
 * (`EscrowSignedSnapshotEnvelope`, backlog #1017) and this repo's
 * `PayoutEventDedupe` signed snapshot
 * (`PayoutEventDedupeSignedSnapshotEnvelope`, backlog #1011).
 *
 * - `v`: envelope format version. Only `1` exists; restore rejects
 *   any other value (including a missing `v`) instead of guessing.
 * - `snapshot`: the wrapped {@link TaskSnapshot}, exactly as
 *   `toJSON()` produces it.
 * - `mac`: lowercase hex HMAC-SHA256 over the canonical JSON of
 *   `snapshot` (object keys sorted recursively, array order
 *   preserved) under the caller's secret.
 *
 * Why this exists: the audit hash chain covers the history entries
 * only — the snapshot-level fields (`state`, `slaDeadlines`,
 * `maxResubmits`, `maxDisputes`, `maxVisitsByState`, `rolePolicy`,
 * `idempotencyKeys`) sit outside the chain, so a rewritten persisted
 * snapshot could push an SLA deadline back, loosen a budget or a
 * policy, or clear consumed idempotency keys without breaking any
 * history link. The envelope MAC covers the whole snapshot, so any
 * such rewrite fails closed at restore.
 *
 * The envelope carries no secret: the secret is caller configuration,
 * never persisted in the envelope, and the same secret must be
 * supplied at restore time. An envelope with any other field is
 * rejected, so a caller cannot smuggle extra data (including a
 * secret) past restore. The MAC is integrity protection only — it
 * proves the snapshot was not rewritten by anyone without the
 * secret — not confidentiality: the snapshot contents are plain
 * JSON, and the envelope itself is plain JSON. A caller that needs
 * the snapshot kept private must encrypt it separately; this
 * envelope does not. The envelope secret need not equal the task's
 * `auditSecret` (they protect different things — the chain and the
 * snapshot envelope — and are managed independently);
 * `opts.auditSecret` is still handed to `fromJSON` on restore so a
 * keyed history chain re-verifies.
 */
export interface TaskLifecycleSignedSnapshotEnvelope {
  v: 1;
  snapshot: TaskSnapshot;
  mac: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCanonicalIso(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const ms = Date.parse(s);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === s;
}

/**
 * Canonical JSON for snapshot-diff comparison: object keys sorted,
 * `undefined` values omitted, array order preserved. Used only by
 * {@link diffTaskSnapshots}; it is not a serializer — values that JSON
 * cannot represent keep JSON's answer. Key order in a snapshot object
 * (notably `slaDeadlines`, a plain record built from a Map) is not a
 * change, so the comparison must not depend on it.
 */
function canonicalDiffJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalDiffJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalDiffJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Order-insensitive key for a consumed idempotency-key set, used only
 * by {@link diffTaskSnapshots}: duplicates collapse and the remaining
 * keys sort, so two snapshots carrying the same set in a different
 * order compare equal. A snapshot without the field (legacy, or no
 * key consumed yet) is the empty set, so "no field" and an empty
 * array are the same state. This mirrors the sibling
 * `escrow-state-machine-ts` repo's `idempotencyKeysKey` helper.
 */
function idempotencyKeysKey(keys: readonly string[] | undefined): string {
  if (keys === undefined) return "[]";
  return JSON.stringify([...new Set(keys)].sort());
}

/**
 * Settled payout amount recorded in a snapshot: the `payoutAmount` on
 * the last `PAYOUT_COMPLETE` history entry, or `undefined` when the
 * snapshot has no such entry (or that entry carries no amount). This
 * is the same evidence {@link totalPaidOut} and
 * {@link unreconciledPayouts} read — a `REQUEST_PAYOUT` entry alone is
 * not a payout — except that a missing amount stays `undefined` here
 * rather than counting as 0, so "no settled amount recorded" and
 * "settled for 0" remain distinguishable in a diff.
 */
function snapshotPayoutAmount(snapshot: TaskSnapshot): number | undefined {
  let paid: number | undefined;
  for (const entry of snapshot.history) {
    if (entry.event === "PAYOUT_COMPLETE") paid = entry.payoutAmount;
  }
  return paid;
}

/**
 * Quoted (owed) amount recorded in a snapshot: the `quotedAmount` on
 * the last `ACCEPT` entry, or `undefined` when the snapshot has no
 * such entry (or that entry carries no amount). This is the same
 * evidence {@link payoutMismatch} and {@link totalQuoted} read — a
 * task that was never accepted, or accepted without a quote, has no
 * quoted amount — except that a missing amount stays `undefined`
 * here rather than counting as 0, so "no quote recorded" and
 * "quoted 0" remain distinguishable in a diff. The live machine
 * permits only one `ACCEPT` per task, so a quote can only appear
 * (absent to present), never move: `last` is by construction, not a
 * re-quote rule.
 */
function snapshotQuotedAmount(snapshot: TaskSnapshot): number | undefined {
  let quoted: number | undefined;
  for (const entry of snapshot.history) {
    if (entry.event === "ACCEPT") quoted = entry.quotedAmount;
  }
  return quoted;
}

/**
 * Structured difference between two snapshots of the same task, as
 * reported by {@link diffTaskSnapshots}. Only keys that actually
 * changed are present; two equal snapshots diff to `{}`.
 */
export interface TaskSnapshotDiff {
  /** Live state moved (e.g. `OPEN` to `ACCEPTED`). */
  stateChanged?: { from: TaskState; to: TaskState };
  /**
   * Settled payout amount moved, per {@link snapshotPayoutAmount}:
   * `undefined` means no settled amount recorded in that snapshot.
   */
  payoutChanged?: { from: number | undefined; to: number | undefined };
  /**
   * Quoted (owed) amount moved, per {@link snapshotQuotedAmount}:
   * `undefined` means no quote recorded in that snapshot. In live
   * use this only ever reports absent to present — the quote lands
   * on the single `ACCEPT` entry — never a re-price.
   */
  quoteChanged?: { from: number | undefined; to: number | undefined };
  /**
   * History entries appended in `b` beyond `a`'s history, with the
   * seq range they cover. `fromSeq` is the first appended entry's
   * seq, `toSeq` the last.
   */
  historyAppended?: {
    fromSeq: number;
    toSeq: number;
    entries: TaskHistoryEntry[];
  };
  /**
   * Advisory SLA deadline map moved, compared as a whole (key order
   * is not a change). Setting, changing, or clearing any deadline
   * reports the full before/after maps, not a per-state delta.
   */
  slaChanged?: {
    from: Partial<Record<TaskState, string>>;
    to: Partial<Record<TaskState, string>>;
  };
  /**
   * Consumed idempotency-key set moved (a key consumed, or a key
   * dropped on restore). Reported as a plain boolean: the set is
   * compared order-insensitively, and a snapshot without the field
   * (legacy, or no key consumed yet) compares as the empty set, so
   * "no field" and an empty array are the same state.
   */
  idempotencyKeysChanged?: boolean;
}

/**
 * Compare two snapshots of the same task and report what changed
 * between them — the audit/change-review question ("what moved since
 * the last snapshot I stored?") without hand-written field compares
 * that disagree about what counts as a history change. This is the
 * task-snapshot counterpart to the escrow repo's
 * `diffEscrowSnapshots`; the dimensions differ because a task
 * snapshot carries a settled payout and a per-state SLA map instead
 * of a single deadline and a role policy.
 *
 * Dimensions compared, and only these: live `state`, quoted amount
 * (see {@link snapshotQuotedAmount} — only ever absent to present,
 * since the live machine permits a single `ACCEPT` per task and
 * there is no re-price path), settled payout
 * amount (see {@link snapshotPayoutAmount}), the `slaDeadlines` map
 * as a whole (setting or clearing a deadline is a change even though
 * it appends no history entry — `setSlaDeadline` /
 * `clearSlaDeadline` touch no audit log), the consumed
 * idempotency-key set as a whole (compared order-insensitively; a
 * snapshot without the field is the empty set), and history appends.
 * `v` and the configuration fields (`maxResubmits`, `maxDisputes`,
 * `maxVisitsByState`, `rolePolicy`) are deliberately not reported:
 * the version is schema metadata, and the rest is task
 * configuration, not task state. The idempotency-key set is the
 * exception to that exclusion: unlike the budgets and the role
 * policy, it is not fixed configuration — it grows with every
 * keyed dispatch, so it is task state, and a key consumed (or
 * dropped on restore) between two stored snapshots is a change
 * worth reporting. This mirrors the sibling
 * `escrow-state-machine-ts` repo's `diffEscrowSnapshots`, which
 * reports the same dimension for the same reason.
 *
 * History is append-only, so `b`'s history must be an extension of
 * `a`'s: same entries in the same order, then zero or more new ones
 * whose seq continues from `a`'s last entry without gaps. A shorter
 * `b`, a rewritten entry, or an appended entry that breaks seq
 * continuity throws `snapshot diff failed: history … diverged …`
 * instead of being silently reported as an append — a rewritten audit
 * entry is tampering (or a restore from a different lineage), not
 * progress. Snapshots of different tasks throw the same way: diffing
 * across ids would report nonsense as if it were one task's
 * evolution.
 *
 * Pure: reads both snapshots, never mutates them, and the returned
 * `historyAppended.entries` and `slaChanged` maps are detached
 * copies. This is a comparison, not a validation — it does not
 * re-check transition legality, seq continuity inside `a` itself, or
 * the hash chain; run a snapshot through `fromJSON` (or its history
 * through {@link verifyHistoryChain}) when the input itself is
 * untrusted.
 *
 *   const before = task.toJSON();
 *   task.dispatch("PUBLISH", { actor: "researcher" });
 *   diffTaskSnapshots(before, task.toJSON());
 *   // { stateChanged: { from: "DRAFT", to: "OPEN" },
 *   //   historyAppended: { fromSeq: 1, toSeq: 1, entries: [...] } }
 */
export function diffTaskSnapshots(
  a: TaskSnapshot,
  b: TaskSnapshot,
): TaskSnapshotDiff {
  if (!isRecord(a) || !isRecord(b)) {
    throw new Error(
      "invalid snapshot diff: both snapshots must be objects",
    );
  }
  if (a.id !== b.id) {
    throw new Error(
      `snapshot diff failed: cannot diff snapshots of different tasks (${JSON.stringify(a.id)} vs ${JSON.stringify(b.id)})`,
    );
  }
  if (!Array.isArray(a.history) || !Array.isArray(b.history)) {
    throw new Error(
      `snapshot diff failed: history of task ${JSON.stringify(a.id)} must be an array in both snapshots`,
    );
  }
  for (let i = 0; i < a.history.length; i++) {
    if (
      i >= b.history.length ||
      canonicalDiffJson(a.history[i]) !== canonicalDiffJson(b.history[i])
    ) {
      throw new Error(
        `snapshot diff failed: history of task ${JSON.stringify(a.id)} diverged at entry ${i + 1} (b is not an append-only extension of a)`,
      );
    }
  }
  const appended = b.history.slice(a.history.length);
  let expectedSeq =
    a.history.length > 0 ? a.history[a.history.length - 1].seq : 0;
  for (const entry of appended) {
    expectedSeq += 1;
    if (entry.seq !== expectedSeq) {
      throw new Error(
        `snapshot diff failed: history of task ${JSON.stringify(a.id)} diverged at appended entry seq ${String(entry.seq)} (expected ${expectedSeq}; b is not an append-only extension of a)`,
      );
    }
  }
  const diff: TaskSnapshotDiff = {};
  if (a.state !== b.state) {
    diff.stateChanged = { from: a.state, to: b.state };
  }
  const payoutFrom = snapshotPayoutAmount(a);
  const payoutTo = snapshotPayoutAmount(b);
  if (payoutFrom !== payoutTo) {
    diff.payoutChanged = { from: payoutFrom, to: payoutTo };
  }
  const quoteFrom = snapshotQuotedAmount(a);
  const quoteTo = snapshotQuotedAmount(b);
  if (quoteFrom !== quoteTo) {
    diff.quoteChanged = { from: quoteFrom, to: quoteTo };
  }
  if (appended.length > 0) {
    diff.historyAppended = {
      fromSeq: appended[0].seq,
      toSeq: appended[appended.length - 1].seq,
      entries: appended.map((entry) => ({ ...entry })),
    };
  }
  const slaFrom: Partial<Record<TaskState, string>> = {
    ...(a.slaDeadlines ?? {}),
  };
  const slaTo: Partial<Record<TaskState, string>> = {
    ...(b.slaDeadlines ?? {}),
  };
  if (canonicalDiffJson(slaFrom) !== canonicalDiffJson(slaTo)) {
    diff.slaChanged = { from: slaFrom, to: slaTo };
  }
  if (idempotencyKeysKey(a.idempotencyKeys) !== idempotencyKeysKey(b.idempotencyKeys)) {
    diff.idempotencyKeysChanged = true;
  }
  return diff;
}

// ------------------------------------------------------------------
// Audit-history hash chain (tamper evidence for persisted logs).
//
// The runtime-frozen `history` getter stops in-process tampering, but a
// persisted snapshot (toJSON) or NDJSON export (historyToNdjson) could be
// rewritten on disk / in transit and rehydrated without anyone noticing.
// Every chained entry commits to the full content of its predecessor:
// `hash = sha256(canonical(entry sans hash) + prevHash)`, with the
// genesis entry's `prevHash` set to GENESIS_PREV_HASH. Rewriting any field
// of any entry (or deleting / reordering entries) breaks the chain, and
// parseHistory / verifyHistoryChain report it. The same convention is
// used by the sibling escrow-state-machine-ts repo (cross-repo
// consistency).
//
// Honest limits: by default this is an UNKEYED chain. It detects edits
// by anyone who rewrites entries without recomputing the chain (manual
// edits, log-shipper corruption, partial restores). It does NOT stop an
// attacker who rewrites the whole JSON and recomputes the hashes.
//
// Optional keyed mode: when the task is constructed with
// `TaskLifecycleOptions.auditSecret`, each link is HMAC-SHA256 over the
// same canonical input instead of plain SHA-256 (the canonical byte
// format is unchanged, so legacy hashless entries serialize exactly as
// before). Rewriting the log then requires the secret as well as the
// data, which turns the chain from tamper evidence into a MAC — at the
// price of key management, which stays the caller's problem: the
// secret is per-instance configuration, is never written into
// snapshots, and must be re-supplied to `verifyHistoryChain` /
// `parseHistory` / `TaskLifecycle.fromJSON` / `fromHistory` to check a
// keyed chain. The two modes are fail-closed against each other: a
// keyed chain does not verify without (or with the wrong) secret, and
// an unkeyed chain does not verify when a secret is supplied. The same
// convention is used by the sibling escrow-state-machine-ts repo
// (there the option is named `auditKey`).
// ------------------------------------------------------------------

/** `prevHash` of the first (genesis) audit entry. */
export const GENESIS_PREV_HASH = "GENESIS";

/** Secret for the optional keyed (HMAC) audit hash chain. */
export type AuditSecret = string | Buffer;

/**
 * Options carrying an {@link AuditSecret} for the hash-chain functions
 * ({@link verifyHistoryChain}, {@link parseHistory}, {@link replay},
 * and the NDJSON import/export helpers).
 */
export interface AuditChainOptions {
  auditSecret?: AuditSecret;
}

/**
 * Validate an audit secret: it must be a non-empty string or Buffer
 * (mirrors the settlement-webhook `assertSecret` fail-fast style — an
 * empty secret would silently provide no MAC security at all, so it is
 * a caller configuration error, never a verification result).
 */
function assertAuditSecret(
  secret: unknown,
  tag: string,
): asserts secret is AuditSecret {
  if (typeof secret !== "string" && !Buffer.isBuffer(secret)) {
    throw new Error(
      `${tag}: auditSecret must be a non-empty string or Buffer, got ${typeof secret}`,
    );
  }
  if (secret.length === 0) {
    throw new Error(
      `${tag}: auditSecret must not be empty (an empty secret provides no MAC security)`,
    );
  }
}

/**
 * Canonical serialization of a history entry for hashing: fixed key order
 * (seq, event, from, to, at, then the optional fields in declaration
 * order: actor, note, payoutRef, payoutAmount, quotedAmount, prevHash), `undefined`
 * values omitted.
 * `hash` itself is never part of the hashed content (it is what we are
 * computing). Deterministic: the same entry always serializes to the
 * same string, regardless of the key order the entry object was built
 * with.
 */
function canonicalHistoryEntry(
  entry: Omit<TaskHistoryEntry, "hash">,
): string {
  const obj: Record<string, unknown> = {
    seq: entry.seq,
    event: entry.event,
    from: entry.from,
    to: entry.to,
    at: entry.at,
  };
  if (entry.actor !== undefined) obj.actor = entry.actor;
  if (entry.note !== undefined) obj.note = entry.note;
  if (entry.payoutRef !== undefined) obj.payoutRef = entry.payoutRef;
  if (entry.payoutAmount !== undefined) obj.payoutAmount = entry.payoutAmount;
  if (entry.quotedAmount !== undefined) obj.quotedAmount = entry.quotedAmount;
  if (entry.prevHash !== undefined) obj.prevHash = entry.prevHash;
  return JSON.stringify(obj);
}

/**
 * Compare a keyed (HMAC-SHA256) audit-chain link in constant time.
 *
 * `timingSafeEqual` throws on length mismatch, and `parseHistory` only
 * requires `hash` to be a non-empty string — so guard the decoded length
 * first: a forged or truncated digest is a mismatch, never a throw.
 * Mirrors the comparison discipline in `verifyPayoutWebhook`
 * (src/settlementWebhook.ts).
 */
function constantTimeHexEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(actual, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function hashHistoryEntry(
  canonical: string,
  prevHash: string,
  secret?: AuditSecret,
): string {
  const input = canonical + prevHash;
  return secret === undefined
    ? createHash("sha256").update(input, "utf8").digest("hex")
    : createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

/**
 * Verify the hash chain of an audit history. Returns `true` when the
 * chain is intact: every entry's `prevHash` matches the previous entry's
 * `hash` (genesis links to {@link GENESIS_PREV_HASH}) and every `hash`
 * recomputes from the entry content.
 *
 * Semantics for histories without a chain:
 *  - empty history -> `true` (vacuous);
 *  - no entry carries hash fields (legacy histories, e.g. produced
 *    before this feature) -> `true`: there is no chain to verify,
 *    mirroring parseHistory's legacy pass-through;
 *  - a mix of chained and hashless entries -> `false` (fail closed).
 *
 * Keyed chains: when the history was produced by a task constructed
 * with {@link TaskLifecycleOptions.auditSecret}, pass the same secret
 * as `opts.auditSecret` — the links are HMAC-SHA256, so verification
 * without the secret (or with the wrong secret) returns `false`, and
 * conversely an unkeyed chain returns `false` when a secret is
 * supplied (fail-closed both ways). An invalid secret value itself
 * (empty, or not a string/Buffer) is a caller configuration error and
 * throws, mirroring the constructor.
 *
 * On the keyed path the recomputed MAC is compared with the stored
 * digest in constant time (`timingSafeEqual` after a length guard), so
 * an online verifier exposes no per-byte timing oracle; the unkeyed
 * chain compares digests with plain equality (its digests are not
 * keyed secrets, so there is no oracle to protect).
 *
 * Note: this checks integrity only, not structure. A re-sequenced or
 * structurally invalid history still needs parseHistory (via
 * {@link TaskLifecycle.fromJSON} / {@link replay}) for the seq/edge/
 * timestamp rules.
 */
export function verifyHistoryChain(
  history: readonly TaskHistoryEntry[],
  opts?: AuditChainOptions,
): boolean {
  const secret = opts?.auditSecret;
  if (secret !== undefined) assertAuditSecret(secret, "invalid audit secret");
  if (history.length === 0) return true;
  const carried = history.map(
    (e) => e.hash !== undefined || e.prevHash !== undefined,
  );
  if (carried.every((c) => !c)) return true; // legacy: nothing to verify
  if (carried.some((c) => !c)) return false; // mixed: fail closed
  let expectedPrev = GENESIS_PREV_HASH;
  for (const entry of history) {
    if (entry.prevHash !== expectedPrev) return false;
    const canonical = canonicalHistoryEntry(entry);
    const recomputed = hashHistoryEntry(canonical, entry.prevHash!, secret);
    if (typeof entry.hash !== "string") return false;
    // Keyed links are MACs: compare in constant time so an online
    // verifier gives no per-byte timing oracle. The unkeyed chain is
    // tamper-evidence only (its digests are not keyed secrets), so its
    // comparison stays a plain equality — semantics unchanged.
    const intact =
      secret === undefined
        ? recomputed === entry.hash
        : constantTimeHexEqual(recomputed, entry.hash);
    if (!intact) {
      return false;
    }
    expectedPrev = entry.hash;
  }
  return true;
}

/**
 * Chain a parsed history: entries that already carry a chain pass
 * through untouched (the parser verified them); a fully hashless legacy
 * history gets its chain computed deterministically from the genesis
 * constant. Mixed input never reaches here — parseHistory rejects it.
 * The audit content is never altered: the hash is a pure function of
 * the entry fields.
 */
function chainHistoryEntries(
  history: TaskHistoryEntry[],
  secret?: AuditSecret,
): TaskHistoryEntry[] {
  if (history.length === 0) return history;
  if (history[0].hash !== undefined) return history; // already chained
  let prevHash = GENESIS_PREV_HASH;
  return history.map((entry) => {
    const chained: TaskHistoryEntry = { ...entry, prevHash };
    chained.hash = hashHistoryEntry(
      canonicalHistoryEntry(chained),
      prevHash,
      secret,
    );
    prevHash = chained.hash;
    return chained;
  });
}

/**
 * Parse and strictly validate an untrusted value into a sanitized audit
 * history — the append-only event log every TaskLifecycle carries.
 *
 * Throws `invalid history: …` on the first problem found:
 *  - history is not an array, or an entry is not an object
 *  - unknown fields are rejected (fail-closed), never silently dropped:
 *    an entry allows only `seq`/`event`/`from`/`to`/`at`/`actor`/`note`/
 *    `payoutRef`/`payoutAmount`/`quotedAmount`/`prevHash`/`hash`
 *    (`entry[i]: unknown field "<name>"`), checked before any field is
 *    consumed so a typo is reported as itself
 *  - entry shape violations (seq, event, from, to, at, actor, note,
 *    payoutRef, prevHash, hash)
 *  - seq must restart at 1 and increment by 1 with no gaps
 *  - the from/to chain must be continuous and start at DRAFT
 *  - every (from, event) -> to edge must be a legal transition edge
 *  - timestamps must be canonical ISO-8601 and non-decreasing
 *  - hash-chain rule: entries carrying hash fields must carry both
 *    (prevHash and hash); a history mixing chained and hashless entries
 *    is rejected; a fully chained history must re-verify end to end
 *    (a fully hashless history is legacy and passes through)
 *
 * `opts.auditSecret` selects the keyed (HMAC) chain mode for that
 * re-verification — see {@link verifyHistoryChain}: a keyed history
 * parsed without the secret (or with the wrong one) is rejected as a
 * broken chain, and an unkeyed history parsed with a secret is
 * rejected the same way (fail-closed both ways).
 *
 * The returned entries are fresh, sanitized copies: mutating the input
 * afterwards never affects them.
 */
export function parseHistory(
  history: unknown,
  opts?: AuditChainOptions,
): TaskHistoryEntry[] {
  const secret = opts?.auditSecret;
  if (secret !== undefined) assertAuditSecret(secret, "invalid history");
  if (!Array.isArray(history)) {
    throw new Error("invalid history: history must be an array");
  }
  const entries: TaskHistoryEntry[] = [];
  for (let i = 0; i < history.length; i++) {
    const raw = history[i];
    const tag = `invalid history: entry[${i}]`;
    if (!isRecord(raw)) throw new Error(`${tag}: entry must be an object`);
    // Unknown entry fields fail closed (see HISTORY_ENTRY_FIELDS),
    // checked before any field is consumed so a typo is reported as
    // itself, not as a missing-field or chain error.
    for (const key of Object.keys(raw)) {
      if (!HISTORY_ENTRY_FIELDS.has(key)) {
        throw new Error(`${tag}: unknown field "${key}"`);
      }
    }
    if (raw.seq !== i + 1) {
      throw new Error(`${tag}: seq must be ${i + 1}, got ${String(raw.seq)}`);
    }
    if (!EVENTS.has(raw.event as TaskEvent)) {
      throw new Error(`${tag}: unknown event ${String(raw.event)}`);
    }
    if (!STATES.has(raw.from as TaskState)) {
      throw new Error(`${tag}: unknown from-state ${String(raw.from)}`);
    }
    if (!STATES.has(raw.to as TaskState)) {
      throw new Error(`${tag}: unknown to-state ${String(raw.to)}`);
    }
    if (!isCanonicalIso(raw.at)) {
      throw new Error(`${tag}: at must be canonical ISO-8601, got ${String(raw.at)}`);
    }
    const event = raw.event as TaskEvent;
    const from = raw.from as TaskState;
    const to = raw.to as TaskState;
    if (i === 0 && from !== "DRAFT") {
      throw new Error(`${tag}: chain must start at DRAFT, got ${from}`);
    }
    if (i > 0) {
      const prev = entries[i - 1];
      if (from !== prev.to) {
        throw new Error(
          `${tag}: from ${from} does not continue previous to ${prev.to}`,
        );
      }
      if (Date.parse(raw.at) < Date.parse(prev.at)) {
        throw new Error(`${tag}: timestamps must be non-decreasing`);
      }
    }
    const legal = (TRANSITIONS[from] as Partial<Record<TaskEvent, TaskState>>)[
      event
    ];
    if (legal !== to) {
      throw new Error(`${tag}: ${event} from ${from} cannot lead to ${to}`);
    }
    const entry: TaskHistoryEntry = {
      seq: i + 1,
      event,
      from,
      to,
      at: raw.at,
    };
    if (raw.actor !== undefined) {
      // Same bar as dispatch(): an empty actor in an untrusted log is
      // malformed — audit entries must say WHO or omit the field.
      if (typeof raw.actor !== "string" || raw.actor.length === 0) {
        throw new Error(
          `${tag}: actor must be a non-empty string, got ${JSON.stringify(raw.actor)}`,
        );
      }
      entry.actor = raw.actor;
    }
    if (raw.note !== undefined) {
      // Same bar as dispatch(): oversized notes in an untrusted log are
      // malformed, so a corrupted snapshot cannot blow up rehydration.
      if (typeof raw.note !== "string") {
        throw new Error(`${tag}: note must be a string`);
      }
      if (raw.note.length > MAX_NOTE_LENGTH) {
        throw new Error(
          `${tag}: note must be at most ${MAX_NOTE_LENGTH} characters, got ${raw.note.length}`,
        );
      }
      entry.note = raw.note;
    }
    if (raw.payoutRef !== undefined) {
      // dispatch() only ever writes non-empty strings, so an empty or
      // non-string payoutRef in an untrusted log is malformed.
      if (typeof raw.payoutRef !== "string" || raw.payoutRef.length === 0) {
        throw new Error(
          `${tag}: payoutRef must be a non-empty string, got ${JSON.stringify(raw.payoutRef)}`,
        );
      }
      entry.payoutRef = raw.payoutRef;
    }
    if (raw.payoutAmount !== undefined) {
      // dispatch() only ever writes finite, non-negative, minor-unit
      // amounts, but the parse side deliberately does NOT enforce the
      // minor-unit gate: a legacy log may carry sub-cent precision and
      // must stay readable (backlog #558). Only a negative, NaN/Infinity,
      // or non-number payoutAmount in an untrusted log is malformed
      // (an unrecorded amount simply omits the field).
      if (
        typeof raw.payoutAmount !== "number" ||
        !Number.isFinite(raw.payoutAmount) ||
        raw.payoutAmount < 0
      ) {
        throw new Error(
          `${tag}: payoutAmount must be a non-negative finite number, got ${String(raw.payoutAmount)}`,
        );
      }
      entry.payoutAmount = raw.payoutAmount;
    }
    if (raw.quotedAmount !== undefined) {
      // Same bar as payoutAmount: dispatch() only ever writes finite,
      // non-negative, minor-unit amounts, but the parse side likewise
      // does not enforce the minor-unit gate for legacy readability, so
      // a negative, NaN/Infinity, or non-number quotedAmount in an
      // untrusted log is malformed (an unrecorded quote simply omits
      // the field).
      if (
        typeof raw.quotedAmount !== "number" ||
        !Number.isFinite(raw.quotedAmount) ||
        raw.quotedAmount < 0
      ) {
        throw new Error(
          `${tag}: quotedAmount must be a non-negative finite number, got ${String(raw.quotedAmount)}`,
        );
      }
      entry.quotedAmount = raw.quotedAmount;
    }
    // Hash-chain fields are all-or-nothing per entry: one without the
    // other is malformed. Chain CONTENT verification happens after the
    // structural loop, once every entry is known to be chained or not.
    if (raw.prevHash !== undefined || raw.hash !== undefined) {
      if (typeof raw.prevHash !== "string" || raw.prevHash.length === 0) {
        throw new Error(`${tag}: prevHash must be a non-empty string`);
      }
      if (typeof raw.hash !== "string" || raw.hash.length === 0) {
        throw new Error(`${tag}: hash must be a non-empty string`);
      }
      entry.prevHash = raw.prevHash;
      entry.hash = raw.hash;
    }
    entries.push(entry);
  }
  // Hash-chain rule (tamper evidence for persisted logs): a history that
  // mixes chained and hashless entries is rejected — a partially chained
  // log is the classic signature of a rewritten-middle attack. A fully
  // chained history must re-verify end to end; a fully hashless history
  // is legacy and passes through (fromJSON()/fromHistory() chain it
  // deterministically on rehydration).
  const chainedFlags = entries.map((e) => e.hash !== undefined);
  if (chainedFlags.some(Boolean) && chainedFlags.some((c) => !c)) {
    throw new Error(
      "invalid history: hash-chain entries must not be mixed with hashless entries",
    );
  }
  if (chainedFlags.length > 0 && chainedFlags.every(Boolean)) {
    if (!verifyHistoryChain(entries, {
      ...(secret !== undefined ? { auditSecret: secret } : {}),
    })) {
      throw new Error(
        "invalid history: history hash chain is broken (an entry was tampered with, deleted, or reordered)",
      );
    }
  }
  return entries;
}

/**
 * Event-sourced replay: derive the final state from a pure audit history
 * log — no snapshot envelope, no state field to trust. The history is the
 * only source of truth; every entry must survive the same integrity
 * checks as the audit tests enforce (see parseHistory). An empty history
 * replays to DRAFT, the state of a task with no events yet.
 */
export function replay(history: unknown, opts?: AuditChainOptions): TaskState {
  const entries = parseHistory(history, opts);
  return entries.length === 0 ? "DRAFT" : entries[entries.length - 1].to;
}

/**
 * Canonical JSON for snapshot MACing: object keys sorted
 * recursively (so a JSON round-trip that reorders keys still
 * verifies), array order preserved (reordering history entries would
 * change the audit trail, so it must change the MAC), and
 * primitives via `JSON.stringify`. A non-JSON value (notably
 * `undefined`, which `JSON.stringify` would silently drop) throws
 * instead of being silently normalized — a MAC computed over a
 * silently altered document would be worse than no MAC.
 * Same semantics as the sibling `PayoutEventDedupe` signed
 * snapshot's canonical form (`src/settlementWebhook.ts`).
 */
function canonicalJsonForSignedSnapshot(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(
        "TaskLifecycle: cannot canonicalize a non-finite number for snapshot signing",
      );
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJsonForSignedSnapshot(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJsonForSignedSnapshot(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error(
    `TaskLifecycle: cannot canonicalize a non-JSON value of type ${typeof value} for snapshot signing`,
  );
}

/**
 * Validate a signed-snapshot secret and return its bytes. A secret
 * is a non-empty string (UTF-8) or a non-empty `Buffer` — the same
 * input shapes as the sibling `PayoutEventDedupe` helper, and
 * deliberately without a length floor: this MAC is integrity
 * protection for a persisted snapshot, and the backlog contract
 * for this helper rejects only an empty secret, so a shorter caller
 * secret is the caller's risk to take (use a long random secret;
 * the envelope never records how long it was). An empty or
 * wrongly typed secret is a caller-configuration error, thrown
 * before any task state is touched.
 */
function signedSnapshotSecretBytes(secret: unknown): Buffer {
  if (typeof secret === "string") {
    if (secret.length === 0)
      throw new Error(
        "TaskLifecycle: signed snapshot secret must not be empty",
      );
    return Buffer.from(secret, "utf8");
  }
  if (Buffer.isBuffer(secret)) {
    if (secret.length === 0)
      throw new Error(
        "TaskLifecycle: signed snapshot secret must not be empty",
      );
    return secret;
  }
  throw new Error(
    `TaskLifecycle: signed snapshot secret must be a non-empty string or Buffer, got ${typeof secret}`,
  );
}

/** HMAC-SHA256 (hex) over the canonical JSON of a snapshot. */
function computeSignedSnapshotMac(
  snapshot: TaskSnapshot,
  secretBytes: Buffer,
): string {
  return createHmac("sha256", secretBytes)
    .update(canonicalJsonForSignedSnapshot(snapshot), "utf8")
    .digest("hex");
}

/**
 * Parse and strictly validate an untrusted value into a TaskSnapshot.
 *
 * Throws with a specific message on the first problem found:
 *  - not an object / missing id / unknown state
 *  - `v`, when present, must be exactly {@link SNAPSHOT_VERSION}; a
 *    missing `v` is a legacy (pre-versioning) snapshot and passes, but
 *    any other value throws `unsupported snapshot version`. The version
 *    check runs before the history/hash-chain checks, so a snapshot
 *    from an unknown future format reports its version problem rather
 *    than a misleading structural or chain error.
 *  - unknown top-level fields are rejected (fail-closed), never silently
 *    dropped: only `v`/`id`/`state`/`history`/`slaDeadlines`/
 *    `maxResubmits`/`maxDisputes`/`maxVisitsByState`/`rolePolicy`/
 *    `idempotencyKeys` are allowed (`unknown field "<name>"`), checked
 *    right after the version gate and before any field is consumed, so a
 *    typo like `deadlline` fails loudly instead of quietly losing the
 *    SLA deadlines it was meant to carry
 *  - history entry violations — see parseHistory for the full checklist
 *  - the history's replayed state must land on the snapshot's state
 *  - SLA deadlines must name real states with parseable dates (values
 *    are normalized to canonical ISO, exactly like setSlaDeadline does)
 *  - maxResubmits, when present, must be a non-negative integer or
 *    Infinity (absent means the unlimited default; a history that already
 *    exceeds the budget does NOT fail rehydration — the budget only
 *    governs future dispatches)
 *  - maxDisputes, when present, follows the exact same rule for the
 *    DISPUTE appeal budget
 *  - maxVisitsByState, when present, must be an object mapping known
 *    states to positive integers (absent means no visit budgets; a
 *    history that already exceeds a budget does NOT fail rehydration —
 *    the budget only governs future dispatches into that state)
 *  - idempotencyKeys, when present, must be an array of non-empty
 *    strings (duplicates are deduped on rehydration)
 *
 * Anything produced by toJSON() passes; anything else must earn its way.
 */
function parseSnapshot(snapshot: unknown, auditSecret?: AuditSecret): {
  id: string;
  state: TaskState;
  history: TaskHistoryEntry[];
  slaDeadlines: Partial<Record<TaskState, string>>;
  maxResubmits: number;
  maxDisputes: number;
  maxVisitsByState: Map<TaskState, number>;
  rolePolicy: Map<TaskEvent, string[]>;
  idempotencyKeys: Set<string>;
} {
  if (!isRecord(snapshot)) {
    throw new Error("invalid snapshot: expected a JSON object");
  }
  // Schema version gate, deliberately first (right after the shape
  // check): missing `v` = legacy snapshot, accepted for backward
  // compatibility (the same pass-through treatment as hashless chains);
  // present-but-not-current = a format this parser does not understand,
  // rejected before any structural or hash-chain check can misreport
  // it as corruption.
  if (snapshot.v !== undefined && snapshot.v !== SNAPSHOT_VERSION) {
    throw new Error(
      `invalid snapshot: unsupported snapshot version ${String(snapshot.v)}`,
    );
  }
  // Unknown top-level fields fail closed (see SNAPSHOT_FIELDS): after
  // the version gate, so an unknown future format still reports its
  // version first, but before any field is consumed.
  for (const key of Object.keys(snapshot)) {
    if (!SNAPSHOT_FIELDS.has(key)) {
      throw new Error(`invalid snapshot: unknown field "${key}"`);
    }
  }
  if (typeof snapshot.id !== "string" || snapshot.id.length === 0) {
    throw new Error("invalid snapshot: id must be a non-empty string");
  }
  if (!STATES.has(snapshot.state as TaskState)) {
    throw new Error(`invalid snapshot: unknown state ${String(snapshot.state)}`);
  }
  const state = snapshot.state as TaskState;

  const history = parseHistory(snapshot.history, {
    ...(auditSecret !== undefined ? { auditSecret } : {}),
  });

  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last.to !== state) {
      throw new Error(
        `invalid snapshot: history ends at ${last.to} but state is ${state}`,
      );
    }
  } else if (state !== "DRAFT") {
    throw new Error(
      `invalid snapshot: empty history but state is ${state} (expected DRAFT)`,
    );
  }

  const slaDeadlines: Partial<Record<TaskState, string>> = {};
  if (snapshot.slaDeadlines !== undefined) {
    if (!isRecord(snapshot.slaDeadlines)) {
      throw new Error("invalid snapshot: slaDeadlines must be an object");
    }
    for (const [key, value] of Object.entries(snapshot.slaDeadlines)) {
      if (!STATES.has(key as TaskState)) {
        throw new Error(`invalid snapshot: unknown SLA state ${key}`);
      }
      const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
      if (Number.isNaN(ms)) {
        throw new Error(`invalid snapshot: unparseable SLA deadline for ${key}`);
      }
      slaDeadlines[key as TaskState] = new Date(ms).toISOString();
    }
  }

  // The budget is policy for FUTURE dispatches, not part of the audit
  // truth, so a snapshot whose history already exceeds its budget is
  // still a valid record — rehydration does not throw; the next
  // dispatch("RESUBMIT") will. (assertMaxResubmits rejects null/NaN/
  // negatives/strings; absent means unlimited, exactly the default.)
  const maxResubmits = assertMaxResubmits(
    snapshot.maxResubmits,
    "invalid snapshot",
  );

  // The DISPUTE appeal budget is configuration for future dispatches,
  // exactly like the RESUBMIT retry budget: a snapshot whose history
  // already exceeds it is still a valid record — rehydration does not
  // throw; the next dispatch("DISPUTE") will.
  const maxDisputes = assertMaxDisputes(
    snapshot.maxDisputes,
    "invalid snapshot",
  );

  // The per-state visit budget is configuration for future dispatches,
  // exactly like the event budgets: a snapshot whose history already
  // exceeds a state's budget is still a valid record — rehydration does
  // not throw; the next dispatch into that state will.
  const maxVisitsByState = assertMaxVisitsByState(
    snapshot.maxVisitsByState,
    "invalid snapshot",
  );

  // Same for the RBAC policy: configuration for future dispatches, so it
  // is validated strictly but never consulted against the stored history.
  const rolePolicy = assertRolePolicy(snapshot.rolePolicy, "invalid snapshot");

  // Same for the consumed idempotency keys: dispatch configuration for
  // future dispatches, validated strictly (a tampered key list is
  // rejected, not silently trusted) but never consulted against the
  // stored history.
  const idempotencyKeys = assertIdempotencyKeys(
    snapshot.idempotencyKeys,
    "invalid snapshot",
  );

  return { id: snapshot.id, state, history, slaDeadlines, maxResubmits, maxDisputes, maxVisitsByState, rolePolicy, idempotencyKeys };
}

/** Stateful task with an append-only audit history. */
export class TaskLifecycle {
  readonly id: string;
  private _state: TaskState = "DRAFT";
  private _history: TaskHistoryEntry[] = [];
  private _maxResubmits: number;
  private _maxDisputes: number;
  private _maxVisitsByState: Map<TaskState, number>;
  private _rolePolicy: Map<TaskEvent, string[]>;
  /**
   * Up-front enforcement for PAYOUT_COMPLETE evidence. Task configuration:
   * never written into the JSON snapshot (see toJSON), so a rehydrated
   * task re-enables it via fromHistory(id, history, { requirePayoutRef }).
   */
  private _requirePayoutRef: boolean;
  /**
   * Up-front enforcement for PAYOUT_COMPLETE evidence. Task configuration:
   * never written into the JSON snapshot (see toJSON), so a rehydrated
   * task re-enables it via fromHistory(id, history, { requirePayoutAmount }).
   */
  private _requirePayoutAmount: boolean;
  /**
   * Up-front enforcement for audit attribution. Task configuration:
   * never written into the JSON snapshot (see toJSON), so a rehydrated
   * task re-enables it via fromHistory(id, history, { requireActor }).
   */
  private _requireActor: boolean;
  /**
   * Idempotency keys consumed by successful dispatches. Persisted in
   * the JSON snapshot when non-empty (see DispatchOptions for the
   * documented semantics), and re-attachable on fromHistory() via
   * `TaskLifecycleOptions.idempotencyKeys`.
   */
  private _idempotencyKeys: Set<string>;
  /**
   * Secret for the keyed (HMAC) audit hash chain, or undefined for the
   * default unkeyed chain. Task configuration: never written into the
   * JSON snapshot (see {@link TaskLifecycleOptions.auditSecret}).
   */
  private readonly _auditSecret: AuditSecret | undefined;

  constructor(id: string, opts?: TaskLifecycleOptions) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("invalid task: id must be a non-empty string");
    }
    if (opts !== undefined) {
      if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
        throw new Error("invalid task options: opts must be an object");
      }
      // Unknown option fields fail closed (see TASK_OPTION_FIELDS),
      // checked before any field is consumed so a typo is reported as
      // itself, not as a missing-field default.
      for (const key of Object.keys(opts)) {
        if (!TASK_OPTION_FIELDS.has(key)) {
          throw new Error(`invalid task options: unknown option "${key}"`);
        }
      }
    }
    this.id = id;
    this._maxResubmits = assertMaxResubmits(opts?.maxResubmits, "invalid option");
    this._maxDisputes = assertMaxDisputes(opts?.maxDisputes, "invalid option");
    this._maxVisitsByState = assertMaxVisitsByState(opts?.maxVisitsByState, "invalid option");
    this._rolePolicy = assertRolePolicy(opts?.rolePolicy, "invalid option");
    this._requirePayoutRef = assertRequirePayoutRef(
      opts?.requirePayoutRef,
      "invalid option",
    );
    this._requirePayoutAmount = assertRequirePayoutAmount(
      opts?.requirePayoutAmount,
      "invalid option",
    );
    this._requireActor = assertRequireActor(
      opts?.requireActor,
      "invalid option",
    );
    this._idempotencyKeys = assertIdempotencyKeys(
      opts?.idempotencyKeys,
      "invalid option",
    );
    if (opts?.auditSecret !== undefined) {
      assertAuditSecret(opts.auditSecret, "invalid option");
    }
    // Defensive copy for Buffer secrets: the caller must not be able to
    // mutate the secret material after construction and silently change
    // what future dispatches MAC with.
    this._auditSecret =
      opts?.auditSecret === undefined
        ? undefined
        : Buffer.isBuffer(opts.auditSecret)
          ? Buffer.from(opts.auditSecret)
          : opts.auditSecret;
    // Per-state SLA deadlines, attached up front (validated + normalized
    // by assertSlaDeadlines, the same bar setSlaDeadline applies singly).
    // A throwing map aborts construction, so no half-configured task
    // ever escapes; fromHistory() passes its opts through here, which
    // is how a history-only rebuild re-attaches deadlines.
    this._slaDeadlines = assertSlaDeadlines(opts?.slaDeadlines, "invalid option");
  }

  get state(): TaskState {
    return this._state;
  }

  /**
   * Append-only audit history. Returns a frozen snapshot: the array and
   * every entry are Object.freeze'd copies, so the audit trail cannot be
   * rewritten at runtime — push/splice/entry-field writes all fail —
   * even by an accidental caller. dispatch() remains the only way to
   * append.
   */
  get history(): readonly TaskHistoryEntry[] {
    return Object.freeze(this._history.map((e) => Object.freeze({ ...e })));
  }

  get isTerminal(): boolean {
    return isTerminal(this._state);
  }

  // ------------------------------------------------------------------
  // SLA deadlines — advisory only.
  //
  // A state may carry an optional ISO-8601 deadline. The deadline is
  // informational: it NEVER moves the task by itself. There is no timer,
  // no auto-EXPIRE — a watchdog (or a human) reads isOverdue() and
  // dispatches EXPIRE explicitly, which keeps expiry auditable in the
  // append-only history.
  // ------------------------------------------------------------------

  private _slaDeadlines: Map<TaskState, string> = new Map();

  /**
   * Attach an SLA deadline to a state (defaults to the task's current
   * state). Overwrites any existing deadline for that state.
   * Throws on an unknown state, a non-Date/non-string value, or
   * unparseable input; stores the normalized ISO string. The
   * constructor's `slaDeadlines` option applies this same bar to
   * every entry up front.
   */
  setSlaDeadline(deadline: Date | string, forState: TaskState = this._state): void {
    if (!STATES.has(forState)) {
      throw new Error(`invalid SLA deadline: unknown state ${String(forState)}`);
    }
    if (!(deadline instanceof Date) && typeof deadline !== "string") {
      throw new Error(`invalid SLA deadline: ${String(deadline)}`);
    }
    const ms = deadline instanceof Date ? deadline.getTime() : Date.parse(deadline);
    if (Number.isNaN(ms)) {
      throw new Error(`invalid SLA deadline: ${String(deadline)}`);
    }
    this._slaDeadlines.set(forState, new Date(ms).toISOString());
  }

  /** SLA deadline attached to a state, or undefined if none set. */
  getSlaDeadline(state: TaskState = this._state): string | undefined {
    return this._slaDeadlines.get(state);
  }

  /**
   * Clear the SLA deadline for one state, or for all states when called
   * without an argument.
   */
  clearSlaDeadline(state?: TaskState): void {
    if (state === undefined) this._slaDeadlines.clear();
    else this._slaDeadlines.delete(state);
  }

  /**
   * How many RESUBMITs have been used so far (derived from the
   * append-only history — the audit entries are the source of truth,
   * so the count can never drift from what actually happened).
   */
  private get _resubmitCount(): number {
    let n = 0;
    for (const e of this._history) {
      if (e.event === "RESUBMIT") n++;
    }
    return n;
  }

  /**
   * How many DISPUTE appeal rounds have been used so far (derived from
   * the append-only history, exactly like `_resubmitCount` — the audit
   * entries are the source of truth, so the count survives persistence
   * and can never drift from what actually happened).
   */
  private get _disputeCount(): number {
    let n = 0;
    for (const e of this._history) {
      if (e.event === "DISPUTE") n++;
    }
    return n;
  }

  /**
   * How many times the task has visited a state so far (derived from the
   * append-only history, exactly like `_resubmitCount`): 1 for the
   * task's initial state — the first history entry's `from`, or the
   * current state when the history is still empty — plus 1 per history
   * entry whose `to` is that state. A state the task never entered
   * counts 0. The dispatch-time budget check compares this count
   * against the budget for the TARGET state before appending, so a
   * count already at the budget blocks the next entry into that state.
   */
  private _stateVisitCount(state: TaskState): number {
    if (this._history.length === 0) {
      return this._state === state ? 1 : 0;
    }
    let n = this._history[0].from === state ? 1 : 0;
    for (const e of this._history) {
      if (e.to === state) n++;
    }
    return n;
  }

  /**
   * Move the task to the next state via an event, appending the audit entry.
   *
   * `opts.actor` / `opts.note` are written into the entry verbatim, so they
   * are validated up front: a non-string actor/note, an empty-string
   * actor (zero audit value — `undefined` is the anonymous form), or a
   * note longer than {@link MAX_NOTE_LENGTH} (append-only history is
   * serialized verbatim by every export) throws
   * `invalid dispatch options: …` before anything mutates. This mirrors
   * the strict actor/note checks `fromJSON()` / `fromHistory()` apply to
   * untrusted snapshots — the audit trail stays well-formed on both the
   * live and the rehydrated path. Invalid events still throw
   * `invalid transition: …` (checked after the options).
   *
   * `opts.at` is optional and exists for deterministic audit tests: when
   * given it must be a canonical ISO-8601 timestamp (exactly what
   * `new Date(ms).toISOString()` produces) and must not be earlier than
   * the previous entry's `at` (non-decreasing — the same rule
   * `parseHistory()` enforces), so an injected timestamp always lands
   * verbatim and stays replay-safe. Invalid values throw
   * `invalid dispatch options: …` up front, like actor/note. When
   * omitted, the wall clock is used as before.
   *
   * `opts.payoutRef` is an optional external payment reference (payout
   * batch id, bank/ledger transfer id, …) recorded verbatim into the
   * audit entry for settlement reconciliation. It is intended for
   * `REQUEST_PAYOUT` / `PAYOUT_COMPLETE` entries, but it is accepted on
   * any event — like actor/note, it is generic audit metadata. It must be
   * a non-empty string; an empty or non-string value throws
   * `invalid dispatch options: …` up front, before anything mutates.
   *
   * Advisory (deliberately not enforced by default): a `PAYOUT_COMPLETE`
   * dispatch with no `payoutRef` is legal. The library cannot verify
   * whether an external payment actually happened — requiring the field
   * would be a guess, not a guarantee. If your payout flow always
   * produces a reference, either pass it or opt in to up-front
   * enforcement: a task constructed with `requirePayoutRef: true` rejects
   * `dispatch("PAYOUT_COMPLETE")` without a `payoutRef` with
   * `payout reference required: …` (checked after the transition/budget
   * checks, before anything is appended — a rejected dispatch leaves no
   * trace). The `unreconciledPayouts()` reconciliation helper flags `PAID`
   * tasks whose `PAYOUT_COMPLETE` entry lacks one.
   *
   * `opts.payoutAmount` is the actual settled amount (in the currency the
   * external payment used), recorded verbatim into the audit entry — the
   * `payoutRef` companion for money. It must be a finite number ≥ 0; an
   * invalid value throws `invalid dispatch options: …` up front, before
   * anything mutates. The {@link totalPaidOut} reconciliation helper sums
   * it across `PAID` tasks; a task without one contributes 0 (sums only
   * what was recorded, not what was owed). Like `payoutRef`, it is accepted
   * on any event but intended for `PAYOUT_COMPLETE`.
   *
   * `opts.quotedAmount` is the quoted (owed) counterpart: the amount the
   * task was agreed to pay, recorded verbatim into the audit entry. It
   * must be a finite number ≥ 0; an invalid value throws
   * `invalid dispatch options: …` up front, before anything mutates. Like
   * `payoutAmount`, it is generic audit metadata accepted on any event,
   * but conventionally attached to `ACCEPT` — the moment the price is
   * agreed. The {@link payoutMismatch} / {@link mismatchedPayouts}
   * reconciliation helpers compare it against the settled
   * `PAYOUT_COMPLETE` amount.
   *
   * Optimistic concurrency: when `opts.expectedSeq` is set, it must equal
   * the task's current history length (the last entry's `seq`; `0` for an
   * empty history), or dispatch throws
   * `dispatch conflict: expected seq <n> but task is at seq <m>`. The
   * guard runs before every other check in this method — option
   * validation, the idempotency dedupe, transition legality, RBAC, and
   * the budgets — and a conflict changes nothing (no key consumed, no
   * listener notified), so a caller that re-reads the task can retry with
   * the fresh seq. A non-integer or negative `expectedSeq` throws
   * `invalid dispatch options: …` instead. This is a single-process
   * optimistic lock only — see {@link DispatchOptions}.
   *
   * Idempotency: when `opts.idempotencyKey` carries a key the task has
   * already consumed, dispatch returns the current state immediately as a
   * no-op — no history entry, no listener notification, no transition
   * validation. Failed dispatches never consume a key (the key is recorded
   * only alongside a successful append), so a corrected retry with the same
   * key still executes. The key set survives `toJSON()`/`fromJSON()`
   * round-trips and is re-attached on `fromHistory()` via options — see
   * {@link DispatchOptions}.
   *
   * Retry budget: when this task was constructed with a finite
   * `maxResubmits` and the history already holds that many RESUBMIT
   * entries, `dispatch("RESUBMIT")` throws `resubmit budget exhausted: …`
   * (checked after the transition legality check). This is checked before
   * appending, so a rejected dispatch leaves no trace in the history.
   *
   * Dispute budget: the same rule for appeal rounds — when this task was
   * constructed with a finite `maxDisputes` and the history already holds
   * that many DISPUTE entries, `dispatch("DISPUTE")` throws
   * `dispute budget exhausted: …` (checked after the RESUBMIT budget
   * check; the two budgets govern disjoint events, so the order is
   * unobservable). This is checked before appending, so a rejected
   * dispatch leaves no trace in the history.
   *
   * State visit budget: when this task was constructed with a
   * `maxVisitsByState` budget for the TARGET state and the history
   * already records that many visits to it (initial visit plus one per
   * entry landing there — see `_stateVisitCount`), dispatch throws
   * `state visit budget exhausted: …` (checked after the transition
   * legality, RBAC, and event-budget checks, so an event budget that
   * also blocks the dispatch reports first). This is checked before
   * appending, so a rejected dispatch leaves no trace in the history.
   * Unlike the event budgets, this one governs states, not events: it
   * blocks re-entry into a state the task has already visited too
   * often, whatever event would take it there.
   *
   * Event-level RBAC: when the task carries a `rolePolicy` that lists this
   * event, `opts.actor` must be present and exactly match one of the
   * allowed role names, or dispatch throws `actor not authorized for …`
   * (checked after the transition legality check, before the retry budget).
   * Events the policy does not cover are unrestricted, and a task built
   * without a policy skips the check entirely.
   *
   * Actor-required enforcement: when the task was constructed with
   * `requireActor: true`, every dispatch without an `actor` throws
   * `actor required: …` (checked after the transition/RBAC/budget
   * checks, before the idempotency key is consumed — a rejected dispatch
   * leaves no trace and consumes nothing). Unlike the policy, it covers
   * all events, not just the listed ones; a listed event still needs a
   * matching actor, not just any actor. The default is anonymous
   * dispatches stay legal.
   *
   * After the audit entry is appended, registered `subscribe()` listeners
   * are notified (event, from, to, entry) in subscription order; a listener
   * that throws is isolated — the dispatch still returns normally and the
   * history stays intact.
   */
  dispatch(event: TaskEvent, opts?: DispatchOptions): TaskState {
    // Optimistic-concurrency guard — checked before EVERYTHING else in
    // dispatch (option shape, idempotency dedupe, transition, RBAC,
    // budgets): a caller that pinned the seq it read must learn that the
    // task moved on, loudly, instead of advancing a state it never saw
    // (or silently no-oping through the dedupe). A conflict is a pure
    // rejection: no mutation, no key consumed, no listener notified.
    // The seq of a task is its history length (entries are numbered
    // from 1, so the length IS the last entry's seq; empty history = 0).
    if (opts?.expectedSeq !== undefined) {
      if (
        typeof opts.expectedSeq !== "number" ||
        !Number.isInteger(opts.expectedSeq) ||
        opts.expectedSeq < 0
      ) {
        throw new Error(
          `invalid dispatch options: expectedSeq must be a non-negative integer, got ${String(opts.expectedSeq)}`,
        );
      }
      if (opts.expectedSeq !== this._history.length) {
        throw new Error(
          `dispatch conflict: expected seq ${opts.expectedSeq} but task is at seq ${this._history.length}`,
        );
      }
    }
    // An empty actor has zero audit value: the field exists to say WHO
    // did the dispatch, and "" says nothing (assertRolePolicy already
    // rejects empty role names — the producer side matches that bar).
    // undefined remains legal = anonymous, and the field is omitted.
    if (opts?.actor !== undefined) {
      if (typeof opts.actor !== "string" || opts.actor.length === 0) {
        throw new Error(
          `invalid dispatch options: actor must be a non-empty string, got ${JSON.stringify(opts.actor)}`,
        );
      }
    }
    // Notes are written verbatim into the append-only audit history and
    // serialized on every toJSON()/historyToNdjson() export, so an
    // oversized note permanently inflates the persisted log — cap it.
    if (opts?.note !== undefined) {
      if (typeof opts.note !== "string") {
        throw new Error(
          `invalid dispatch options: note must be a string, got ${typeof opts.note}`,
        );
      }
      if (opts.note.length > MAX_NOTE_LENGTH) {
        throw new Error(
          `invalid dispatch options: note must be at most ${MAX_NOTE_LENGTH} characters, got ${opts.note.length}`,
        );
      }
    }
    if (opts?.payoutRef !== undefined) {
      if (typeof opts.payoutRef !== "string" || opts.payoutRef.length === 0) {
        throw new Error(
          `invalid dispatch options: payoutRef must be a non-empty string, got ${JSON.stringify(opts.payoutRef)}`,
        );
      }
    }
    if (opts?.payoutAmount !== undefined) {
      // A payout amount must be a real, non-negative number: NaN, ±Infinity
      // and negatives are caller errors (a bad amount in the audit trail
      // would poison totalPaidOut), so fail fast up front, before
      // anything mutates.
      if (
        typeof opts.payoutAmount !== "number" ||
        !Number.isFinite(opts.payoutAmount) ||
        opts.payoutAmount < 0
      ) {
        throw new Error(
          `invalid dispatch options: payoutAmount must be a non-negative finite number, got ${String(opts.payoutAmount)}`,
        );
      }
      // Minor-unit denomination (backlog #558): the amount must also be
      // exactly representable in integer minor units — more than 2
      // decimals cannot be stored as integer cents, and silently keeping
      // sub-cent precision is how binary-float drift accumulates in
      // batch totals. The round-trip through toMinorUnits is the check:
      // an amount that does not survive it carries sub-cent precision.
      // Stored verbatim once it passes; no rounding is applied here.
      if (toMinorUnits(opts.payoutAmount) / 100 !== opts.payoutAmount) {
        throw new Error(
          `invalid dispatch options: payoutAmount must be a minor-unit amount (at most 2 decimal places), got ${String(opts.payoutAmount)}`,
        );
      }
    }
    if (opts?.quotedAmount !== undefined) {
      // Same bar as payoutAmount: a quoted amount must be a real,
      // non-negative number — a bad quote in the audit trail would
      // poison payoutMismatch reconciliation — so fail fast up front,
      // before anything mutates. Same minor-unit gate as payoutAmount:
      // sub-cent quotes are rejected, never silently stored.
      if (
        typeof opts.quotedAmount !== "number" ||
        !Number.isFinite(opts.quotedAmount) ||
        opts.quotedAmount < 0
      ) {
        throw new Error(
          `invalid dispatch options: quotedAmount must be a non-negative finite number, got ${String(opts.quotedAmount)}`,
        );
      }
      if (toMinorUnits(opts.quotedAmount) / 100 !== opts.quotedAmount) {
        throw new Error(
          `invalid dispatch options: quotedAmount must be a minor-unit amount (at most 2 decimal places), got ${String(opts.quotedAmount)}`,
        );
      }
    }
    if (opts?.idempotencyKey !== undefined) {
      if (
        typeof opts.idempotencyKey !== "string" ||
        opts.idempotencyKey.length === 0
      ) {
        throw new Error(
          `invalid dispatch options: idempotencyKey must be a non-empty string, got ${JSON.stringify(opts.idempotencyKey)}`,
        );
      }
      // Retry: a known key is a complete no-op — no transition validation
      // (the task may already have moved on), no history append, no
      // listener notification. Failed dispatches consume nothing, so this
      // point is only reached when the key was fully consumed by an
      // earlier successful dispatch.
      if (this._idempotencyKeys.has(opts.idempotencyKey)) {
        return this._state;
      }
    }
    if (opts?.at !== undefined) {
      if (typeof opts.at !== "string" || !isCanonicalIso(opts.at)) {
        throw new Error(
          `invalid dispatch options: at must be canonical ISO-8601, got ${String(opts.at)}`,
        );
      }
      const prev = this._history[this._history.length - 1];
      if (prev !== undefined && Date.parse(opts.at) < Date.parse(prev.at)) {
        throw new Error(
          `invalid dispatch options: at ${opts.at} is earlier than the previous entry's at ${prev.at}`,
        );
      }
    }
    const from = this._state;
    const to = transition(from, event); // throws on invalid transition
    const allowedRoles = this._rolePolicy.get(event);
    if (allowedRoles !== undefined) {
      const actor = opts?.actor;
      const list = allowedRoles.join(", ");
      if (actor === undefined) {
        throw new Error(
          `actor not authorized for ${event}: policy requires an actor in [${list}]`,
        );
      }
      if (!allowedRoles.includes(actor)) {
        throw new Error(
          `actor not authorized for ${event}: "${actor}" is not in [${list}]`,
        );
      }
    }
    if (event === "RESUBMIT" && this._resubmitCount >= this._maxResubmits) {
      throw new Error(
        `resubmit budget exhausted: ${this._resubmitCount} of ${this._maxResubmits} RESUBMITs already used`,
      );
    }
    if (event === "DISPUTE" && this._disputeCount >= this._maxDisputes) {
      throw new Error(
        `dispute budget exhausted: ${this._disputeCount} of ${this._maxDisputes} DISPUTEs already used`,
      );
    }
    const visitBudget = this._maxVisitsByState.get(to);
    if (visitBudget !== undefined) {
      const visits = this._stateVisitCount(to);
      if (visits >= visitBudget) {
        throw new Error(
          `state visit budget exhausted: ${to} already visited ${visits} of ${visitBudget} times`,
        );
      }
    }
    if (this._requireActor && opts?.actor === undefined) {
      // Up-front enforcement is opt-in configuration: the advisory
      // default stays legal, and requiring an actor cannot verify who
      // the actor really is — it only guarantees the audit trail names
      // one. Checked alongside requirePayoutRef, after the transition /
      // RBAC / budget checks and before the idempotency key is consumed,
      // so a rejected dispatch consumes nothing.
      throw new Error(
        "actor required: dispatch must carry a non-empty actor when requireActor is enabled",
      );
    }
    if (
      event === "PAYOUT_COMPLETE" &&
      this._requirePayoutRef &&
      opts?.payoutRef === undefined
    ) {
      // Up-front enforcement is opt-in configuration: the advisory default
      // stays legal, and requiring the reference cannot guarantee the
      // external payment happened — it only guarantees the audit trail
      // says which transfer it was. Checked before the idempotency key is
      // consumed, so a rejected dispatch consumes nothing.
      throw new Error(
        "payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled",
      );
    }
    if (
      event === "PAYOUT_COMPLETE" &&
      this._requirePayoutAmount &&
      opts?.payoutAmount === undefined
    ) {
      // Same shape as the requirePayoutRef gate directly above: opt-in
      // configuration, advisory default stays legal, and requiring the
      // amount cannot prove the external payment happened — it only
      // guarantees the audit trail records how much settled. Only
      // presence is checked here: a present amount already passed the
      // dispatch shape validation (finite, non-negative, at most 2
      // decimal places), so NaN/negative/sub-cent amounts never reach
      // this gate. Checked before the idempotency key is consumed, so a
      // rejected dispatch consumes nothing.
      throw new Error(
        "payout amount required: PAYOUT_COMPLETE must carry a payoutAmount when requirePayoutAmount is enabled",
      );
    }
    // All checks passed: consume the idempotency key exactly once, with the
    // successful append. Keys are never recorded for failed dispatches,
    // so retrying a bad call with the same key stays possible.
    if (opts?.idempotencyKey !== undefined) {
      this._idempotencyKeys.add(opts.idempotencyKey);
    }
    this._state = to;
    // Hash-chain the audit trail: the new entry commits to the previous
    // entry's hash (genesis links to GENESIS_PREV_HASH), so any later
    // rewrite of a persisted entry — or of a persisted NDJSON line — is
    // detectable via verifyHistoryChain / parseHistory. The live history
    // is always fully chained (fromJSON()/fromHistory() chain legacy
    // hashless histories on rehydration), so the fallback is defensive
    // only.
    const prevHash: string =
      this._history[this._history.length - 1]?.hash ?? GENESIS_PREV_HASH;
    const entry: TaskHistoryEntry = {
      seq: this._history.length + 1,
      event,
      from,
      to,
      at: opts?.at ?? new Date().toISOString(),
      prevHash,
    };
    if (opts?.actor !== undefined) entry.actor = opts.actor;
    if (opts?.note !== undefined) entry.note = opts.note;
    if (opts?.payoutRef !== undefined) entry.payoutRef = opts.payoutRef;
    if (opts?.payoutAmount !== undefined) entry.payoutAmount = opts.payoutAmount;
    if (opts?.quotedAmount !== undefined) entry.quotedAmount = opts.quotedAmount;
    entry.hash = hashHistoryEntry(
      canonicalHistoryEntry(entry),
      prevHash,
      this._auditSecret,
    );
    this._history.push(entry);
    this._notifyListeners(event, from, to, entry);
    return to;
  }

  // ------------------------------------------------------------------
  // Dispatch subscriptions — the notification fan-out seam.
  //
  // `dispatch` currently has no external notification point beyond the
  // audit history. subscribe() fills that seam with in-process hooks:
  // listeners run AFTER the audit entry is appended, in subscription
  // order, and can never roll it back.
  //
  // Error isolation is a deliberate, documented tradeoff: each listener's
  // throw is caught and swallowed so a bad fan-out consumer can never
  // break dispatch, corrupt the audit trail, or starve later listeners.
  // For failure visibility without wrapping every listener in try/catch,
  // subscribe(listener, { onError }) routes each caught error to onError
  // with the dispatch context; a throwing onError is swallowed as well.
  // The entry handed to listeners is a frozen, detached copy,
  // so a listener cannot rewrite the audit trail either.
  //
  // Honest limits: subscriptions are in-memory only. They are NOT part of
  // the JSON snapshot (toJSON()/fromJSON()/fromHistory() rehydrate with
  // zero listeners), and there is no durable fan-out (queues, webhooks,
  // retries) — that stays the caller's infrastructure.
  // ------------------------------------------------------------------

  private _listeners: Array<{
    listener: TaskEventListener;
    onError?: SubscribeOptions["onError"];
  }> = [];

  /**
   * Register a listener called with (event, from, to, entry) after every
   * successful dispatch. Returns an unsubscribe function (idempotent:
   * calling it twice is a no-op).
   *
   * Listeners are called in subscription order over a snapshot of the
   * listener list, so a listener that subscribes/unsubscribes during
   * notification affects only later dispatches. A listener that throws is
   * isolated: the error is swallowed, the remaining listeners still run,
   * and dispatch returns normally with the audit entry intact. Pass
   * `{ onError }` to observe those failures instead of losing them to
   * the documented silence.
   */
  subscribe(
    listener: TaskEventListener,
    opts?: SubscribeOptions,
  ): () => void {
    if (typeof listener !== "function") {
      throw new Error(
        `invalid subscribe: listener must be a function, got ${typeof listener}`,
      );
    }
    if (
      opts !== undefined &&
      (typeof opts !== "object" || opts === null || Array.isArray(opts))
    ) {
      throw new Error(
        `invalid subscribe: options must be an object, got ${Array.isArray(opts) ? "array" : typeof opts}`,
      );
    }
    const onError = opts?.onError;
    if (onError !== undefined && typeof onError !== "function") {
      throw new Error(
        `invalid subscribe: onError must be a function, got ${typeof onError}`,
      );
    }
    this._listeners.push({ listener, onError });
    return () => {
      const i = this._listeners.findIndex((e) => e.listener === listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  /** How many listeners are currently subscribed (debug/observability aid). */
  get listenerCount(): number {
    return this._listeners.length;
  }

  private _notifyListeners(
    event: TaskEvent,
    from: TaskState,
    to: TaskState,
    entry: TaskHistoryEntry,
  ): void {
    if (this._listeners.length === 0) return;
    const notification = Object.freeze({ ...entry });
    for (const { listener, onError } of [...this._listeners]) {
      try {
        listener(event, from, to, notification);
      } catch (err) {
        // Swallowed on purpose: isolation is the contract (see subscribe).
        if (onError !== undefined) {
          try {
            onError(err, { event, from, to });
          } catch {
            // A broken error hook is isolated the same way.
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // JSON persistence — snapshot export / import.
  //
  // The history is the audit trail, so a snapshot carries the live state,
  // the full append-only history, and the advisory SLA deadlines — all as
  // plain JSON, safe for any document store. Rehydrating runs the same
  // integrity checks the audit tests enforce: seq continuity, from/to
  // chain, legal transition edges, canonical ISO timestamps.
  // ------------------------------------------------------------------

  /**
   * Export this task as a plain-JSON snapshot. The returned object is
   * detached: mutating it never affects the live task.
   *
   * The snapshot always carries `v: SNAPSHOT_VERSION` (currently 1) as
   * its first field. Snapshots written before versioning existed have
   * no `v`; `fromJSON()` still accepts those as legacy (see
   * {@link TaskSnapshot.v}).
   *
   * When the retry budget is finite, `maxResubmits` is included in the
   * envelope (the unlimited default is omitted — JSON cannot represent
   * `Infinity`). The used count is not stored; it is derived from the
   * history on rehydration, so a round-trip keeps the budget AND the
   * used count without either being able to drift from the audit trail.
   *
   * The same convention applies to the DISPUTE appeal budget:
   * `maxDisputes` is stored only when finite, and the used appeal count
   * is derived from the history on rehydration.
   *
   * The same convention applies to the per-state visit budget:
   * `maxVisitsByState` is stored only when the map is non-empty, and
   * the used visit counts are derived from the history on rehydration.
   *
   * A task-level RBAC policy is included as a plain record when set
   * (absent means unrestricted, exactly the constructor default).
   *
   * The consumed idempotency key set IS included, but only when
   * non-empty: an empty set is omitted so keyless tasks keep the exact
   * legacy snapshot shape. A rehydrated task therefore keeps the
   * exactly-once effect of every consumed key (see DispatchOptions).
   *
   * `requirePayoutRef` is likewise NOT included: it is caller
   * configuration, not audit data (same class as the idempotency set,
   * deliberately different from `maxDisputes`/`maxResubmits`/`rolePolicy`,
   * which are task-level rules the audit trail must keep). A rehydrated
   * task re-enables up-front payout-reference enforcement via
   * `fromHistory(id, history, { requirePayoutRef: true })`; until then
   * `PAYOUT_COMPLETE` without a `payoutRef` is legal again.
   *
   * `requirePayoutAmount` is likewise NOT included, for the same reason:
   * a rehydrated task re-enables up-front payout-amount enforcement via
   * `fromHistory(id, history, { requirePayoutAmount: true })`; until then
   * `PAYOUT_COMPLETE` without a `payoutAmount` is legal again.
   *
   * `requireActor` is likewise NOT included, for the same reason: a
   * rehydrated task re-enables up-front actor-required enforcement via
   * `fromHistory(id, history, { requireActor: true })`; until then
   * anonymous dispatches are legal again.
   *
   * The `auditSecret` is NOT included either — a snapshot must never
   * carry the secret that MACs its own history. A keyed task's
   * snapshot therefore only rehydrates when the caller re-supplies
   * the secret: `fromJSON(snapshot, { auditSecret })`.
   */
  toJSON(): TaskSnapshot {
    const deadlines: Partial<Record<TaskState, string>> = {};
    for (const [state, deadline] of this._slaDeadlines) {
      deadlines[state] = deadline;
    }
    const snapshot: TaskSnapshot = {
      v: SNAPSHOT_VERSION,
      id: this.id,
      state: this._state,
      history: this._history.map((e) => ({ ...e })),
      slaDeadlines: deadlines,
    };
    if (Number.isFinite(this._maxResubmits)) {
      snapshot.maxResubmits = this._maxResubmits;
    }
    if (Number.isFinite(this._maxDisputes)) {
      snapshot.maxDisputes = this._maxDisputes;
    }
    if (this._maxVisitsByState.size > 0) {
      snapshot.maxVisitsByState = Object.fromEntries(this._maxVisitsByState);
    }
    if (this._rolePolicy.size > 0) {
      snapshot.rolePolicy = Object.fromEntries(this._rolePolicy);
    }
    if (this._idempotencyKeys.size > 0) {
      snapshot.idempotencyKeys = [...this._idempotencyKeys];
    }
    return snapshot;
  }

  /**
   * Export the current snapshot wrapped in an HMAC-signed envelope
   * (see {@link TaskLifecycleSignedSnapshotEnvelope}):
   * `{ v: 1, snapshot, mac }` where `mac` is HMAC-SHA256 over the
   * canonical JSON of the snapshot under `secret`. Persist the
   * envelope (plain JSON) before a restart and restore it with
   * {@link TaskLifecycle.restoreSignedSnapshot} — a process that
   * restarts keeps its state, SLA deadlines, budgets, policy, and
   * consumed idempotency keys, and anyone who rewrites the persisted
   * file without the secret is caught at restore instead of silently
   * pushing a deadline back, loosening a budget or a policy, or
   * clearing consumed keys.
   *
   * The secret is never written into the envelope, and the envelope
   * is integrity protection only, not encryption: the snapshot
   * contents are plain JSON, so the secret must be kept where the
   * snapshot writer keeps its other signing-side secrets. An empty
   * secret is a caller-configuration error. The unsigned `toJSON()`
   * path is unchanged: this envelope is opt-in, and a caller that
   * never signs keeps the old trusted-configuration semantics.
   * The envelope secret need not equal the task's `auditSecret`;
   * on restore, `opts.auditSecret` is still handed to `fromJSON` so a
   * keyed history chain re-verifies under its own key.
   */
  exportSignedSnapshot(
    secret: string | Buffer,
  ): TaskLifecycleSignedSnapshotEnvelope {
    const secretBytes = signedSnapshotSecretBytes(secret);
    const snapshot = this.toJSON();
    return { v: 1, snapshot, mac: computeSignedSnapshotMac(snapshot, secretBytes) };
  }

  /**
   * Rebuild a TaskLifecycle from an untrusted snapshot (e.g. one read
   * back from a store). Throws a specific error on any malformed or
   * inconsistent input — see parseSnapshot for the full checklist.
   *
   * `opts.auditSecret` re-attaches the keyed hash-chain secret (the
   * snapshot never stores it — see {@link TaskLifecycleOptions}):
   * a snapshot chained in keyed mode only restores when the same
   * secret is supplied here — without it, or with the wrong secret,
   * the chain check fails and the snapshot is rejected as broken
   * (fail-closed; the same applies in reverse to an unkeyed snapshot
   * restored with a secret). A legacy hashless snapshot restored with
   * a secret is chained in keyed mode on rehydration, so its live
   * history verifies with that secret from then on.
   */
  static fromJSON(
    snapshot: unknown,
    opts?: TaskLifecycleOptions,
  ): TaskLifecycle {
    const parsed = parseSnapshot(snapshot, opts?.auditSecret);
    const task = new TaskLifecycle(parsed.id, {
      maxResubmits: parsed.maxResubmits,
      maxDisputes: parsed.maxDisputes,
      ...(opts?.auditSecret !== undefined
        ? { auditSecret: opts.auditSecret }
        : {}),
    });
    task._state = parsed.state;
    task._idempotencyKeys = parsed.idempotencyKeys;
    // A fully hashless legacy history is chained deterministically here
    // (the audit content is unchanged — the hash is a pure function of
    // the entry fields), so the live history is always fully chained and
    // later dispatches keep linking to it.
    task._history = chainHistoryEntries(parsed.history, opts?.auditSecret);
    task._maxVisitsByState = parsed.maxVisitsByState;
    task._rolePolicy = parsed.rolePolicy;
    for (const [state, deadline] of Object.entries(parsed.slaDeadlines)) {
      task.setSlaDeadline(deadline, state as TaskState);
    }
    return task;
  }

  /**
   * Rebuild a TaskLifecycle from a signed envelope produced by
   * {@link TaskLifecycle.exportSignedSnapshot} (typically after a
   * `JSON.parse` of the persisted form). `opts` is passed straight
   * through to {@link TaskLifecycle.fromJSON} — including
   * `opts.auditSecret`, which feeds the snapshot's hash-chain
   * re-verification, so a keyed chain restores only under its own key
   * (and a keyed chain restored without the key, or with the wrong
   * key, is rejected as broken, exactly as on the unsigned path).
   *
   * Restore is fail-closed in the same order as the unsigned path,
   * with authenticity checked first: an envelope with an unknown
   * field (including a smuggled `secret`), a version other than
   * `1`, a malformed `mac`, or a MAC that does not match the
   * snapshot under `secret` throws a descriptive configuration
   * `Error` and no task is produced — a tampered `state`,
   * `slaDeadlines`, `maxResubmits`, `maxDisputes`,
   * `maxVisitsByState`, `rolePolicy`, or `idempotencyKeys`, a
   * tampered history entry, or a wrong secret all fail here, before
   * any snapshot parsing, so a tampered envelope can never partially
   * install. A MAC-valid envelope whose snapshot is itself malformed
   * then fails through the same strict snapshot validation as
   * {@link TaskLifecycle.fromJSON}, again with no task produced. The
   * MAC comparison is constant-time over equal-length hex digests; a
   * wrong-length `mac` is rejected as malformed before comparison.
   *
   * The unsigned `fromJSON()` and this signed restore do not accept
   * each other's input: an unsigned snapshot has no `mac` (and
   * fields where the envelope expects `snapshot`), and a signed
   * envelope has fields the unsigned path rejects — so a caller
   * cannot silently downgrade a signed restore to the
   * trusted-configuration path.
   */
  static restoreSignedSnapshot(
    envelope: unknown,
    secret: string | Buffer,
    opts?: TaskLifecycleOptions,
  ): TaskLifecycle {
    const secretBytes = signedSnapshotSecretBytes(secret);
    const fail = (detail: string): never => {
      throw new Error(
        `TaskLifecycle: invalid signed snapshot envelope: ${detail}`,
      );
    };
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      Array.isArray(envelope)
    )
      fail("expected an object of the form { v: 1, snapshot, mac }");
    const record = envelope as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "v" && key !== "snapshot" && key !== "mac")
        fail(`unknown field "${key}"`);
    }
    if (record.v !== 1)
      fail(
        `unsupported envelope version ${JSON.stringify(record.v) ?? String(record.v)} (expected 1)`,
      );
    const mac = record.mac;
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac))
      throw new Error(
        "TaskLifecycle: invalid signed snapshot envelope: mac must be a 64-character lowercase hex HMAC-SHA256 digest",
      );
    const snapshot = record.snapshot;
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      Array.isArray(snapshot)
    )
      fail('"snapshot" must be an object');
    const expectedMac = computeSignedSnapshotMac(
      snapshot as TaskSnapshot,
      secretBytes,
    );
    if (!constantTimeHexEqual(expectedMac, mac))
      throw new Error(
        "TaskLifecycle: signed snapshot MAC mismatch: the snapshot was tampered with or the secret is wrong",
      );
    // MAC verified — now the same strict structural validation as fromJSON().
    return TaskLifecycle.fromJSON(snapshot, opts);
  }

  /** Alias of {@link TaskLifecycle.restoreSignedSnapshot} (snapshot naming). */
  static fromSignedSnapshot(
    envelope: unknown,
    secret: string | Buffer,
    opts?: TaskLifecycleOptions,
  ): TaskLifecycle {
    return TaskLifecycle.restoreSignedSnapshot(envelope, secret, opts);
  }

  /**
   * Rebuild a TaskLifecycle from a pure audit history log, making the
   * history the only source of truth: the final state is derived by
   * replaying the entries, not read from a state field.
   *
   * The task id is not recoverable from the log (history entries carry
   * no id), so it is passed explicitly rather than invented. Advisory
   * SLA deadlines are not part of the audit log and are therefore not
   * restored from the log — re-attach them with
   * `opts.slaDeadlines` (see `TaskLifecycleOptions`), or use
   * fromJSON() when the snapshot envelope is available.
   * Throws a specific `invalid history: …` error on any malformed or
   * inconsistent input — see parseHistory for the full checklist.
   *
   * `opts.maxResubmits` re-attaches a retry budget to the rehydrated
   * task; the used count is derived from the replayed history (the same
   * rule as fromJSON()). Omit it for the unlimited default.
   * `opts.maxDisputes` re-attaches a DISPUTE appeal budget the same way;
   * omit it and the rehydrated task disputes without limit.
   * `opts.maxVisitsByState` re-attaches a per-state visit budget the
   * same way; the used visit counts derive from the replayed log, so a
   * state the log already visited to its budget blocks the next entry
   * into it. Omit it and the rehydrated task re-enters states without
   * limit.
   * `opts.rolePolicy`
   * re-attaches an event-level RBAC policy the same way; omit it and the
   * rehydrated task is unrestricted (policy is caller configuration, not
   * audit data, so the log cannot restore it on its own).
   * `opts.requirePayoutRef` re-attaches up-front payout-reference
   * enforcement the same way; omit it and the rehydrated task falls back
   * to the advisory default (the switch is not part of the audit log, so
   * it cannot be restored on its own).
   * `opts.requirePayoutAmount` re-attaches up-front payout-amount
   * enforcement the same way; omit it and the rehydrated task falls back
   * to the advisory default (the switch is not part of the audit log, so
   * it cannot be restored on its own).
   * `opts.requireActor` re-attaches up-front actor-required enforcement
   * the same way; omit it and the rehydrated task falls back to the
   * advisory default (the switch is not part of the audit log, so it
   * cannot be restored on its own).
   * `opts.idempotencyKeys` re-attaches the consumed dispatch idempotency
   * keys the same way; omit it and the rehydrated task starts with an
   * empty key set, so a retried key would re-execute (the keys are not
   * part of the audit log, so they cannot be restored on their own).
   * `opts.auditSecret` re-attaches the keyed hash-chain secret the same
   * way; a keyed log restored without it (or with the wrong secret) is
   * rejected as a broken hash chain, and a legacy hashless log restored
   * with a secret is chained in keyed mode on rehydration.
   * `opts.slaDeadlines` re-attaches per-state advisory SLA deadlines
   * the same way; omit it and the rehydrated task has no deadlines
   * (the log carries none, so they cannot be restored on their own).
   */
  static fromHistory(
    id: string,
    history: unknown,
    opts?: TaskLifecycleOptions,
  ): TaskLifecycle {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("invalid history: id must be a non-empty string");
    }
    const task = new TaskLifecycle(id, opts);
    task._state = replay(history, {
      ...(opts?.auditSecret !== undefined
        ? { auditSecret: opts.auditSecret }
        : {}),
    });
    // See fromJSON(): a legacy hashless log is chained deterministically
    // on rehydration, so the live history is always fully chained.
    task._history = chainHistoryEntries(
      parseHistory(history, {
        ...(opts?.auditSecret !== undefined
          ? { auditSecret: opts.auditSecret }
          : {}),
      }),
      opts?.auditSecret,
    );
    return task;
  }
}
