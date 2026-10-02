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
