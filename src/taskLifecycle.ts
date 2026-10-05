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

export interface TaskHistoryEntry {
  seq: number;
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
  at: string; // ISO timestamp
  actor?: string; // contributor | reviewer | moderator | system
  note?: string;
}

/**
 * Serializable snapshot of a task: live state + append-only history +
 * per-state SLA deadlines. Plain JSON (no class instances, no Maps), safe
 * to store in any document store and feed back into fromJSON().
 */
export interface TaskSnapshot {
  id: string;
  state: TaskState;
  history: TaskHistoryEntry[];
  slaDeadlines: Partial<Record<TaskState, string>>;
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
function parseHistory(history: unknown): TaskHistoryEntry[] {
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
 *
 * Anything produced by toJSON() passes; anything else must earn its way.
 */
function parseSnapshot(snapshot: unknown): {
  id: string;
  state: TaskState;
  history: TaskHistoryEntry[];
  slaDeadlines: Partial<Record<TaskState, string>>;
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

  return { id: snapshot.id, state, history, slaDeadlines };
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
    const entry: TaskHistoryEntry = {
      seq: this._history.length + 1,
      event,
      from,
      to,
      at: new Date().toISOString(),
    };
    if (opts?.actor !== undefined) entry.actor = opts.actor;
    if (opts?.note !== undefined) entry.note = opts.note;
    this._history.push(entry);
    return to;
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
   */
  toJSON(): TaskSnapshot {
    const deadlines: Partial<Record<TaskState, string>> = {};
    for (const [state, deadline] of this._slaDeadlines) {
      deadlines[state] = deadline;
    }
    return {
      id: this.id,
      state: this._state,
      history: this._history.map((e) => ({ ...e })),
      slaDeadlines: deadlines,
    };
  }

  /**
   * Rebuild a TaskLifecycle from an untrusted snapshot (e.g. one read
   * back from a store). Throws a specific error on any malformed or
   * inconsistent input — see parseSnapshot for the full checklist.
   */
  static fromJSON(snapshot: unknown): TaskLifecycle {
    const parsed = parseSnapshot(snapshot);
    const task = new TaskLifecycle(parsed.id);
    task._state = parsed.state;
    task._history = parsed.history;
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
   */
  static fromHistory(id: string, history: unknown): TaskLifecycle {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("invalid history: id must be a non-empty string");
    }
    const task = new TaskLifecycle(id);
    task._state = replay(history);
    task._history = parseHistory(history);
    return task;
  }
}
