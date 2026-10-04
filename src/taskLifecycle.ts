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

export interface TaskHistoryEntry {
  seq: number;
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
  at: string; // ISO timestamp
  actor?: string; // contributor | reviewer | moderator | system
  note?: string;
}

/** Stateful task with an append-only audit history. */
export class TaskLifecycle {
  readonly id: string;
  private _state: TaskState = "DRAFT";
  private _history: TaskHistoryEntry[] = [];

  constructor(id: string) {
    this.id = id;
  }

  get state(): TaskState {
    return this._state;
  }

  get history(): readonly TaskHistoryEntry[] {
    return this._history;
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

  dispatch(event: TaskEvent, opts?: { actor?: string; note?: string }): TaskState {
    const from = this._state;
    const to = transition(from, event); // throws on invalid transition
    this._state = to;
    this._history.push({
      seq: this._history.length + 1,
      event,
      from,
      to,
      at: new Date().toISOString(),
      actor: opts?.actor,
      note: opts?.note,
    });
    return to;
  }
}
