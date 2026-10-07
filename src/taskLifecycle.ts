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
 */
export function expiredTasks(
  tasks: readonly TaskLifecycle[],
  now: Date = new Date(),
): TaskLifecycle[] {
  return tasks.filter((task) => isOverdue(task, now));
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
 */
export interface TaskLifecycleOptions {
  maxResubmits?: number;
  maxDisputes?: number;
  rolePolicy?: RolePolicy;
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
 */
export interface TaskSnapshot {
  id: string;
  state: TaskState;
  history: TaskHistoryEntry[];
  slaDeadlines: Partial<Record<TaskState, string>>;
  maxResubmits?: number;
  maxDisputes?: number;
  rolePolicy?: RolePolicy;
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
 * Parse and strictly validate an untrusted value into a sanitized audit
 * history — the append-only event log every TaskLifecycle carries.
 *
 * Throws `invalid history: …` on the first problem found:
 *  - history is not an array, or an entry is not an object
 *  - entry shape violations (seq, event, from, to, at, actor, note)
 *  - seq must restart at 1 and increment by 1 with no gaps
 *  - the from/to chain must be continuous and start at DRAFT
 *  - every (from, event) -> to edge must be a legal transition edge
 *  - timestamps must be canonical ISO-8601 and non-decreasing
 *
 * The returned entries are fresh, sanitized copies: mutating the input
 * afterwards never affects them.
 */
export function parseHistory(history: unknown): TaskHistoryEntry[] {
  if (!Array.isArray(history)) {
    throw new Error("invalid history: history must be an array");
  }
  const entries: TaskHistoryEntry[] = [];
  for (let i = 0; i < history.length; i++) {
    const raw = history[i];
    const tag = `invalid history: entry[${i}]`;
    if (!isRecord(raw)) throw new Error(`${tag}: entry must be an object`);
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
      if (typeof raw.actor !== "string") {
        throw new Error(`${tag}: actor must be a string`);
      }
      entry.actor = raw.actor;
    }
    if (raw.note !== undefined) {
      if (typeof raw.note !== "string") {
        throw new Error(`${tag}: note must be a string`);
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
    entries.push(entry);
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
export function replay(history: unknown): TaskState {
  const entries = parseHistory(history);
  return entries.length === 0 ? "DRAFT" : entries[entries.length - 1].to;
}

/**
 * Parse and strictly validate an untrusted value into a TaskSnapshot.
 *
 * Throws with a specific message on the first problem found:
 *  - not an object / missing id / unknown state
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
 *
 * Anything produced by toJSON() passes; anything else must earn its way.
 */
function parseSnapshot(snapshot: unknown): {
  id: string;
  state: TaskState;
  history: TaskHistoryEntry[];
  slaDeadlines: Partial<Record<TaskState, string>>;
  maxResubmits: number;
  maxDisputes: number;
  rolePolicy: Map<TaskEvent, string[]>;
} {
  if (!isRecord(snapshot)) {
    throw new Error("invalid snapshot: expected a JSON object");
  }
  if (typeof snapshot.id !== "string" || snapshot.id.length === 0) {
    throw new Error("invalid snapshot: id must be a non-empty string");
  }
  if (!STATES.has(snapshot.state as TaskState)) {
    throw new Error(`invalid snapshot: unknown state ${String(snapshot.state)}`);
  }
  const state = snapshot.state as TaskState;

  const history = parseHistory(snapshot.history);

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

  return { id: snapshot.id, state, history, slaDeadlines, maxResubmits, maxDisputes, rolePolicy };
}

/** Stateful task with an append-only audit history. */
export class TaskLifecycle {
  readonly id: string;
  private _state: TaskState = "DRAFT";
  private _history: TaskHistoryEntry[] = [];
  private _maxResubmits: number;
  private _maxDisputes: number;
  private _rolePolicy: Map<TaskEvent, string[]>;

  constructor(id: string, opts?: TaskLifecycleOptions) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("invalid task: id must be a non-empty string");
    }
    this.id = id;
    this._maxResubmits = assertMaxResubmits(opts?.maxResubmits, "invalid option");
    this._maxDisputes = assertMaxDisputes(opts?.maxDisputes, "invalid option");
    this._rolePolicy = assertRolePolicy(opts?.rolePolicy, "invalid option");
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
   * are validated up front: any non-string value throws
   * `invalid dispatch options: …` before anything mutates. This mirrors the
   * strict actor/note checks `fromJSON()` / `fromHistory()` apply to
   * untrusted snapshots — the audit trail must stay string-typed on both
   * the live and the rehydrated path. Invalid events still throw
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
   * Advisory (deliberately not enforced): a `PAYOUT_COMPLETE` dispatch
   * with no `payoutRef` is legal. The library cannot verify whether an
   * external payment actually happened — requiring the field would be a
   * guess, not a guarantee. If your payout flow always produces a
   * reference, pass it; the `unreconciledPayouts()` reconciliation helper
   * flags `PAID` tasks whose `PAYOUT_COMPLETE` entry lacks one.
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
  dispatch(
    event: TaskEvent,
    opts?: { actor?: string; note?: string; at?: string; payoutRef?: string },
  ): TaskState {
    if (opts?.actor !== undefined && typeof opts.actor !== "string") {
      throw new Error(
        `invalid dispatch options: actor must be a string, got ${typeof opts.actor}`,
      );
    }
    if (opts?.note !== undefined && typeof opts.note !== "string") {
      throw new Error(
        `invalid dispatch options: note must be a string, got ${typeof opts.note}`,
      );
    }
    if (opts?.payoutRef !== undefined) {
      if (typeof opts.payoutRef !== "string" || opts.payoutRef.length === 0) {
        throw new Error(
          `invalid dispatch options: payoutRef must be a non-empty string, got ${JSON.stringify(opts.payoutRef)}`,
        );
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
    this._state = to;
    const entry: TaskHistoryEntry = {
      seq: this._history.length + 1,
      event,
      from,
      to,
      at: opts?.at ?? new Date().toISOString(),
    };
    if (opts?.actor !== undefined) entry.actor = opts.actor;
    if (opts?.note !== undefined) entry.note = opts.note;
    if (opts?.payoutRef !== undefined) entry.payoutRef = opts.payoutRef;
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
   */
  toJSON(): TaskSnapshot {
    const deadlines: Partial<Record<TaskState, string>> = {};
    for (const [state, deadline] of this._slaDeadlines) {
      deadlines[state] = deadline;
    }
    const snapshot: TaskSnapshot = {
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
    return snapshot;
  }

  /**
   * Rebuild a TaskLifecycle from an untrusted snapshot (e.g. one read
   * back from a store). Throws a specific error on any malformed or
   * inconsistent input — see parseSnapshot for the full checklist.
   */
  static fromJSON(snapshot: unknown): TaskLifecycle {
    const parsed = parseSnapshot(snapshot);
    const task = new TaskLifecycle(parsed.id, {
      maxResubmits: parsed.maxResubmits,
      maxDisputes: parsed.maxDisputes,
    });
    task._state = parsed.state;
    task._history = parsed.history;
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
    task._state = replay(history);
    task._history = parseHistory(history);
    return task;
  }
}
