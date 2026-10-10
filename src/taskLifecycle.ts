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

import { createHash, createHmac } from "node:crypto";

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
 * Per-task outcome of {@link expireOverdueTasks}.
 */
export interface ExpireOverdueResult {
  /** The task this outcome belongs to. */
  task: TaskLifecycle;
  /** True when the EXPIRE dispatch succeeded and the task is now EXPIRED. */
  expired: boolean;
  /** Set when the EXPIRE dispatch threw; the message of the caught error. */
  error?: string;
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
 * Same semantics as the manual pattern: nothing auto-migrates. Expiry
 * only happens through an explicit, auditable dispatch that lands in the
 * append-only history. Only overdue (non-terminal, past deadline) tasks
 * are attempted; the result has one entry per attempted task, in batch
 * order. The `now` default is the real clock, so unit tests pin it.
 */
export function expireOverdueTasks(
  tasks: readonly TaskLifecycle[],
  now: Date = new Date(),
): ExpireOverdueResult[] {
  return expiredTasks(tasks, now).map((task) => {
    try {
      task.dispatch("EXPIRE");
      return { task, expired: true };
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
 * untouched and produce no entry. Pass a custom `action` to do
 * something other than abandon — e.g. notify-only paging that leaves
 * the task in its current state:
 *
 *   actOnStaleTasks(tasks, (t) => pageOnCall(t.id), budgets);
 *
 * Configuration is validated fail-fast before any action runs:
 * an invalid `maxAgeByState` or `now` (via `staleTasks()`) or a
 * non-function `action` throws and no task is touched. The `now`
 * default is the real clock, so unit tests pin it.
 */
export function actOnStaleTasks(
  tasks: readonly TaskLifecycle[],
  action: StaleTaskAction | undefined,
  maxAgeByState: Partial<Record<TaskState, number>>,
  now: Date = new Date(),
): StaleActionResult[] {
  if (action !== undefined && typeof action !== "function") {
    throw new Error("invalid action: expected a function (task) => void");
  }
  const run: StaleTaskAction =
    action ?? ((task) => task.dispatch("ABANDON", { actor: "system" }));
  // staleTasks() validates maxAgeByState and now fail-fast, before any
  // action runs.
  return staleTasks(tasks, maxAgeByState, now).map((task) => {
    try {
      run(task);
      return { task, acted: true };
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

/**
 * Reconciliation helper: sum the actual settled payout amounts across a
 * batch of `PAID` tasks. For each task it reads the `payoutAmount`
 * recorded on its `PAYOUT_COMPLETE` entry (see {@link DispatchOptions})
 * and returns the total rounded to cents (same `Math.round(x * 100) / 100`
 * convention as the sibling escrow-state-machine-ts money math).
 *
 * Honest accounting rules, all deliberate:
 *  - only `PAID` tasks contribute; in-flight or otherwise-terminated
 *    tasks are ignored;
 *  - a `PAID` task whose `PAYOUT_COMPLETE` entry carries no `payoutAmount`
 *    contributes 0 — the library cannot observe the external payment, so
 *    this sums only what was recorded, not what was owed;
 *  - per-entry amounts are stored verbatim; only the returned total is
 *    cent-rounded (a per-entry amount with more than 2 decimals is the
 *    caller's representation choice, see
 *    {@link TaskHistoryEntry.payoutAmount});
 *  - empty input returns 0.
 *
 * Pure: reads the tasks, never mutates or dispatches.
 */
export function totalPaidOut(tasks: readonly TaskLifecycle[]): number {
  let total = 0;
  for (const task of tasks) {
    if (task.state !== "PAID") continue;
    let complete: TaskHistoryEntry | undefined;
    for (const entry of task.history) {
      if (entry.event === "PAYOUT_COMPLETE") complete = entry;
    }
    if (complete?.payoutAmount !== undefined) {
      total += complete.payoutAmount;
    }
  }
  return Math.round(total * 100) / 100;
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
   * Stored verbatim on the audit entry (no rounding at write time); the
   * {@link totalPaidOut} helper rounds the summed total to cents.
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
   * Stored verbatim on the audit entry (no rounding at write time),
   * exactly like `payoutAmount`. The {@link payoutMismatch} helper
   * compares the last `ACCEPT` quote against the `PAYOUT_COMPLETE`
   * settled amount for settlement reconciliation.
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
   * are all-or-nothing per entry and per history.
   */
  prevHash?: string;
  /**
   * Content hash of this entry within the audit-history hash chain.
   * Recomputed by {@link verifyHistoryChain} (and enforced by
   * {@link parseHistory}); rewriting any field of a chained entry
   * invalidates it. See `prevHash` for the chaining rule.
   */
  hash?: string;
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
  rolePolicy?: RolePolicy;
  requirePayoutRef?: boolean;
  idempotencyKeys?: string[];
  auditSecret?: AuditSecret;
}

function assertRequirePayoutRef(value: unknown, tag: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(
      `${tag}: requirePayoutRef must be a boolean, got ${String(value)}`,
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
   * when provided; an invalid value throws
   * `invalid dispatch options: …` up front, before anything mutates.
   */
  payoutAmount?: number;
  /**
   * Quoted (owed) amount recorded on the audit entry
   * ({@link TaskHistoryEntry.quotedAmount}). Must be a finite number ≥ 0
   * when provided; an invalid value throws
   * `invalid dispatch options: …` up front, before anything mutates.
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCanonicalIso(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const ms = Date.parse(s);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === s;
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
    if (hashHistoryEntry(canonical, entry.prevHash!, secret) !== entry.hash) {
      return false;
    }
    expectedPrev = entry.hash!;
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
      // dispatch() only ever writes finite, non-negative amounts, so a
      // negative, NaN/Infinity, or non-number payoutAmount in an untrusted
      // log is malformed (an unrecorded amount simply omits the field).
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
      // non-negative amounts, so a negative, NaN/Infinity, or non-number
      // quotedAmount in an untrusted log is malformed (an unrecorded
      // quote simply omits the field).
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
    if (!verifyHistoryChain(entries, { auditSecret: secret })) {
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
 *    `maxResubmits`/`maxDisputes`/`rolePolicy`/`idempotencyKeys` are
 *    allowed (`unknown field "<name>"`), checked right after the
 *    version gate and before any field is consumed, so a typo like
 *    `deadlline` fails loudly instead of quietly losing the SLA
 *    deadlines it was meant to carry
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

  const history = parseHistory(snapshot.history, { auditSecret });

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

  return { id: snapshot.id, state, history, slaDeadlines, maxResubmits, maxDisputes, rolePolicy, idempotencyKeys };
}

/** Stateful task with an append-only audit history. */
export class TaskLifecycle {
  readonly id: string;
  private _state: TaskState = "DRAFT";
  private _history: TaskHistoryEntry[] = [];
  private _maxResubmits: number;
  private _maxDisputes: number;
  private _rolePolicy: Map<TaskEvent, string[]>;
  /**
   * Up-front enforcement for PAYOUT_COMPLETE evidence. Task configuration:
   * never written into the JSON snapshot (see toJSON), so a rehydrated
   * task re-enables it via fromHistory(id, history, { requirePayoutRef }).
   */
  private _requirePayoutRef: boolean;
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
    this.id = id;
    this._maxResubmits = assertMaxResubmits(opts?.maxResubmits, "invalid option");
    this._maxDisputes = assertMaxDisputes(opts?.maxDisputes, "invalid option");
    this._rolePolicy = assertRolePolicy(opts?.rolePolicy, "invalid option");
    this._requirePayoutRef = assertRequirePayoutRef(
      opts?.requirePayoutRef,
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
   * Throws on unparseable input; stores the normalized ISO string.
   */
  setSlaDeadline(deadline: Date | string, forState: TaskState = this._state): void {
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
   * Event-level RBAC: when the task carries a `rolePolicy` that lists this
   * event, `opts.actor` must be present and exactly match one of the
   * allowed role names, or dispatch throws `actor not authorized for …`
   * (checked after the transition legality check, before the retry budget).
   * Events the policy does not cover are unrestricted, and a task built
   * without a policy skips the check entirely.
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
      // anything mutates. Rounding is deliberately not applied here — the
      // entry stores the verbatim amount; totalPaidOut rounds the total.
      if (
        typeof opts.payoutAmount !== "number" ||
        !Number.isFinite(opts.payoutAmount) ||
        opts.payoutAmount < 0
      ) {
        throw new Error(
          `invalid dispatch options: payoutAmount must be a non-negative finite number, got ${String(opts.payoutAmount)}`,
        );
      }
    }
    if (opts?.quotedAmount !== undefined) {
      // Same bar as payoutAmount: a quoted amount must be a real,
      // non-negative number — a bad quote in the audit trail would
      // poison payoutMismatch reconciliation — so fail fast up front,
      // before anything mutates. Stored verbatim; no rounding at write.
      if (
        typeof opts.quotedAmount !== "number" ||
        !Number.isFinite(opts.quotedAmount) ||
        opts.quotedAmount < 0
      ) {
        throw new Error(
          `invalid dispatch options: quotedAmount must be a non-negative finite number, got ${String(opts.quotedAmount)}`,
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
    if (this._rolePolicy.size > 0) {
      snapshot.rolePolicy = Object.fromEntries(this._rolePolicy);
    }
    if (this._idempotencyKeys.size > 0) {
      snapshot.idempotencyKeys = [...this._idempotencyKeys];
    }
    return snapshot;
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
      auditSecret: opts?.auditSecret,
    });
    task._state = parsed.state;
    task._idempotencyKeys = parsed.idempotencyKeys;
    // A fully hashless legacy history is chained deterministically here
    // (the audit content is unchanged — the hash is a pure function of
    // the entry fields), so the live history is always fully chained and
    // later dispatches keep linking to it.
    task._history = chainHistoryEntries(parsed.history, opts?.auditSecret);
    task._rolePolicy = parsed.rolePolicy;
    for (const [state, deadline] of Object.entries(parsed.slaDeadlines)) {
      task.setSlaDeadline(deadline, state as TaskState);
    }
    return task;
  }

  /**
   * Rebuild a TaskLifecycle from a pure audit history log, making the
   * history the only source of truth: the final state is derived by
   * replaying the entries, not read from a state field.
   *
   * The task id is not recoverable from the log (history entries carry
   * no id), so it is passed explicitly rather than invented. Advisory
   * SLA deadlines are not part of the audit log and are therefore not
   * restored — use fromJSON() when the snapshot envelope is available.
   * Throws a specific `invalid history: …` error on any malformed or
   * inconsistent input — see parseHistory for the full checklist.
   *
   * `opts.maxResubmits` re-attaches a retry budget to the rehydrated
   * task; the used count is derived from the replayed history (the same
   * rule as fromJSON()). Omit it for the unlimited default.
   * `opts.maxDisputes` re-attaches a DISPUTE appeal budget the same way;
   * omit it and the rehydrated task disputes without limit.
   * `opts.rolePolicy`
   * re-attaches an event-level RBAC policy the same way; omit it and the
   * rehydrated task is unrestricted (policy is caller configuration, not
   * audit data, so the log cannot restore it on its own).
   * `opts.requirePayoutRef` re-attaches up-front payout-reference
   * enforcement the same way; omit it and the rehydrated task falls back
   * to the advisory default (the switch is not part of the audit log, so
   * it cannot be restored on its own).
   * `opts.idempotencyKeys` re-attaches the consumed dispatch idempotency
   * keys the same way; omit it and the rehydrated task starts with an
   * empty key set, so a retried key would re-execute (the keys are not
   * part of the audit log, so they cannot be restored on their own).
   * `opts.auditSecret` re-attaches the keyed hash-chain secret the same
   * way; a keyed log restored without it (or with the wrong secret) is
   * rejected as a broken hash chain, and a legacy hashless log restored
   * with a secret is chained in keyed mode on rehydration.
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
    task._state = replay(history, { auditSecret: opts?.auditSecret });
    // See fromJSON(): a legacy hashless log is chained deterministically
    // on rehydration, so the live history is always fully chained.
    task._history = chainHistoryEntries(
      parseHistory(history, { auditSecret: opts?.auditSecret }),
      opts?.auditSecret,
    );
    return task;
  }
}
