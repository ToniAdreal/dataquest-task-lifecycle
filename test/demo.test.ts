import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runDemo,
  DEMO_AUDIT_SECRET,
  DEMO_AUDIT_WRONG_SECRET,
  DEMO_CONSTRUCTOR_ID_ERROR,
  DEMO_GUARD_TASK_ID,
  DEMO_HISTORY_BASE_AT,
  DEMO_HISTORY_TASK_ID,
  DEMO_ROLE_POLICY,
  DEMO_ROTATION_NEW_SECRET,
  DEMO_ROTATION_OLD_SECRET,
  DEMO_PATROL_EXACT_PUBLISH_AT,
  DEMO_PATROL_EXACT_TASK_ID,
  DEMO_PATROL_MAX_AGE_MS,
  DEMO_PATROL_NOW,
  DEMO_PATROL_NO_HISTORY_TASK_ID,
  DEMO_PATROL_STALE_CONFIG_ERROR,
  DEMO_PATROL_STALE_PUBLISH_AT,
  DEMO_PATROL_STALE_TASK_ID,
  DEMO_PATROL_TERMINAL_COMPLETE_AT,
  DEMO_PATROL_TERMINAL_TASK_ID,
  DEMO_PATROL_UNMAPPED_REVIEW_AT,
  DEMO_PATROL_UNMAPPED_TASK_ID,
  DEMO_SEEDED_IDEMPOTENCY_KEYS,
  DEMO_WEBHOOK_SECRET,
} from "../src/demo.js";
import { readmeDiagramInSync } from "../src/diagram.js";
import {
  MAX_NOTE_LENGTH,
  PayoutEventDedupe,
  SNAPSHOT_VERSION,
  TaskLifecycle,
  actOnStaleTasks,
  allowedEvents,
  expireOverdueTasks,
  expiredTasks,
  historyFromNdjson,
  historyToNdjson,
  isOverdue,
  isTerminal,
  parseHistory,
  parsePayoutRetryAfter,
  payoutMismatch,
  staleTasks,
  stateDiagram,
  tasksApproachingDeadline,
  transitionTable,
  transitionTableJson,
  verifyHistoryChain,
  buildPayoutWebhook,
  deliverPayoutWebhook,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
  type TaskHistoryEntry,
  type TaskState,
} from "../src/index.js";

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

/**
 * Golden output of the pre-refactor top-level demo script, captured
 * from a real `npm run demo` run before the runDemo() refactor. The
 * only normalized values are the ones that already varied between
 * any two runs of the old script: ISO timestamps (the main task's
 * wall-clock history timestamps, from which the webhook `at` also
 * derives), the webhook eventId (a random UUID), and the HMAC
 * signature (a function of those), and the audit hash-chain links
 * (`prevHash` / `hash`) carried by the NDJSON export lines, which
 * are hashes of entries containing those timestamps. Every other
 * byte — wording, spacing, ordering, blank lines — must match
 * exactly.
 */
function normalize(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g,
      "<uuid>",
    )
    .replace(/sha256=[0-9a-f]{64}/g, "sha256=<signature>")
    .replace(/"(prevHash|hash)":"[0-9a-f]{64}"/g, '"$1":"<hash>"');
}

const GOLDEN_DEMO_OUTPUT = `Task DEMO-001: DRAFT
  PUBLISH         DRAFT        -> OPEN  (system)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  START_CAPTURE   ACCEPTED     -> CAPTURING  (contributor)
  SUBMIT          CAPTURING    -> SUBMITTED  (contributor)
  BEGIN_REVIEW    SUBMITTED    -> IN_REVIEW  (reviewer)
  REJECT          IN_REVIEW    -> REJECTED  (reviewer)
  RESUBMIT        REJECTED     -> CAPTURING  (contributor)
  SUBMIT          CAPTURING    -> SUBMITTED  (contributor)
  BEGIN_REVIEW    SUBMITTED    -> IN_REVIEW  (reviewer)
  APPROVE         IN_REVIEW    -> APPROVED  (reviewer)
  REQUEST_PAYOUT  APPROVED     -> PAYOUT_PENDING  (contributor)
  PAYOUT_COMPLETE PAYOUT_PENDING -> PAID  (system)

Final state: PAID (terminal: true)
History (append-only audit trail):
  seq  event            from          -> to             actor        at
    1  PUBLISH          DRAFT         -> OPEN          system       <timestamp>
    2  ACCEPT           OPEN          -> ACCEPTED      contributor  <timestamp>
    3  START_CAPTURE    ACCEPTED      -> CAPTURING     contributor  <timestamp>
    4  SUBMIT           CAPTURING     -> SUBMITTED     contributor  <timestamp>
    5  BEGIN_REVIEW     SUBMITTED     -> IN_REVIEW     reviewer     <timestamp>
    6  REJECT           IN_REVIEW     -> REJECTED      reviewer     <timestamp>
    7  RESUBMIT         REJECTED      -> CAPTURING     contributor  <timestamp>
    8  SUBMIT           CAPTURING     -> SUBMITTED     contributor  <timestamp>
    9  BEGIN_REVIEW     SUBMITTED     -> IN_REVIEW     reviewer     <timestamp>
   10  APPROVE          IN_REVIEW     -> APPROVED      reviewer     <timestamp>
   11  REQUEST_PAYOUT   APPROVED      -> PAYOUT_PENDING contributor  <timestamp>
   12  PAYOUT_COMPLETE  PAYOUT_PENDING -> PAID          system       <timestamp>

Audit hash chain (verifyHistoryChain on the main task history):
  intact history: verifyHistoryChain: true (12 entries, genesis-linked, every hash recomputes)
  tampered copy: PAYOUT_COMPLETE payoutAmount 10098.5 -> 10099.5 — verifyHistoryChain: false (tamper detected: the stored hash no longer recomputes)
  original history after the tamper check: verifyHistoryChain: true (detached copy — the task's own history is untouched)

SLA watchdog branch (second task, advisory deadline):
Task DEMO-002: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  SLA deadline (ACCEPTED): <timestamp>
  expiredTasks([DEMO-001, DEMO-002], <timestamp>): DEMO-002 (1 overdue)
  DEMO-002 still ACCEPTED: the deadline alone never expires a task
  EXPIRE          ACCEPTED     -> EXPIRED  (watchdog)

Final state (SLA branch): EXPIRED (terminal: true)
History (SLA branch, append-only audit trail):
  seq  event            from          -> to             actor        at
    1  PUBLISH          DRAFT         -> OPEN          researcher   <timestamp>
    2  ACCEPT           OPEN          -> ACCEPTED      contributor  <timestamp>
    3  EXPIRE           ACCEPTED      -> EXPIRED       watchdog     <timestamp>

DISPUTE appeal branch (third task, dispute budget):
Task DEMO-003: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  START_CAPTURE   ACCEPTED     -> CAPTURING  (contributor)
  SUBMIT          CAPTURING    -> SUBMITTED  (contributor)
  BEGIN_REVIEW    SUBMITTED    -> IN_REVIEW  (reviewer)
  REJECT          IN_REVIEW    -> REJECTED  (reviewer)
  DISPUTE         REJECTED     -> DISPUTED  (contributor)
  ARBITRATE_REJECT DISPUTED     -> REJECTED  (moderator)
  dispute budget: 1 of 1 DISPUTEs used (demo sets maxDisputes: 1; the library default is unlimited)

Final state (DISPUTE branch): REJECTED (terminal: false)
History (DISPUTE branch, append-only audit trail):
  seq  event            from          -> to             actor        at
    1  PUBLISH          DRAFT         -> OPEN          researcher   <timestamp>
    2  ACCEPT           OPEN          -> ACCEPTED      contributor  <timestamp>
    3  START_CAPTURE    ACCEPTED      -> CAPTURING     contributor  <timestamp>
    4  SUBMIT           CAPTURING     -> SUBMITTED     contributor  <timestamp>
    5  BEGIN_REVIEW     SUBMITTED     -> IN_REVIEW     reviewer     <timestamp>
    6  REJECT           IN_REVIEW     -> REJECTED      reviewer     <timestamp>
    7  DISPUTE          REJECTED      -> DISPUTED      contributor  <timestamp>
    8  ARBITRATE_REJECT DISPUTED      -> REJECTED      moderator    <timestamp>

Payout webhook (signed PAYOUT_COMPLETE notification):
  event:        PAYOUT_COMPLETE
  taskId:       DEMO-001
  payoutRef:    xfer-88f2
  payoutAmount: 10098.5
  at:           <timestamp>
  eventId:      <uuid>
  signature:    sha256=<signature>
  verifyPayoutWebhook: ok

Receiver-side dedupe (PayoutEventDedupe on the webhook's eventId):
  dedupe ttl: 60000 ms (demo policy; the library default is 3600000 ms) — clock injected and fixed at <timestamp>
  delivery 1: eventId <uuid> -> checkAndRecord false (new event, payout booked)
  delivery 2: same eventId redelivered -> checkAndRecord true (duplicate, skipped — no second booking)
  delivery 3: clock advanced by exactly the ttl to <timestamp> -> checkAndRecord false (record expired at the ttl boundary, accepted again)

Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):
  shared now: <timestamp> (eventIds from a deterministic factory)
  DEMO-001: webhook eventId=evt_demo_batch_001 payoutRef=xfer-88f2 payoutAmount=10098.5 verifyPayoutWebhook: ok
  DEMO-002: error: cannot build payout webhook: task DEMO-002 is in state EXPIRED, only PAID tasks have a completed settlement to announce
  DEMO-003: error: cannot build payout webhook: task DEMO-003 is in state REJECTED, only PAID tasks have a completed settlement to announce
  batch: 1 webhook(s) built, 2 error(s) — a non-PAID task fails only itself and never blocks later tasks

Payout webhook fan-out delivery (deliverPayoutWebhookToMany to 3 endpoints, fake fetch — no real network):
  shared eventId: evt_demo_fanout_001, shared at: <timestamp> (one logical event for all endpoints)
  billing (https://billing.example.com/hooks/payout): ok attempts=1 status=200
  risk (https://risk.example.com/hooks/payout): FAILED attempts=3 status=500 error=server responded with status 500
  notifications (https://notifications.example.com/hooks/payout): ok attempts=1 status=200
  fan-out: 2 delivered, 1 failed — the failing endpoint did not block the others
  shared event check: all endpoints received the same eventId evt_demo_fanout_001: true (identical payload bytes, signed per endpoint with its own secret)

Payout Retry-After parsing (parsePayoutRetryAfter under a fixed now):
  fixed now: <timestamp> (the fan-out segment's shared instant, reused as nowMs; no wall clock)
  parsePayoutRetryAfter("2") -> 2000 ms
  parsePayoutRetryAfter("  30 ") -> 30000 ms
  parsePayoutRetryAfter("Fri, 20 Mar 2026 09:00:05 GMT") -> 5000 ms
  parsePayoutRetryAfter("Fri, 20 Mar 2026 08:59:59 GMT") -> 0 ms
  parsePayoutRetryAfter("banana") -> undefined
  parsePayoutRetryAfter(null) -> undefined
  retry context: the fan-out risk endpoint answered 500, so its retries used exponential backoff; had it answered 429 with a Retry-After header, the parsed wait above (clamped to maxRetryDelayMs) would have set the next attempt's delay — an absent or unparsable header (undefined) falls back to that backoff

Reconciliation screening branch (two more PAID tasks, then the finance pass):
Task DEMO-004: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  START_CAPTURE   ACCEPTED     -> CAPTURING  (contributor)
  SUBMIT          CAPTURING    -> SUBMITTED  (contributor)
  BEGIN_REVIEW    SUBMITTED    -> IN_REVIEW  (reviewer)
  APPROVE         IN_REVIEW    -> APPROVED  (reviewer)
  REQUEST_PAYOUT  APPROVED     -> PAYOUT_PENDING  (contributor)
  PAYOUT_COMPLETE PAYOUT_PENDING -> PAID  (system)
  note: PAYOUT_COMPLETE records payoutAmount=2500 and no payoutRef (the ACCEPT quote was also 2500, so the amount itself agrees)
Task DEMO-005: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  START_CAPTURE   ACCEPTED     -> CAPTURING  (contributor)
  SUBMIT          CAPTURING    -> SUBMITTED  (contributor)
  BEGIN_REVIEW    SUBMITTED    -> IN_REVIEW  (reviewer)
  APPROVE         IN_REVIEW    -> APPROVED  (reviewer)
  REQUEST_PAYOUT  APPROVED     -> PAYOUT_PENDING  (contributor)
  PAYOUT_COMPLETE PAYOUT_PENDING -> PAID  (system)
  note: ACCEPT quoted 4000 but PAYOUT_COMPLETE settled 3750.5 under payoutRef xfer-91c7 (the amount, not the evidence, is the problem)
  screened: DEMO-001, DEMO-002, DEMO-003, DEMO-004, DEMO-005 (all five demo tasks)
  unreconciledPayouts: DEMO-004 (1 hit: PAID but no payoutRef on the PAYOUT_COMPLETE entry)
  mismatchedPayouts: DEMO-005 (quoted 4000, paid 3750.5, delta -249.5) (1 hit: settled amount differs from the ACCEPT quote)
  totalPaidOut: 16349 (10098.5 + 2500 + 3750.5 across the 3 PAID tasks; the EXPIRED and REJECTED tasks contribute nothing)

Dispatch subscription branch (sixth task, in-process fan-out):
Task DEMO-006: DRAFT
  subscribed: 1 collecting listener (notified after each audit append, in subscription order)
  listener received 3 notification(s), in dispatch order:
    notification 1: PUBLISH DRAFT -> OPEN (entry seq 1)
    notification 2: ACCEPT OPEN -> ACCEPTED (entry seq 2)
    notification 3: START_CAPTURE ACCEPTED -> CAPTURING (entry seq 3)
  notifications match the task history: true (each (event, from, to) equals the history entry with the same seq)
  unsubscribed: listenerCount 0
  SUBMIT          CAPTURING    -> SUBMITTED  (contributor)
  listener received after unsubscribe: 3 notification(s) (unchanged — SUBMIT produced no new notification)

Final state (subscription branch): SUBMITTED (terminal: false)

listenerCount lifecycle (subscription registry observability):
Task DEMO-043: DRAFT
  listenerCount with no subscriptions: 0
  subscribed: 2 collecting listeners (listenerCount 2)
  unsubscribed one listener (listenerCount 1)
  PUBLISH         DRAFT        -> OPEN  (researcher)
  surviving listener heard 1 notification(s): PUBLISH DRAFT -> OPEN (entry seq 1); departed listener heard 0
  unsubscribed the survivor (listenerCount 0)
  second call of the same unsubscribe is idempotent (listenerCount 0)

Final state (listenerCount branch): OPEN (listenerCount 0)

Stale-task dwell screening branch (three more tasks, dwell vs deadline):
  screened at: <timestamp> (fixed now; no wall clock)
  budgets: OPEN 604800000 ms (7 days), IN_REVIEW 432000000 ms (5 days) — dwell is now minus the last history entry's at
Task DEMO-007: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  SLA deadline (OPEN): <timestamp>
Task DEMO-008: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  START_CAPTURE   ACCEPTED     -> CAPTURING  (contributor)
  SUBMIT          CAPTURING    -> SUBMITTED  (contributor)
  BEGIN_REVIEW    SUBMITTED    -> IN_REVIEW  (reviewer)
  SLA deadline (IN_REVIEW): <timestamp>
Task DEMO-009: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  SLA deadline (OPEN): none
  DEMO-007: state OPEN, entered at <timestamp>, dwell 1814400000 ms (21 days) vs OPEN budget 604800000 ms -> stale: true, overdue: false
  DEMO-008: state IN_REVIEW, entered at <timestamp>, dwell 86400000 ms (1 day) vs IN_REVIEW budget 432000000 ms -> stale: false, overdue: true
  DEMO-009: state OPEN, entered at <timestamp>, dwell 86400000 ms (1 day) vs OPEN budget 604800000 ms -> stale: false, overdue: false
  staleTasks([DEMO-007, DEMO-008, DEMO-009], budgets, <timestamp>): DEMO-007 (1 stale)
  expiredTasks([DEMO-007, DEMO-008, DEMO-009], <timestamp>): DEMO-008 (1 overdue)
  contrast: the two screens disagree on the same batch — DEMO-007 is stale but not overdue (dwell past budget, deadline still ahead), DEMO-008 is overdue but not stale (deadline passed, dwell within budget), DEMO-009 is neither
  screening is pure: no task was dispatched or mutated by either screen

Approaching-deadline screening branch (four more tasks, warning window vs deadline):
  screened at: <timestamp> (fixed now; no wall clock)
  window: (now, now + 86400000 ms] (24 hours) — lower bound exclusive, upper bound inclusive
Task DEMO-046: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  SLA deadline (OPEN): <timestamp>
Task DEMO-047: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  SLA deadline (OPEN): <timestamp>
Task DEMO-048: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  SLA deadline (OPEN): <timestamp>
Task DEMO-049: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  SLA deadline (OPEN): <timestamp>
  DEMO-046: state OPEN, deadline <timestamp> -> approaching: true, overdue: false
  DEMO-047: state OPEN, deadline <timestamp> -> approaching: true, overdue: false
  DEMO-048: state OPEN, deadline <timestamp> -> approaching: false, overdue: true
  DEMO-049: state OPEN, deadline <timestamp> -> approaching: false, overdue: true
  tasksApproachingDeadline([DEMO-046, DEMO-047, DEMO-048, DEMO-049], 86400000, <timestamp>): DEMO-046, DEMO-047 (2 approaching)
  expiredTasks([DEMO-046, DEMO-047, DEMO-048, DEMO-049], <timestamp>): DEMO-048, DEMO-049 (2 overdue)
  contrast: the window's bounds decide membership — DEMO-047 lands exactly on now + 24 hours and is approaching (upper bound inclusive), DEMO-048 lands exactly on now and is overdue instead (lower bound exclusive), DEMO-049 is overdue, DEMO-046 is approaching from inside the window
  screening is pure: no task was dispatched or mutated by either screen

Stale-task batch execution branch (actOnStaleTasks over four more tasks):
  executed at: <timestamp> (fixed now; no wall clock)
  budgets: ACCEPTED 604800000 ms (7 days), CAPTURING 604800000 ms (7 days), SUBMITTED 604800000 ms (7 days) — action dispatches ABANDON with the fixed execution instant as its audit timestamp
Task DEMO-010: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  START_CAPTURE   ACCEPTED     -> CAPTURING  (contributor)
  SUBMIT          CAPTURING    -> SUBMITTED  (contributor)
Task DEMO-011: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
Task DEMO-012: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  START_CAPTURE   ACCEPTED     -> CAPTURING  (contributor)
Task DEMO-013: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  DEMO-010: acted=false error="invalid transition: ABANDON from SUBMITTED" -> state SUBMITTED (left untouched — the failure is isolated)
  DEMO-011: acted=true -> state ABANDONED (ABANDON dispatched; the batch kept going)
  DEMO-012: acted=true -> state ABANDONED (ABANDON dispatched; the batch kept going)
  DEMO-013: not stale at the fixed now (dwell 86400000 ms (1 day) within the ACCEPTED budget) -> no result entry, untouched in ACCEPTED
  execution: 3 attempted, 2 acted, 1 failed — one unactionable stale task never blocks the rest of the batch

SLA watchdog batch execution branch (expireOverdueTasks over a rebuilt SLA batch):
  executed at: <timestamp> (the SLA branch's fixed screening now, reused; no new screening instant)
  rebuilt batch: the executor mutates its inputs and the original SLA tasks are already settled, so the batch is rebuilt fresh from the same fixed literals (DEMO-014 mirrors DEMO-002's setup exactly)
Task DEMO-014: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  SLA deadline (ACCEPTED): <timestamp>
Task DEMO-015: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  SLA deadline (OPEN): <timestamp>
Task DEMO-016: DRAFT
  PUBLISH         DRAFT        -> OPEN  (researcher)
  ACCEPT          OPEN         -> ACCEPTED  (contributor)
  SLA deadline (ACCEPTED): <timestamp>
  expiredTasks([DEMO-014, DEMO-015, DEMO-016], <timestamp>): DEMO-014, DEMO-015 (2 overdue)
  DEMO-014: expired=true -> state EXPIRED (EXPIRE dispatched by the executor)
  DEMO-015: expired=true -> state EXPIRED (EXPIRE dispatched by the executor)
  DEMO-016: not overdue at the fixed now (deadline <timestamp> still ahead) -> no result entry, untouched in ACCEPTED
  screening vs execution: expiredTasks subset [DEMO-014, DEMO-015] == expireOverdueTasks acted set [DEMO-014, DEMO-015]: true (same tasks, same batch order)
  execution: 2 attempted, 2 expired, 0 failed — the not-yet-overdue task was never attempted

Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):
  historyToNdjson(DEMO-001): 12 lines (one JSON entry per line, trailing newline)
  {"seq":1,"event":"PUBLISH","from":"DRAFT","to":"OPEN","at":"<timestamp>","actor":"system","note":"Researcher publishes the data-collection task","prevHash":"GENESIS","hash":"<hash>"}
  {"seq":2,"event":"ACCEPT","from":"OPEN","to":"ACCEPTED","at":"<timestamp>","actor":"contributor","note":"Contributor picks up the task","prevHash":"<hash>","hash":"<hash>"}
  {"seq":3,"event":"START_CAPTURE","from":"ACCEPTED","to":"CAPTURING","at":"<timestamp>","actor":"contributor","note":"Data capture begins","prevHash":"<hash>","hash":"<hash>"}
  {"seq":4,"event":"SUBMIT","from":"CAPTURING","to":"SUBMITTED","at":"<timestamp>","actor":"contributor","note":"Batch uploaded for QA","prevHash":"<hash>","hash":"<hash>"}
  {"seq":5,"event":"BEGIN_REVIEW","from":"SUBMITTED","to":"IN_REVIEW","at":"<timestamp>","actor":"reviewer","note":"QA specialist starts review","prevHash":"<hash>","hash":"<hash>"}
  {"seq":6,"event":"REJECT","from":"IN_REVIEW","to":"REJECTED","at":"<timestamp>","actor":"reviewer","note":"Sample fails QA: gaps in the capture","prevHash":"<hash>","hash":"<hash>"}
  {"seq":7,"event":"RESUBMIT","from":"REJECTED","to":"CAPTURING","at":"<timestamp>","actor":"contributor","note":"Contributor fixes the batch and resubmits (uses 1 of the demo's 2 allowed RESUBMITs)","prevHash":"<hash>","hash":"<hash>"}
  {"seq":8,"event":"SUBMIT","from":"CAPTURING","to":"SUBMITTED","at":"<timestamp>","actor":"contributor","note":"Revised batch uploaded for QA","prevHash":"<hash>","hash":"<hash>"}
  {"seq":9,"event":"BEGIN_REVIEW","from":"SUBMITTED","to":"IN_REVIEW","at":"<timestamp>","actor":"reviewer","note":"QA specialist re-reviews the revised batch","prevHash":"<hash>","hash":"<hash>"}
  {"seq":10,"event":"APPROVE","from":"IN_REVIEW","to":"APPROVED","at":"<timestamp>","actor":"reviewer","note":"Revised sample passes QA","prevHash":"<hash>","hash":"<hash>"}
  {"seq":11,"event":"REQUEST_PAYOUT","from":"APPROVED","to":"PAYOUT_PENDING","at":"<timestamp>","actor":"contributor","note":"Contributor requests payout","prevHash":"<hash>","hash":"<hash>"}
  {"seq":12,"event":"PAYOUT_COMPLETE","from":"PAYOUT_PENDING","to":"PAID","at":"<timestamp>","actor":"system","note":"Finance settles the payout","payoutRef":"xfer-88f2","payoutAmount":10098.5,"prevHash":"<hash>","hash":"<hash>"}
  historyFromNdjson: 12 entries parsed back
  TaskLifecycle.fromHistory(DEMO-001, entries): state PAID, 12 history entries
  replay matches the original (state + full history): true — last entry seq 12 PAYOUT_COMPLETE PAYOUT_PENDING -> PAID
  replay(parsedEntries): pure function derives final state PAID — matches task.state (PAID) and fromHistory state (PAID): true
  replay([]): empty history replays to the DRAFT sentinel (no events yet)

Allowed events by state (allowedEvents over all 13 states):
  DRAFT           -> PUBLISH
  OPEN            -> ACCEPT, EXPIRE
  ACCEPTED        -> START_CAPTURE, ABANDON, EXPIRE
  CAPTURING       -> SUBMIT, ABANDON, EXPIRE
  SUBMITTED       -> BEGIN_REVIEW, EXPIRE
  IN_REVIEW       -> APPROVE, REJECT
  APPROVED        -> REQUEST_PAYOUT
  PAYOUT_PENDING  -> PAYOUT_COMPLETE
  PAID            -> (none — terminal)
  REJECTED        -> DISPUTE, RESUBMIT
  DISPUTED        -> ARBITRATE_APPROVE, ARBITRATE_REJECT
  ABANDONED       -> (none — terminal)
  EXPIRED         -> (none — terminal)
  main task DEMO-001 (PAID): allowedEvents -> (none) — a terminal task offers no further events, so a task-list UI renders no actions for it

Standalone history parsing (parseHistory on a fixed external history):
  source: fixed JSON text with 5 hashless entries (the PUBLISH..BEGIN_REVIEW chain that opens DEMO-001, fixed timestamps; no TaskLifecycle instance involved)
  entry seq 1: PUBLISH DRAFT -> OPEN (actor system, at <timestamp>)
  entry seq 2: ACCEPT OPEN -> ACCEPTED (actor contributor, at <timestamp>)
  entry seq 3: START_CAPTURE ACCEPTED -> CAPTURING (actor contributor, at <timestamp>)
  entry seq 4: SUBMIT CAPTURING -> SUBMITTED (actor contributor, at <timestamp>)
  entry seq 5: BEGIN_REVIEW SUBMITTED -> IN_REVIEW (actor reviewer, at <timestamp>)
  parsed: 5 entries, final state IN_REVIEW (last entry seq 5 BEGIN_REVIEW SUBMITTED -> IN_REVIEW)
  matches DEMO-001 prefix: true (the parsed seq/event/from/to chain equals the main task history's first 5 entries)
  invalid copy: parseHistory FAILED — invalid history: entry[2]: from OPEN does not continue previous to ACCEPTED (a broken chain is rejected and the original parse is untouched)

Transition table JSON export (transitionTableJson for front-end / docs tooling):
  transitionTableJson(): 19 edges as canonical JSON (2-space indent, trailing newline; parsed back: 19 edges)
  first edge (index 0): DRAFT --PUBLISH--> OPEN
  payout edge (index 14): PAYOUT_PENDING --PAYOUT_COMPLETE--> PAID
  last edge (index 18): DISPUTED --ARBITRATE_REJECT--> REJECTED
  key order per edge: from, event, to on every edge: true (the canonical field order a consumer can rely on)

State diagram generation (stateDiagram from the transition table):
  stateDiagram(): 24 lines, 19 edges (generated from transitionTable() — the Mermaid block the README embeds verbatim)
  first line: \`\`\`mermaid
  second line: stateDiagram-v2
  initial transition (line 4): [*] --> DRAFT
  first edge (line 5): DRAFT --> OPEN : PUBLISH
  last edge (line 23): DISPUTED --> REJECTED : ARBITRATE_REJECT
  last line: \`\`\`

README diagram sync check (readmeDiagramInSync on this repo's README):
  readmeDiagramInSync(): true (README.md embeds the exact stateDiagram() block generated above — no diagram drift)
  checked file: README.md (this repo only — the sole file read by the check; no network, no wall clock)
  CLI equivalent: node dist/src/diagram.js --check (exit 0 in sync, exit 1 on drift — the same check test/diagram.test.ts runs)

JSON snapshot round-trip (toJSON/fromJSON on the main task):
  toJSON(): snapshot v1 for DEMO-001 — state PAID, 12 history entries, maxResubmits 2 stored (the finite budget travels in the envelope; the used count is derived from the history, never stored)
  serialized: 3838 bytes (JSON.stringify of the snapshot — the detached plain-JSON form a document store persists)
  TaskLifecycle.fromJSON(parsed snapshot): state PAID, 12 history entries — state and full history match the original: true (entry for entry, hashes included)
  RESUBMIT budget: 1 of 2 used before and after the round-trip (derived from the history on both sides)
  fixed point: re-exporting the restored task yields the identical snapshot content (3838 bytes; fromJSON normalizes history-entry key order — values and hashes unchanged) — a second round-trip changes nothing

Single-task payout reconciliation detail (payoutMismatch on the screened tasks):
  DEMO-005: payoutMismatch -> quoted 4000, paid 3750.5, delta -249.5 (underpaid by 249.5 — the batch screen's one mismatched hit, opened up per task)
  DEMO-004: payoutMismatch -> undefined (quoted 2500, paid 2500 — settled exactly as quoted, so there is no mismatch to report)
  reading the detail: delta = paid - quoted, rounded to cents — negative is an underpayment, positive an overpayment (the per-task follow-up finance runs after mismatchedPayouts flags a task)

Snapshot version envelope (SNAPSHOT_VERSION on the main task snapshot):
  toJSON(): snapshot v is 1 — equals SNAPSHOT_VERSION 1 (the current snapshot schema version written on every export)
  future version: TaskLifecycle.fromJSON(snapshot with v: 2) rejected — invalid snapshot: unsupported snapshot version 2 (a future format is refused, not silently misread)
  original snapshot: TaskLifecycle.fromJSON(snapshot with v: 1) still restores DEMO-001 in state PAID (the rejection touched only the detached copy)

Note length limit (MAX_NOTE_LENGTH on dispatch notes):
  limit: MAX_NOTE_LENGTH is 32768 characters (a note is written verbatim into the append-only audit history, so an oversized note would permanently inflate every export)
  at the limit: dispatch PUBLISH with a 32768-character note succeeded — DEMO-017 in state OPEN, history 1 entry, stored note length 32768 (the note itself is not printed, only its length)
  over the limit: dispatch ACCEPT with a 32769-character note rejected — invalid dispatch options: note must be at most 32768 characters, got 32769 (rejected before anything mutates)
  after the rejection: DEMO-017 still in state OPEN with 1 history entry (the oversized dispatch left no trace — no state change, no history entry, no seq gap)

Standalone overdue judgement (isOverdue on fixed tasks):
  before the deadline: DEMO-018 (ACCEPTED, deadline <timestamp>) at <timestamp> -> isOverdue: false (the deadline has not yet been reached)
  exactly at the deadline: DEMO-018 at <timestamp> -> isOverdue: true (the boundary is inclusive — now >= deadline)
  after the deadline: DEMO-018 at <timestamp> -> isOverdue: true (past the deadline and still non-terminal)
  no deadline set: DEMO-019 (ACCEPTED, no SLA deadline) at <timestamp> -> isOverdue: false (a task with no deadline is never overdue)
  terminal state: DEMO-020 (ABANDONED, deadline <timestamp>) at <timestamp> -> isOverdue: false (a finished task is no longer overdue, even past its deadline)

Terminal-state judgement (isTerminal over all 13 states):
  DRAFT           -> isTerminal: false (1 outgoing edge in transitionTable())
  OPEN            -> isTerminal: false (2 outgoing edges in transitionTable())
  ACCEPTED        -> isTerminal: false (3 outgoing edges in transitionTable())
  CAPTURING       -> isTerminal: false (3 outgoing edges in transitionTable())
  SUBMITTED       -> isTerminal: false (2 outgoing edges in transitionTable())
  IN_REVIEW       -> isTerminal: false (2 outgoing edges in transitionTable())
  APPROVED        -> isTerminal: false (1 outgoing edge in transitionTable())
  PAYOUT_PENDING  -> isTerminal: false (1 outgoing edge in transitionTable())
  PAID            -> isTerminal: true (terminal — 0 outgoing edges in transitionTable())
  REJECTED        -> isTerminal: false (2 outgoing edges in transitionTable())
  DISPUTED        -> isTerminal: false (2 outgoing edges in transitionTable())
  ABANDONED       -> isTerminal: true (terminal — 0 outgoing edges in transitionTable())
  EXPIRED         -> isTerminal: true (terminal — 0 outgoing edges in transitionTable())
  terminal states: PAID, ABANDONED, EXPIRED (3 of 13 states)
  cross-check: the isTerminal set equals the transition table's no-outgoing-edge set (PAID, ABANDONED, EXPIRED): true (every terminal state has no outgoing edges, and every state with no outgoing edges is terminal)
  main task DEMO-001 (PAID): isTerminal: true (the standalone function and the instance getter agree — a finished task offers no further events)

SLA deadline clearing (clearSlaDeadline on a fixed task):
  before clearing: DEMO-021 (ACCEPTED, ACCEPTED deadline <timestamp>) at <timestamp> -> isOverdue: true (past its ACCEPTED deadline; CAPTURING and SUBMITTED also carry deadlines)
  clear one state: clearSlaDeadline("ACCEPTED") -> getSlaDeadline("ACCEPTED"): undefined, isOverdue at the same instant: false (a renegotiated or cancelled deadline no longer makes the task overdue)
  other states untouched: getSlaDeadline("CAPTURING"): <timestamp>, getSlaDeadline("SUBMITTED"): <timestamp> (clearing one state leaves the other states' deadlines in place)
  clear all states: clearSlaDeadline() with no argument -> getSlaDeadline("ACCEPTED"): undefined, getSlaDeadline("CAPTURING"): undefined, getSlaDeadline("SUBMITTED"): undefined (every state's deadline is cleared)

Single-target payout webhook delivery (deliverPayoutWebhook to 1 endpoint, fake fetch — no real network):
  endpoint: https://payouts.example.com/hooks/payout (the main task's signed payout webhook, delivered on its own — no fan-out)
  delivery: ok attempts=2 status=200 (the first attempt answered 500 and the retry succeeded; a 429 Retry-After hint would have set that retry's delay, clamped to maxRetryDelayMs — the 500 fell back to exponential backoff, here backoffMs 0 with a no-op sleep, so nothing really waited)
  wire check: 2 POSTs captured with byte-identical bodies: true (a retry re-POSTs the same signed body under the same eventId, so a receiver deduplicates it)
  signature check: verifyPayoutWebhook over the captured wire body: true (the X-Hub-Signature-256 header captured on the wire verifies under the demo secret)

Subscribe onError error routing (a throwing listener routed to onError):
  listener: DEMO-022 carries 1 listener that throws Error("demo listener failure") on every notification, subscribed with a collecting onError hook
  routed errors: onError received 3 report(s); first report: event=PUBLISH from=DRAFT to=OPEN error="demo listener failure" (the dispatch context handed to the hook)
  dispatch unaffected: all 3 dispatches returned normally (OPEN, ACCEPTED, CAPTURING) and the audit history holds all 3 entries — a failing listener is isolated, never breaking dispatch
  final state: CAPTURING (terminal: false)

Payout dedupe snapshot persistence (PayoutEventDedupe exportSnapshot / restore across a restart):
  source dedupe (fixed clock <timestamp>, TTL 60000 ms): eventId evt_demo_payout_001 — checkAndRecord: false (new event), again: true (duplicate); eventId evt_demo_payout_002 — checkAndRecord: false (new event), again: true (duplicate)
  exportSnapshot(): v 1, 2 entries — only the version and entry count are printed, never the full entries (persist the JSON before shutdown)
  after JSON round-trip + PayoutEventDedupe.restore(): stats size 2, hits 0, misses 0, evictions 0 — counters restart at zero, the recorded ids do not
  restored dedupe: eventId evt_demo_payout_001 — checkAndRecord: true (duplicate — the restart did not reopen the dedupe window); eventId evt_demo_payout_002 — checkAndRecord: true (duplicate); eventId evt_demo_payout_003 — checkAndRecord: false (new event, recorded)
  tampered snapshot rejected: a detached copy with v changed to 2 throws "PayoutEventDedupe: invalid snapshot: unsupported snapshot version 2 (expected 1)" — a corrupt snapshot fails loudly at startup instead of silently disabling deduplication

Payout dedupe stats observability (PayoutEventDedupe.stats() counters over a pinned script):
  dedupe (fixed clock <timestamp>, TTL 60000 ms, maxEntries 3): initial stats size 0, hits 0, misses 0, evictions 0 — no delivery seen yet
  eventId evt_demo_stats_001 — checkAndRecord: false (new event) -> stats size 1, hits 0, misses 1, evictions 0; again: true (duplicate) -> stats size 1, hits 1, misses 1, evictions 0
  eventId evt_demo_stats_002 — checkAndRecord: false (new event) -> stats size 2, hits 1, misses 2, evictions 0; eventId evt_demo_stats_003 — checkAndRecord: false (new event) -> stats size 3, hits 1, misses 3, evictions 0 (store full)
  eventId evt_demo_stats_004 — checkAndRecord: false (new event, evicts least recently seen evt_demo_stats_001) -> stats size 3, hits 1, misses 4, evictions 1
  detached copy: mutating a returned stats() object (hits set to 999) leaves the store's stats unchanged at size 3, hits 1, misses 4, evictions 1 — the snapshot is a copy, not a live view

Payout dedupe clear reset (PayoutEventDedupe.clear() drops every id and zeroes the counters):
  dedupe (fixed clock <timestamp>, TTL 60000 ms): eventId evt_demo_clear_001 — checkAndRecord: false (new event); again: true (duplicate) -> stats size 1, hits 1, misses 1, evictions 0
  clear(): size 0, stats size 0, hits 0, misses 0, evictions 0 — every recorded id dropped and every counter reset in one call (the explicit reset for key rotation, test isolation, or a deliberate window reset)
  same eventId after clear — checkAndRecord: false (new event again — the clear forgot it, no TTL wait needed) -> stats size 1, hits 0, misses 1, evictions 0 (counters re-accumulate from zero)

Payout webhook 429 Retry-After delivery (deliverPayoutWebhook waits the clamped hint before retrying, fake fetch + recording fake sleep — no real network, no real wait):
  endpoint: https://payouts.example.com/hooks/payout (the main task's signed payout webhook, delivered on its own — no fan-out)
  first answer: 429 with Retry-After: 30 (parsed hint 30000 ms, clamped to maxRetryDelayMs 5000) -> recorded sleep: [5000] ms (the recording sleepImpl received exactly the clamped hint — exponential backoff, here backoffMs 100, never ran, and nothing really waited)
  delivery: ok attempts=2 status=200 (the retry after the clamped wait succeeded)
  wire check: 2 POSTs captured with byte-identical bodies: true (a retry re-POSTs the same signed body under the same eventId, so a receiver deduplicates it); signature check: verifyPayoutWebhook over the captured wire body: true (the X-Hub-Signature-256 header captured on the wire verifies under the demo secret)

Payout webhook secret rotation (verifyPayoutWebhook with { secrets: [new, old] } accepts either secret during the rotation window):
  notifications (main task DEMO-001, fixed signing time <timestamp>): eventId evt_demo_rotation_new signed with the new secret; eventId evt_demo_rotation_old signed with the old secret — the secrets themselves are never printed
  rotation window { secrets: [new, old] }: new-signed verifies: true; old-signed verifies: true (in-flight notifications signed before the rotation still pass, and new-signed ones pass as soon as the new secret is listed — any one matching secret authenticates)
  window edges fail closed: new-signed under the old secret alone: false (a receiver that has not adopted the new secret yet rejects it); both under an unrelated secret list: false, false (no listed secret matches, so verification fails closed as false — never a throw, never a pass)
  configuration guard: passing the positional secret together with { secrets: [...] } throws "cannot verify payout webhook: pass either 'secret' or 'secrets', not both" (the two shapes are mutually exclusive, so a misconfigured receiver fails loudly instead of silently picking one)

Payout webhook AbortSignal abort (deliverPayoutWebhook honours an external AbortSignal, fake fetch + hanging fake sleep — no real network, no real wait):
  endpoint: https://payouts.example.com/hooks/payout (the main task's signed payout webhook, delivered on its own — no fan-out)
  pre-aborted signal: delivery ok=false attempts=0 error="payout webhook delivery aborted"; fetch calls: 0 (the caller asked to stop before the delivery started, so no request was made and the abort is reported, not thrown)
  abort during the backoff wait: first answer 500 -> backoff sleep [30000] ms entered, signal aborted inside the sleep; delivery ok=false attempts=1 status=500 error="payout webhook delivery aborted"; fetch calls: 1 (no second attempt was started — the pending wait was cut short, nothing really waited)

Payout webhook freshness window (verifyPayoutWebhook with { maxAgeMs } rejects a validly signed but stale notification):
  notification (main task DEMO-001, fixed signing time <timestamp>): eventId evt_demo_freshness signed with the demo secret; freshness window maxAgeMs 3600000 ms (1 hour) — the secret itself is never printed
  inside the window: receiver now <timestamp> (30 minutes after signing) with maxAgeMs 3600000 -> verifies: true; boundary: receiver now <timestamp> (exactly maxAgeMs after signing) -> verifies: true (the boundary is inclusive — only now - at > maxAgeMs fails)
  stale replay fails closed: receiver now <timestamp> (2 hours after signing, same body and signature) -> verifies: false (the signature alone still verifies: true — only the freshness gate rejects it, bounding replays of a legitimately signed old notification)
  future skew fails closed: receiver now <timestamp> (the payload at lies 2 hours ahead of the receiver) with maxFutureSkewMs 3600000 -> verifies: false (a sender clock set too far ahead gains no unbounded replay window — maxAgeMs alone never bounds the future direction)

Payout reference enforcement (requirePayoutRef: true rejects a PAYOUT_COMPLETE that carries no payoutRef):
  enforced task DEMO-024 (constructed with requirePayoutRef: true, driven to PAYOUT_PENDING under fixed timestamps): PAYOUT_COMPLETE without a payoutRef -> rejected: "payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled"; state after rejection: PAYOUT_PENDING, history entries: 7 (nothing was appended — the gate is fail-fast, checked before the audit entry is written)
  enforced task with the reference: PAYOUT_COMPLETE with payoutRef "xfer-demo-require-ref" at <timestamp> -> PAID; history last entry: seq 8 PAYOUT_COMPLETE payoutRef=xfer-demo-require-ref (the audit trail now names the transfer the settlement claims)
  default task DEMO-025 (requirePayoutRef unset — the advisory default): PAYOUT_COMPLETE without a payoutRef -> PAID; history last entry carries no payoutRef (backward compatible: enforcement is opt-in, so an unenforced task still settles on the advisory path)

Dispatch idempotency keys (dispatch with { idempotencyKey } makes a retried dispatch a no-op):
  same key, same event (DEMO-026): PUBLISH with idempotencyKey "demo-idem-publish" at <timestamp> -> OPEN, history entries: 1; the same PUBLISH under the same key again -> returns OPEN, history entries: 1 (nothing was appended and the listener was not notified again — a redelivered request is answered from the consumed-key set, not re-executed)
  keys are global and survive progress (DEMO-026): ACCEPT under a second key -> ACCEPTED, history entries: 2; START_CAPTURE under the old key "demo-idem-publish" (a different, would-be legal event) -> returns ACCEPTED, history entries: 2; the stale PUBLISH under that same old key (now an illegal transition) -> returns ACCEPTED without throwing (the transition is not even validated for a known key — a late retry is safe to replay); listener notifications: [PUBLISH, ACCEPT] (only the two real dispatches ever notified)
  a failed dispatch consumes no key (DEMO-027): ACCEPT from DRAFT with idempotencyKey "demo-idem-retry" -> rejected: "invalid transition: ACCEPT from DRAFT"; history entries after the failure: 0; the corrected PUBLISH under the same key -> OPEN (the key was still free, so the retry executed instead of deduping)
  no key, no change (DEMO-027): ACCEPT with no idempotencyKey -> ACCEPTED; history entries: 2 (omitting the key preserves the exact pre-idempotency behavior — every keyless dispatch still validates and appends normally)

Keyed audit hash chain (verifyHistoryChain with { auditSecret } verifies an HMAC-chained history only under its secret):
  keyed task DEMO-028 (constructed with auditSecret, driven PUBLISH -> SUBMIT under fixed timestamps): history entries: 4; verifyHistoryChain with the correct secret: true (every link is HMAC-SHA256 keyed by the pinned secret — the secret itself is never printed)
  wrong secret: verifyHistoryChain: false (the same history under a different secret recomputes no link — verification fails closed as false, never a throw)
  tampered copy: middle entry START_CAPTURE gains payoutAmount 999 — verifyHistoryChain with the correct secret: false (tamper detected: the stored HMAC no longer recomputes); original history after the tamper check: verifyHistoryChain: true (detached copy — the keyed task's own history is untouched)
  no secret: verifyHistoryChain without a secret: false (a keyed chain never verifies unkeyed — fail-closed both ways, exactly as an unkeyed chain never verifies under a secret)

Event-level RBAC (rolePolicy gates covered events to the listed actors):
  policy task DEMO-029 (constructed with rolePolicy { PUBLISH: [researcher], ACCEPT: [contributor], ARBITRATE_APPROVE: [senior-moderator], ARBITRATE_REJECT: [senior-moderator] }): PUBLISH by researcher at <timestamp> -> OPEN; ACCEPT by contributor -> ACCEPTED (the allowlist is an authorization check on the actor name, not identity authentication — a real deployment authenticates its actors itself)
  covered event, wrong or missing actor (DEMO-029): PUBLISH by contributor -> rejected: "actor not authorized for PUBLISH: \"contributor\" is not in [researcher]"; PUBLISH with no actor -> rejected: "actor not authorized for PUBLISH: policy requires an actor in [researcher]"; state after both rejections: DRAFT, history entries: 0 (a rejected dispatch appends nothing — the check runs before the audit entry is written)
  uncovered events are unrestricted (DEMO-029): START_CAPTURE, SUBMIT, BEGIN_REVIEW, REJECT and DISPUTE with no actor at all -> DISPUTED, history entries: 7 (the policy lists only PUBLISH, ACCEPT and the two arbitration events — every other event skips the check entirely)
  arbitration is moderator-only (DEMO-029): ARBITRATE_APPROVE by contributor -> rejected: "actor not authorized for ARBITRATE_APPROVE: \"contributor\" is not in [senior-moderator]"; ARBITRATE_APPROVE with no actor -> rejected: "actor not authorized for ARBITRATE_APPROVE: policy requires an actor in [senior-moderator]"; state after both rejections: DISPUTED, history entries: 7; ARBITRATE_APPROVE by senior-moderator -> APPROVED, history entries: 8
  no policy, no check (DEMO-030): a task constructed without rolePolicy is driven to DISPUTED and arbitrated with no actor at all -> APPROVED, history entries: 8 (omitting the policy preserves the exact pre-policy behavior — no event requires an actor anywhere)

Preseeded idempotency keys (idempotencyKeys seeds a task with already-consumed dispatch keys):
  seeded task DEMO-031 (constructed with idempotencyKeys ["demo-seed-publish", "demo-seed-publish", "demo-seed-accept"]): duplicate seed entries are deduped, first occurrence wins — snapshot idempotencyKeys: ["demo-seed-publish","demo-seed-accept"] (the re-attachment path for fromHistory(), whose audit log cannot carry the key set — keys are dispatch configuration, not audit data)
  seeded key, illegal event (DEMO-031): ACCEPT with idempotencyKey "demo-seed-accept" from DRAFT (no ACCEPT edge leaves DRAFT) -> returns DRAFT; state after: DRAFT, history entries: 0, listener notifications: 0 (a consumed key is a complete no-op — the transition is not even validated, nothing is appended, no listener is notified)
  same event, fresh keys (DEMO-031): PUBLISH with idempotencyKey "demo-fresh-publish" -> OPEN; ACCEPT with idempotencyKey "demo-fresh-accept" -> ACCEPTED, history entries: 2; snapshot idempotencyKeys after both: ["demo-seed-publish","demo-seed-accept","demo-fresh-publish","demo-fresh-accept"] (each fresh key is consumed by its successful dispatch — a later retry under either is a no-op)
  invalid seed (construction): idempotencyKeys [""] -> rejected: "invalid option: idempotencyKeys entries must be non-empty strings, got """ (every seed must be a non-empty string — the same bar dispatch applies to a single key, checked at construction before any task exists)
  no seed, no change (DEMO-032): a task constructed without idempotencyKeys dispatches PUBLISH with no key at all -> OPEN, history entries: 1; snapshot idempotencyKeys: undefined (omitting the seed preserves the exact pre-seeding behavior — the snapshot omits the field while the key set is empty)

Payout webhook timeout (deliverPayoutWebhook enforces a per-attempt timeoutMs, injected hanging fetch — no real network):
  endpoint: https://payouts.example.com/hooks/payout (the main task's signed payout webhook, delivered on its own — no fan-out)
  hanging receiver, pinned timeout: timeoutMs 50 with maxAttempts 1; the injected fetch never answers on its own and only settles when the per-attempt abort fires -> delivery ok=false attempts=1 error="webhook delivery timed out after 50ms"; fetch calls: 1 (the timeout is reported in the result, never thrown — the 50 ms wait is the behaviour under test itself, at its pinned short length, and no elapsed duration is asserted)
  invalid timeout (configuration): timeoutMs 0 -> rejected: "cannot deliver payout webhook: timeoutMs must be a positive number, got 0"; fetch calls: 0 (an invalid timeout is a caller bug, so it throws before any request is made — a delivery outcome, by contrast, is only ever reported)
  loose timeout, immediate answer: timeoutMs 5000 and the endpoint answers 200 at once -> delivery ok=true attempts=1 status=200; fetch calls: 1 (a generous deadline changes nothing when the receiver is fast — the success shape is exactly the untimed one)

Payout webhook fan-out timeout overrides (deliverPayoutWebhookToMany resolves timeoutMs per endpoint — endpoint.timeoutMs ?? call-level timeoutMs, injected fetches — no real network):
  shared eventId: evt_demo_fanout_timeout_001, shared at: <timestamp> (one logical event for all three endpoints in each call, as in the fan-out segment above; every endpoint signed with its own secret)
  pinned override, hanging receiver (slow, https://slow.example.com/hooks/payout): per-endpoint timeoutMs 50 overrides the call-level 5000; the endpoint's own injected fetch never answers on its own and only settles when the per-attempt abort fires -> ok=false attempts=3 error="webhook delivery timed out after 50ms"; fetch calls: 3 (a timeout is a retryable failure, so the endpoint burns all 3 attempts at 50 ms each — the waits are the behaviour under test itself, at their pinned short length, and no elapsed duration is asserted)
  no override, same call (billing + notifications): neither endpoint pins timeoutMs, so the call-level 5000 applies and both answer 200 at once -> billing ok=true attempts=1 status=200, notifications ok=true attempts=1 status=200; fan-out: 2 delivered, 1 failed — results stay in input order (billing, slow, notifications) and the timed-out endpoint did not block the others
  invalid override, isolated failure (notifications): per-endpoint timeoutMs 0 -> its result is exactly { ok: false, attempts: 0, error: "cannot deliver payout webhook: timeoutMs must be a positive number, got 0" }; fetch calls to that endpoint: 0; billing and slow (answering 200 at once in this call) are unchanged at ok=true attempts=1 status=200 — a bad per-endpoint override is reported for its own endpoint only, where the same value at call level would throw for the whole call before any request
  no overrides anywhere: no endpoint pins timeoutMs and the call sets none either (the 5000 ms default applies) -> all three endpoints ok=true attempts=1 status=200; fan-out: 3 delivered, 0 failed (omitting the override preserves the exact pre-override fan-out behaviour)

Dispatch expectedSeq optimistic concurrency (dispatch pins the history length the caller read — fixed timestamps, no network):
  correct guard (DEMO-033): driven PUBLISH -> ACCEPT under fixed timestamps to seq 2 (state ACCEPTED, history entries: 2); START_CAPTURE with expectedSeq 2 at <timestamp> -> CAPTURING, history entries: 3; last entry: seq 3 START_CAPTURE ACCEPTED -> CAPTURING by contributor (the caller pinned the seq it based its decision on and the task was still there, so exactly one step advances)
  stale guard (DEMO-034): the same pinned 2-entry history; START_CAPTURE with expectedSeq 1 -> rejected: "dispatch conflict: expected seq 1 but task is at seq 2"; state after: ACCEPTED, history entries: 2 (the guard runs before every other dispatch check and changes nothing — no state move, no history entry — so a writer holding a stale snapshot fails loudly instead of advancing a state it never saw, and re-reading the task and retrying with the fresh seq works)
  empty history (DEMO-035): a fresh task (history entries: 0); PUBLISH with expectedSeq 0 -> OPEN, history entries: 1 (0 is the guard for an empty history — the seq is the history length, which is the last entry's seq once entries exist)
  illegal guards (DEMO-036): PUBLISH with expectedSeq -1 -> rejected: "invalid dispatch options: expectedSeq must be a non-negative integer, got -1"; PUBLISH with expectedSeq 1.5 -> rejected: "invalid dispatch options: expectedSeq must be a non-negative integer, got 1.5"; state after both: DRAFT, history entries: 0 (a non-integer or negative expectedSeq is a caller configuration error, thrown up front before anything mutates)
  no guard (DEMO-037): the same pinned 2-entry history; START_CAPTURE with no expectedSeq -> CAPTURING, history entries: 3 (omitting expectedSeq preserves the exact pre-guard behavior)

Constructor id fail-fast (the first door of the audit chain):
  new TaskLifecycle("") throws: invalid task: id must be a non-empty string
  new TaskLifecycle(undefined) throws: invalid task: id must be a non-empty string
  new TaskLifecycle(123) throws: invalid task: id must be a non-empty string
  new TaskLifecycle("DEMO-044") constructs and dispatches PUBLISH → OPEN

History getter immutability (the audit trail cannot be rewritten at runtime — fixed timestamps, no network):
  push a forged entry onto the history snapshot (DEMO-045): throws TypeError; internal history still 2 entries
  splice the history snapshot: throws TypeError; internal history still 2 entries
  rewrite entry.note on the history snapshot: throws TypeError; internal entry unchanged
  two history getter calls return deep-equal but reference-independent snapshots (the array is never handed out twice)
  dispatch START_CAPTURE after the snapshot: the old snapshot stays at 2 entries, the live history grows to 3 — a frozen detached copy; dispatch() is the only append path

Stale patrol (staleTasks / maxAgeByState screening, notify-only action):
  fixed now: <timestamp> — patrol budgets: DRAFT 7 days, OPEN 7 days, PAID 7 days (IN_REVIEW has no budget; dwell from the last history entry, strictly past the budget)
  DEMO-038: state OPEN, entered <timestamp>, dwell 21 days — stale: true
  DEMO-039: state OPEN, entered <timestamp>, dwell 7 days — stale: false
  DEMO-040: state PAID, entered <timestamp>, dwell 22 days — stale: false
  DEMO-041: state DRAFT, no history (no measurable dwell) — stale: false
  DEMO-042: state IN_REVIEW, entered <timestamp>, dwell 35 days — stale: false
  staleTasks selection: [DEMO-038] — exactly-at-budget (DEMO-039), terminal (DEMO-040), no-history (DEMO-041) and unmapped-state (DEMO-042) tasks are not selected
  actOnStaleTasks (action: notify the assignee, dispatch nothing): 1 attempted
  DEMO-038: acted true — notified, task unchanged at OPEN
  invalid patrol configuration fails fast: staleTasks with an unknown state name throws invalid maxAgeByState: unknown state "BOGUS" before any task is read`;

test("demo lines match the pre-refactor golden output, line for line", async () => {
  const { lines } = await runDemo();
  assert.equal(lines.length, 512);
  assert.equal(normalize(lines.join("\n")), GOLDEN_DEMO_OUTPUT);
});

test("demo runs the DRAFT -> PAID chain with a REJECT -> RESUBMIT loop in-process", async () => {
  const { task, lines } = await runDemo();
  const text = lines.join("\n");

  assert.equal(task.id, "DEMO-001");
  assert.equal(task.state, "PAID");
  assert.equal(task.isTerminal, true);
  // Exactly 12 entries: the happy path plus REJECT + RESUBMIT and the
  // second SUBMIT + second BEGIN_REVIEW of the re-review round.
  assert.equal(task.history.length, 12);
  assert.deepEqual(
    task.history.map((h) => [h.event, h.from, h.to]),
    [
      ["PUBLISH", "DRAFT", "OPEN"],
      ["ACCEPT", "OPEN", "ACCEPTED"],
      ["START_CAPTURE", "ACCEPTED", "CAPTURING"],
      ["SUBMIT", "CAPTURING", "SUBMITTED"],
      ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW"],
      ["REJECT", "IN_REVIEW", "REJECTED"],
      ["RESUBMIT", "REJECTED", "CAPTURING"],
      ["SUBMIT", "CAPTURING", "SUBMITTED"],
      ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW"],
      ["APPROVE", "IN_REVIEW", "APPROVED"],
      ["REQUEST_PAYOUT", "APPROVED", "PAYOUT_PENDING"],
      ["PAYOUT_COMPLETE", "PAYOUT_PENDING", "PAID"],
    ],
  );
  // The printed loop is ordered: REJECT before RESUBMIT before APPROVE.
  const rejectAt = text.indexOf("REJECT");
  const resubmitAt = text.indexOf("RESUBMIT");
  const approveAt = text.indexOf("APPROVE");
  assert.ok(rejectAt >= 0 && resubmitAt > rejectAt, "RESUBMIT must follow REJECT");
  assert.ok(approveAt > resubmitAt, "APPROVE must follow the RESUBMIT loop");
  assert.match(text, /Final state: PAID \(terminal: true\)/);
  // Numbered history rows across all printed audit trails: 12 + 3 + 8.
  const seqRows = text.match(/^\s+\d+  /gm) ?? [];
  assert.equal(seqRows.length, 23);
});

test("demo shows the audit hash-chain segment in-process: intact chain passes, tampered payoutAmount is detected, original untouched", async () => {
  const { task, historyChainVerified, tamperedChainVerified, tamperedPayoutAmount, lines } =
    await runDemo();
  const text = lines.join("\n");

  // The structured verdicts are the hand-written expectations:
  // the main task's 12-entry chain verifies, the detached copy
  // with its PAYOUT_COMPLETE payoutAmount raised by 1 does not.
  assert.equal(historyChainVerified, true);
  assert.equal(tamperedChainVerified, false);
  assert.equal(tamperedPayoutAmount, 10099.5);
  // An independent re-verification of the returned task agrees,
  // and a hand-built tamper in the test (not the demo's own copy)
  // is detected the same way — the segment is not self-certifying.
  assert.equal(verifyHistoryChain(task.history), true);
  const crossCheck = task.history.map((entry) => ({ ...entry }));
  const crossEntry = crossCheck.find((e) => e.event === "PAYOUT_COMPLETE")!;
  crossEntry.payoutAmount = crossEntry.payoutAmount! + 1;
  assert.equal(verifyHistoryChain(crossCheck), false);
  // The original is untouched: its PAYOUT_COMPLETE amount is
  // still the fixture value and its chain still verifies.
  assert.equal(
    task.history.find((h) => h.event === "PAYOUT_COMPLETE")!.payoutAmount,
    10098.5,
  );
  assert.equal(task.history.length, 12);
  // The segment is printed after the main history and before the
  // SLA branch, with its three lines verbatim.
  const chainAt = text.indexOf("Audit hash chain (verifyHistoryChain on the main task history):");
  assert.ok(
    chainAt > text.indexOf("History (append-only audit trail):"),
    "chain segment must follow the main history",
  );
  assert.ok(
    text.indexOf("SLA watchdog branch") > chainAt,
    "SLA branch must follow the chain segment",
  );
  assert.match(
    text,
    /intact history: verifyHistoryChain: true \(12 entries, genesis-linked, every hash recomputes\)/,
  );
  assert.match(
    text,
    /tampered copy: PAYOUT_COMPLETE payoutAmount 10098\.5 -> 10099\.5 — verifyHistoryChain: false \(tamper detected: the stored hash no longer recomputes\)/,
  );
  assert.match(
    text,
    /original history after the tamper check: verifyHistoryChain: true \(detached copy — the task's own history is untouched\)/,
  );
});

test("demo audit hash-chain segment is deterministic in outcome: two runs agree on all three verdicts and lines", async () => {
  const chainLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Audit hash chain (verifyHistoryChain on the main task history):"),
      ls.indexOf("SLA watchdog branch (second task, advisory deadline):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = chainLines(a.lines);
  // Header + intact + tampered + original lines; the segment
  // prints no timestamps or hashes (only verdicts and the fixed
  // fixture amounts), so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, chainLines(b.lines));
  assert.deepEqual(
    [a.historyChainVerified, a.tamperedChainVerified, a.tamperedPayoutAmount],
    [b.historyChainVerified, b.tamperedChainVerified, b.tamperedPayoutAmount],
  );
});

test("demo builds the payout webhook from the settled task and verifies it (structured)", async () => {
  const { webhook, webhookVerified, lines } = await runDemo();
  const { payload, signature } = webhook;

  // Payload fields derive from the PAYOUT_COMPLETE audit entry — the
  // structured values the old subprocess test could only regex-shape.
  assert.equal(payload.event, "PAYOUT_COMPLETE");
  assert.equal(payload.taskId, "DEMO-001");
  assert.equal(payload.payoutRef, "xfer-88f2");
  assert.equal(payload.payoutAmount, 10098.5);
  assert.match(
    payload.eventId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  // The demo's own receiver-side check passes, and an independent
  // re-verification agrees; tampering with a signed field breaks it.
  assert.equal(webhookVerified, true);
  assert.equal(verifyPayoutWebhook(payload, signature, DEMO_WEBHOOK_SECRET), true);
  assert.equal(
    verifyPayoutWebhook(
      { ...payload, payoutAmount: 1 },
      signature,
      DEMO_WEBHOOK_SECRET,
    ),
    false,
  );
  // The webhook section is printed after the SLA branch.
  const text = lines.join("\n");
  assert.ok(
    text.indexOf("Payout webhook (signed PAYOUT_COMPLETE notification):") >
      text.indexOf("SLA watchdog branch"),
    "payout webhook section must follow the SLA branch",
  );
  assert.match(text, /verifyPayoutWebhook: ok/);
});

test("demo shows the receiver-side dedupe segment in-process: first delivery booked, redelivery skipped, same id accepted again after the TTL", async () => {
  const { dedupeFirst, dedupeRedelivery, dedupeAfterTtl, webhook, lines } = await runDemo();
  const text = lines.join("\n");

  // The three structured outcomes are the hand-written expectations
  // for checkAndRecord's contract (false = first sighting, true =
  // duplicate within the TTL, false again once the record expired).
  assert.equal(dedupeFirst, false);
  assert.equal(dedupeRedelivery, true);
  assert.equal(dedupeAfterTtl, false);
  // An independent dedupe instance under the same fixed-clock /
  // TTL setup reproduces the same three outcomes for the demo
  // webhook's eventId — the demo segment is not self-certifying.
  let nowMs = Date.parse("2026-03-18T09:00:00.000Z");
  const replay = new PayoutEventDedupe({ ttlMs: 60_000, now: () => nowMs });
  assert.equal(replay.checkAndRecord(webhook.payload.eventId), false);
  assert.equal(replay.checkAndRecord(webhook.payload.eventId), true);
  nowMs += 60_000; // exactly the TTL: the record has expired
  assert.equal(replay.checkAndRecord(webhook.payload.eventId), false);
  // The segment is printed after the single webhook section and
  // before the batch section, with the three delivery lines
  // verbatim (the fixed clock start and the TTL-advanced instant
  // are fixed literals).
  const dedupeAt = text.indexOf("Receiver-side dedupe (PayoutEventDedupe on the webhook's eventId):");
  assert.ok(
    dedupeAt > text.indexOf("Payout webhook (signed PAYOUT_COMPLETE notification):"),
    "dedupe segment must follow the single webhook section",
  );
  assert.ok(
    text.indexOf("Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):") > dedupeAt,
    "batch section must follow the dedupe segment",
  );
  assert.match(
    text,
    /dedupe ttl: 60000 ms \(demo policy; the library default is 3600000 ms\) — clock injected and fixed at 2026-03-18T09:00:00\.000Z/,
  );
  assert.match(text, /delivery 1: eventId \S+ -> checkAndRecord false \(new event, payout booked\)/);
  assert.match(
    text,
    /delivery 2: same eventId redelivered -> checkAndRecord true \(duplicate, skipped — no second booking\)/,
  );
  assert.match(
    text,
    /delivery 3: clock advanced by exactly the ttl to 2026-03-18T09:01:00\.000Z -> checkAndRecord false \(record expired at the ttl boundary, accepted again\)/,
  );
});

test("demo dedupe segment is deterministic in outcome: two runs agree on all three checkAndRecord results", async () => {
  const dedupeLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Receiver-side dedupe (PayoutEventDedupe on the webhook's eventId):"),
      ls.indexOf("Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  // Header + ttl line + 3 delivery lines; the only varying value
  // is the main webhook's random eventId, normalized away — the
  // segment's clock is injected and fixed, never the wall clock.
  const segA = dedupeLines(a.lines);
  assert.equal(segA.length, 5);
  assert.equal(normalize(segA.join("\n")), normalize(dedupeLines(b.lines).join("\n")));
  assert.deepEqual(
    [a.dedupeFirst, a.dedupeRedelivery, a.dedupeAfterTtl],
    [b.dedupeFirst, b.dedupeRedelivery, b.dedupeAfterTtl],
  );
});

test("demo shows the SLA watchdog branch in-process: screening finds DEMO-002, then EXPIRE lands it in EXPIRED", async () => {
  const { overdueTask, overdueFound, lines } = await runDemo();
  const text = lines.join("\n");

  assert.deepEqual(
    overdueFound.map((t) => t.id),
    ["DEMO-002"],
  );
  assert.equal(overdueTask.id, "DEMO-002");
  assert.equal(overdueTask.state, "EXPIRED");
  assert.equal(overdueTask.isTerminal, true);
  // Fixed-literal branch timestamps: no wall clock anywhere here.
  assert.deepEqual(
    overdueTask.history.map((h) => [h.event, h.from, h.to, h.actor, h.at]),
    [
      ["PUBLISH", "DRAFT", "OPEN", "researcher", "2026-03-01T09:00:00.000Z"],
      ["ACCEPT", "OPEN", "ACCEPTED", "contributor", "2026-03-01T09:05:00.000Z"],
      ["EXPIRE", "ACCEPTED", "EXPIRED", "watchdog", "2026-03-06T09:00:00.000Z"],
    ],
  );
  assert.equal(overdueTask.getSlaDeadline("ACCEPTED"), "2026-03-03T09:00:00.000Z");
  assert.match(text, /SLA deadline \(ACCEPTED\): 2026-03-03T09:00:00\.000Z/);
  assert.match(
    text,
    /expiredTasks\(\[DEMO-001, DEMO-002\], 2026-03-06T09:00:00\.000Z\): DEMO-002 \(1 overdue\)/,
  );
  assert.match(text, /DEMO-002 still ACCEPTED: the deadline alone never expires a task/);
  assert.match(text, /Final state \(SLA branch\): EXPIRED \(terminal: true\)/);
  const screenAt = text.indexOf("expiredTasks([DEMO-001, DEMO-002]");
  const expireAt = text.indexOf("EXPIRE", screenAt);
  assert.ok(screenAt >= 0 && expireAt > screenAt, "EXPIRE must follow the screening line");
});

test("demo shows the DISPUTE appeal branch in-process: DISPUTE lands DEMO-003 in DISPUTED, arbitration returns it to REJECTED", async () => {
  const { disputeTask, lines } = await runDemo();
  const text = lines.join("\n");

  assert.equal(disputeTask.id, "DEMO-003");
  assert.equal(disputeTask.state, "REJECTED");
  assert.equal(disputeTask.isTerminal, false);
  // Fixed-literal branch timestamps: no wall clock anywhere here.
  assert.deepEqual(
    disputeTask.history.map((h) => [h.event, h.from, h.to, h.actor, h.at]),
    [
      ["PUBLISH", "DRAFT", "OPEN", "researcher", "2026-03-10T09:00:00.000Z"],
      ["ACCEPT", "OPEN", "ACCEPTED", "contributor", "2026-03-10T09:05:00.000Z"],
      ["START_CAPTURE", "ACCEPTED", "CAPTURING", "contributor", "2026-03-10T09:10:00.000Z"],
      ["SUBMIT", "CAPTURING", "SUBMITTED", "contributor", "2026-03-11T09:00:00.000Z"],
      ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW", "reviewer", "2026-03-11T09:05:00.000Z"],
      ["REJECT", "IN_REVIEW", "REJECTED", "reviewer", "2026-03-11T09:10:00.000Z"],
      ["DISPUTE", "REJECTED", "DISPUTED", "contributor", "2026-03-11T10:00:00.000Z"],
      ["ARBITRATE_REJECT", "DISPUTED", "REJECTED", "moderator", "2026-03-12T09:00:00.000Z"],
    ],
  );
  assert.match(text, /DISPUTE\s+REJECTED\s+-> DISPUTED\s+\(contributor\)/);
  assert.match(text, /ARBITRATE_REJECT DISPUTED\s+-> REJECTED\s+\(moderator\)/);
  assert.match(text, /Final state \(DISPUTE branch\): REJECTED \(terminal: false\)/);
  assert.match(
    text,
    /dispute budget: 1 of 1 DISPUTEs used \(demo sets maxDisputes: 1; the library default is unlimited\)/,
  );
  // The appeal consumed the demo's budget of 1: a second DISPUTE throws
  // the explicit budget error and leaves no trace in the history.
  assert.throws(
    () =>
      disputeTask.dispatch("DISPUTE", {
        actor: "contributor",
        at: "2026-03-12T10:00:00.000Z",
      }),
    /dispute budget exhausted: 1 of 1 DISPUTEs already used/,
  );
  assert.equal(disputeTask.state, "REJECTED");
  assert.equal(disputeTask.history.length, 8);
  // The dispute branch is printed after the SLA branch and before the
  // payout webhook section (the reconciliation branch now closes the
  // demo, after the batch section).
  const disputeAt = text.indexOf("DISPUTE appeal branch");
  assert.ok(
    disputeAt > text.indexOf("SLA watchdog branch"),
    "DISPUTE branch must follow the SLA branch",
  );
  assert.ok(
    text.indexOf("Payout webhook (signed PAYOUT_COMPLETE notification):") > disputeAt,
    "payout webhook section must follow the DISPUTE branch",
  );
});

test("demo builds the batch payout webhooks in-process: per-item isolation and per-item verification", async () => {
  const { batchResults, batchVerified, lines } = await runDemo();
  const text = lines.join("\n");

  // One result per demo task, in input order.
  assert.equal(batchResults.length, 3);
  assert.deepEqual(
    batchResults.map((r) => r.taskId),
    ["DEMO-001", "DEMO-002", "DEMO-003"],
  );
  // The PAID main task builds, with the deterministic factory's first
  // eventId, the shared fixed `now`, and the audit-derived settlement
  // fields; it verifies under the demo secret.
  const first = batchResults[0];
  assert.ok(first.webhook);
  assert.equal(first.error, undefined);
  assert.equal(first.webhook.payload.eventId, "evt_demo_batch_001");
  assert.equal(first.webhook.payload.at, "2026-03-13T09:00:00.000Z");
  assert.equal(first.webhook.payload.payoutRef, "xfer-88f2");
  assert.equal(first.webhook.payload.payoutAmount, 10098.5);
  assert.deepEqual(batchVerified, [true, undefined, undefined]);
  assert.equal(
    verifyPayoutWebhook(first.webhook.payload, first.webhook.signature, DEMO_WEBHOOK_SECRET),
    true,
  );
  // Each non-PAID branch task lands as { taskId, error } only — the
  // single build's exact error — and DEMO-003 is still attempted
  // after DEMO-002 errors (per-item isolation, never blocking).
  assert.equal(batchResults[1].webhook, undefined);
  assert.equal(
    batchResults[1].error,
    "cannot build payout webhook: task DEMO-002 is in state EXPIRED, only PAID tasks have a completed settlement to announce",
  );
  assert.equal(batchResults[2].webhook, undefined);
  assert.equal(
    batchResults[2].error,
    "cannot build payout webhook: task DEMO-003 is in state REJECTED, only PAID tasks have a completed settlement to announce",
  );
  // The batch section is printed after the single webhook section,
  // with one line per result plus the summary (the fan-out delivery
  // segment follows it).
  const batchAt = text.indexOf("Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):");
  assert.ok(
    batchAt > text.indexOf("Payout webhook (signed PAYOUT_COMPLETE notification):"),
    "batch section must follow the single webhook section",
  );
  assert.match(
    text,
    /DEMO-001: webhook eventId=evt_demo_batch_001 payoutRef=xfer-88f2 payoutAmount=10098\.5 verifyPayoutWebhook: ok/,
  );
  assert.match(text, /batch: 1 webhook\(s\) built, 2 error\(s\)/);
});

test("demo batch segment is deterministic: two runs print byte-identical batch lines", async () => {
  const batchLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):"),
      ls.indexOf("Payout webhook fan-out delivery (deliverPayoutWebhookToMany to 3 endpoints, fake fetch — no real network):") - 1,
    );
  const a = batchLines((await runDemo()).lines);
  const b = batchLines((await runDemo()).lines);
  assert.equal(a.length, 6);
  assert.deepEqual(a, b);
  // The fixed shared `now` is printed literally — no wall clock, no
  // random eventId anywhere in the segment.
  assert.match(a.join("\n"), /shared now: 2026-03-13T09:00:00\.000Z/);
});

test("demo shows the reconciliation screening branch in-process: unreconciled, mismatched, and total match the hand-computed expectations", async () => {
  const { unreconciledTask, mismatchedTask, unreconciledFound, mismatchedFound, totalPaid, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Both branch tasks are driven to PAID under fixed-literal
  // timestamps — no wall clock anywhere in either history.
  for (const [task, firstDay, secondDay] of [
    [unreconciledTask, "2026-03-14", "2026-03-15"],
    [mismatchedTask, "2026-03-16", "2026-03-17"],
  ] as const) {
    assert.equal(task.state, "PAID");
    assert.equal(task.isTerminal, true);
    assert.equal(task.history.length, 8);
    assert.ok(task.history.slice(0, 3).every((h) => h.at.startsWith(firstDay)));
    assert.ok(task.history.slice(3).every((h) => h.at.startsWith(secondDay)));
  }
  // DEMO-004's deliberate flaw is evidence only: its PAYOUT_COMPLETE
  // entry records the settled amount but no payoutRef, and its
  // ACCEPT quote equals the settled amount.
  const unreconciledComplete = unreconciledTask.history.at(-1)!;
  assert.equal(unreconciledComplete.event, "PAYOUT_COMPLETE");
  assert.equal(unreconciledComplete.payoutRef, undefined);
  assert.equal(unreconciledComplete.payoutAmount, 2500);
  assert.equal(
    unreconciledTask.history.find((h) => h.event === "ACCEPT")!.quotedAmount,
    2500,
  );
  // DEMO-005's deliberate flaw is the amount only: evidenced under a
  // payoutRef, but settled 249.5 under its ACCEPT quote.
  const mismatchedComplete = mismatchedTask.history.at(-1)!;
  assert.equal(mismatchedComplete.event, "PAYOUT_COMPLETE");
  assert.equal(mismatchedComplete.payoutRef, "xfer-91c7");
  assert.equal(mismatchedComplete.payoutAmount, 3750.5);
  assert.equal(
    mismatchedTask.history.find((h) => h.event === "ACCEPT")!.quotedAmount,
    4000,
  );
  // The three screens over all five demo tasks hit exactly the
  // hand-computed expectations written in the demo source: the main
  // task (ref recorded, no quote) is flagged by neither screen, and
  // the EXPIRED / REJECTED tasks contribute nothing to the total.
  assert.deepEqual(
    unreconciledFound.map((t) => t.id),
    ["DEMO-004"],
  );
  assert.deepEqual(
    mismatchedFound.map((t) => t.id),
    ["DEMO-005"],
  );
  assert.equal(totalPaid, 16349);
  // The screening is pure: every screened task is untouched.
  assert.equal(unreconciledTask.state, "PAID");
  assert.equal(mismatchedTask.state, "PAID");
  assert.equal(unreconciledTask.history.length, 8);
  assert.equal(mismatchedTask.history.length, 8);
  // The branch is printed after the batch section and the fan-out
  // delivery segment (the subscription branch follows it, then the
  // event-sourcing replay segment closes the demo), with the three
  // screening lines verbatim.
  const reconAt = text.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):");
  assert.ok(
    reconAt > text.indexOf("Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):"),
    "reconciliation branch must follow the batch section",
  );
  assert.match(text, /screened: DEMO-001, DEMO-002, DEMO-003, DEMO-004, DEMO-005 \(all five demo tasks\)/);
  assert.match(
    text,
    /unreconciledPayouts: DEMO-004 \(1 hit: PAID but no payoutRef on the PAYOUT_COMPLETE entry\)/,
  );
  assert.match(
    text,
    /mismatchedPayouts: DEMO-005 \(quoted 4000, paid 3750\.5, delta -249\.5\) \(1 hit: settled amount differs from the ACCEPT quote\)/,
  );
  assert.match(text, /totalPaidOut: 16349 \(10098\.5 \+ 2500 \+ 3750\.5 across the 3 PAID tasks/);
});

test("demo reconciliation segment is deterministic: two runs print byte-identical reconciliation lines", async () => {
  const reconLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):"),
      ls.indexOf("Dispatch subscription branch (sixth task, in-process fan-out):") - 1,
    );
  const a = reconLines((await runDemo()).lines);
  const b = reconLines((await runDemo()).lines);
  // Header + (task header + 8 transitions + note) x2 + 4 screening
  // lines; every timestamp in the segment is a fixed literal that
  // never reaches the printed lines, so no normalization is needed.
  assert.equal(a.length, 25);
  assert.deepEqual(a, b);
});


test("demo shows the dispatch subscription branch in-process: ordered notifications match history, silence after unsubscribe", async () => {
  const {
    subscriptionTask,
    subscriptionNotifications,
    subscriptionMatchesHistory,
    subscriptionCountAfterUnsubscribe,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // The branch task ends in SUBMITTED (not terminal) with four
  // fixed-literal history entries — three subscribed dispatches
  // plus the post-unsubscribe SUBMIT.
  assert.equal(subscriptionTask.id, "DEMO-006");
  assert.equal(subscriptionTask.state, "SUBMITTED");
  assert.equal(subscriptionTask.isTerminal, false);
  assert.equal(subscriptionTask.listenerCount, 0);
  assert.deepEqual(
    subscriptionTask.history.map((h) => [h.event, h.from, h.to, h.actor, h.at]),
    [
      ["PUBLISH", "DRAFT", "OPEN", "researcher", "2026-03-19T09:00:00.000Z"],
      ["ACCEPT", "OPEN", "ACCEPTED", "contributor", "2026-03-19T09:05:00.000Z"],
      ["START_CAPTURE", "ACCEPTED", "CAPTURING", "contributor", "2026-03-19T09:10:00.000Z"],
      ["SUBMIT", "CAPTURING", "SUBMITTED", "contributor", "2026-03-19T09:15:00.000Z"],
    ],
  );
  // The collected notifications are exactly the first three
  // dispatches, in order, each carrying its audit entry's seq —
  // independently re-derived from the task history here, not just
  // trusted from the demo's own match flag.
  assert.deepEqual(subscriptionNotifications, [
    { event: "PUBLISH", from: "DRAFT", to: "OPEN", seq: 1 },
    { event: "ACCEPT", from: "OPEN", to: "ACCEPTED", seq: 2 },
    { event: "START_CAPTURE", from: "ACCEPTED", to: "CAPTURING", seq: 3 },
  ]);
  assert.deepEqual(
    subscriptionNotifications,
    subscriptionTask.history
      .slice(0, 3)
      .map((h) => ({ event: h.event, from: h.from, to: h.to, seq: h.seq })),
  );
  assert.equal(subscriptionMatchesHistory, true);
  // After unsubscribe, the SUBMIT dispatch moved the task but
  // produced no fourth notification.
  assert.equal(subscriptionCountAfterUnsubscribe, 3);
  // The branch is printed after the reconciliation branch and
  // before the closing event-sourcing replay segment, with its
  // lines verbatim.
  const subAt = text.indexOf("Dispatch subscription branch (sixth task, in-process fan-out):");
  assert.ok(
    subAt > text.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):"),
    "subscription branch must follow the reconciliation branch",
  );
  assert.ok(
    text.indexOf("Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):") > subAt,
    "event-sourcing segment must follow the subscription branch",
  );
  assert.match(text, /notification 1: PUBLISH DRAFT -> OPEN \(entry seq 1\)/);
  assert.match(text, /notification 3: START_CAPTURE ACCEPTED -> CAPTURING \(entry seq 3\)/);
  assert.match(text, /notifications match the task history: true/);
  assert.match(text, /unsubscribed: listenerCount 0/);
  assert.match(
    text,
    /listener received after unsubscribe: 3 notification\(s\) \(unchanged — SUBMIT produced no new notification\)/,
  );
  assert.match(text, /Final state \(subscription branch\): SUBMITTED \(terminal: false\)/);
});

test("demo subscription segment is deterministic: two runs print byte-identical subscription lines", async () => {
  const subLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Dispatch subscription branch (sixth task, in-process fan-out):"),
      ls.indexOf("Stale-task dwell screening branch (three more tasks, dwell vs deadline):") - 1,
    );
  const a = subLines((await runDemo()).lines);
  const b = subLines((await runDemo()).lines);
  // Header + task header + subscribed line + received header + 3
  // notification lines + match line + unsubscribed line + SUBMIT
  // line + after-unsubscribe line + blank + final-state line + the
  // listenerCount lifecycle segment (blank + header + task header +
  // 7 action lines + blank + final-state line); every timestamp in
  // the segment is a fixed literal that never reaches the printed
  // lines, so no normalization is needed.
  assert.equal(a.length, 25);
  assert.deepEqual(a, b);
});

test("demo listenerCount lifecycle branch: the registry count pins the subscribe/unsubscribe lifecycle", async () => {
  const {
    listenerCountTask,
    listenerCountTimeline,
    listenerCountKept,
    listenerCountDropped,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // DEMO-043 ends in OPEN with a single PUBLISH entry; the registry
  // is empty again after the pinned 0 -> 2 -> 1 -> 0 -> 0 walk.
  assert.equal(listenerCountTask.id, "DEMO-043");
  assert.equal(listenerCountTask.state, "OPEN");
  assert.equal(listenerCountTask.listenerCount, 0);
  assert.deepEqual(listenerCountTimeline, [0, 2, 1, 0, 0]);
  assert.deepEqual(
    listenerCountTask.history.map((h) => [h.event, h.from, h.to, h.actor, h.at]),
    [["PUBLISH", "DRAFT", "OPEN", "researcher", "2026-03-19T09:30:00.000Z"]],
  );
  // Between the two unsubscribes, the survivor heard exactly the
  // one PUBLISH while the departed collector stayed silent.
  assert.deepEqual(listenerCountKept, [
    { event: "PUBLISH", from: "DRAFT", to: "OPEN", seq: 1 },
  ]);
  assert.deepEqual(listenerCountDropped, []);
  // The branch is printed between the subscription branch and the
  // stale-task branch, with its lines verbatim.
  const lcAt = text.indexOf("listenerCount lifecycle (subscription registry observability):");
  assert.ok(
    lcAt > text.indexOf("Dispatch subscription branch (sixth task, in-process fan-out):"),
    "listenerCount branch must follow the subscription branch",
  );
  assert.ok(
    text.indexOf("Stale-task dwell screening branch (three more tasks, dwell vs deadline):") > lcAt,
    "stale-task branch must follow the listenerCount branch",
  );
  assert.match(text, /  listenerCount with no subscriptions: 0/);
  assert.match(text, /  subscribed: 2 collecting listeners \(listenerCount 2\)/);
  assert.match(text, /  unsubscribed one listener \(listenerCount 1\)/);
  assert.match(
    text,
    /  surviving listener heard 1 notification\(s\): PUBLISH DRAFT -> OPEN \(entry seq 1\); departed listener heard 0/,
  );
  assert.match(text, /  unsubscribed the survivor \(listenerCount 0\)/);
  assert.match(text, /  second call of the same unsubscribe is idempotent \(listenerCount 0\)/);
  assert.match(text, /Final state \(listenerCount branch\): OPEN \(listenerCount 0\)/);
});

test("demo shows the stale-task dwell screening branch in-process: stale and overdue subsets disagree on the same batch", async () => {
  const { staleDwellTasks, staleFound, staleExpiredFound, lines } = await runDemo();
  const text = lines.join("\n");
  const NOW = new Date("2026-03-22T09:00:00.000Z");
  const BUDGETS = { OPEN: 7 * 24 * 3600_000, IN_REVIEW: 5 * 24 * 3600_000 };

  // The three branch tasks end in the hand-written states with
  // fixed-literal histories — no wall clock anywhere.
  assert.deepEqual(
    staleDwellTasks.map((t) => [t.id, t.state, t.history.length]),
    [
      ["DEMO-007", "OPEN", 1],
      ["DEMO-008", "IN_REVIEW", 5],
      ["DEMO-009", "OPEN", 1],
    ],
  );
  assert.deepEqual(
    staleDwellTasks[1].history.map((h) => [h.event, h.from, h.to, h.actor, h.at]),
    [
      ["PUBLISH", "DRAFT", "OPEN", "researcher", "2026-03-20T09:00:00.000Z"],
      ["ACCEPT", "OPEN", "ACCEPTED", "contributor", "2026-03-20T09:05:00.000Z"],
      ["START_CAPTURE", "ACCEPTED", "CAPTURING", "contributor", "2026-03-20T09:10:00.000Z"],
      ["SUBMIT", "CAPTURING", "SUBMITTED", "contributor", "2026-03-21T08:55:00.000Z"],
      ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW", "reviewer", "2026-03-21T09:00:00.000Z"],
    ],
  );
  // The dwell of each task (now minus its last entry's `at`) is the
  // hand-computed value written in the demo source.
  assert.deepEqual(
    staleDwellTasks.map(
      (t) => NOW.getTime() - Date.parse(t.history[t.history.length - 1].at),
    ),
    [1814400000, 86400000, 86400000],
  );
  assert.equal(staleDwellTasks[0].getSlaDeadline("OPEN"), "2026-03-25T09:00:00.000Z");
  assert.equal(staleDwellTasks[1].getSlaDeadline("IN_REVIEW"), "2026-03-21T12:00:00.000Z");
  assert.equal(staleDwellTasks[2].getSlaDeadline("OPEN"), undefined);
  // The two screens disagree on the same batch, exactly as the demo
  // source's hand-written expectations say: DEMO-007 is stale only,
  // DEMO-008 is overdue only, DEMO-009 is neither.
  assert.deepEqual(
    staleFound.map((t) => t.id),
    ["DEMO-007"],
  );
  assert.deepEqual(
    staleExpiredFound.map((t) => t.id),
    ["DEMO-008"],
  );
  assert.deepEqual(
    staleDwellTasks.map((t) => isOverdue(t, NOW)),
    [false, true, false],
  );
  // An independent re-screening of the returned tasks under the
  // same fixed now and budgets reproduces both subsets — the demo
  // segment is not self-certifying.
  assert.deepEqual(
    staleTasks(staleDwellTasks, BUDGETS, NOW).map((t) => t.id),
    ["DEMO-007"],
  );
  assert.deepEqual(
    expiredTasks(staleDwellTasks, NOW).map((t) => t.id),
    ["DEMO-008"],
  );
  // Screening is pure: the tasks keep their states and history
  // lengths after both screens ran inside the demo.
  assert.deepEqual(
    staleDwellTasks.map((t) => [t.state, t.history.length]),
    [
      ["OPEN", 1],
      ["IN_REVIEW", 5],
      ["OPEN", 1],
    ],
  );
  // The branch is printed after the subscription branch and before
  // the closing event-sourcing replay segment, with its lines
  // verbatim.
  const staleAt = text.indexOf("Stale-task dwell screening branch (three more tasks, dwell vs deadline):");
  assert.ok(
    staleAt > text.indexOf("Dispatch subscription branch (sixth task, in-process fan-out):"),
    "stale branch must follow the subscription branch",
  );
  assert.ok(
    text.indexOf("Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):") > staleAt,
    "event-sourcing segment must follow the stale branch",
  );
  assert.match(text, /screened at: 2026-03-22T09:00:00\.000Z \(fixed now; no wall clock\)/);
  assert.match(
    text,
    /DEMO-007: state OPEN, entered at 2026-03-01T09:00:00\.000Z, dwell 1814400000 ms \(21 days\) vs OPEN budget 604800000 ms -> stale: true, overdue: false/,
  );
  assert.match(
    text,
    /DEMO-008: state IN_REVIEW, entered at 2026-03-21T09:00:00\.000Z, dwell 86400000 ms \(1 day\) vs IN_REVIEW budget 432000000 ms -> stale: false, overdue: true/,
  );
  assert.match(
    text,
    /staleTasks\(\[DEMO-007, DEMO-008, DEMO-009\], budgets, 2026-03-22T09:00:00\.000Z\): DEMO-007 \(1 stale\)/,
  );
  assert.match(
    text,
    /expiredTasks\(\[DEMO-007, DEMO-008, DEMO-009\], 2026-03-22T09:00:00\.000Z\): DEMO-008 \(1 overdue\)/,
  );
  assert.match(text, /contrast: the two screens disagree on the same batch/);
});

test("demo stale-task segment is deterministic: two runs print byte-identical stale lines", async () => {
  const staleLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Stale-task dwell screening branch (three more tasks, dwell vs deadline):"),
      ls.indexOf("Approaching-deadline screening branch (four more tasks, warning window vs deadline):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = staleLines(a.lines);
  // Header + screened-at + budgets + (task header + 1 transition +
  // SLA line) + (task header + 5 transitions + SLA line) + (task
  // header + 1 transition + SLA line) + 3 dwell lines + stale line
  // + expired line + contrast line + purity line; every timestamp
  // in the segment is a fixed literal, so no normalization is
  // needed.
  assert.equal(segA.length, 23);
  assert.deepEqual(segA, staleLines(b.lines));
  assert.deepEqual(
    a.staleFound.map((t) => t.id),
    b.staleFound.map((t) => t.id),
  );
  assert.deepEqual(
    a.staleExpiredFound.map((t) => t.id),
    b.staleExpiredFound.map((t) => t.id),
  );
});

test("demo shows the approaching-deadline screening branch in-process: window bounds decide membership", async () => {
  const { approachingTasks, approachingFound, approachingOverdueFound, lines } =
    await runDemo();
  const text = lines.join("\n");
  const NOW = new Date("2026-03-22T09:00:00.000Z");
  const WINDOW_MS = 24 * 3600_000;

  // The four branch tasks end in the hand-written states with
  // fixed-literal histories — no wall clock anywhere.
  assert.deepEqual(
    approachingTasks.map((t) => [t.id, t.state, t.history.length]),
    [
      ["DEMO-046", "OPEN", 1],
      ["DEMO-047", "OPEN", 1],
      ["DEMO-048", "OPEN", 1],
      ["DEMO-049", "OPEN", 1],
    ],
  );
  assert.deepEqual(
    approachingTasks.map((t) => t.getSlaDeadline("OPEN")),
    [
      "2026-03-22T21:00:00.000Z",
      "2026-03-23T09:00:00.000Z",
      "2026-03-22T09:00:00.000Z",
      "2026-03-21T09:00:00.000Z",
    ],
  );
  // The half-open window (now, now + 24h] selects the in-window
  // task and the exact-upper-bound task, and nothing else: the
  // exact-lower-bound task is overdue instead of approaching.
  assert.deepEqual(
    approachingFound.map((t) => t.id),
    ["DEMO-046", "DEMO-047"],
  );
  assert.deepEqual(
    approachingOverdueFound.map((t) => t.id),
    ["DEMO-048", "DEMO-049"],
  );
  assert.deepEqual(
    approachingTasks.map((t) => isOverdue(t, NOW)),
    [false, false, true, true],
  );
  // An independent re-screening of the returned tasks under the
  // same fixed now and window reproduces both subsets — the demo
  // segment is not self-certifying.
  assert.deepEqual(
    tasksApproachingDeadline(approachingTasks, WINDOW_MS, NOW).map((t) => t.id),
    ["DEMO-046", "DEMO-047"],
  );
  assert.deepEqual(
    expiredTasks(approachingTasks, NOW).map((t) => t.id),
    ["DEMO-048", "DEMO-049"],
  );
  // Screening is pure: the tasks keep their states and history
  // lengths after both screens ran inside the demo.
  assert.deepEqual(
    approachingTasks.map((t) => [t.state, t.history.length]),
    [
      ["OPEN", 1],
      ["OPEN", 1],
      ["OPEN", 1],
      ["OPEN", 1],
    ],
  );
  // The branch is printed after the stale-task dwell screening
  // branch and before the stale-task batch execution branch, with
  // its lines verbatim.
  const approachingAt = text.indexOf(
    "Approaching-deadline screening branch (four more tasks, warning window vs deadline):",
  );
  assert.ok(
    approachingAt >
      text.indexOf("Stale-task dwell screening branch (three more tasks, dwell vs deadline):"),
    "approaching branch must follow the stale screening branch",
  );
  assert.ok(
    text.indexOf("Stale-task batch execution branch (actOnStaleTasks over four more tasks):") >
      approachingAt,
    "batch execution branch must follow the approaching branch",
  );
  assert.match(text, /screened at: 2026-03-22T09:00:00\.000Z \(fixed now; no wall clock\)/);
  assert.match(
    text,
    /window: \(now, now \+ 86400000 ms\] \(24 hours\) — lower bound exclusive, upper bound inclusive/,
  );
  assert.match(
    text,
    /DEMO-046: state OPEN, deadline 2026-03-22T21:00:00\.000Z -> approaching: true, overdue: false/,
  );
  assert.match(
    text,
    /DEMO-048: state OPEN, deadline 2026-03-22T09:00:00\.000Z -> approaching: false, overdue: true/,
  );
  assert.match(
    text,
    /tasksApproachingDeadline\(\[DEMO-046, DEMO-047, DEMO-048, DEMO-049\], 86400000, 2026-03-22T09:00:00\.000Z\): DEMO-046, DEMO-047 \(2 approaching\)/,
  );
  assert.match(
    text,
    /expiredTasks\(\[DEMO-046, DEMO-047, DEMO-048, DEMO-049\], 2026-03-22T09:00:00\.000Z\): DEMO-048, DEMO-049 \(2 overdue\)/,
  );
  assert.match(text, /contrast: the window's bounds decide membership/);
});

test("demo approaching-deadline segment is deterministic: two runs print byte-identical approaching lines", async () => {
  const approachingLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Approaching-deadline screening branch (four more tasks, warning window vs deadline):"),
      ls.indexOf("Stale-task batch execution branch (actOnStaleTasks over four more tasks):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = approachingLines(a.lines);
  // Header + screened-at + window + (task header + 1 transition +
  // SLA line) x 4 + 4 per-task lines + approaching line +
  // expired line + contrast line + purity line; every timestamp
  // in the segment is a fixed literal, so no normalization is
  // needed.
  assert.equal(segA.length, 23);
  assert.deepEqual(segA, approachingLines(b.lines));
  assert.deepEqual(
    a.approachingFound.map((t) => t.id),
    b.approachingFound.map((t) => t.id),
  );
  assert.deepEqual(
    a.approachingOverdueFound.map((t) => t.id),
    b.approachingOverdueFound.map((t) => t.id),
  );
});

test("demo shows the event-sourcing replay segment in-process: NDJSON export parses back and fromHistory rebuilds the same PAID task", async () => {
  const { task, ndjsonText, replayedTask, lines } = await runDemo();
  const text = lines.join("\n");

  // The export is the main task's full history: 12 NDJSON lines,
  // one canonical JSON entry per line, trailing newline, seq 1..12
  // in order.
  assert.ok(ndjsonText.endsWith("\n"));
  const ndjsonLines = ndjsonText.trimEnd().split("\n");
  assert.equal(ndjsonLines.length, 12);
  ndjsonLines.forEach((line, i) => {
    const entry = JSON.parse(line) as { seq: number };
    assert.equal(entry.seq, i + 1);
  });
  // Parsing the export back yields the original history entry for
  // entry (deep equality) — the export is not a lossy summary.
  assert.deepEqual(historyFromNdjson(ndjsonText), [...task.history]);
  // The replayed task matches the hand-written expectations: same
  // id, PAID terminal state, the full 12-entry history deep-equal
  // to the original's, last entry included.
  assert.equal(replayedTask.id, "DEMO-001");
  assert.equal(replayedTask.state, "PAID");
  assert.equal(replayedTask.isTerminal, true);
  assert.deepEqual([...replayedTask.history], [...task.history]);
  const last = replayedTask.history.at(-1)!;
  assert.deepEqual(
    [last.seq, last.event, last.from, last.to],
    [12, "PAYOUT_COMPLETE", "PAYOUT_PENDING", "PAID"],
  );
  // An independent replay of the parsed entries lands identically —
  // the demo segment is not self-certifying — and re-exporting the
  // replayed task reproduces the NDJSON byte for byte.
  const independent = TaskLifecycle.fromHistory("DEMO-001", historyFromNdjson(ndjsonText));
  assert.equal(independent.state, "PAID");
  assert.deepEqual([...independent.history], [...task.history]);
  assert.equal(historyToNdjson(replayedTask), ndjsonText);
  // The segment is printed after the reconciliation branch and
  // closes the demo, with every NDJSON line printed in full and
  // the replay lines verbatim.
  const replayAt = text.indexOf("Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):");
  assert.ok(
    replayAt > text.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):"),
    "event-sourcing segment must follow the reconciliation branch",
  );
  assert.match(
    text,
    /historyToNdjson\(DEMO-001\): 12 lines \(one JSON entry per line, trailing newline\)/,
  );
  for (const line of ndjsonLines) {
    assert.ok(text.includes(`  ${line}`), "every NDJSON line is printed in full");
  }
  assert.match(text, /historyFromNdjson: 12 entries parsed back/);
  assert.match(
    text,
    /TaskLifecycle\.fromHistory\(DEMO-001, entries\): state PAID, 12 history entries/,
  );
  assert.match(
    text,
    /replay matches the original \(state \+ full history\): true — last entry seq 12 PAYOUT_COMPLETE PAYOUT_PENDING -> PAID/,
  );
});

test("demo shows the pure replay() terminal-state derivation: the NDJSON round-tripped history feeds replay() and the three derivations agree", async () => {
  const { task, replayedTask, replayDerivedState, lines } = await runDemo();
  const text = lines.join("\n");

  // The pure function derives the terminal state with no instance
  // and no snapshot envelope: the hand-written expectation is PAID.
  assert.equal(replayDerivedState, "PAID");
  // Three-way cross-check: the pure function's derivation, the live
  // task's state, and the fromHistory-rebuilt task's state agree —
  // mutating any one of them turns this test red.
  assert.equal(replayDerivedState, task.state);
  assert.equal(replayDerivedState, replayedTask.state);
  // The derivation lines are printed verbatim, pinning the
  // three-way agreement and the empty-history DRAFT sentinel.
  assert.match(
    text,
    /replay\(parsedEntries\): pure function derives final state PAID — matches task\.state \(PAID\) and fromHistory state \(PAID\): true/,
  );
  assert.match(text, /replay\(\[\]\): empty history replays to the DRAFT sentinel \(no events yet\)/);
});

test("demo event-sourcing segment agrees across two runs once the main task's own varying values are normalized", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):") - 1,
      ls.indexOf("Allowed events by state (allowedEvents over all 13 states):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Blank separator + header + intro line + 12 NDJSON lines + the
  // parsed-count, fromHistory, match, replay-derivation, and
  // replay-sentinel lines.
  assert.equal(segA.length, 20);
  // The only varying values are the ones the main task already
  // varied on between any two runs: its wall-clock history
  // timestamps and the hash-chain links derived from them, both
  // replaced by normalize(). The segment itself reads no new wall
  // clock, no randomness, and no network.
  assert.equal(normalize(segA.join("\n")), normalize(segment(b.lines).join("\n")));
  assert.equal(a.replayedTask.state, "PAID");
  assert.equal(b.replayedTask.state, "PAID");
  assert.equal(a.ndjsonText.trimEnd().split("\n").length, 12);
  assert.equal(b.ndjsonText.trimEnd().split("\n").length, 12);
});

test("demo shows the fan-out delivery segment in-process: per-endpoint results in input order, one failure does not block the others, one shared eventId", async () => {
  const { fanoutResult, fanoutCalls, lines } = await runDemo();
  const text = lines.join("\n");

  // The aggregate outcome is exactly the hand-written expectation
  // from the demo source: billing and notifications succeed on
  // their first attempt; risk answers 500 on every attempt and
  // exhausts the default retry budget (3 attempts) — and its
  // failure neither blocks nor fails the other two.
  assert.deepEqual(fanoutResult.results, [
    { ok: true, attempts: 1, status: 200 },
    {
      ok: false,
      attempts: 3,
      status: 500,
      error: "server responded with status 500",
    },
    { ok: true, attempts: 1, status: 200 },
  ]);
  assert.equal(fanoutResult.delivered, 2);
  assert.equal(fanoutResult.failed, 1);
  // The wire record proves the delivery really happened through
  // the injected fake fetch: 5 calls in total (1 + 3 + 1), zero
  // real network. The first call per endpoint carries a
  // byte-identical body — one logical event: the shared fixed
  // eventId, the shared fixed `at`, the main task's settlement —
  // under three different signatures, each verifying only under
  // its own endpoint's demo secret.
  assert.equal(fanoutCalls.length, 5);
  const fanoutUrls = [
    "https://billing.example.com/hooks/payout",
    "https://risk.example.com/hooks/payout",
    "https://notifications.example.com/hooks/payout",
  ];
  const fanoutSecrets = [
    "demo-fanout-billing-secret-do-not-use-in-production",
    "demo-fanout-risk-secret-do-not-use-in-production",
    "demo-fanout-notifications-secret-do-not-use-in-production",
  ];
  const firsts = fanoutUrls.map((u) => fanoutCalls.find((c) => c.url === u)!);
  assert.ok(firsts.every((c) => c.body === firsts[0].body));
  const sharedPayload = JSON.parse(firsts[0].body) as {
    eventId: string;
    at: string;
    taskId: string;
  };
  assert.equal(sharedPayload.eventId, "evt_demo_fanout_001");
  assert.equal(sharedPayload.at, "2026-03-20T09:00:00.000Z");
  assert.equal(sharedPayload.taskId, "DEMO-001");
  assert.equal(new Set(firsts.map((c) => c.signature)).size, 3);
  firsts.forEach((c, i) => {
    assert.equal(verifyPayoutWebhook(c.body, c.signature, fanoutSecrets[i]), true);
    assert.equal(
      verifyPayoutWebhook(c.body, c.signature, fanoutSecrets[(i + 1) % 3]),
      false,
    );
  });
  // The failing endpoint's retries re-POST the identical signed
  // bytes (the same body and signature on all 3 attempts).
  const riskCalls = fanoutCalls.filter((c) => c.url === fanoutUrls[1]);
  assert.equal(riskCalls.length, 3);
  assert.ok(
    riskCalls.every(
      (c) => c.body === riskCalls[0].body && c.signature === riskCalls[0].signature,
    ),
  );
  // The segment is printed after the batch section and before the
  // reconciliation branch, with its lines verbatim (the shared
  // `at` is a fixed literal, printed as-is).
  const fanAt = text.indexOf(
    "Payout webhook fan-out delivery (deliverPayoutWebhookToMany to 3 endpoints, fake fetch — no real network):",
  );
  assert.ok(
    fanAt > text.indexOf("Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):"),
    "fan-out segment must follow the batch section",
  );
  assert.ok(
    text.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):") > fanAt,
    "reconciliation branch must follow the fan-out segment",
  );
  assert.match(
    text,
    /shared eventId: evt_demo_fanout_001, shared at: 2026-03-20T09:00:00\.000Z \(one logical event for all endpoints\)/,
  );
  assert.match(
    text,
    /billing \(https:\/\/billing\.example\.com\/hooks\/payout\): ok attempts=1 status=200/,
  );
  assert.match(
    text,
    /risk \(https:\/\/risk\.example\.com\/hooks\/payout\): FAILED attempts=3 status=500 error=server responded with status 500/,
  );
  assert.match(
    text,
    /notifications \(https:\/\/notifications\.example\.com\/hooks\/payout\): ok attempts=1 status=200/,
  );
  assert.match(
    text,
    /fan-out: 2 delivered, 1 failed — the failing endpoint did not block the others/,
  );
  assert.match(
    text,
    /shared event check: all endpoints received the same eventId evt_demo_fanout_001: true \(identical payload bytes, signed per endpoint with its own secret\)/,
  );
});

test("demo fan-out segment is deterministic: two runs print byte-identical fan-out lines and record identical wire calls", async () => {
  const fanLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout webhook fan-out delivery (deliverPayoutWebhookToMany to 3 endpoints, fake fetch — no real network):"),
      ls.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = fanLines(a.lines);
  // Header + shared line + 3 per-endpoint lines + summary line +
  // shared-event check line, plus the Retry-After segment that
  // now follows it (blank + header + fixed-now line + 6 corpus
  // lines + retry-context line); every value in either segment
  // is a fixed literal or derived from one (shared now / eventId,
  // per-endpoint demo secrets), so no normalization is needed.
  assert.equal(segA.length, 17);
  assert.deepEqual(segA, fanLines(b.lines));
  assert.deepEqual(a.fanoutCalls, b.fanoutCalls);
  assert.deepEqual(a.fanoutResult, b.fanoutResult);
});

test("demo shows the Retry-After parsing segment in-process: delay-seconds and HTTP-date forms normalize, past dates clamp, garbage and absent values fall back", async () => {
  const { retryAfterParsed, lines } = await runDemo();
  const text = lines.join("\n");
  const NOW_MS = Date.parse("2026-03-20T09:00:00.000Z");

  // The structured results are exactly the hand-written
  // expectations from the demo source for the fixed 6-value
  // corpus under the fan-out segment's shared instant.
  assert.deepEqual(retryAfterParsed, [2000, 30000, 5000, 0, undefined, undefined]);
  // An independent re-parse of the same hand-written corpus
  // under the same fixed now reproduces the same results — the
  // demo segment is not self-certifying.
  const corpus: Array<string | null> = [
    "2",
    "  30 ",
    new Date(NOW_MS + 5_000).toUTCString(),
    new Date(NOW_MS - 1_000).toUTCString(),
    "banana",
    null,
  ];
  assert.deepEqual(
    corpus.map((v) => parsePayoutRetryAfter(v, NOW_MS)),
    retryAfterParsed,
  );
  // The segment is printed after the fan-out segment and before
  // the reconciliation branch, with its lines verbatim (the
  // HTTP-date strings are exact literals: the fixed instant sits
  // on a whole second and toUTCString() has one-second
  // precision).
  const retryAt = text.indexOf("Payout Retry-After parsing (parsePayoutRetryAfter under a fixed now):");
  assert.ok(
    retryAt >
      text.indexOf("Payout webhook fan-out delivery (deliverPayoutWebhookToMany to 3 endpoints, fake fetch — no real network):"),
    "Retry-After segment must follow the fan-out segment",
  );
  assert.ok(
    text.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):") > retryAt,
    "reconciliation branch must follow the Retry-After segment",
  );
  assert.match(
    text,
    /fixed now: 2026-03-20T09:00:00\.000Z \(the fan-out segment's shared instant, reused as nowMs; no wall clock\)/,
  );
  assert.match(text, /parsePayoutRetryAfter\("2"\) -> 2000 ms/);
  assert.match(text, /parsePayoutRetryAfter\(" {2}30 "\) -> 30000 ms/);
  assert.match(
    text,
    /parsePayoutRetryAfter\("Fri, 20 Mar 2026 09:00:05 GMT"\) -> 5000 ms/,
  );
  assert.match(
    text,
    /parsePayoutRetryAfter\("Fri, 20 Mar 2026 08:59:59 GMT"\) -> 0 ms/,
  );
  assert.match(text, /parsePayoutRetryAfter\("banana"\) -> undefined/);
  assert.match(text, /parsePayoutRetryAfter\(null\) -> undefined/);
  assert.match(
    text,
    /retry context: the fan-out risk endpoint answered 500, so its retries used exponential backoff; had it answered 429 with a Retry-After header, the parsed wait above \(clamped to maxRetryDelayMs\) would have set the next attempt's delay/,
  );
});

test("demo Retry-After segment is deterministic: two runs print byte-identical parsing lines", async () => {
  const retryLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout Retry-After parsing (parsePayoutRetryAfter under a fixed now):"),
      ls.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = retryLines(a.lines);
  // Header + fixed-now line + 6 corpus lines + retry-context
  // line; every value is a fixed literal or derived from the
  // fan-out segment's fixed instant, so no normalization is
  // needed.
  assert.equal(segA.length, 9);
  assert.deepEqual(segA, retryLines(b.lines));
  assert.deepEqual(a.retryAfterParsed, b.retryAfterParsed);
});

test("demo shows the allowed-events listing segment in-process: every state's events match the hand-written table, cross-checked against the transition table", async () => {
  const { allowedEventsByState, mainTaskAllowedEvents, task, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // transition table, in declaration order, never derived by
  // calling allowedEvents itself. Terminal states (PAID /
  // ABANDONED / EXPIRED) expect the empty list.
  const EXPECTED: Array<{ state: string; events: string[] }> = [
    { state: "DRAFT", events: ["PUBLISH"] },
    { state: "OPEN", events: ["ACCEPT", "EXPIRE"] },
    { state: "ACCEPTED", events: ["START_CAPTURE", "ABANDON", "EXPIRE"] },
    { state: "CAPTURING", events: ["SUBMIT", "ABANDON", "EXPIRE"] },
    { state: "SUBMITTED", events: ["BEGIN_REVIEW", "EXPIRE"] },
    { state: "IN_REVIEW", events: ["APPROVE", "REJECT"] },
    { state: "APPROVED", events: ["REQUEST_PAYOUT"] },
    { state: "PAYOUT_PENDING", events: ["PAYOUT_COMPLETE"] },
    { state: "PAID", events: [] },
    { state: "REJECTED", events: ["DISPUTE", "RESUBMIT"] },
    { state: "DISPUTED", events: ["ARBITRATE_APPROVE", "ARBITRATE_REJECT"] },
    { state: "ABANDONED", events: [] },
    { state: "EXPIRED", events: [] },
  ];
  assert.deepEqual(allowedEventsByState, EXPECTED);
  // Cross-check against the transition table itself (the source
  // of the committed snapshot in test/__snapshots__): grouping
  // its edges by `from` must reproduce the same per-state lists —
  // the demo segment is not self-certifying.
  const fromTable = new Map<string, string[]>();
  for (const { from, event } of transitionTable()) {
    const list = fromTable.get(from) ?? [];
    list.push(event);
    fromTable.set(from, list);
  }
  for (const { state, events } of EXPECTED) {
    assert.deepEqual(events, fromTable.get(state) ?? [], `state ${state}`);
    assert.deepEqual(allowedEvents(state as never), events, `state ${state}`);
  }
  // The main task is PAID, so its own allowed set is the empty
  // list — the boundary the segment calls out on its own line.
  assert.equal(task.state, "PAID");
  assert.deepEqual(mainTaskAllowedEvents, []);
  // The segment follows the replay segment and is itself
  // followed by the standalone history parsing segment; it
  // prints every state line verbatim.
  const allowedAt = text.indexOf(
    "Allowed events by state (allowedEvents over all 13 states):",
  );
  assert.ok(
    allowedAt >
      text.indexOf(
        "Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):",
      ),
    "allowed-events segment must follow the replay segment",
  );
  assert.ok(
    text.indexOf(
      "Standalone history parsing (parseHistory on a fixed external history):",
    ) > allowedAt,
    "standalone history parsing segment must follow the allowed-events segment",
  );
  for (const { state, events } of EXPECTED) {
    const line =
      events.length > 0
        ? `  ${state.padEnd(15)} -> ${events.join(", ")}`
        : `  ${state.padEnd(15)} -> (none — terminal)`;
    assert.ok(text.includes(line), `missing listing line for ${state}`);
  }
  assert.ok(
    lines.includes(
      "  main task DEMO-001 (PAID): allowedEvents -> (none) — a terminal task offers no further events, so a task-list UI renders no actions for it",
    ),
  );
});

test("demo allowed-events segment is deterministic: two runs print byte-identical listing lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Allowed events by state (allowedEvents over all 13 states):"),
      ls.indexOf("Standalone history parsing (parseHistory on a fixed external history):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + 13 state lines + the main-task line; every value is
  // derived from the transition table alone, so no normalization
  // is needed.
  assert.equal(segA.length, 15);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.allowedEventsByState, b.allowedEventsByState);
  assert.deepEqual(a.mainTaskAllowedEvents, b.mainTaskAllowedEvents);
});

test("demo shows the standalone history parsing segment in-process: a fixed external history parses entry by entry, matches the main prefix, and a broken copy is rejected", async () => {
  const {
    parsedHistoryEntries,
    parsedHistoryMatchesMainPrefix,
    parsedHistoryInvalidRejected,
    parsedHistoryInvalidError,
    task,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — the fixed JSON corpus written out
  // here entry by entry, never derived by calling the demo.
  const EXPECTED_RAW = [
    { seq: 1, event: "PUBLISH", from: "DRAFT", to: "OPEN", at: "2026-03-23T09:00:00.000Z", actor: "system", note: "Researcher publishes the data-collection task" },
    { seq: 2, event: "ACCEPT", from: "OPEN", to: "ACCEPTED", at: "2026-03-23T09:05:00.000Z", actor: "contributor", note: "Contributor picks up the task" },
    { seq: 3, event: "START_CAPTURE", from: "ACCEPTED", to: "CAPTURING", at: "2026-03-23T09:10:00.000Z", actor: "contributor", note: "Data capture begins" },
    { seq: 4, event: "SUBMIT", from: "CAPTURING", to: "SUBMITTED", at: "2026-03-23T09:15:00.000Z", actor: "contributor", note: "Batch uploaded for QA" },
    { seq: 5, event: "BEGIN_REVIEW", from: "SUBMITTED", to: "IN_REVIEW", at: "2026-03-23T09:20:00.000Z", actor: "reviewer", note: "QA specialist starts review" },
  ];
  assert.deepEqual(parsedHistoryEntries, EXPECTED_RAW);
  // Cross-check by an independent parse of the same raw corpus —
  // the demo segment is not self-certifying.
  assert.deepEqual(parseHistory(EXPECTED_RAW), parsedHistoryEntries);
  assert.deepEqual(parseHistory(JSON.parse(JSON.stringify(EXPECTED_RAW))), parsedHistoryEntries);
  // The parsed chain equals the main task history's first 5 entries
  // on seq/event/from/to (the main history's timestamps and hashes
  // are its own; the chain is the shared part).
  assert.equal(parsedHistoryMatchesMainPrefix, true);
  assert.deepEqual(
    parsedHistoryEntries.map((e) => [e.seq, e.event, e.from, e.to]),
    task.history.slice(0, 5).map((h) => [h.seq, h.event, h.from, h.to]),
  );
  assert.equal(parsedHistoryEntries.at(-1)?.to, "IN_REVIEW");
  // The invalid copy is rejected outside the printed parse, with
  // the exact chain-break message, and the original parse is
  // untouched (re-parsing the good corpus still succeeds).
  assert.equal(parsedHistoryInvalidRejected, true);
  assert.equal(
    parsedHistoryInvalidError,
    "invalid history: entry[2]: from OPEN does not continue previous to ACCEPTED",
  );
  assert.throws(
    () =>
      parseHistory(
        EXPECTED_RAW.map((e, i) => (i === 2 ? { ...e, from: "OPEN" } : e)),
      ),
    /does not continue previous to/,
  );
  assert.deepEqual(parseHistory(EXPECTED_RAW), parsedHistoryEntries);
  // The segment follows the allowed-events segment, prints every
  // entry line verbatim, and is itself followed by the
  // transition-table JSON export segment.
  const parseAt = text.indexOf(
    "Standalone history parsing (parseHistory on a fixed external history):",
  );
  assert.ok(
    parseAt >
      text.indexOf("Allowed events by state (allowedEvents over all 13 states):"),
    "standalone history parsing segment must follow the allowed-events segment",
  );
  assert.ok(
    text.indexOf(
      "Transition table JSON export (transitionTableJson for front-end / docs tooling):",
    ) > parseAt,
    "transition-table JSON export segment must follow the standalone history parsing segment",
  );
  for (const e of EXPECTED_RAW) {
    assert.ok(
      text.includes(
        `  entry seq ${e.seq}: ${e.event} ${e.from} -> ${e.to} (actor ${e.actor}, at ${e.at})`,
      ),
      `missing parsed entry line for seq ${e.seq}`,
    );
  }
  assert.ok(
    text.includes(
      "  parsed: 5 entries, final state IN_REVIEW (last entry seq 5 BEGIN_REVIEW SUBMITTED -> IN_REVIEW)",
    ),
  );
  assert.ok(
    text.includes(
      "  matches DEMO-001 prefix: true (the parsed seq/event/from/to chain equals the main task history's first 5 entries)",
    ),
  );
  assert.ok(
    lines.includes(
      "  invalid copy: parseHistory FAILED — invalid history: entry[2]: from OPEN does not continue previous to ACCEPTED (a broken chain is rejected and the original parse is untouched)",
    ),
  );
});

test("demo standalone history parsing segment is deterministic: two runs print byte-identical parsing lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Standalone history parsing (parseHistory on a fixed external history):"),
      ls.indexOf("Transition table JSON export (transitionTableJson for front-end / docs tooling):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + source line + 5 entry lines + parsed / matches /
  // invalid lines; every value is a fixed literal, so no
  // normalization is needed.
  assert.equal(segA.length, 10);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.parsedHistoryEntries, b.parsedHistoryEntries);
  assert.equal(a.parsedHistoryMatchesMainPrefix, b.parsedHistoryMatchesMainPrefix);
  assert.equal(a.parsedHistoryInvalidError, b.parsedHistoryInvalidError);
});

test("demo shows the transition-table JSON export segment in-process: the parsed-back edges match the hand-written table and the committed snapshot", async () => {
  const { transitionTableJsonText, transitionTableEdges, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — the full 19-edge table written
  // out here in declaration order, never derived by calling
  // transitionTableJson itself.
  const EXPECTED = [
    { from: "DRAFT", event: "PUBLISH", to: "OPEN" },
    { from: "OPEN", event: "ACCEPT", to: "ACCEPTED" },
    { from: "OPEN", event: "EXPIRE", to: "EXPIRED" },
    { from: "ACCEPTED", event: "START_CAPTURE", to: "CAPTURING" },
    { from: "ACCEPTED", event: "ABANDON", to: "ABANDONED" },
    { from: "ACCEPTED", event: "EXPIRE", to: "EXPIRED" },
    { from: "CAPTURING", event: "SUBMIT", to: "SUBMITTED" },
    { from: "CAPTURING", event: "ABANDON", to: "ABANDONED" },
    { from: "CAPTURING", event: "EXPIRE", to: "EXPIRED" },
    { from: "SUBMITTED", event: "BEGIN_REVIEW", to: "IN_REVIEW" },
    { from: "SUBMITTED", event: "EXPIRE", to: "EXPIRED" },
    { from: "IN_REVIEW", event: "APPROVE", to: "APPROVED" },
    { from: "IN_REVIEW", event: "REJECT", to: "REJECTED" },
    { from: "APPROVED", event: "REQUEST_PAYOUT", to: "PAYOUT_PENDING" },
    { from: "PAYOUT_PENDING", event: "PAYOUT_COMPLETE", to: "PAID" },
    { from: "REJECTED", event: "DISPUTE", to: "DISPUTED" },
    { from: "REJECTED", event: "RESUBMIT", to: "CAPTURING" },
    { from: "DISPUTED", event: "ARBITRATE_APPROVE", to: "APPROVED" },
    { from: "DISPUTED", event: "ARBITRATE_REJECT", to: "REJECTED" },
  ];
  assert.deepEqual(transitionTableEdges, EXPECTED);
  // Cross-check against the committed snapshot file and the
  // library export itself — the demo segment is not
  // self-certifying.
  const snapshotText = readFileSync(
    path.join(repoRoot, "test", "__snapshots__", "transitionTable.snapshot.json"),
    "utf8",
  );
  assert.equal(transitionTableJsonText, snapshotText);
  assert.deepEqual(JSON.parse(snapshotText), transitionTableEdges);
  assert.equal(transitionTableJsonText, transitionTableJson());
  assert.deepEqual(transitionTable(), transitionTableEdges);
  // Canonical shape: trailing newline, and every edge carries
  // its keys in from, event, to order.
  assert.ok(transitionTableJsonText.endsWith("]\n"));
  for (const edge of transitionTableEdges) {
    assert.deepEqual(Object.keys(edge), ["from", "event", "to"]);
  }
  // The segment follows the standalone history parsing segment
  // and prints its summary lines verbatim; the state diagram
  // generation segment follows it (the README diagram sync
  // check segment now closes the demo after that).
  const exportAt = text.indexOf(
    "Transition table JSON export (transitionTableJson for front-end / docs tooling):",
  );
  assert.ok(
    exportAt >
      text.indexOf(
        "Standalone history parsing (parseHistory on a fixed external history):",
      ),
    "transition-table JSON export segment must follow the standalone history parsing segment",
  );
  for (const line of [
    "  transitionTableJson(): 19 edges as canonical JSON (2-space indent, trailing newline; parsed back: 19 edges)",
    "  first edge (index 0): DRAFT --PUBLISH--> OPEN",
    "  payout edge (index 14): PAYOUT_PENDING --PAYOUT_COMPLETE--> PAID",
    "  last edge (index 18): DISPUTED --ARBITRATE_REJECT--> REJECTED",
  ]) {
    assert.ok(text.includes(line), `missing export line: ${line}`);
  }
  assert.ok(
    lines.includes(
      "  key order per edge: from, event, to on every edge: true (the canonical field order a consumer can rely on)",
    ),
  );
  assert.ok(
    text.indexOf(
      "State diagram generation (stateDiagram from the transition table):",
    ) > exportAt,
    "state diagram generation segment must follow the transition-table JSON export segment",
  );
});

test("demo transition-table JSON export segment is deterministic: two runs print byte-identical export lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Transition table JSON export (transitionTableJson for front-end / docs tooling):"),
      ls.indexOf("State diagram generation (stateDiagram from the transition table):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + total / first / payout / last / key-order lines;
  // every value is derived from the transition table alone, so
  // no normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.transitionTableJsonText, b.transitionTableJsonText);
  assert.deepEqual(a.transitionTableEdges, b.transitionTableEdges);
});

test("demo shows the state diagram generation segment in-process: the generated block matches the hand-written diagram line by line", async () => {
  const { stateDiagramText, stateDiagramEdgeCount, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — the full 24-line Mermaid block
  // written out here line by line, never derived by calling
  // stateDiagram itself.
  const EXPECTED_LINES = [
    "```mermaid",
    "stateDiagram-v2",
    "    direction LR",
    "    [*] --> DRAFT",
    "    DRAFT --> OPEN : PUBLISH",
    "    OPEN --> ACCEPTED : ACCEPT",
    "    OPEN --> EXPIRED : EXPIRE",
    "    ACCEPTED --> CAPTURING : START_CAPTURE",
    "    ACCEPTED --> ABANDONED : ABANDON",
    "    ACCEPTED --> EXPIRED : EXPIRE",
    "    CAPTURING --> SUBMITTED : SUBMIT",
    "    CAPTURING --> ABANDONED : ABANDON",
    "    CAPTURING --> EXPIRED : EXPIRE",
    "    SUBMITTED --> IN_REVIEW : BEGIN_REVIEW",
    "    SUBMITTED --> EXPIRED : EXPIRE",
    "    IN_REVIEW --> APPROVED : APPROVE",
    "    IN_REVIEW --> REJECTED : REJECT",
    "    APPROVED --> PAYOUT_PENDING : REQUEST_PAYOUT",
    "    PAYOUT_PENDING --> PAID : PAYOUT_COMPLETE",
    "    REJECTED --> DISPUTED : DISPUTE",
    "    REJECTED --> CAPTURING : RESUBMIT",
    "    DISPUTED --> APPROVED : ARBITRATE_APPROVE",
    "    DISPUTED --> REJECTED : ARBITRATE_REJECT",
    "```",
  ];
  assert.deepEqual(stateDiagramText.split("\n"), EXPECTED_LINES);
  // The shape the backlog pins: first line is the mermaid fence,
  // the block carries the stateDiagram-v2 header, and the edge
  // count equals the transition-table snapshot's pinned 19.
  assert.equal(stateDiagramText.split("\n")[0], "```mermaid");
  assert.ok(stateDiagramText.includes("stateDiagram-v2"));
  assert.equal(stateDiagramEdgeCount, 19);
  assert.equal(stateDiagramEdgeCount, transitionTable().length);
  // Cross-check against the library generator itself and the
  // README-embedded copy — the demo segment is not
  // self-certifying.
  assert.equal(stateDiagramText, stateDiagram());
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.ok(readme.includes(stateDiagramText));
  // The segment follows the transition-table JSON export
  // segment and prints its summary lines verbatim; the README
  // diagram sync check segment follows it (the JSON snapshot
  // round-trip segment now closes the demo).
  const diagramAt = text.indexOf(
    "State diagram generation (stateDiagram from the transition table):",
  );
  assert.ok(
    diagramAt >
      text.indexOf(
        "Transition table JSON export (transitionTableJson for front-end / docs tooling):",
      ),
    "state diagram generation segment must follow the transition-table JSON export segment",
  );
  for (const line of [
    "  stateDiagram(): 24 lines, 19 edges (generated from transitionTable() — the Mermaid block the README embeds verbatim)",
    "  first line: ```mermaid",
    "  second line: stateDiagram-v2",
    "  initial transition (line 4): [*] --> DRAFT",
    "  first edge (line 5): DRAFT --> OPEN : PUBLISH",
    "  last edge (line 23): DISPUTED --> REJECTED : ARBITRATE_REJECT",
  ]) {
    assert.ok(text.includes(line), `missing diagram line: ${line}`);
  }
  assert.ok(lines.includes("  last line: ```"));
  assert.ok(
    text.indexOf(
      "README diagram sync check (readmeDiagramInSync on this repo's README):",
    ) > diagramAt,
    "README diagram sync check segment must follow the state diagram generation segment",
  );
});

test("demo state diagram generation segment is deterministic: two runs print byte-identical diagram lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("State diagram generation (stateDiagram from the transition table):"),
      ls.indexOf("README diagram sync check (readmeDiagramInSync on this repo's README):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + total / first / second / initial / first-edge /
  // last-edge / last lines; every value is derived from the
  // transition table alone, so no normalization is needed.
  assert.equal(segA.length, 8);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.stateDiagramText, b.stateDiagramText);
  assert.equal(a.stateDiagramEdgeCount, b.stateDiagramEdgeCount);
});

test("demo shows the README diagram sync check segment in-process: the verdict is the hand-pinned true", async () => {
  const { readmeDiagramInSync: demoSync, stateDiagramText, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-written expectation — written out here from the state
  // the test suite pins, never derived by calling
  // readmeDiagramInSync itself: exactly true.
  assert.equal(demoSync, true);
  // Cross-check against the library check itself and the
  // README-embedded copy — the demo segment is not
  // self-certifying.
  assert.equal(readmeDiagramInSync(), true);
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.ok(readme.includes(stateDiagramText));
  // The segment follows the state diagram generation segment
  // and prints its lines verbatim; the JSON snapshot round-trip
  // segment now closes the demo after it.
  const syncAt = text.indexOf(
    "README diagram sync check (readmeDiagramInSync on this repo's README):",
  );
  assert.ok(
    syncAt >
      text.indexOf(
        "State diagram generation (stateDiagram from the transition table):",
      ),
    "README diagram sync check segment must follow the state diagram generation segment",
  );
  for (const line of [
    "  readmeDiagramInSync(): true (README.md embeds the exact stateDiagram() block generated above — no diagram drift)",
    "  checked file: README.md (this repo only — the sole file read by the check; no network, no wall clock)",
  ]) {
    assert.ok(text.includes(line), `missing sync line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "JSON snapshot round-trip (toJSON/fromJSON on the main task):",
    ) > syncAt,
    "JSON snapshot round-trip segment must follow the README diagram sync check segment",
  );
});

test("demo README diagram sync check segment is deterministic: two runs print byte-identical sync lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("README diagram sync check (readmeDiagramInSync on this repo's README):"),
      ls.indexOf("JSON snapshot round-trip (toJSON/fromJSON on the main task):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + verdict / checked-file / CLI-equivalent lines;
  // every value is the pinned in-sync verdict, so no
  // normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.readmeDiagramInSync, b.readmeDiagramInSync);
});

test("CLI entry point still runs as a subprocess and prints the same golden output", async () => {
  const out = execFileSync(
    "node",
    [path.join(repoRoot, "dist", "src", "demo.js")],
    { encoding: "utf8" },
  );

  assert.equal(out.trimEnd().split("\n").length, 512);
  assert.equal(normalize(out.trimEnd()), GOLDEN_DEMO_OUTPUT);
  assert.match(out, /Task DEMO-001: DRAFT/);
  assert.match(out, /verifyPayoutWebhook: ok/);
});

test("demo shows the stale-task batch execution branch in-process: the unactionable stale task fails in isolation and the rest of the batch is still acted on", async () => {
  const { staleActionTasks, staleActionResults, lines } = await runDemo();
  const text = lines.join("\n");
  const NOW = new Date("2026-03-22T09:00:00.000Z");
  const BUDGETS = {
    ACCEPTED: 7 * 24 * 3600_000,
    CAPTURING: 7 * 24 * 3600_000,
    SUBMITTED: 7 * 24 * 3600_000,
  };

  // Final states and history lengths are the hand-written
  // expectations: the failed task is untouched, the two actionable
  // stale tasks gained exactly one ABANDON entry each (dispatched
  // by the watchdog at the fixed execution instant), and the fresh
  // task was never attempted.
  assert.deepEqual(
    staleActionTasks.map((t) => [t.id, t.state, t.history.length]),
    [
      ["DEMO-010", "SUBMITTED", 4],
      ["DEMO-011", "ABANDONED", 3],
      ["DEMO-012", "ABANDONED", 4],
      ["DEMO-013", "ACCEPTED", 2],
    ],
  );
  for (const t of [staleActionTasks[1], staleActionTasks[2]]) {
    const last = t.history.at(-1)!;
    assert.deepEqual([last.event, last.to, last.actor, last.at], [
      "ABANDON",
      "ABANDONED",
      "watchdog",
      "2026-03-22T09:00:00.000Z",
    ]);
  }
  assert.equal(staleActionTasks[0].history.at(-1)!.event, "SUBMIT");
  // One result per attempted task, in batch order: the SUBMITTED
  // failure comes first and does not block the two successes.
  assert.deepEqual(
    staleActionResults.map((r) => [r.task.id, r.acted, r.error]),
    [
      ["DEMO-010", false, "invalid transition: ABANDON from SUBMITTED"],
      ["DEMO-011", true, undefined],
      ["DEMO-012", true, undefined],
    ],
  );
  // An independent batch rebuilt from hand-written histories and
  // run through actOnStaleTasks under the same fixed now, budgets
  // and action reproduces the same outcomes — the demo segment is
  // not self-certifying.
  const rebuild = (
    id: string,
    steps: Array<[string, string, string, string]>,
  ): TaskLifecycle =>
    TaskLifecycle.fromHistory(
      id,
      steps.map(([event, from, to, at], i) => ({
        seq: i + 1,
        event: event as never,
        from: from as never,
        to: to as never,
        at,
        actor: "system",
      })),
    );
  const independent = [
    rebuild("DEMO-010", [
      ["PUBLISH", "DRAFT", "OPEN", "2026-03-02T09:00:00.000Z"],
      ["ACCEPT", "OPEN", "ACCEPTED", "2026-03-02T09:05:00.000Z"],
      ["START_CAPTURE", "ACCEPTED", "CAPTURING", "2026-03-02T09:10:00.000Z"],
      ["SUBMIT", "CAPTURING", "SUBMITTED", "2026-03-10T09:00:00.000Z"],
    ]),
    rebuild("DEMO-011", [
      ["PUBLISH", "DRAFT", "OPEN", "2026-03-01T09:00:00.000Z"],
      ["ACCEPT", "OPEN", "ACCEPTED", "2026-03-05T09:00:00.000Z"],
    ]),
    rebuild("DEMO-012", [
      ["PUBLISH", "DRAFT", "OPEN", "2026-03-01T09:00:00.000Z"],
      ["ACCEPT", "OPEN", "ACCEPTED", "2026-03-01T09:05:00.000Z"],
      ["START_CAPTURE", "ACCEPTED", "CAPTURING", "2026-03-08T09:00:00.000Z"],
    ]),
    rebuild("DEMO-013", [
      ["PUBLISH", "DRAFT", "OPEN", "2026-03-21T08:55:00.000Z"],
      ["ACCEPT", "OPEN", "ACCEPTED", "2026-03-21T09:00:00.000Z"],
    ]),
  ];
  const independentResults = actOnStaleTasks(
    independent,
    (t) => t.dispatch("ABANDON", { actor: "watchdog", at: NOW.toISOString() }),
    BUDGETS,
    NOW,
  );
  assert.deepEqual(
    independentResults.map((r) => [r.task.id, r.acted, r.error]),
    staleActionResults.map((r) => [r.task.id, r.acted, r.error]),
  );
  assert.deepEqual(
    independent.map((t) => t.state),
    staleActionTasks.map((t) => t.state),
  );
  // The branch is printed after the dwell screening branch and
  // before the closing event-sourcing replay segment, with its
  // lines verbatim.
  const execAt = text.indexOf("Stale-task batch execution branch (actOnStaleTasks over four more tasks):");
  assert.ok(
    execAt > text.indexOf("Stale-task dwell screening branch (three more tasks, dwell vs deadline):"),
    "execution branch must follow the dwell screening branch",
  );
  assert.ok(
    text.indexOf("Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):") > execAt,
    "event-sourcing segment must follow the execution branch",
  );
  assert.match(text, /executed at: 2026-03-22T09:00:00\.000Z \(fixed now; no wall clock\)/);
  assert.match(
    text,
    /DEMO-010: acted=false error="invalid transition: ABANDON from SUBMITTED" -> state SUBMITTED \(left untouched — the failure is isolated\)/,
  );
  assert.match(text, /DEMO-013: not stale at the fixed now \(dwell 86400000 ms \(1 day\)/);
  assert.match(
    text,
    /execution: 3 attempted, 2 acted, 1 failed — one unactionable stale task never blocks the rest of the batch/,
  );
});

test("demo stale-task execution segment is deterministic: two runs print byte-identical execution lines", async () => {
  const execLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Stale-task batch execution branch (actOnStaleTasks over four more tasks):"),
      ls.indexOf("SLA watchdog batch execution branch (expireOverdueTasks over a rebuilt SLA batch):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = execLines(a.lines);
  // Header + executed-at + budgets + (task header + 4 transitions)
  // + (task header + 2 transitions) + (task header + 3 transitions)
  // + (task header + 2 transitions) + 3 result lines + the
  // not-stale line + the execution summary; every timestamp in the
  // segment is a fixed literal, so no normalization is needed.
  assert.equal(segA.length, 23);
  assert.deepEqual(segA, execLines(b.lines));
  assert.deepEqual(
    a.staleActionResults.map((r) => [r.task.id, r.acted, r.error]),
    b.staleActionResults.map((r) => [r.task.id, r.acted, r.error]),
  );
});

test("demo shows the SLA watchdog batch execution branch in-process: screening subset equals the acted set, the not-yet-overdue task has no result entry", async () => {
  const {
    expireExecutionTasks,
    expireExecutionFound,
    expireExecutionResults,
    lines,
  } = await runDemo();
  const text = lines.join("\n");
  const NOW = new Date("2026-03-06T09:00:00.000Z");

  // Final states and history lengths are the hand-written
  // expectations: both overdue tasks gained exactly one EXPIRE
  // entry, and the fresh task was never attempted.
  assert.deepEqual(
    expireExecutionTasks.map((t) => [t.id, t.state, t.history.length]),
    [
      ["DEMO-014", "EXPIRED", 3],
      ["DEMO-015", "EXPIRED", 2],
      ["DEMO-016", "ACCEPTED", 2],
    ],
  );
  // The executor's EXPIRE entries carry the library defaults for `at`
  // (wall-clock) but are always signed `actor: "system"` — watchdog-driven
  // expiry must stay distinguishable from a human one — so the test pins
  // event/from/to/actor, never those entries' wall-clock `at`.
  assert.deepEqual(
    expireExecutionTasks.slice(0, 2).map((t) => {
      const last = t.history.at(-1)!;
      return [last.event, last.from, last.to, last.actor];
    }),
    [
      ["EXPIRE", "ACCEPTED", "EXPIRED", "system"],
      ["EXPIRE", "OPEN", "EXPIRED", "system"],
    ],
  );
  assert.equal(
    expireExecutionTasks[2].history.at(-1)!.event,
    "ACCEPT",
  );
  // The deadlines are the fixed literals from the demo source:
  // DEMO-014 mirrors DEMO-002's ACCEPTED deadline exactly.
  assert.equal(
    expireExecutionTasks[0].getSlaDeadline("ACCEPTED"),
    "2026-03-03T09:00:00.000Z",
  );
  assert.equal(
    expireExecutionTasks[1].getSlaDeadline("OPEN"),
    "2026-03-04T09:00:00.000Z",
  );
  assert.equal(
    expireExecutionTasks[2].getSlaDeadline("ACCEPTED"),
    "2026-03-10T09:00:00.000Z",
  );
  // Screening subset (captured before execution) and the
  // executor's per-task results agree exactly: one entry per
  // screened task, in batch order, both expired — and no entry
  // at all for DEMO-016.
  assert.deepEqual(
    expireExecutionFound.map((t) => t.id),
    ["DEMO-014", "DEMO-015"],
  );
  assert.deepEqual(
    expireExecutionResults.map((r) => [r.task.id, r.expired, r.error]),
    [
      ["DEMO-014", true, undefined],
      ["DEMO-015", true, undefined],
    ],
  );
  // An independent batch driven from the same fixed literals and
  // run through expiredTasks + expireOverdueTasks under the same
  // fixed now reproduces the same subsets and outcomes — the
  // demo segment is not self-certifying.
  const drive = (
    id: string,
    steps: Array<[string, string]>,
    deadline: string,
    deadlineState?: "OPEN" | "ACCEPTED",
  ): TaskLifecycle => {
    const t = new TaskLifecycle(id);
    for (const [event, at] of steps) {
      t.dispatch(event as never, { actor: "system", at });
    }
    t.setSlaDeadline(deadline, deadlineState);
    return t;
  };
  const independent = [
    drive(
      "DEMO-014",
      [
        ["PUBLISH", "2026-03-01T09:00:00.000Z"],
        ["ACCEPT", "2026-03-01T09:05:00.000Z"],
      ],
      "2026-03-03T09:00:00.000Z",
    ),
    drive(
      "DEMO-015",
      [["PUBLISH", "2026-03-02T09:00:00.000Z"]],
      "2026-03-04T09:00:00.000Z",
      "OPEN",
    ),
    drive(
      "DEMO-016",
      [
        ["PUBLISH", "2026-03-01T09:00:00.000Z"],
        ["ACCEPT", "2026-03-01T09:05:00.000Z"],
      ],
      "2026-03-10T09:00:00.000Z",
    ),
  ];
  assert.deepEqual(
    expiredTasks(independent, NOW).map((t) => t.id),
    ["DEMO-014", "DEMO-015"],
  );
  const independentResults = expireOverdueTasks(independent, NOW);
  assert.deepEqual(
    independentResults.map((r) => [r.task.id, r.expired, r.error]),
    expireExecutionResults.map((r) => [r.task.id, r.expired, r.error]),
  );
  assert.deepEqual(
    independent.map((t) => t.state),
    expireExecutionTasks.map((t) => t.state),
  );
  // The branch is printed after the stale-task batch execution
  // branch and before the closing event-sourcing replay segment,
  // with its lines verbatim.
  const execAt = text.indexOf("SLA watchdog batch execution branch (expireOverdueTasks over a rebuilt SLA batch):");
  assert.ok(
    execAt > text.indexOf("Stale-task batch execution branch (actOnStaleTasks over four more tasks):"),
    "SLA execution branch must follow the stale execution branch",
  );
  assert.ok(
    text.indexOf("Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):") > execAt,
    "event-sourcing segment must follow the SLA execution branch",
  );
  assert.match(text, /executed at: 2026-03-06T09:00:00\.000Z \(the SLA branch's fixed screening now, reused; no new screening instant\)/);
  assert.match(
    text,
    /expiredTasks\(\[DEMO-014, DEMO-015, DEMO-016\], 2026-03-06T09:00:00\.000Z\): DEMO-014, DEMO-015 \(2 overdue\)/,
  );
  assert.match(text, /DEMO-014: expired=true -> state EXPIRED \(EXPIRE dispatched by the executor\)/);
  assert.match(text, /DEMO-015: expired=true -> state EXPIRED \(EXPIRE dispatched by the executor\)/);
  assert.match(
    text,
    /DEMO-016: not overdue at the fixed now \(deadline 2026-03-10T09:00:00\.000Z still ahead\) -> no result entry, untouched in ACCEPTED/,
  );
  assert.match(
    text,
    /screening vs execution: expiredTasks subset \[DEMO-014, DEMO-015\] == expireOverdueTasks acted set \[DEMO-014, DEMO-015\]: true \(same tasks, same batch order\)/,
  );
  assert.match(
    text,
    /execution: 2 attempted, 2 expired, 0 failed — the not-yet-overdue task was never attempted/,
  );
});

test("demo SLA watchdog execution segment is deterministic in its printed lines: two runs print byte-identical execution lines", async () => {
  const execLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("SLA watchdog batch execution branch (expireOverdueTasks over a rebuilt SLA batch):"),
      ls.indexOf("Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = execLines(a.lines);
  // Header + executed-at + rebuilt note + (task header + 2
  // transitions + deadline line) + (task header + 1 transition +
  // deadline line) + (task header + 2 transitions + deadline
  // line) + screening line + 2 result lines + the not-overdue
  // line + the consistency line + the execution summary; every
  // printed value is a fixed literal or derived from one — the
  // executor's own wall-clock audit timestamps are never
  // printed — so no normalization is needed.
  assert.equal(segA.length, 20);
  assert.deepEqual(segA, execLines(b.lines));
  assert.deepEqual(
    a.expireExecutionResults.map((r) => [r.task.id, r.expired, r.error]),
    b.expireExecutionResults.map((r) => [r.task.id, r.expired, r.error]),
  );
  assert.deepEqual(
    a.expireExecutionFound.map((t) => t.id),
    b.expireExecutionFound.map((t) => t.id),
  );
});

test("demo shows the JSON snapshot round-trip segment in-process: state, history and used RESUBMIT count survive toJSON/fromJSON", async () => {
  const {
    task,
    snapshotJsonText,
    snapshotBytes,
    restoredTask,
    snapshotResubmitUsed,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the main
  // task's construction (DEMO-001, maxResubmits 2, the 12-step
  // chain with exactly one RESUBMIT), never derived by calling
  // toJSON/fromJSON themselves: the serialized snapshot is
  // exactly 3838 bytes on every run, because the only varying
  // fields (wall-clock timestamps and the hashes over them)
  // are fixed-length.
  assert.equal(snapshotBytes, 3838);
  assert.equal(snapshotJsonText.length, 3838);
  assert.equal(new TextEncoder().encode(snapshotJsonText).length, 3838);
  const snapshot = JSON.parse(snapshotJsonText) as {
    v?: number;
    id: string;
    state: string;
    history: unknown[];
    slaDeadlines: Record<string, string>;
    maxResubmits?: number;
  };
  assert.equal(snapshot.v, 1);
  assert.equal(snapshot.id, "DEMO-001");
  assert.equal(snapshot.state, "PAID");
  assert.equal(snapshot.history.length, 12);
  assert.deepEqual(snapshot.slaDeadlines, {});
  assert.equal(snapshot.maxResubmits, 2);
  // The restored task matches the original on every surface the
  // backlog pins: id, state, the full history entry for entry,
  // and an identical re-export (the fixed point): deep-equal
  // content at the same serialized length. The JSON text is
  // not string-identical — fromJSON rebuilds history entries
  // in canonical field order — so the test pins content, not
  // key order.
  assert.equal(restoredTask.id, "DEMO-001");
  assert.equal(restoredTask.state, "PAID");
  assert.equal(restoredTask.isTerminal, true);
  assert.deepEqual(restoredTask.history, task.history);
  assert.deepEqual(restoredTask.toJSON(), task.toJSON());
  assert.equal(
    new TextEncoder().encode(JSON.stringify(restoredTask.toJSON())).length,
    3838,
  );
  // The used RESUBMIT count is the history-derived count on
  // both sides: exactly 1 of the demo's budget of 2.
  assert.equal(snapshotResubmitUsed, 1);
  assert.equal(
    task.history.filter((h) => h.event === "RESUBMIT").length,
    1,
  );
  assert.equal(
    restoredTask.history.filter((h) => h.event === "RESUBMIT").length,
    1,
  );
  // An independent round-trip built in the test from the
  // returned task reproduces the same snapshot — the demo
  // segment is not self-certifying.
  const independent = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(task.toJSON())) as unknown,
  );
  assert.deepEqual(independent.toJSON(), task.toJSON());
  assert.deepEqual(independent.history, task.history);
  // The segment follows the README diagram sync check segment
  // and prints its lines verbatim; the single-task payout
  // reconciliation detail segment follows it.
  const snapAt = text.indexOf(
    "JSON snapshot round-trip (toJSON/fromJSON on the main task):",
  );
  assert.ok(
    snapAt >
      text.indexOf(
        "README diagram sync check (readmeDiagramInSync on this repo's README):",
      ),
    "JSON snapshot round-trip segment must follow the README diagram sync check segment",
  );
  assert.ok(
    text.indexOf(
      "Single-task payout reconciliation detail (payoutMismatch on the screened tasks):",
    ) > snapAt,
    "single-task payout reconciliation detail segment must follow the JSON snapshot round-trip segment",
  );
  for (const line of [
    "  toJSON(): snapshot v1 for DEMO-001 — state PAID, 12 history entries, maxResubmits 2 stored (the finite budget travels in the envelope; the used count is derived from the history, never stored)",
    "  serialized: 3838 bytes (JSON.stringify of the snapshot — the detached plain-JSON form a document store persists)",
    "  TaskLifecycle.fromJSON(parsed snapshot): state PAID, 12 history entries — state and full history match the original: true (entry for entry, hashes included)",
    "  RESUBMIT budget: 1 of 2 used before and after the round-trip (derived from the history on both sides)",
    "  fixed point: re-exporting the restored task yields the identical snapshot content (3838 bytes; fromJSON normalizes history-entry key order — values and hashes unchanged) — a second round-trip changes nothing",
  ]) {
    assert.ok(text.includes(line), `missing snapshot line: ${line}`);
  }
});

test("demo JSON snapshot round-trip segment is deterministic: two runs print byte-identical snapshot lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("JSON snapshot round-trip (toJSON/fromJSON on the main task):"),
      ls.indexOf("Single-task payout reconciliation detail (payoutMismatch on the screened tasks):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + toJSON / serialized / fromJSON / budget /
  // fixed-point lines; the snapshot text itself differs
  // between runs (wall-clock timestamps), but every printed
  // value is a hand-pinned constant or a fixed-length-derived
  // byte count, so the printed segment is byte-identical.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.snapshotBytes, b.snapshotBytes);
  assert.equal(a.snapshotResubmitUsed, b.snapshotResubmitUsed);
  assert.equal(a.restoredTask.state, b.restoredTask.state);
});

test("demo shows the single-task payout reconciliation detail segment in-process: the mismatched task's detail and the settled task's undefined", async () => {
  const {
    mismatchedTask,
    unreconciledTask,
    payoutMismatchDetail,
    payoutMismatchSettled,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // reconciliation branch's fixed literals (DEMO-005 ACCEPT
  // quotedAmount 4000, PAYOUT_COMPLETE payoutAmount 3750.5;
  // DEMO-004 quoted 2500, paid 2500), never derived by calling
  // payoutMismatch itself: delta = 3750.5 - 4000 = -249.5.
  assert.deepEqual(payoutMismatchDetail, {
    quoted: 4000,
    paid: 3750.5,
    delta: -249.5,
  });
  assert.equal(payoutMismatchSettled, undefined);
  // An independent call on the returned tasks reproduces both
  // shapes — the demo segment is not self-certifying — and the
  // helper is pure: both tasks stay PAID with their histories
  // untouched.
  assert.deepEqual(payoutMismatch(mismatchedTask), {
    quoted: 4000,
    paid: 3750.5,
    delta: -249.5,
  });
  assert.equal(payoutMismatch(unreconciledTask), undefined);
  assert.equal(mismatchedTask.state, "PAID");
  assert.equal(mismatchedTask.history.length, 8);
  assert.equal(unreconciledTask.state, "PAID");
  assert.equal(unreconciledTask.history.length, 8);
  // The segment follows the JSON snapshot round-trip segment
  // and prints its lines verbatim; the snapshot version
  // envelope segment follows it.
  const detailAt = text.indexOf(
    "Single-task payout reconciliation detail (payoutMismatch on the screened tasks):",
  );
  assert.ok(
    detailAt >
      text.indexOf("JSON snapshot round-trip (toJSON/fromJSON on the main task):"),
    "single-task payout reconciliation detail segment must follow the JSON snapshot round-trip segment",
  );
  assert.ok(
    text.indexOf(
      "Snapshot version envelope (SNAPSHOT_VERSION on the main task snapshot):",
    ) > detailAt,
    "snapshot version envelope segment must follow the single-task payout reconciliation detail segment",
  );
  for (const line of [
    "  DEMO-005: payoutMismatch -> quoted 4000, paid 3750.5, delta -249.5 (underpaid by 249.5 — the batch screen's one mismatched hit, opened up per task)",
    "  DEMO-004: payoutMismatch -> undefined (quoted 2500, paid 2500 — settled exactly as quoted, so there is no mismatch to report)",
  ]) {
    assert.ok(text.includes(line), `missing payout detail line: ${line}`);
  }
});

test("demo single-task payout reconciliation detail segment is deterministic: two runs print byte-identical detail lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Single-task payout reconciliation detail (payoutMismatch on the screened tasks):"),
      ls.indexOf("Snapshot version envelope (SNAPSHOT_VERSION on the main task snapshot):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + DEMO-005 detail / DEMO-004 undefined / reading
  // lines; every value is a fixed literal from the
  // reconciliation branch, so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.payoutMismatchDetail, b.payoutMismatchDetail);
  assert.equal(a.payoutMismatchSettled, b.payoutMismatchSettled);
});

test("demo shows the snapshot version envelope segment in-process: current version, future-version rejection, original still restores", async () => {
  const {
    task,
    snapshotVersion,
    snapshotVersionFutureError,
    snapshotVersionRestoredState,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // snapshotVersion tests and the parser source, never derived
  // by calling fromJSON itself: SNAPSHOT_VERSION is 1, the main
  // snapshot carries v 1, and a v: 2 copy is rejected with
  // exactly the version error.
  assert.equal(SNAPSHOT_VERSION, 1);
  assert.equal(snapshotVersion, 1);
  assert.equal(task.toJSON().v, 1);
  assert.equal(
    snapshotVersionFutureError,
    "invalid snapshot: unsupported snapshot version 2",
  );
  assert.equal(snapshotVersionRestoredState, "PAID");
  // Independent checks built in the test — the demo segment is
  // not self-certifying: the v: 2 copy throws the same error,
  // and the original snapshot restores the task in full.
  assert.throws(
    () => TaskLifecycle.fromJSON({ ...task.toJSON(), v: 2 }),
    /invalid snapshot: unsupported snapshot version 2/,
  );
  const independent = TaskLifecycle.fromJSON(task.toJSON());
  assert.equal(independent.id, "DEMO-001");
  assert.equal(independent.state, "PAID");
  assert.deepEqual(independent.history, task.history);
  // The segment follows the single-task payout
  // reconciliation detail segment and prints its lines
  // verbatim; the note length limit segment follows it.
  const versionAt = text.indexOf(
    "Snapshot version envelope (SNAPSHOT_VERSION on the main task snapshot):",
  );
  assert.ok(
    versionAt >
      text.indexOf(
        "Single-task payout reconciliation detail (payoutMismatch on the screened tasks):",
      ),
    "snapshot version envelope segment must follow the single-task payout reconciliation detail segment",
  );
  assert.ok(
    text.indexOf("Note length limit (MAX_NOTE_LENGTH on dispatch notes):") >
      versionAt,
    "note length limit segment must follow the snapshot version envelope segment",
  );
  for (const line of [
    "  toJSON(): snapshot v is 1 — equals SNAPSHOT_VERSION 1 (the current snapshot schema version written on every export)",
    "  future version: TaskLifecycle.fromJSON(snapshot with v: 2) rejected — invalid snapshot: unsupported snapshot version 2 (a future format is refused, not silently misread)",
    "  original snapshot: TaskLifecycle.fromJSON(snapshot with v: 1) still restores DEMO-001 in state PAID (the rejection touched only the detached copy)",
  ]) {
    assert.ok(text.includes(line), `missing snapshot version line: ${line}`);
  }
});

test("demo snapshot version envelope segment is deterministic: two runs print byte-identical version lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Snapshot version envelope (SNAPSHOT_VERSION on the main task snapshot):"),
      ls.indexOf("Note length limit (MAX_NOTE_LENGTH on dispatch notes):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + current-version / future-rejection /
  // original-restores lines; every value is a hand-pinned
  // constant, so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.snapshotVersion, b.snapshotVersion);
  assert.equal(a.snapshotVersionFutureError, b.snapshotVersionFutureError);
  assert.equal(a.snapshotVersionRestoredState, b.snapshotVersionRestoredState);
});

test("demo shows the note length limit segment in-process: boundary note accepted, over-limit note rejected with no trace", async () => {
  const {
    noteLimitTask,
    noteLengthLimit,
    noteLimitBoundaryLength,
    noteLimitOverLength,
    noteLimitError,
    noteLimitStateAfter,
    noteLimitHistoryLengthAfter,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // taskLifecycle source and the actor/note hardening tests,
  // never derived by calling dispatch itself: MAX_NOTE_LENGTH
  // is 32768, the boundary note is accepted, and the
  // 32769-character note is rejected with exactly the length
  // error, leaving state and history untouched.
  assert.equal(MAX_NOTE_LENGTH, 32768);
  assert.equal(noteLengthLimit, 32768);
  assert.equal(noteLimitBoundaryLength, 32768);
  assert.equal(noteLimitOverLength, 32769);
  assert.equal(
    noteLimitError,
    "invalid dispatch options: note must be at most 32768 characters, got 32769",
  );
  assert.equal(noteLimitStateAfter, "OPEN");
  assert.equal(noteLimitHistoryLengthAfter, 1);
  assert.equal(noteLimitTask.id, "DEMO-017");
  assert.equal(noteLimitTask.state, "OPEN");
  assert.equal(noteLimitTask.history.length, 1);
  assert.equal(noteLimitTask.history[0].event, "PUBLISH");
  assert.equal(noteLimitTask.history[0].seq, 1);
  assert.equal(noteLimitTask.history[0].at, "2026-03-23T09:00:00.000Z");
  assert.equal(noteLimitTask.history[0].note?.length, 32768);
  // Independent checks built in the test — the demo segment is
  // not self-certifying: a fresh task accepts the boundary
  // note and rejects the over-limit note the same way.
  const independent = new TaskLifecycle("note-limit-check");
  independent.dispatch("PUBLISH", {
    actor: "researcher",
    note: "x".repeat(32768),
    at: "2026-03-23T09:00:00.000Z",
  });
  assert.equal(independent.history[0].note?.length, 32768);
  assert.throws(
    () =>
      independent.dispatch("ACCEPT", {
        actor: "contributor",
        note: "x".repeat(32769),
        at: "2026-03-23T09:05:00.000Z",
      }),
    /invalid dispatch options: note must be at most 32768 characters, got 32769/,
  );
  assert.equal(independent.state, "OPEN");
  assert.equal(independent.history.length, 1);
  // The segment follows the snapshot version envelope
  // segment and prints its lines verbatim; the standalone
  // overdue judgement segment follows it. The long notes
  // themselves are never printed — only lengths.
  const limitAt = text.indexOf(
    "Note length limit (MAX_NOTE_LENGTH on dispatch notes):",
  );
  assert.ok(
    limitAt >
      text.indexOf(
        "Snapshot version envelope (SNAPSHOT_VERSION on the main task snapshot):",
      ),
    "note length limit segment must follow the snapshot version envelope segment",
  );
  assert.ok(
    text.indexOf("Standalone overdue judgement (isOverdue on fixed tasks):") >
      limitAt,
    "standalone overdue judgement segment must follow the note length limit segment",
  );
  for (const line of [
    "  limit: MAX_NOTE_LENGTH is 32768 characters (a note is written verbatim into the append-only audit history, so an oversized note would permanently inflate every export)",
    "  at the limit: dispatch PUBLISH with a 32768-character note succeeded — DEMO-017 in state OPEN, history 1 entry, stored note length 32768 (the note itself is not printed, only its length)",
    "  over the limit: dispatch ACCEPT with a 32769-character note rejected — invalid dispatch options: note must be at most 32768 characters, got 32769 (rejected before anything mutates)",
    "  after the rejection: DEMO-017 still in state OPEN with 1 history entry (the oversized dispatch left no trace — no state change, no history entry, no seq gap)",
  ]) {
    assert.ok(text.includes(line), `missing note length limit line: ${line}`);
  }
  assert.ok(
    !text.includes("x".repeat(100)),
    "the demo must print only the note lengths, never the long notes themselves",
  );
});

test("demo note length limit segment is deterministic: two runs print byte-identical limit lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Note length limit (MAX_NOTE_LENGTH on dispatch notes):"),
      ls.indexOf("Standalone overdue judgement (isOverdue on fixed tasks):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + limit / at-the-limit / over-the-limit /
  // after-the-rejection lines; every value is a hand-pinned
  // constant under fixed timestamps, so no normalization is
  // needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.noteLengthLimit, b.noteLengthLimit);
  assert.equal(a.noteLimitBoundaryLength, b.noteLimitBoundaryLength);
  assert.equal(a.noteLimitOverLength, b.noteLimitOverLength);
  assert.equal(a.noteLimitError, b.noteLimitError);
  assert.equal(a.noteLimitStateAfter, b.noteLimitStateAfter);
  assert.equal(a.noteLimitHistoryLengthAfter, b.noteLimitHistoryLengthAfter);
});

test("demo shows the standalone overdue judgement segment in-process: five boundary verdicts on fixed tasks", async () => {
  const {
    overdueStandaloneTask,
    overdueStandaloneNoDeadlineTask,
    overdueStandaloneTerminalTask,
    overdueStandaloneDeadline,
    overdueStandaloneVerdicts,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // isOverdue source and the SLA tests, never derived by
  // calling isOverdue itself: before the deadline false,
  // exactly at it true (inclusive), after it true, and
  // no-deadline and terminal tasks false.
  assert.equal(overdueStandaloneDeadline, "2026-03-24T09:00:00.000Z");
  assert.deepEqual(overdueStandaloneVerdicts, [false, true, true, false, false]);
  assert.equal(overdueStandaloneTask.id, "DEMO-018");
  assert.equal(overdueStandaloneTask.state, "ACCEPTED");
  assert.equal(overdueStandaloneTask.history.length, 2);
  assert.equal(
    overdueStandaloneTask.getSlaDeadline("ACCEPTED"),
    "2026-03-24T09:00:00.000Z",
  );
  assert.equal(overdueStandaloneNoDeadlineTask.id, "DEMO-019");
  assert.equal(overdueStandaloneNoDeadlineTask.state, "ACCEPTED");
  assert.equal(overdueStandaloneNoDeadlineTask.getSlaDeadline(), undefined);
  assert.equal(overdueStandaloneTerminalTask.id, "DEMO-020");
  assert.equal(overdueStandaloneTerminalTask.state, "ABANDONED");
  assert.equal(overdueStandaloneTerminalTask.isTerminal, true);
  assert.equal(
    overdueStandaloneTerminalTask.getSlaDeadline("ABANDONED"),
    "2026-03-24T09:00:00.000Z",
  );
  // Independent checks built in the test — the demo segment
  // is not self-certifying: a fresh task reproduces the same
  // five verdicts at the same fixed instants.
  const independent = new TaskLifecycle("overdue-check");
  independent.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-03-24T07:00:00.000Z",
  });
  independent.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-03-24T07:05:00.000Z",
  });
  independent.setSlaDeadline("2026-03-24T09:00:00.000Z");
  assert.equal(isOverdue(independent, new Date("2026-03-24T08:00:00.000Z")), false);
  assert.equal(isOverdue(independent, new Date("2026-03-24T09:00:00.000Z")), true);
  assert.equal(isOverdue(independent, new Date("2026-03-24T10:00:00.000Z")), true);
  independent.clearSlaDeadline();
  assert.equal(isOverdue(independent, new Date("2026-03-24T10:00:00.000Z")), false);
  // The segment follows the note length limit segment and
  // prints its lines verbatim (the terminal-state judgement
  // segment now closes the demo after it).
  const overdueAt = text.indexOf(
    "Standalone overdue judgement (isOverdue on fixed tasks):",
  );
  assert.ok(
    overdueAt >
      text.indexOf("Note length limit (MAX_NOTE_LENGTH on dispatch notes):"),
    "standalone overdue judgement segment must follow the note length limit segment",
  );
  for (const line of [
    "  before the deadline: DEMO-018 (ACCEPTED, deadline 2026-03-24T09:00:00.000Z) at 2026-03-24T08:00:00.000Z -> isOverdue: false (the deadline has not yet been reached)",
    "  exactly at the deadline: DEMO-018 at 2026-03-24T09:00:00.000Z -> isOverdue: true (the boundary is inclusive — now >= deadline)",
    "  after the deadline: DEMO-018 at 2026-03-24T10:00:00.000Z -> isOverdue: true (past the deadline and still non-terminal)",
    "  no deadline set: DEMO-019 (ACCEPTED, no SLA deadline) at 2026-03-24T10:00:00.000Z -> isOverdue: false (a task with no deadline is never overdue)",
    "  terminal state: DEMO-020 (ABANDONED, deadline 2026-03-24T09:00:00.000Z) at 2026-03-24T10:00:00.000Z -> isOverdue: false (a finished task is no longer overdue, even past its deadline)",
  ]) {
    assert.ok(text.includes(line), `missing overdue judgement line: ${line}`);
  }
  // The terminal-state judgement segment closes the demo
  // after this one (its own test pins the demo's last line).
  assert.ok(
    text.indexOf("Terminal-state judgement (isTerminal over all 13 states):") >
      overdueAt,
    "terminal-state judgement segment must follow the standalone overdue judgement segment",
  );
});

test("demo standalone overdue judgement segment is deterministic: two runs print byte-identical judgement lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Standalone overdue judgement (isOverdue on fixed tasks):"),
      ls.indexOf("Terminal-state judgement (isTerminal over all 13 states):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + before / at / after / no-deadline / terminal
  // lines; every value is a hand-pinned constant under
  // fixed timestamps, so no normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.overdueStandaloneDeadline, b.overdueStandaloneDeadline);
  assert.deepEqual(a.overdueStandaloneVerdicts, b.overdueStandaloneVerdicts);
});

test("demo shows the terminal-state judgement segment in-process: all 13 states with the no-outgoing-edge cross-check", async () => {
  const { task, terminalByState, terminalStates, noOutEdgeStates, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // TERMINAL set in src/taskLifecycle.ts and the isTerminal
  // tests, never derived by calling isTerminal itself: only
  // PAID / ABANDONED / EXPIRED are terminal.
  const EXPECTED: Array<{ state: TaskState; terminal: boolean }> = [
    { state: "DRAFT", terminal: false },
    { state: "OPEN", terminal: false },
    { state: "ACCEPTED", terminal: false },
    { state: "CAPTURING", terminal: false },
    { state: "SUBMITTED", terminal: false },
    { state: "IN_REVIEW", terminal: false },
    { state: "APPROVED", terminal: false },
    { state: "PAYOUT_PENDING", terminal: false },
    { state: "PAID", terminal: true },
    { state: "REJECTED", terminal: false },
    { state: "DISPUTED", terminal: false },
    { state: "ABANDONED", terminal: true },
    { state: "EXPIRED", terminal: true },
  ];
  assert.deepEqual(terminalByState, EXPECTED);
  assert.deepEqual(terminalStates, ["PAID", "ABANDONED", "EXPIRED"]);
  assert.deepEqual(noOutEdgeStates, ["PAID", "ABANDONED", "EXPIRED"]);
  // Independent checks built in the test — the demo segment
  // is not self-certifying: the standalone function reproduces
  // the same verdicts, and the transition table's own shape
  // (states with no outgoing edge, 19 edges in total)
  // reproduces the same terminal set.
  for (const { state, terminal } of EXPECTED) {
    assert.equal(isTerminal(state), terminal, `state ${state}`);
  }
  const edges = transitionTable();
  assert.equal(edges.length, 19);
  const withOutgoing = new Set(edges.map((e) => e.from));
  assert.deepEqual(
    EXPECTED.map(({ state }) => state).filter((s) => !withOutgoing.has(s)),
    ["PAID", "ABANDONED", "EXPIRED"],
  );
  assert.equal(task.state, "PAID");
  assert.equal(isTerminal(task.state), true);
  assert.equal(task.isTerminal, true);
  // The segment follows the standalone overdue judgement
  // segment and prints its lines verbatim (the SLA deadline
  // clearing segment now closes the demo after it).
  const terminalAt = text.indexOf(
    "Terminal-state judgement (isTerminal over all 13 states):",
  );
  assert.ok(
    terminalAt >
      text.indexOf("Standalone overdue judgement (isOverdue on fixed tasks):"),
    "terminal-state judgement segment must follow the standalone overdue judgement segment",
  );
  for (const line of [
    "  DRAFT           -> isTerminal: false (1 outgoing edge in transitionTable())",
    "  OPEN            -> isTerminal: false (2 outgoing edges in transitionTable())",
    "  ACCEPTED        -> isTerminal: false (3 outgoing edges in transitionTable())",
    "  CAPTURING       -> isTerminal: false (3 outgoing edges in transitionTable())",
    "  SUBMITTED       -> isTerminal: false (2 outgoing edges in transitionTable())",
    "  IN_REVIEW       -> isTerminal: false (2 outgoing edges in transitionTable())",
    "  APPROVED        -> isTerminal: false (1 outgoing edge in transitionTable())",
    "  PAYOUT_PENDING  -> isTerminal: false (1 outgoing edge in transitionTable())",
    "  PAID            -> isTerminal: true (terminal — 0 outgoing edges in transitionTable())",
    "  REJECTED        -> isTerminal: false (2 outgoing edges in transitionTable())",
    "  DISPUTED        -> isTerminal: false (2 outgoing edges in transitionTable())",
    "  ABANDONED       -> isTerminal: true (terminal — 0 outgoing edges in transitionTable())",
    "  EXPIRED         -> isTerminal: true (terminal — 0 outgoing edges in transitionTable())",
    "  terminal states: PAID, ABANDONED, EXPIRED (3 of 13 states)",
    "  cross-check: the isTerminal set equals the transition table's no-outgoing-edge set (PAID, ABANDONED, EXPIRED): true (every terminal state has no outgoing edges, and every state with no outgoing edges is terminal)",
    "  main task DEMO-001 (PAID): isTerminal: true (the standalone function and the instance getter agree — a finished task offers no further events)",
  ]) {
    assert.ok(text.includes(line), `missing terminal-state line: ${line}`);
  }
  assert.ok(
    lines.includes(
      "  main task DEMO-001 (PAID): isTerminal: true (the standalone function and the instance getter agree — a finished task offers no further events)",
    ),
  );
  // The SLA deadline clearing segment closes the demo after
  // this one (its own test pins the demo's last line).
  assert.ok(
    text.indexOf("SLA deadline clearing (clearSlaDeadline on a fixed task):") >
      terminalAt,
    "SLA deadline clearing segment must follow the terminal-state judgement segment",
  );
});

test("demo terminal-state judgement segment is deterministic: two runs print byte-identical judgement lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Terminal-state judgement (isTerminal over all 13 states):"),
      ls.indexOf("SLA deadline clearing (clearSlaDeadline on a fixed task):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + 13 state lines + terminal-set / cross-check /
  // main-task lines; every value is a hand-pinned constant
  // derived from the transition table alone, so no
  // normalization is needed.
  assert.equal(segA.length, 17);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.terminalByState, b.terminalByState);
  assert.deepEqual(a.terminalStates, b.terminalStates);
  assert.deepEqual(a.noOutEdgeStates, b.noOutEdgeStates);
});

test("demo shows the SLA deadline clearing segment in-process: per-state clear revokes overdue, no-arg clear revokes all", async () => {
  const {
    slaClearTask,
    slaClearDeadline,
    slaClearOtherDeadlines,
    slaClearOverdueBefore,
    slaClearOverdueAfterStateClear,
    slaClearAcceptedAfterStateClear,
    slaClearOthersAfterStateClear,
    slaClearAfterAllClear,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // clearSlaDeadline source and the SLA tests, never derived
  // by calling the clearing methods themselves.
  assert.equal(slaClearDeadline, "2026-03-25T09:00:00.000Z");
  assert.deepEqual(slaClearOtherDeadlines, [
    "2026-03-26T09:00:00.000Z",
    "2026-03-27T09:00:00.000Z",
  ]);
  assert.equal(slaClearOverdueBefore, true);
  assert.equal(slaClearAcceptedAfterStateClear, undefined);
  assert.equal(slaClearOverdueAfterStateClear, false);
  assert.deepEqual(slaClearOthersAfterStateClear, [
    "2026-03-26T09:00:00.000Z",
    "2026-03-27T09:00:00.000Z",
  ]);
  assert.deepEqual(slaClearAfterAllClear, [undefined, undefined, undefined]);
  assert.equal(slaClearTask.id, "DEMO-021");
  assert.equal(slaClearTask.state, "ACCEPTED");
  assert.equal(slaClearTask.history.length, 2);
  assert.equal(slaClearTask.getSlaDeadline("ACCEPTED"), undefined);
  assert.equal(slaClearTask.getSlaDeadline("CAPTURING"), undefined);
  assert.equal(slaClearTask.getSlaDeadline("SUBMITTED"), undefined);
  // Independent checks built in the test — the demo segment
  // is not self-certifying: a fresh task reproduces the same
  // before / after verdicts at the same fixed instant.
  const independent = new TaskLifecycle("sla-clear-check");
  independent.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-03-25T07:00:00.000Z",
  });
  independent.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-03-25T07:05:00.000Z",
  });
  independent.setSlaDeadline("2026-03-25T09:00:00.000Z");
  independent.setSlaDeadline("2026-03-26T09:00:00.000Z", "CAPTURING");
  const NOW = new Date("2026-03-25T10:00:00.000Z");
  assert.equal(isOverdue(independent, NOW), true);
  independent.clearSlaDeadline("ACCEPTED");
  assert.equal(independent.getSlaDeadline("ACCEPTED"), undefined);
  assert.equal(isOverdue(independent, NOW), false);
  assert.equal(
    independent.getSlaDeadline("CAPTURING"),
    "2026-03-26T09:00:00.000Z",
  );
  independent.clearSlaDeadline();
  assert.equal(independent.getSlaDeadline("CAPTURING"), undefined);
  // The segment follows the terminal-state judgement segment
  // and prints its lines verbatim (the single-target delivery
  // segment now closes the demo after it).
  const clearAt = text.indexOf(
    "SLA deadline clearing (clearSlaDeadline on a fixed task):",
  );
  assert.ok(
    clearAt >
      text.indexOf("Terminal-state judgement (isTerminal over all 13 states):"),
    "SLA deadline clearing segment must follow the terminal-state judgement segment",
  );
  for (const line of [
    "  before clearing: DEMO-021 (ACCEPTED, ACCEPTED deadline 2026-03-25T09:00:00.000Z) at 2026-03-25T10:00:00.000Z -> isOverdue: true (past its ACCEPTED deadline; CAPTURING and SUBMITTED also carry deadlines)",
    '  clear one state: clearSlaDeadline("ACCEPTED") -> getSlaDeadline("ACCEPTED"): undefined, isOverdue at the same instant: false (a renegotiated or cancelled deadline no longer makes the task overdue)',
    '  other states untouched: getSlaDeadline("CAPTURING"): 2026-03-26T09:00:00.000Z, getSlaDeadline("SUBMITTED"): 2026-03-27T09:00:00.000Z (clearing one state leaves the other states\' deadlines in place)',
    '  clear all states: clearSlaDeadline() with no argument -> getSlaDeadline("ACCEPTED"): undefined, getSlaDeadline("CAPTURING"): undefined, getSlaDeadline("SUBMITTED"): undefined (every state\'s deadline is cleared)',
  ]) {
    assert.ok(text.includes(line), `missing SLA clearing line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Single-target payout webhook delivery (deliverPayoutWebhook to 1 endpoint, fake fetch — no real network):",
    ) > clearAt,
    "single-target delivery segment must follow the SLA deadline clearing segment",
  );
});

test("demo SLA deadline clearing segment is deterministic: two runs print byte-identical clearing lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("SLA deadline clearing (clearSlaDeadline on a fixed task):"),
      ls.indexOf("Single-target payout webhook delivery (deliverPayoutWebhook to 1 endpoint, fake fetch — no real network):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + before / clear-one / other-states / clear-all
  // lines; every value is a hand-pinned constant under fixed
  // timestamps, so no normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.slaClearDeadline, b.slaClearDeadline);
  assert.deepEqual(a.slaClearOtherDeadlines, b.slaClearOtherDeadlines);
  assert.equal(a.slaClearOverdueBefore, b.slaClearOverdueBefore);
  assert.equal(
    a.slaClearOverdueAfterStateClear,
    b.slaClearOverdueAfterStateClear,
  );
  assert.deepEqual(a.slaClearAfterAllClear, b.slaClearAfterAllClear);
});

test("demo shows the single-target payout webhook delivery segment in-process: scripted 500 then 200, byte-identical wire bodies, wire signature verifies", async () => {
  const {
    webhook,
    singleDeliveryEndpoint,
    singleDeliveryResult,
    singleDeliveryCalls,
    singleDeliveryBodyVerifies,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // delivery source and the delivery tests, never derived by
  // calling deliverPayoutWebhook itself.
  assert.equal(singleDeliveryEndpoint, "https://payouts.example.com/hooks/payout");
  assert.deepEqual(singleDeliveryResult, { ok: true, attempts: 2, status: 200 });
  assert.equal(singleDeliveryCalls.length, 2);
  assert.ok(singleDeliveryCalls.every((c) => c.url === singleDeliveryEndpoint));
  assert.equal(singleDeliveryCalls[0].body, singleDeliveryCalls[1].body);
  assert.equal(singleDeliveryCalls[0].body, JSON.stringify(webhook.payload));
  assert.equal(singleDeliveryCalls[0].signature, webhook.signature);
  assert.equal(singleDeliveryCalls[1].signature, webhook.signature);
  assert.equal(singleDeliveryBodyVerifies, true);
  assert.equal(
    verifyPayoutWebhook(singleDeliveryCalls[0].body, singleDeliveryCalls[0].signature, DEMO_WEBHOOK_SECRET),
    true,
  );
  // Independent checks built in the test — the demo segment is
  // not self-certifying: a fresh scripted fetch reproduces the
  // same outcome for the same webhook.
  const replayCalls: Array<{ url: string; body: string; signature: string }> = [];
  let replayAttempt = 0;
  const replayResult = await deliverPayoutWebhook(singleDeliveryEndpoint, webhook, {
    fetchImpl: async (url, init) => {
      replayCalls.push({
        url,
        body: String(init.body ?? ""),
        signature: String(new Headers(init.headers).get("x-hub-signature-256") ?? ""),
      });
      replayAttempt += 1;
      return new Response("{}", { status: replayAttempt === 1 ? 500 : 200 });
    },
    sleepImpl: async () => {},
    backoffMs: 0,
  });
  assert.deepEqual(replayResult, { ok: true, attempts: 2, status: 200 });
  assert.equal(replayCalls.length, 2);
  assert.equal(replayCalls[0].body, replayCalls[1].body);
  assert.equal(
    verifyPayoutWebhook(replayCalls[0].body, replayCalls[0].signature, DEMO_WEBHOOK_SECRET),
    true,
  );
  // The segment follows the SLA deadline clearing segment
  // and prints its lines verbatim (the subscribe onError
  // segment now closes the demo after it).
  const deliveryAt = text.indexOf(
    "Single-target payout webhook delivery (deliverPayoutWebhook to 1 endpoint, fake fetch — no real network):",
  );
  assert.ok(
    deliveryAt > text.indexOf("SLA deadline clearing (clearSlaDeadline on a fixed task):"),
    "single-target delivery segment must follow the SLA deadline clearing segment",
  );
  for (const line of [
    "  endpoint: https://payouts.example.com/hooks/payout (the main task's signed payout webhook, delivered on its own — no fan-out)",
    "  delivery: ok attempts=2 status=200 (the first attempt answered 500 and the retry succeeded; a 429 Retry-After hint would have set that retry's delay, clamped to maxRetryDelayMs — the 500 fell back to exponential backoff, here backoffMs 0 with a no-op sleep, so nothing really waited)",
    "  wire check: 2 POSTs captured with byte-identical bodies: true (a retry re-POSTs the same signed body under the same eventId, so a receiver deduplicates it)",
    "  signature check: verifyPayoutWebhook over the captured wire body: true (the X-Hub-Signature-256 header captured on the wire verifies under the demo secret)",
  ]) {
    assert.ok(text.includes(line), `missing single-target delivery line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Subscribe onError error routing (a throwing listener routed to onError):",
    ) > deliveryAt,
    "subscribe onError segment must follow the single-target delivery segment",
  );
});

test("demo single-target delivery segment is deterministic in outcome: two runs agree on the result and printed lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Single-target payout webhook delivery (deliverPayoutWebhook to 1 endpoint, fake fetch — no real network):"),
      ls.indexOf("Subscribe onError error routing (a throwing listener routed to onError):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + endpoint / delivery / wire-check / signature-check
  // lines; the printed lines carry no timestamps, eventIds or
  // signatures (only fixed verdicts), so no normalization is
  // needed — the wire bodies themselves differ between runs
  // (the main webhook's at / eventId do) and are therefore
  // compared only within each run.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.singleDeliveryResult, b.singleDeliveryResult);
  assert.equal(a.singleDeliveryEndpoint, b.singleDeliveryEndpoint);
  assert.equal(a.singleDeliveryCalls.length, 2);
  assert.equal(a.singleDeliveryCalls[0].body, a.singleDeliveryCalls[1].body);
  assert.equal(b.singleDeliveryCalls[0].body, b.singleDeliveryCalls[1].body);
  assert.equal(a.singleDeliveryBodyVerifies, true);
  assert.equal(b.singleDeliveryBodyVerifies, true);
});

test("demo shows the subscribe onError segment in-process: throwing listener routed to onError, dispatch and history intact, throwing onError probe swallowed", async () => {
  const { onErrorTask, onErrorReports, onErrorProbeTask, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // subscribe source and the subscribeOnError tests, never
  // derived by calling the routing itself.
  assert.equal(onErrorTask.id, "DEMO-022");
  assert.equal(onErrorTask.state, "CAPTURING");
  assert.equal(onErrorTask.isTerminal, false);
  assert.equal(onErrorTask.listenerCount, 1);
  assert.deepEqual(
    onErrorTask.history.map((h) => [h.event, h.from, h.to, h.actor, h.at]),
    [
      ["PUBLISH", "DRAFT", "OPEN", "researcher", "2026-03-23T09:00:00.000Z"],
      ["ACCEPT", "OPEN", "ACCEPTED", "contributor", "2026-03-23T09:05:00.000Z"],
      ["START_CAPTURE", "ACCEPTED", "CAPTURING", "contributor", "2026-03-23T09:10:00.000Z"],
    ],
  );
  assert.deepEqual(onErrorReports, [
    { message: "demo listener failure", event: "PUBLISH", from: "DRAFT", to: "OPEN" },
    { message: "demo listener failure", event: "ACCEPT", from: "OPEN", to: "ACCEPTED" },
    { message: "demo listener failure", event: "START_CAPTURE", from: "ACCEPTED", to: "CAPTURING" },
  ]);
  // The probe task: its onError hook itself throws, and both
  // dispatches still landed with both audit entries intact.
  assert.equal(onErrorProbeTask.id, "DEMO-023");
  assert.equal(onErrorProbeTask.state, "ACCEPTED");
  assert.equal(onErrorProbeTask.history.length, 2);
  assert.deepEqual(
    onErrorProbeTask.history.map((h) => [h.event, h.from, h.to]),
    [
      ["PUBLISH", "DRAFT", "OPEN"],
      ["ACCEPT", "OPEN", "ACCEPTED"],
    ],
  );
  // Independent checks built in the test — the demo segment is
  // not self-certifying: fresh tasks reproduce the routing and
  // the throwing-hook swallow with their own listener and hook.
  const independent = new TaskLifecycle("t-demo-onerror-independent");
  const seen: Array<{ message: string; event: string; from: string; to: string }> = [];
  const boom = new Error("independent boom");
  independent.subscribe(
    () => {
      throw boom;
    },
    {
      onError: (err, ctx) => {
        seen.push({
          message: (err as Error).message,
          event: ctx.event,
          from: ctx.from,
          to: ctx.to,
        });
      },
    },
  );
  assert.equal(independent.dispatch("PUBLISH"), "OPEN");
  assert.deepEqual(seen, [
    { message: "independent boom", event: "PUBLISH", from: "DRAFT", to: "OPEN" },
  ]);
  const probe = new TaskLifecycle("t-demo-onerror-probe");
  probe.subscribe(
    () => {
      throw new Error("probe listener boom");
    },
    {
      onError: () => {
        throw new Error("probe onError boom");
      },
    },
  );
  assert.equal(probe.dispatch("PUBLISH"), "OPEN");
  assert.equal(probe.history.length, 1);
  // The segment follows the single-target delivery segment
  // and prints its lines verbatim (the payout dedupe snapshot
  // persistence segment follows it, and the payout dedupe
  // stats segment now closes the demo).
  const onErrorAt = text.indexOf(
    "Subscribe onError error routing (a throwing listener routed to onError):",
  );
  assert.ok(
    onErrorAt >
      text.indexOf(
        "Single-target payout webhook delivery (deliverPayoutWebhook to 1 endpoint, fake fetch — no real network):",
      ),
    "subscribe onError segment must follow the single-target delivery segment",
  );
  for (const line of [
    '  listener: DEMO-022 carries 1 listener that throws Error("demo listener failure") on every notification, subscribed with a collecting onError hook',
    '  routed errors: onError received 3 report(s); first report: event=PUBLISH from=DRAFT to=OPEN error="demo listener failure" (the dispatch context handed to the hook)',
    "  dispatch unaffected: all 3 dispatches returned normally (OPEN, ACCEPTED, CAPTURING) and the audit history holds all 3 entries — a failing listener is isolated, never breaking dispatch",
    "  final state: CAPTURING (terminal: false)",
  ]) {
    assert.ok(text.includes(line), `missing subscribe onError line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Payout dedupe snapshot persistence (PayoutEventDedupe exportSnapshot / restore across a restart):",
    ) > onErrorAt,
    "payout dedupe snapshot segment must follow the subscribe onError segment",
  );
});

test("demo subscribe onError segment is deterministic: two runs print byte-identical routing lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Subscribe onError error routing (a throwing listener routed to onError):"),
      ls.indexOf("Payout dedupe snapshot persistence (PayoutEventDedupe exportSnapshot / restore across a restart):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + listener / routed-errors / dispatch-unaffected /
  // final-state lines; every value in the segment is a fixed
  // literal (fixed timestamps inside the tasks, fixed error
  // message, fixed chain), so no normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.onErrorReports, b.onErrorReports);
  assert.equal(a.onErrorTask.state, "CAPTURING");
  assert.equal(b.onErrorTask.state, "CAPTURING");
  assert.equal(a.onErrorProbeTask.state, "ACCEPTED");
  assert.equal(b.onErrorProbeTask.state, "ACCEPTED");
  assert.equal(a.onErrorProbeTask.history.length, 2);
});

test("demo shows the payout dedupe snapshot persistence segment in-process: ids survive a JSON round-trip restore, counters restart at zero, v:2 copy rejected", async () => {
  const {
    dedupeSnapshotSource,
    dedupeSnapshotFirst,
    dedupeSnapshotDuplicate,
    dedupeSnapshot,
    dedupeSnapshotRestored,
    dedupeSnapshotStatsAfterRestore,
    dedupeSnapshotRestoredSeen,
    dedupeSnapshotRestoredUnseen,
    dedupeSnapshotTamperedError,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // snapshot docs in src/settlementWebhook.ts and the
  // payoutEventDedupeSnapshot tests, never derived by calling
  // the snapshot pair itself.
  const START_MS = Date.parse("2026-03-24T09:00:00.000Z");
  assert.deepEqual(dedupeSnapshotFirst, [false, false]);
  assert.deepEqual(dedupeSnapshotDuplicate, [true, true]);
  assert.deepEqual(dedupeSnapshotSource.stats(), {
    size: 2,
    hits: 2,
    misses: 2,
    evictions: 0,
  });
  assert.deepEqual(dedupeSnapshot, {
    v: 1,
    entries: [
      ["evt_demo_payout_001", START_MS],
      ["evt_demo_payout_002", START_MS],
    ],
  });
  // Counters do not travel with the snapshot: the restored
  // store's stats were read before any probe ran.
  assert.deepEqual(dedupeSnapshotStatsAfterRestore, {
    size: 2,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  assert.deepEqual(dedupeSnapshotRestoredSeen, [true, true]);
  assert.equal(dedupeSnapshotRestoredUnseen, false);
  assert.equal(dedupeSnapshotRestored.size, 3);
  assert.deepEqual(dedupeSnapshotRestored.stats(), {
    size: 3,
    hits: 2,
    misses: 1,
    evictions: 0,
  });
  assert.equal(
    dedupeSnapshotTamperedError,
    "PayoutEventDedupe: invalid snapshot: unsupported snapshot version 2 (expected 1)",
  );
  // Independent checks built in the test — the demo segment is
  // not self-certifying: a fresh dedupe reproduces the
  // round-trip and the version rejection on its own.
  const independent = new PayoutEventDedupe({
    ttlMs: 60_000,
    now: () => START_MS,
  });
  assert.equal(independent.checkAndRecord("evt-independent-1"), false);
  const revived = PayoutEventDedupe.restore(
    JSON.parse(JSON.stringify(independent.exportSnapshot())) as unknown,
    { ttlMs: 60_000, now: () => START_MS },
  );
  assert.deepEqual(revived.stats(), {
    size: 1,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  assert.equal(revived.checkAndRecord("evt-independent-1"), true);
  assert.equal(revived.checkAndRecord("evt-independent-2"), false);
  assert.throws(
    () =>
      PayoutEventDedupe.restore(
        { v: 2, entries: [] },
        { ttlMs: 60_000, now: () => START_MS },
      ),
    /^Error: PayoutEventDedupe: invalid snapshot: unsupported snapshot version 2 \(expected 1\)$/,
  );
  // The segment follows the subscribe onError segment and
  // prints its lines verbatim (the payout dedupe stats
  // segment now closes the demo after it).
  const snapshotAt = text.indexOf(
    "Payout dedupe snapshot persistence (PayoutEventDedupe exportSnapshot / restore across a restart):",
  );
  assert.ok(
    snapshotAt >
      text.indexOf(
        "Subscribe onError error routing (a throwing listener routed to onError):",
      ),
    "payout dedupe snapshot segment must follow the subscribe onError segment",
  );
  for (const line of [
    "  source dedupe (fixed clock 2026-03-24T09:00:00.000Z, TTL 60000 ms): eventId evt_demo_payout_001 — checkAndRecord: false (new event), again: true (duplicate); eventId evt_demo_payout_002 — checkAndRecord: false (new event), again: true (duplicate)",
    "  exportSnapshot(): v 1, 2 entries — only the version and entry count are printed, never the full entries (persist the JSON before shutdown)",
    "  after JSON round-trip + PayoutEventDedupe.restore(): stats size 2, hits 0, misses 0, evictions 0 — counters restart at zero, the recorded ids do not",
    "  restored dedupe: eventId evt_demo_payout_001 — checkAndRecord: true (duplicate — the restart did not reopen the dedupe window); eventId evt_demo_payout_002 — checkAndRecord: true (duplicate); eventId evt_demo_payout_003 — checkAndRecord: false (new event, recorded)",
    '  tampered snapshot rejected: a detached copy with v changed to 2 throws "PayoutEventDedupe: invalid snapshot: unsupported snapshot version 2 (expected 1)" — a corrupt snapshot fails loudly at startup instead of silently disabling deduplication',
  ]) {
    assert.ok(text.includes(line), `missing payout dedupe snapshot line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Payout dedupe stats observability (PayoutEventDedupe.stats() counters over a pinned script):",
    ) > snapshotAt,
    "payout dedupe stats segment must follow the payout dedupe snapshot segment",
  );
});

test("demo payout dedupe snapshot segment is deterministic: two runs print byte-identical persistence lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout dedupe snapshot persistence (PayoutEventDedupe exportSnapshot / restore across a restart):"),
      ls.indexOf("Payout dedupe stats observability (PayoutEventDedupe.stats() counters over a pinned script):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + source / export / restore-stats / restored /
  // tampered lines; every value in the segment is a fixed
  // literal (fixed clock, fixed eventIds, fixed TTL), so no
  // normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.dedupeSnapshot, b.dedupeSnapshot);
  assert.deepEqual(
    a.dedupeSnapshotStatsAfterRestore,
    b.dedupeSnapshotStatsAfterRestore,
  );
  assert.equal(
    a.dedupeSnapshotTamperedError,
    b.dedupeSnapshotTamperedError,
  );
});

test("demo shows the payout dedupe stats observability segment in-process: pinned script counters step by step, one LRU eviction, detached copy mutation leaves the store unchanged", async () => {
  const {
    dedupeStatsDedupe,
    dedupeStatsOutcomes,
    dedupeStatsSnapshots,
    dedupeStatsAfterMutation,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // stats docs in src/settlementWebhook.ts and the
  // payoutEventDedupe stats test, never derived by calling
  // stats() itself.
  assert.deepEqual(dedupeStatsOutcomes, [false, true, false, false, false]);
  assert.deepEqual(dedupeStatsSnapshots, [
    { size: 0, hits: 0, misses: 0, evictions: 0 },
    { size: 1, hits: 0, misses: 1, evictions: 0 },
    { size: 1, hits: 1, misses: 1, evictions: 0 },
    { size: 2, hits: 1, misses: 2, evictions: 0 },
    { size: 3, hits: 1, misses: 3, evictions: 0 },
    { size: 3, hits: 1, misses: 4, evictions: 1 },
  ]);
  assert.deepEqual(dedupeStatsAfterMutation, {
    size: 3,
    hits: 1,
    misses: 4,
    evictions: 1,
  });
  assert.equal(dedupeStatsDedupe.size, 3);
  assert.deepEqual(dedupeStatsDedupe.stats(), {
    size: 3,
    hits: 1,
    misses: 4,
    evictions: 1,
  });
  // Independent checks built in the test — the demo segment is
  // not self-certifying: a fresh dedupe reproduces the counter
  // steps and the detached-copy semantics on its own (the
  // maxEntries: 2 script from the dedupe stats test).
  const START_MS = Date.parse("2026-03-25T09:00:00.000Z");
  const independent = new PayoutEventDedupe({
    ttlMs: 60_000,
    maxEntries: 2,
    now: () => START_MS,
  });
  independent.checkAndRecord("a"); // miss
  independent.checkAndRecord("a"); // hit
  independent.checkAndRecord("b"); // miss
  independent.checkAndRecord("c"); // miss, evicts "a" (LRU)
  assert.deepEqual(independent.stats(), {
    size: 2,
    hits: 1,
    misses: 3,
    evictions: 1,
  });
  const detached = independent.stats();
  detached.hits = 999;
  assert.equal(independent.stats().hits, 1);
  // The segment follows the payout dedupe snapshot segment
  // and prints its lines verbatim (the payout dedupe clear
  // segment now closes the demo after it).
  const statsAt = text.indexOf(
    "Payout dedupe stats observability (PayoutEventDedupe.stats() counters over a pinned script):",
  );
  assert.ok(
    statsAt >
      text.indexOf(
        "Payout dedupe snapshot persistence (PayoutEventDedupe exportSnapshot / restore across a restart):",
      ),
    "payout dedupe stats segment must follow the payout dedupe snapshot segment",
  );
  for (const line of [
    "  dedupe (fixed clock 2026-03-25T09:00:00.000Z, TTL 60000 ms, maxEntries 3): initial stats size 0, hits 0, misses 0, evictions 0 — no delivery seen yet",
    "  eventId evt_demo_stats_001 — checkAndRecord: false (new event) -> stats size 1, hits 0, misses 1, evictions 0; again: true (duplicate) -> stats size 1, hits 1, misses 1, evictions 0",
    "  eventId evt_demo_stats_002 — checkAndRecord: false (new event) -> stats size 2, hits 1, misses 2, evictions 0; eventId evt_demo_stats_003 — checkAndRecord: false (new event) -> stats size 3, hits 1, misses 3, evictions 0 (store full)",
    "  eventId evt_demo_stats_004 — checkAndRecord: false (new event, evicts least recently seen evt_demo_stats_001) -> stats size 3, hits 1, misses 4, evictions 1",
    "  detached copy: mutating a returned stats() object (hits set to 999) leaves the store's stats unchanged at size 3, hits 1, misses 4, evictions 1 — the snapshot is a copy, not a live view",
  ]) {
    assert.ok(text.includes(line), `missing payout dedupe stats line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Payout dedupe clear reset (PayoutEventDedupe.clear() drops every id and zeroes the counters):",
    ) > statsAt,
    "payout dedupe clear segment must follow the payout dedupe stats segment",
  );
});

test("demo payout dedupe stats segment is deterministic: two runs print byte-identical observability lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout dedupe stats observability (PayoutEventDedupe.stats() counters over a pinned script):"),
      ls.indexOf("Payout dedupe clear reset (PayoutEventDedupe.clear() drops every id and zeroes the counters):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + dedupe / first-id / fill / eviction /
  // detached-copy lines; every value in the segment is a fixed
  // literal (fixed clock, fixed eventIds, fixed TTL and
  // capacity), so no normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.dedupeStatsOutcomes, b.dedupeStatsOutcomes);
  assert.deepEqual(a.dedupeStatsSnapshots, b.dedupeStatsSnapshots);
  assert.deepEqual(a.dedupeStatsAfterMutation, b.dedupeStatsAfterMutation);
});

test("demo shows the payout dedupe clear reset segment in-process: pinned id forgotten by clear(), counters zeroed, same id new again", async () => {
  const {
    dedupeClearDedupe,
    dedupeClearEventId,
    dedupeClearOutcomes,
    dedupeClearStatsBefore,
    dedupeClearStatsAfterClear,
    dedupeClearStatsAfterReRecord,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // clear() docs in src/settlementWebhook.ts and the
  // payoutEventDedupe clear test, never derived by calling
  // clear() itself.
  assert.equal(dedupeClearEventId, "evt_demo_clear_001");
  assert.deepEqual(dedupeClearOutcomes, [false, true, false]);
  assert.deepEqual(dedupeClearStatsBefore, {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
  assert.deepEqual(dedupeClearStatsAfterClear, {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  assert.deepEqual(dedupeClearStatsAfterReRecord, {
    size: 1,
    hits: 0,
    misses: 1,
    evictions: 0,
  });
  assert.equal(dedupeClearDedupe.size, 1);
  assert.deepEqual(dedupeClearDedupe.stats(), {
    size: 1,
    hits: 0,
    misses: 1,
    evictions: 0,
  });
  // Independent checks built in the test — the demo segment
  // is not self-certifying: a fresh dedupe reproduces the
  // clear semantics on its own (the script from the dedupe
  // clear test).
  const START_MS = Date.parse("2026-03-26T09:00:00.000Z");
  const independent = new PayoutEventDedupe({
    ttlMs: 60_000,
    now: () => START_MS,
  });
  assert.equal(independent.checkAndRecord("evt-1"), false);
  assert.equal(independent.checkAndRecord("evt-1"), true);
  independent.clear();
  assert.equal(independent.size, 0);
  assert.deepEqual(independent.stats(), {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  assert.equal(independent.checkAndRecord("evt-1"), false); // forgotten
  // The segment follows the payout dedupe stats segment
  // and prints its lines verbatim (the payout webhook 429
  // Retry-After delivery segment follows it).
  const clearAt = text.indexOf(
    "Payout dedupe clear reset (PayoutEventDedupe.clear() drops every id and zeroes the counters):",
  );
  assert.ok(
    clearAt >
      text.indexOf(
        "Payout dedupe stats observability (PayoutEventDedupe.stats() counters over a pinned script):",
      ),
    "payout dedupe clear segment must follow the payout dedupe stats segment",
  );
  for (const line of [
    "  dedupe (fixed clock 2026-03-26T09:00:00.000Z, TTL 60000 ms): eventId evt_demo_clear_001 — checkAndRecord: false (new event); again: true (duplicate) -> stats size 1, hits 1, misses 1, evictions 0",
    "  clear(): size 0, stats size 0, hits 0, misses 0, evictions 0 — every recorded id dropped and every counter reset in one call (the explicit reset for key rotation, test isolation, or a deliberate window reset)",
    "  same eventId after clear — checkAndRecord: false (new event again — the clear forgot it, no TTL wait needed) -> stats size 1, hits 0, misses 1, evictions 0 (counters re-accumulate from zero)",
  ]) {
    assert.ok(text.includes(line), `missing payout dedupe clear line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Payout webhook 429 Retry-After delivery (deliverPayoutWebhook waits the clamped hint before retrying, fake fetch + recording fake sleep — no real network, no real wait):",
    ) > clearAt,
    "payout webhook 429 Retry-After segment must follow the payout dedupe clear segment",
  );
});

test("demo payout dedupe clear segment is deterministic: two runs print byte-identical reset lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout dedupe clear reset (PayoutEventDedupe.clear() drops every id and zeroes the counters):"),
      ls.indexOf("Payout webhook 429 Retry-After delivery (deliverPayoutWebhook waits the clamped hint before retrying, fake fetch + recording fake sleep — no real network, no real wait):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + dedupe / clear / re-record lines; every value
  // in the segment is a fixed literal (fixed clock, fixed
  // eventId, fixed TTL), so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.dedupeClearOutcomes, b.dedupeClearOutcomes);
  assert.deepEqual(a.dedupeClearStatsBefore, b.dedupeClearStatsBefore);
  assert.deepEqual(a.dedupeClearStatsAfterClear, b.dedupeClearStatsAfterClear);
  assert.deepEqual(
    a.dedupeClearStatsAfterReRecord,
    b.dedupeClearStatsAfterReRecord,
  );
});

test("demo shows the payout webhook 429 Retry-After delivery segment in-process: clamped hint is the recorded sleep, retry succeeds, wire body verifies", async () => {
  const {
    webhook,
    retryAfterDeliveryEndpoint,
    retryAfterDeliveryResult,
    retryAfterDeliveryCalls,
    retryAfterDeliverySleeps,
    retryAfterDeliveryBodyVerifies,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // retryDelayMs docs in src/settlementWebhook.ts and the
  // payoutWebhookDelivery tests, never derived by calling
  // deliverPayoutWebhook itself.
  assert.equal(
    retryAfterDeliveryEndpoint,
    "https://payouts.example.com/hooks/payout",
  );
  assert.deepEqual(retryAfterDeliveryResult, {
    ok: true,
    attempts: 2,
    status: 200,
  });
  // The pinned hint "30" parses to 30000 ms and the segment's
  // maxRetryDelayMs of 5000 clamps it: exactly one recorded
  // sleep of 5000, never the backoffMs 100 fallback.
  assert.equal(parsePayoutRetryAfter("30"), 30_000);
  assert.deepEqual(retryAfterDeliverySleeps, [5_000]);
  assert.equal(retryAfterDeliveryCalls.length, 2);
  for (const call of retryAfterDeliveryCalls) {
    assert.equal(call.url, retryAfterDeliveryEndpoint);
    assert.equal(call.body, JSON.stringify(webhook.payload));
    assert.equal(call.signature, webhook.signature);
  }
  assert.equal(
    retryAfterDeliveryCalls[0].body,
    retryAfterDeliveryCalls[1].body,
  );
  assert.equal(retryAfterDeliveryBodyVerifies, true);
  assert.ok(
    verifyPayoutWebhook(
      retryAfterDeliveryCalls[0].body,
      retryAfterDeliveryCalls[0].signature,
      DEMO_WEBHOOK_SECRET,
    ),
  );
  // Independent checks built in the test — the demo segment
  // is not self-certifying: a fresh delivery of the demo
  // webhook through the test's own scripted fetch/sleep
  // reproduces the clamped wait on its own (the script from
  // the delivery tests, with the segment's pinned values).
  const independentCalls: Array<{ body: string; signature: string }> = [];
  const independentSleeps: number[] = [];
  let independentAttempt = 0;
  const independentResult = await deliverPayoutWebhook(
    retryAfterDeliveryEndpoint,
    webhook,
    {
      fetchImpl: async (_url, init) => {
        independentCalls.push({
          body: String(init.body ?? ""),
          signature: String(
            new Headers(init.headers).get("x-hub-signature-256") ?? "",
          ),
        });
        independentAttempt += 1;
        return independentAttempt === 1
          ? new Response("{}", {
              status: 429,
              headers: { "retry-after": "30" },
            })
          : new Response("{}", { status: 200 });
      },
      sleepImpl: async (ms: number) => {
        independentSleeps.push(ms);
      },
      backoffMs: 100,
      maxRetryDelayMs: 5_000,
    },
  );
  assert.deepEqual(independentResult, { ok: true, attempts: 2, status: 200 });
  assert.deepEqual(independentSleeps, [5_000]);
  assert.equal(independentCalls.length, 2);
  assert.equal(independentCalls[0].body, independentCalls[1].body);
  // The segment follows the payout dedupe clear segment
  // and prints its lines verbatim (the payout webhook
  // secret rotation segment now closes the demo after it).
  const retryAt = text.indexOf(
    "Payout webhook 429 Retry-After delivery (deliverPayoutWebhook waits the clamped hint before retrying, fake fetch + recording fake sleep — no real network, no real wait):",
  );
  assert.ok(
    retryAt >
      text.indexOf(
        "Payout dedupe clear reset (PayoutEventDedupe.clear() drops every id and zeroes the counters):",
      ),
    "payout webhook 429 Retry-After segment must follow the payout dedupe clear segment",
  );
  for (const line of [
    "  endpoint: https://payouts.example.com/hooks/payout (the main task's signed payout webhook, delivered on its own — no fan-out)",
    "  first answer: 429 with Retry-After: 30 (parsed hint 30000 ms, clamped to maxRetryDelayMs 5000) -> recorded sleep: [5000] ms (the recording sleepImpl received exactly the clamped hint — exponential backoff, here backoffMs 100, never ran, and nothing really waited)",
    "  delivery: ok attempts=2 status=200 (the retry after the clamped wait succeeded)",
    "  wire check: 2 POSTs captured with byte-identical bodies: true (a retry re-POSTs the same signed body under the same eventId, so a receiver deduplicates it); signature check: verifyPayoutWebhook over the captured wire body: true (the X-Hub-Signature-256 header captured on the wire verifies under the demo secret)",
  ]) {
    assert.ok(text.includes(line), `missing 429 Retry-After line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Payout webhook secret rotation (verifyPayoutWebhook with { secrets: [new, old] } accepts either secret during the rotation window):",
    ) > retryAt,
    "payout webhook secret rotation segment must follow the payout webhook 429 Retry-After segment",
  );
});

test("demo payout webhook 429 Retry-After segment is deterministic: two runs print byte-identical wait lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout webhook 429 Retry-After delivery (deliverPayoutWebhook waits the clamped hint before retrying, fake fetch + recording fake sleep — no real network, no real wait):"),
      ls.indexOf("Payout webhook secret rotation (verifyPayoutWebhook with { secrets: [new, old] } accepts either secret during the rotation window):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + endpoint / first-answer / delivery / wire
  // lines; every value in the segment is a fixed literal
  // (pinned hint, pinned cap, scripted answers), so no
  // normalization is needed — the wire bodies themselves
  // carry the main task's wall-clock timestamps and are
  // asserted in-process above, not printed here.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.retryAfterDeliveryResult, b.retryAfterDeliveryResult);
  assert.deepEqual(a.retryAfterDeliverySleeps, b.retryAfterDeliverySleeps);
  assert.equal(
    a.retryAfterDeliveryBodyVerifies,
    b.retryAfterDeliveryBodyVerifies,
  );
});

test("demo shows the payout webhook secret rotation segment in-process: both secrets verify inside the window, edges fail closed, both-shapes call throws", async () => {
  const {
    task,
    rotationNewWebhook,
    rotationOldWebhook,
    rotationNewUnderRotation,
    rotationOldUnderRotation,
    rotationNewUnderOldOnly,
    rotationUnderUnrelatedList,
    rotationBothError,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // VerifyPayoutWebhookOptions docs in
  // src/settlementWebhook.ts and
  // test/payoutWebhookSecretRotation.test.ts, never derived
  // by calling verifyPayoutWebhook itself.
  assert.equal(DEMO_ROTATION_NEW_SECRET, "demo-payout-webhook-secret-new");
  assert.equal(DEMO_ROTATION_OLD_SECRET, "demo-payout-webhook-secret-old");
  assert.equal(rotationNewWebhook.payload.taskId, "DEMO-001");
  assert.equal(rotationNewWebhook.payload.event, "PAYOUT_COMPLETE");
  assert.equal(rotationNewWebhook.payload.eventId, "evt_demo_rotation_new");
  assert.equal(rotationNewWebhook.payload.at, "2026-03-27T09:00:00.000Z");
  assert.equal(rotationNewWebhook.payload.payoutRef, "xfer-88f2");
  assert.equal(rotationNewWebhook.payload.payoutAmount, 10098.5);
  assert.equal(rotationOldWebhook.payload.taskId, "DEMO-001");
  assert.equal(rotationOldWebhook.payload.eventId, "evt_demo_rotation_old");
  assert.equal(rotationOldWebhook.payload.at, "2026-03-27T09:00:00.000Z");
  assert.notEqual(
    rotationNewWebhook.signature,
    rotationOldWebhook.signature,
  );
  assert.equal(rotationNewUnderRotation, true);
  assert.equal(rotationOldUnderRotation, true);
  assert.equal(rotationNewUnderOldOnly, false);
  assert.deepEqual(rotationUnderUnrelatedList, [false, false]);
  assert.equal(
    rotationBothError,
    "cannot verify payout webhook: pass either 'secret' or 'secrets', not both",
  );
  // Independent checks built in the test — the demo segment
  // is not self-certifying: fresh notifications built here
  // from the demo's PAID task under the same pinned time and
  // fresh eventIds reproduce every verdict on their own (the
  // script from the secret-rotation tests).
  const independentNew = buildPayoutWebhook(task, DEMO_ROTATION_NEW_SECRET, {
    eventId: "evt-test-rotation-new",
    now: new Date("2026-03-27T09:00:00.000Z"),
  });
  const independentOld = buildPayoutWebhook(task, DEMO_ROTATION_OLD_SECRET, {
    eventId: "evt-test-rotation-old",
    now: new Date("2026-03-27T09:00:00.000Z"),
  });
  const rotationOpts = {
    secrets: [DEMO_ROTATION_NEW_SECRET, DEMO_ROTATION_OLD_SECRET],
  };
  assert.equal(
    verifyPayoutWebhook(
      JSON.stringify(independentNew.payload),
      independentNew.signature,
      undefined,
      rotationOpts,
    ),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(
      JSON.stringify(independentOld.payload),
      independentOld.signature,
      undefined,
      rotationOpts,
    ),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(
      JSON.stringify(independentOld.payload),
      independentOld.signature,
      undefined,
      {
        secrets: [DEMO_ROTATION_OLD_SECRET, DEMO_ROTATION_NEW_SECRET],
      },
    ),
    true,
    "candidate order is a performance preference only",
  );
  assert.equal(
    verifyPayoutWebhook(
      JSON.stringify(independentNew.payload),
      independentNew.signature,
      DEMO_ROTATION_OLD_SECRET,
    ),
    false,
  );
  assert.equal(
    verifyPayoutWebhook(
      JSON.stringify(independentOld.payload),
      independentOld.signature,
      undefined,
      { secrets: ["demo-payout-webhook-secret-unrelated"] },
    ),
    false,
  );
  assert.throws(
    () =>
      verifyPayoutWebhook(
        JSON.stringify(independentNew.payload),
        independentNew.signature,
        DEMO_ROTATION_NEW_SECRET,
        rotationOpts,
      ),
    /cannot verify payout webhook: pass either 'secret' or 'secrets', not both/,
  );
  // The segment follows the payout webhook 429
  // Retry-After delivery segment and prints its lines
  // verbatim (the payout webhook AbortSignal segment
  // follows it).
  const rotationAt = text.indexOf(
    "Payout webhook secret rotation (verifyPayoutWebhook with { secrets: [new, old] } accepts either secret during the rotation window):",
  );
  assert.ok(
    rotationAt >
      text.indexOf(
        "Payout webhook 429 Retry-After delivery (deliverPayoutWebhook waits the clamped hint before retrying, fake fetch + recording fake sleep — no real network, no real wait):",
      ),
    "payout webhook secret rotation segment must follow the payout webhook 429 Retry-After segment",
  );
  for (const line of [
    "  notifications (main task DEMO-001, fixed signing time 2026-03-27T09:00:00.000Z): eventId evt_demo_rotation_new signed with the new secret; eventId evt_demo_rotation_old signed with the old secret — the secrets themselves are never printed",
    "  rotation window { secrets: [new, old] }: new-signed verifies: true; old-signed verifies: true (in-flight notifications signed before the rotation still pass, and new-signed ones pass as soon as the new secret is listed — any one matching secret authenticates)",
    "  window edges fail closed: new-signed under the old secret alone: false (a receiver that has not adopted the new secret yet rejects it); both under an unrelated secret list: false, false (no listed secret matches, so verification fails closed as false — never a throw, never a pass)",
    "  configuration guard: passing the positional secret together with { secrets: [...] } throws \"cannot verify payout webhook: pass either 'secret' or 'secrets', not both\" (the two shapes are mutually exclusive, so a misconfigured receiver fails loudly instead of silently picking one)",
  ]) {
    assert.ok(text.includes(line), `missing secret rotation line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Payout webhook AbortSignal abort (deliverPayoutWebhook honours an external AbortSignal, fake fetch + hanging fake sleep — no real network, no real wait):",
    ) > rotationAt,
    "payout webhook AbortSignal segment must follow the payout webhook secret rotation segment",
  );
});

test("demo payout webhook secret rotation segment is deterministic: two runs print byte-identical rotation lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout webhook secret rotation (verifyPayoutWebhook with { secrets: [new, old] } accepts either secret during the rotation window):"),
      ls.indexOf("Payout webhook AbortSignal abort (deliverPayoutWebhook honours an external AbortSignal, fake fetch + hanging fake sleep — no real network, no real wait):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + notifications / window / edges / guard lines;
  // every value in the segment is a fixed literal (fixed
  // secrets, fixed signing time, fixed eventIds), so no
  // normalization is needed — the signatures themselves are
  // asserted in-process above, not printed here.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.rotationNewWebhook, b.rotationNewWebhook);
  assert.deepEqual(a.rotationOldWebhook, b.rotationOldWebhook);
  assert.equal(a.rotationNewUnderRotation, b.rotationNewUnderRotation);
  assert.equal(a.rotationOldUnderRotation, b.rotationOldUnderRotation);
  assert.equal(a.rotationNewUnderOldOnly, b.rotationNewUnderOldOnly);
  assert.deepEqual(
    a.rotationUnderUnrelatedList,
    b.rotationUnderUnrelatedList,
  );
  assert.equal(a.rotationBothError, b.rotationBothError);
});

test("demo shows the payout webhook AbortSignal segment in-process: pre-abort makes zero fetches, backoff abort starts no second attempt", async () => {
  const {
    webhook,
    abortDeliveryEndpoint,
    abortPreResult,
    abortPreFetchCalls,
    abortWaitResult,
    abortWaitFetchCalls,
    abortWaitSleeps,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // DeliverPayoutWebhookOptions signal docs in
  // src/settlementWebhook.ts and
  // test/payoutWebhookAbortSignal.test.ts, never derived
  // by calling deliverPayoutWebhook itself.
  assert.equal(
    abortDeliveryEndpoint,
    "https://payouts.example.com/hooks/payout",
  );
  assert.deepEqual(abortPreResult, {
    ok: false,
    attempts: 0,
    error: "payout webhook delivery aborted",
  });
  assert.equal(abortPreFetchCalls, 0);
  assert.deepEqual(abortWaitResult, {
    ok: false,
    attempts: 1,
    status: 500,
    error: "payout webhook delivery aborted",
  });
  assert.equal(abortWaitFetchCalls, 1);
  assert.deepEqual(abortWaitSleeps, [30_000]);
  // Independent checks built in the test — the demo segment
  // is not self-certifying: fresh deliveries of the demo
  // webhook through the test's own counting fetches
  // reproduce both abort forms on their own (the scripts
  // from the abort-signal tests, with the segment's pinned
  // values; the backoff case aborts from inside the
  // injected sleep, the deterministic trigger that proves
  // the wait was entered).
  let independentPreCalls = 0;
  const preController = new AbortController();
  preController.abort();
  const independentPreResult = await deliverPayoutWebhook(
    abortDeliveryEndpoint,
    webhook,
    {
      fetchImpl: async () => {
        independentPreCalls += 1;
        return new Response("{}", { status: 200 });
      },
      sleepImpl: async () => {},
      signal: preController.signal,
    },
  );
  assert.deepEqual(independentPreResult, {
    ok: false,
    attempts: 0,
    error: "payout webhook delivery aborted",
  });
  assert.equal(independentPreCalls, 0);
  let independentWaitCalls = 0;
  const independentWaitSleeps: number[] = [];
  const waitController = new AbortController();
  const independentWaitResult = await deliverPayoutWebhook(
    abortDeliveryEndpoint,
    webhook,
    {
      fetchImpl: async () => {
        independentWaitCalls += 1;
        return new Response("{}", { status: 500 });
      },
      sleepImpl: (ms: number) => {
        independentWaitSleeps.push(ms);
        waitController.abort();
        return new Promise<void>(() => {});
      },
      backoffMs: 30_000,
      maxAttempts: 3,
      signal: waitController.signal,
    },
  );
  assert.deepEqual(independentWaitResult, {
    ok: false,
    attempts: 1,
    status: 500,
    error: "payout webhook delivery aborted",
  });
  assert.equal(independentWaitCalls, 1);
  assert.deepEqual(independentWaitSleeps, [30_000]);
  // The segment follows the payout webhook secret
  // rotation segment and prints its lines verbatim (the
  // payout webhook freshness window segment follows it).
  const abortAt = text.indexOf(
    "Payout webhook AbortSignal abort (deliverPayoutWebhook honours an external AbortSignal, fake fetch + hanging fake sleep — no real network, no real wait):",
  );
  assert.ok(
    abortAt >
      text.indexOf(
        "Payout webhook secret rotation (verifyPayoutWebhook with { secrets: [new, old] } accepts either secret during the rotation window):",
      ),
    "payout webhook AbortSignal segment must follow the payout webhook secret rotation segment",
  );
  for (const line of [
    "  endpoint: https://payouts.example.com/hooks/payout (the main task's signed payout webhook, delivered on its own — no fan-out)",
    "  pre-aborted signal: delivery ok=false attempts=0 error=\"payout webhook delivery aborted\"; fetch calls: 0 (the caller asked to stop before the delivery started, so no request was made and the abort is reported, not thrown)",
    "  abort during the backoff wait: first answer 500 -> backoff sleep [30000] ms entered, signal aborted inside the sleep; delivery ok=false attempts=1 status=500 error=\"payout webhook delivery aborted\"; fetch calls: 1 (no second attempt was started — the pending wait was cut short, nothing really waited)",
  ]) {
    assert.ok(text.includes(line), `missing AbortSignal line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Payout webhook freshness window (verifyPayoutWebhook with { maxAgeMs } rejects a validly signed but stale notification):",
    ) > abortAt,
    "payout webhook freshness window segment must follow the payout webhook AbortSignal segment",
  );
});

test("demo payout webhook AbortSignal segment is deterministic: two runs print byte-identical abort lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout webhook AbortSignal abort (deliverPayoutWebhook honours an external AbortSignal, fake fetch + hanging fake sleep — no real network, no real wait):"),
      ls.indexOf("Payout webhook freshness window (verifyPayoutWebhook with { maxAgeMs } rejects a validly signed but stale notification):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + endpoint / pre-aborted / backoff-abort lines;
  // every value in the segment is a fixed literal (pinned
  // backoff, scripted answers, deterministic in-sleep
  // abort trigger), so no normalization is needed — the
  // wire bodies themselves carry the main task's
  // wall-clock timestamps and are not printed here.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.abortDeliveryEndpoint, b.abortDeliveryEndpoint);
  assert.deepEqual(a.abortPreResult, b.abortPreResult);
  assert.equal(a.abortPreFetchCalls, b.abortPreFetchCalls);
  assert.deepEqual(a.abortWaitResult, b.abortWaitResult);
  assert.equal(a.abortWaitFetchCalls, b.abortWaitFetchCalls);
  assert.deepEqual(a.abortWaitSleeps, b.abortWaitSleeps);
});

test("demo shows the payout webhook freshness window segment in-process: inside and at the boundary pass, stale and future-skewed fail closed", async () => {
  const {
    task,
    freshnessWebhook,
    freshnessMaxAgeMs,
    freshnessMaxFutureSkewMs,
    freshnessWithinWindow,
    freshnessAtBoundary,
    freshnessBeyondWindow,
    freshnessBeyondWindowSignatureOnly,
    freshnessFutureBeyondSkew,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // VerifyPayoutWebhookOptions docs in
  // src/settlementWebhook.ts and
  // test/payoutWebhookFreshness.test.ts /
  // test/payoutWebhookFutureSkew.test.ts, never derived by
  // calling verifyPayoutWebhook itself.
  assert.equal(freshnessWebhook.payload.taskId, "DEMO-001");
  assert.equal(freshnessWebhook.payload.event, "PAYOUT_COMPLETE");
  assert.equal(freshnessWebhook.payload.eventId, "evt_demo_freshness");
  assert.equal(freshnessWebhook.payload.at, "2026-03-28T09:00:00.000Z");
  assert.equal(freshnessWebhook.payload.payoutRef, "xfer-88f2");
  assert.equal(freshnessWebhook.payload.payoutAmount, 10098.5);
  assert.equal(freshnessMaxAgeMs, 3_600_000);
  assert.equal(freshnessMaxFutureSkewMs, 3_600_000);
  assert.equal(freshnessWithinWindow, true);
  assert.equal(freshnessAtBoundary, true);
  assert.equal(freshnessBeyondWindow, false);
  assert.equal(freshnessBeyondWindowSignatureOnly, true);
  assert.equal(freshnessFutureBeyondSkew, false);
  // Independent checks built in the test — the demo segment
  // is not self-certifying: a fresh notification built here
  // from the demo's PAID task under the same pinned time and
  // a fresh eventId reproduces every verdict on its own (the
  // scripts from the freshness / future-skew tests).
  const independent = buildPayoutWebhook(task, DEMO_WEBHOOK_SECRET, {
    eventId: "evt-test-freshness",
    now: new Date("2026-03-28T09:00:00.000Z"),
  });
  const independentBody = JSON.stringify(independent.payload);
  assert.equal(
    verifyPayoutWebhook(independentBody, independent.signature, DEMO_WEBHOOK_SECRET, {
      maxAgeMs: 3_600_000,
      now: new Date("2026-03-28T09:30:00.000Z"),
    }),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(independentBody, independent.signature, DEMO_WEBHOOK_SECRET, {
      maxAgeMs: 3_600_000,
      now: new Date("2026-03-28T10:00:00.000Z"),
    }),
    true,
    "age exactly maxAgeMs is inclusive",
  );
  assert.equal(
    verifyPayoutWebhook(independentBody, independent.signature, DEMO_WEBHOOK_SECRET, {
      maxAgeMs: 3_600_000,
      now: new Date("2026-03-28T10:00:00.001Z"),
    }),
    false,
    "one millisecond past the boundary fails",
  );
  assert.equal(
    verifyPayoutWebhook(independentBody, independent.signature, DEMO_WEBHOOK_SECRET, {
      maxAgeMs: 3_600_000,
      now: new Date("2026-03-28T11:00:00.000Z"),
    }),
    false,
  );
  assert.equal(
    verifyPayoutWebhook(independentBody, independent.signature, DEMO_WEBHOOK_SECRET),
    true,
    "without a window the same stale signature still verifies",
  );
  assert.equal(
    verifyPayoutWebhook(independentBody, independent.signature, DEMO_WEBHOOK_SECRET, {
      maxFutureSkewMs: 3_600_000,
      now: new Date("2026-03-28T07:00:00.000Z"),
    }),
    false,
  );
  assert.equal(
    verifyPayoutWebhook(independentBody, independent.signature, DEMO_WEBHOOK_SECRET, {
      maxAgeMs: 3_600_000,
      now: new Date("2026-03-28T07:00:00.000Z"),
    }),
    true,
    "maxAgeMs alone never bounds the future direction",
  );
  // The segment follows the payout webhook AbortSignal
  // segment and prints its lines verbatim (the payout
  // reference enforcement segment follows it, and the
  // dispatch idempotency key segment follows that, with
  // the keyed audit hash chain segment now closing the
  // demo after it).
  const freshnessAt = text.indexOf(
    "Payout webhook freshness window (verifyPayoutWebhook with { maxAgeMs } rejects a validly signed but stale notification):",
  );
  assert.ok(
    freshnessAt >
      text.indexOf(
        "Payout webhook AbortSignal abort (deliverPayoutWebhook honours an external AbortSignal, fake fetch + hanging fake sleep — no real network, no real wait):",
      ),
    "payout webhook freshness window segment must follow the payout webhook AbortSignal segment",
  );
  for (const line of [
    "  notification (main task DEMO-001, fixed signing time 2026-03-28T09:00:00.000Z): eventId evt_demo_freshness signed with the demo secret; freshness window maxAgeMs 3600000 ms (1 hour) — the secret itself is never printed",
    "  inside the window: receiver now 2026-03-28T09:30:00.000Z (30 minutes after signing) with maxAgeMs 3600000 -> verifies: true; boundary: receiver now 2026-03-28T10:00:00.000Z (exactly maxAgeMs after signing) -> verifies: true (the boundary is inclusive — only now - at > maxAgeMs fails)",
    "  stale replay fails closed: receiver now 2026-03-28T11:00:00.000Z (2 hours after signing, same body and signature) -> verifies: false (the signature alone still verifies: true — only the freshness gate rejects it, bounding replays of a legitimately signed old notification)",
    "  future skew fails closed: receiver now 2026-03-28T07:00:00.000Z (the payload at lies 2 hours ahead of the receiver) with maxFutureSkewMs 3600000 -> verifies: false (a sender clock set too far ahead gains no unbounded replay window — maxAgeMs alone never bounds the future direction)",
  ]) {
    assert.ok(text.includes(line), `missing freshness window line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Payout reference enforcement (requirePayoutRef: true rejects a PAYOUT_COMPLETE that carries no payoutRef):",
    ) > freshnessAt,
    "payout reference enforcement segment must follow the payout webhook freshness window segment",
  );
});

test("demo payout webhook freshness window segment is deterministic: two runs print byte-identical freshness lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout webhook freshness window (verifyPayoutWebhook with { maxAgeMs } rejects a validly signed but stale notification):"),
      ls.indexOf("Payout reference enforcement (requirePayoutRef: true rejects a PAYOUT_COMPLETE that carries no payoutRef):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + notification / inside-boundary / stale /
  // future-skew lines; every value in the segment is a
  // fixed literal (fixed signing time, injected receiver
  // clocks, pinned windows), so no normalization is
  // needed — the signature itself is asserted in-process
  // above, not printed here.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.freshnessWebhook, b.freshnessWebhook);
  assert.equal(a.freshnessMaxAgeMs, b.freshnessMaxAgeMs);
  assert.equal(a.freshnessMaxFutureSkewMs, b.freshnessMaxFutureSkewMs);
  assert.equal(a.freshnessWithinWindow, b.freshnessWithinWindow);
  assert.equal(a.freshnessAtBoundary, b.freshnessAtBoundary);
  assert.equal(a.freshnessBeyondWindow, b.freshnessBeyondWindow);
  assert.equal(
    a.freshnessBeyondWindowSignatureOnly,
    b.freshnessBeyondWindowSignatureOnly,
  );
  assert.equal(a.freshnessFutureBeyondSkew, b.freshnessFutureBeyondSkew);
});

test("demo shows the payout reference enforcement segment in-process: ref-less completion rejected, referenced completion settles, default stays advisory", async () => {
  const {
    requirePayoutRefTask,
    requirePayoutRefError,
    requirePayoutRefStateAfterReject,
    requirePayoutRefHistoryLengthAfterReject,
    requirePayoutRefPayoutRef,
    requirePayoutRefDefaultTask,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // TaskLifecycleOptions docs in src/taskLifecycle.ts and
  // test/requirePayoutRef.test.ts, never derived from the
  // gate itself.
  assert.equal(requirePayoutRefTask.id, "DEMO-024");
  assert.equal(requirePayoutRefTask.state, "PAID");
  assert.equal(requirePayoutRefTask.history.length, 8);
  assert.equal(
    requirePayoutRefError,
    "payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled",
  );
  assert.equal(requirePayoutRefStateAfterReject, "PAYOUT_PENDING");
  assert.equal(requirePayoutRefHistoryLengthAfterReject, 7);
  assert.equal(requirePayoutRefPayoutRef, "xfer-demo-require-ref");
  const enforcedLast =
    requirePayoutRefTask.history[requirePayoutRefTask.history.length - 1];
  assert.equal(enforcedLast.event, "PAYOUT_COMPLETE");
  assert.equal(enforcedLast.seq, 8);
  assert.equal(enforcedLast.payoutRef, "xfer-demo-require-ref");
  assert.equal(enforcedLast.at, "2026-03-29T09:40:00.000Z");
  assert.equal(requirePayoutRefDefaultTask.id, "DEMO-025");
  assert.equal(requirePayoutRefDefaultTask.state, "PAID");
  assert.equal(requirePayoutRefDefaultTask.history.length, 8);
  const defaultLast =
    requirePayoutRefDefaultTask.history[
      requirePayoutRefDefaultTask.history.length - 1
    ];
  assert.equal(defaultLast.event, "PAYOUT_COMPLETE");
  assert.equal(defaultLast.payoutRef, undefined);
  // Independent checks built in the test — the demo segment
  // is not self-certifying: fresh tasks driven here under
  // the same fixed timestamps reproduce every verdict on
  // their own (the script from the requirePayoutRef tests).
  const driveToPayoutPending = (
    id: string,
    opts?: { requirePayoutRef: boolean },
  ): TaskLifecycle => {
    const t = new TaskLifecycle(id, opts);
    for (const [event, actor, at] of [
      ["PUBLISH", "researcher", "2026-04-01T09:00:00.000Z"],
      ["ACCEPT", "contributor", "2026-04-01T09:05:00.000Z"],
      ["START_CAPTURE", "contributor", "2026-04-01T09:10:00.000Z"],
      ["SUBMIT", "contributor", "2026-04-01T09:15:00.000Z"],
      ["BEGIN_REVIEW", "reviewer", "2026-04-01T09:20:00.000Z"],
      ["APPROVE", "reviewer", "2026-04-01T09:25:00.000Z"],
      ["REQUEST_PAYOUT", "contributor", "2026-04-01T09:30:00.000Z"],
    ] as const) {
      t.dispatch(event, { actor, at });
    }
    return t;
  };
  const independentEnforced = driveToPayoutPending("test-rpr-enforced", {
    requirePayoutRef: true,
  });
  assert.throws(
    () =>
      independentEnforced.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        at: "2026-04-01T09:35:00.000Z",
      }),
    /payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled/,
  );
  assert.equal(independentEnforced.state, "PAYOUT_PENDING");
  assert.equal(independentEnforced.history.length, 7);
  independentEnforced.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    at: "2026-04-01T09:40:00.000Z",
    payoutRef: "xfer-test-rpr",
  });
  assert.equal(independentEnforced.state, "PAID");
  assert.equal(
    independentEnforced.history[independentEnforced.history.length - 1]
      .payoutRef,
    "xfer-test-rpr",
  );
  const independentDefault = driveToPayoutPending("test-rpr-default");
  independentDefault.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    at: "2026-04-01T09:35:00.000Z",
  });
  assert.equal(independentDefault.state, "PAID");
  assert.equal(
    independentDefault.history[independentDefault.history.length - 1]
      .payoutRef,
    undefined,
  );
  // The segment follows the payout webhook freshness
  // window segment and prints its lines verbatim (the
  // dispatch idempotency key segment follows it, and the
  // keyed audit hash chain segment now closes the demo
  // after that).
  const enforcementAt = text.indexOf(
    "Payout reference enforcement (requirePayoutRef: true rejects a PAYOUT_COMPLETE that carries no payoutRef):",
  );
  assert.ok(
    enforcementAt >
      text.indexOf(
        "Payout webhook freshness window (verifyPayoutWebhook with { maxAgeMs } rejects a validly signed but stale notification):",
      ),
    "payout reference enforcement segment must follow the payout webhook freshness window segment",
  );
  for (const line of [
    "  enforced task DEMO-024 (constructed with requirePayoutRef: true, driven to PAYOUT_PENDING under fixed timestamps): PAYOUT_COMPLETE without a payoutRef -> rejected: \"payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled\"; state after rejection: PAYOUT_PENDING, history entries: 7 (nothing was appended — the gate is fail-fast, checked before the audit entry is written)",
    "  enforced task with the reference: PAYOUT_COMPLETE with payoutRef \"xfer-demo-require-ref\" at 2026-03-29T09:40:00.000Z -> PAID; history last entry: seq 8 PAYOUT_COMPLETE payoutRef=xfer-demo-require-ref (the audit trail now names the transfer the settlement claims)",
    "  default task DEMO-025 (requirePayoutRef unset — the advisory default): PAYOUT_COMPLETE without a payoutRef -> PAID; history last entry carries no payoutRef (backward compatible: enforcement is opt-in, so an unenforced task still settles on the advisory path)",
  ]) {
    assert.ok(text.includes(line), `missing enforcement line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Dispatch idempotency keys (dispatch with { idempotencyKey } makes a retried dispatch a no-op):",
    ) > enforcementAt,
    "dispatch idempotency key segment must follow the payout reference enforcement segment",
  );
});

test("demo payout reference enforcement segment is deterministic: two runs print byte-identical enforcement lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Payout reference enforcement (requirePayoutRef: true rejects a PAYOUT_COMPLETE that carries no payoutRef):"),
      ls.indexOf("Dispatch idempotency keys (dispatch with { idempotencyKey } makes a retried dispatch a no-op):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + enforced-rejection / enforced-acceptance /
  // default lines; every value in the segment is a fixed
  // literal (fixed timestamps, a pinned error, a pinned
  // payoutRef), so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.requirePayoutRefTask.state, b.requirePayoutRefTask.state);
  assert.deepEqual(a.requirePayoutRefTask.history, b.requirePayoutRefTask.history);
  assert.equal(a.requirePayoutRefError, b.requirePayoutRefError);
  assert.equal(
    a.requirePayoutRefStateAfterReject,
    b.requirePayoutRefStateAfterReject,
  );
  assert.equal(
    a.requirePayoutRefHistoryLengthAfterReject,
    b.requirePayoutRefHistoryLengthAfterReject,
  );
  assert.equal(a.requirePayoutRefPayoutRef, b.requirePayoutRefPayoutRef);
  assert.equal(
    a.requirePayoutRefDefaultTask.state,
    b.requirePayoutRefDefaultTask.state,
  );
  assert.deepEqual(
    a.requirePayoutRefDefaultTask.history,
    b.requirePayoutRefDefaultTask.history,
  );
});

test("demo shows the dispatch idempotency key segment in-process: same-key duplicate no-ops, old key dedupes across events and past progress, failed dispatch consumes no key", async () => {
  const {
    idempotencyTask,
    idempotencyPublishKey,
    idempotencyDuplicateReturn,
    idempotencyHistoryLengthAfterDuplicate,
    idempotencyNotificationEvents,
    idempotencyCrossEventReturn,
    idempotencyStaleReturn,
    idempotencyHistoryLengthAfterRetries,
    idempotencyRetryTask,
    idempotencyFailedError,
    idempotencyRetryKey,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // DispatchOptions docs in src/taskLifecycle.ts and
  // test/idempotencyKey.test.ts, never derived from the
  // dedupe itself.
  assert.equal(idempotencyTask.id, "DEMO-026");
  assert.equal(idempotencyTask.state, "ACCEPTED");
  assert.equal(idempotencyTask.history.length, 2);
  assert.equal(idempotencyPublishKey, "demo-idem-publish");
  assert.equal(idempotencyDuplicateReturn, "OPEN");
  assert.equal(idempotencyHistoryLengthAfterDuplicate, 1);
  assert.deepEqual(idempotencyNotificationEvents, ["PUBLISH", "ACCEPT"]);
  assert.equal(idempotencyCrossEventReturn, "ACCEPTED");
  assert.equal(idempotencyStaleReturn, "ACCEPTED");
  assert.equal(idempotencyHistoryLengthAfterRetries, 2);
  assert.equal(idempotencyTask.history[0].event, "PUBLISH");
  assert.equal(idempotencyTask.history[0].at, "2026-04-02T09:00:00.000Z");
  assert.equal(idempotencyTask.history[1].event, "ACCEPT");
  assert.equal(idempotencyTask.history[1].at, "2026-04-02T09:05:00.000Z");
  assert.deepEqual(idempotencyTask.toJSON().idempotencyKeys, [
    "demo-idem-publish",
    "demo-idem-accept",
  ]);
  assert.equal(idempotencyRetryTask.id, "DEMO-027");
  assert.equal(idempotencyRetryTask.state, "ACCEPTED");
  assert.equal(idempotencyRetryTask.history.length, 2);
  assert.equal(idempotencyFailedError, "invalid transition: ACCEPT from DRAFT");
  assert.equal(idempotencyRetryKey, "demo-idem-retry");
  assert.equal(idempotencyRetryTask.history[0].event, "PUBLISH");
  assert.equal(idempotencyRetryTask.history[0].at, "2026-04-03T09:05:00.000Z");
  assert.equal(idempotencyRetryTask.history[1].event, "ACCEPT");
  // Independent checks built in the test — the demo segment
  // is not self-certifying: fresh tasks driven here under
  // fixed timestamps reproduce every verdict on their own
  // (the script from the idempotency key tests).
  const independent = new TaskLifecycle("test-idem-main");
  const seen: string[] = [];
  independent.subscribe((event) => {
    seen.push(event);
  });
  independent.dispatch("PUBLISH", {
    at: "2026-04-05T09:00:00.000Z",
    idempotencyKey: "test-key-1",
  });
  assert.equal(
    independent.dispatch("PUBLISH", {
      at: "2026-04-05T09:01:00.000Z",
      idempotencyKey: "test-key-1",
    }),
    "OPEN",
  );
  assert.equal(independent.history.length, 1);
  independent.dispatch("ACCEPT", {
    at: "2026-04-05T09:05:00.000Z",
    idempotencyKey: "test-key-2",
  });
  assert.equal(
    independent.dispatch("START_CAPTURE", {
      at: "2026-04-05T09:06:00.000Z",
      idempotencyKey: "test-key-1",
    }),
    "ACCEPTED",
    "a known key dedupes even for a different event",
  );
  assert.equal(
    independent.dispatch("PUBLISH", {
      at: "2026-04-05T09:07:00.000Z",
      idempotencyKey: "test-key-1",
    }),
    "ACCEPTED",
    "a known key returns the current state without validating the transition",
  );
  assert.equal(independent.history.length, 2);
  assert.deepEqual(seen, ["PUBLISH", "ACCEPT"]);
  const independentRetry = new TaskLifecycle("test-idem-retry");
  assert.throws(
    () =>
      independentRetry.dispatch("ACCEPT", {
        at: "2026-04-05T09:00:00.000Z",
        idempotencyKey: "test-retry",
      }),
    /invalid transition: ACCEPT from DRAFT/,
  );
  assert.equal(independentRetry.history.length, 0);
  independentRetry.dispatch("PUBLISH", {
    at: "2026-04-05T09:05:00.000Z",
    idempotencyKey: "test-retry",
  });
  assert.equal(independentRetry.state, "OPEN");
  independentRetry.dispatch("ACCEPT", { at: "2026-04-05T09:10:00.000Z" });
  assert.equal(independentRetry.state, "ACCEPTED");
  assert.equal(independentRetry.history.length, 2);
  // The segment follows the payout reference
  // enforcement segment and prints its lines verbatim
  // (the keyed audit hash chain segment now closes the
  // demo after it).
  const idempotencyAt = text.indexOf(
    "Dispatch idempotency keys (dispatch with { idempotencyKey } makes a retried dispatch a no-op):",
  );
  assert.ok(
    idempotencyAt >
      text.indexOf(
        "Payout reference enforcement (requirePayoutRef: true rejects a PAYOUT_COMPLETE that carries no payoutRef):",
      ),
    "dispatch idempotency key segment must follow the payout reference enforcement segment",
  );
  for (const line of [
    "  same key, same event (DEMO-026): PUBLISH with idempotencyKey \"demo-idem-publish\" at 2026-04-02T09:00:00.000Z -> OPEN, history entries: 1; the same PUBLISH under the same key again -> returns OPEN, history entries: 1 (nothing was appended and the listener was not notified again — a redelivered request is answered from the consumed-key set, not re-executed)",
    "  keys are global and survive progress (DEMO-026): ACCEPT under a second key -> ACCEPTED, history entries: 2; START_CAPTURE under the old key \"demo-idem-publish\" (a different, would-be legal event) -> returns ACCEPTED, history entries: 2; the stale PUBLISH under that same old key (now an illegal transition) -> returns ACCEPTED without throwing (the transition is not even validated for a known key — a late retry is safe to replay); listener notifications: [PUBLISH, ACCEPT] (only the two real dispatches ever notified)",
    "  a failed dispatch consumes no key (DEMO-027): ACCEPT from DRAFT with idempotencyKey \"demo-idem-retry\" -> rejected: \"invalid transition: ACCEPT from DRAFT\"; history entries after the failure: 0; the corrected PUBLISH under the same key -> OPEN (the key was still free, so the retry executed instead of deduping)",
    "  no key, no change (DEMO-027): ACCEPT with no idempotencyKey -> ACCEPTED; history entries: 2 (omitting the key preserves the exact pre-idempotency behavior — every keyless dispatch still validates and appends normally)",
  ]) {
    assert.ok(text.includes(line), `missing idempotency line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Keyed audit hash chain (verifyHistoryChain with { auditSecret } verifies an HMAC-chained history only under its secret):",
    ) > idempotencyAt,
    "keyed audit hash chain segment must follow the dispatch idempotency key segment",
  );
});

test("demo dispatch idempotency key segment is deterministic: two runs print byte-identical idempotency lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Dispatch idempotency keys (dispatch with { idempotencyKey } makes a retried dispatch a no-op):"),
      ls.indexOf("Keyed audit hash chain (verifyHistoryChain with { auditSecret } verifies an HMAC-chained history only under its secret):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + same-key / global-keys / failed-dispatch /
  // no-key lines; every value in the segment is a fixed
  // literal (fixed timestamps, pinned keys, a pinned
  // error), so no normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.idempotencyTask.state, b.idempotencyTask.state);
  assert.deepEqual(a.idempotencyTask.history, b.idempotencyTask.history);
  assert.equal(a.idempotencyPublishKey, b.idempotencyPublishKey);
  assert.equal(a.idempotencyDuplicateReturn, b.idempotencyDuplicateReturn);
  assert.equal(
    a.idempotencyHistoryLengthAfterDuplicate,
    b.idempotencyHistoryLengthAfterDuplicate,
  );
  assert.deepEqual(
    a.idempotencyNotificationEvents,
    b.idempotencyNotificationEvents,
  );
  assert.equal(a.idempotencyCrossEventReturn, b.idempotencyCrossEventReturn);
  assert.equal(a.idempotencyStaleReturn, b.idempotencyStaleReturn);
  assert.equal(
    a.idempotencyHistoryLengthAfterRetries,
    b.idempotencyHistoryLengthAfterRetries,
  );
  assert.equal(a.idempotencyRetryTask.state, b.idempotencyRetryTask.state);
  assert.deepEqual(a.idempotencyRetryTask.history, b.idempotencyRetryTask.history);
  assert.equal(a.idempotencyFailedError, b.idempotencyFailedError);
  assert.equal(a.idempotencyRetryKey, b.idempotencyRetryKey);
});

test("demo shows the keyed audit hash chain segment in-process: correct secret verifies, wrong secret and tampered copy and no secret all fail closed", async () => {
  const {
    auditSecretTask,
    auditSecretVerified,
    auditSecretWrongVerified,
    auditSecretTamperedVerified,
    auditSecretUnkeyedVerified,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // TaskLifecycleOptions docs in src/taskLifecycle.ts and
  // test/keyedHashChain.test.ts, never derived from the
  // verification itself.
  assert.equal(DEMO_AUDIT_SECRET, "demo-audit-secret");
  assert.equal(DEMO_AUDIT_WRONG_SECRET, "demo-audit-secret-wrong");
  assert.equal(auditSecretTask.id, "DEMO-028");
  assert.equal(auditSecretTask.state, "SUBMITTED");
  assert.equal(auditSecretTask.history.length, 4);
  assert.equal(auditSecretVerified, true);
  assert.equal(auditSecretWrongVerified, false);
  assert.equal(auditSecretTamperedVerified, false);
  assert.equal(auditSecretUnkeyedVerified, false);
  assert.equal(auditSecretTask.history[0].prevHash, "GENESIS");
  assert.equal(auditSecretTask.history[0].event, "PUBLISH");
  assert.equal(auditSecretTask.history[0].at, "2026-04-04T09:00:00.000Z");
  assert.equal(auditSecretTask.history[3].event, "SUBMIT");
  assert.equal(auditSecretTask.history[3].at, "2026-04-04T09:15:00.000Z");
  for (let i = 1; i < auditSecretTask.history.length; i++) {
    assert.equal(
      auditSecretTask.history[i].prevHash,
      auditSecretTask.history[i - 1].hash,
    );
  }
  // Independent checks built in the test — the demo segment
  // is not self-certifying: a fresh keyed task driven here
  // under the same fixed timestamps reproduces every
  // verdict on its own (the script from the keyed
  // hash-chain tests).
  const independent = new TaskLifecycle("test-keyed-demo", {
    auditSecret: DEMO_AUDIT_SECRET,
  });
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-04-04T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-04-04T09:05:00.000Z"],
    ["START_CAPTURE", "contributor", "2026-04-04T09:10:00.000Z"],
    ["SUBMIT", "contributor", "2026-04-04T09:15:00.000Z"],
  ] as const) {
    independent.dispatch(event, { actor, at });
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(independent.history)),
    JSON.parse(JSON.stringify(auditSecretTask.history)),
  );
  assert.equal(
    verifyHistoryChain(independent.history, {
      auditSecret: DEMO_AUDIT_SECRET,
    }),
    true,
  );
  assert.equal(
    verifyHistoryChain(independent.history, {
      auditSecret: DEMO_AUDIT_WRONG_SECRET,
    }),
    false,
  );
  assert.equal(verifyHistoryChain(independent.history), false);
  const independentTampered = independent.history.map((e) => ({ ...e }));
  independentTampered[2] = { ...independentTampered[2], payoutAmount: 999 };
  assert.equal(
    verifyHistoryChain(independentTampered, {
      auditSecret: DEMO_AUDIT_SECRET,
    }),
    false,
  );
  assert.equal(
    verifyHistoryChain(independent.history, {
      auditSecret: DEMO_AUDIT_SECRET,
    }),
    true,
  );
  // The segment follows the dispatch idempotency key
  // segment and prints its lines verbatim (the event-level
  // RBAC segment follows it, and the preseeded idempotency
  // keys segment now closes the demo).
  const auditAt = text.indexOf(
    "Keyed audit hash chain (verifyHistoryChain with { auditSecret } verifies an HMAC-chained history only under its secret):",
  );
  assert.ok(
    auditAt >
      text.indexOf(
        "Dispatch idempotency keys (dispatch with { idempotencyKey } makes a retried dispatch a no-op):",
      ),
    "keyed audit hash chain segment must follow the dispatch idempotency key segment",
  );
  for (const line of [
    "  keyed task DEMO-028 (constructed with auditSecret, driven PUBLISH -> SUBMIT under fixed timestamps): history entries: 4; verifyHistoryChain with the correct secret: true (every link is HMAC-SHA256 keyed by the pinned secret — the secret itself is never printed)",
    "  wrong secret: verifyHistoryChain: false (the same history under a different secret recomputes no link — verification fails closed as false, never a throw)",
    "  tampered copy: middle entry START_CAPTURE gains payoutAmount 999 — verifyHistoryChain with the correct secret: false (tamper detected: the stored HMAC no longer recomputes); original history after the tamper check: verifyHistoryChain: true (detached copy — the keyed task's own history is untouched)",
    "  no secret: verifyHistoryChain without a secret: false (a keyed chain never verifies unkeyed — fail-closed both ways, exactly as an unkeyed chain never verifies under a secret)",
  ]) {
    assert.ok(text.includes(line), `missing keyed audit line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Event-level RBAC (rolePolicy gates covered events to the listed actors):",
    ) > auditAt,
    "event-level RBAC segment must follow the keyed audit hash chain segment",
  );
});

test("demo keyed audit hash chain segment is deterministic: two runs print byte-identical keyed lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Keyed audit hash chain (verifyHistoryChain with { auditSecret } verifies an HMAC-chained history only under its secret):"),
      ls.indexOf("Event-level RBAC (rolePolicy gates covered events to the listed actors):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + correct-secret / wrong-secret / tampered /
  // no-secret lines; every value in the segment is a
  // fixed literal (a pinned secret, fixed timestamps),
  // so no normalization is needed — the hashes themselves
  // are asserted in-process above, not printed here.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.auditSecretTask.state, b.auditSecretTask.state);
  assert.deepEqual(a.auditSecretTask.history, b.auditSecretTask.history);
  assert.equal(a.auditSecretVerified, b.auditSecretVerified);
  assert.equal(a.auditSecretWrongVerified, b.auditSecretWrongVerified);
  assert.equal(a.auditSecretTamperedVerified, b.auditSecretTamperedVerified);
  assert.equal(a.auditSecretUnkeyedVerified, b.auditSecretUnkeyedVerified);
});

test("demo shows the event-level RBAC segment in-process: allowlisted actors advance, wrong or missing actors are rejected without a trace, uncovered events and policy-free tasks are unrestricted", async () => {
  const {
    rolePolicyTask,
    rolePolicy,
    rolePolicyPublishUnauthorizedError,
    rolePolicyPublishMissingActorError,
    rolePolicyStateAfterPublishRejects,
    rolePolicyHistoryLengthAfterPublishRejects,
    rolePolicyArbitrateUnauthorizedError,
    rolePolicyArbitrateMissingActorError,
    rolePolicyStateAfterArbitrateRejects,
    rolePolicyHistoryLengthAfterArbitrateRejects,
    rolePolicyDefaultTask,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // TaskLifecycleOptions docs in src/taskLifecycle.ts and
  // test/rbac.test.ts, never derived from the gate itself.
  assert.deepEqual(DEMO_ROLE_POLICY, {
    PUBLISH: ["researcher"],
    ACCEPT: ["contributor"],
    ARBITRATE_APPROVE: ["senior-moderator"],
    ARBITRATE_REJECT: ["senior-moderator"],
  });
  assert.deepEqual(rolePolicy, DEMO_ROLE_POLICY);
  assert.equal(rolePolicyTask.id, "DEMO-029");
  assert.equal(rolePolicyTask.state, "APPROVED");
  assert.equal(rolePolicyTask.history.length, 8);
  assert.equal(
    rolePolicyPublishUnauthorizedError,
    'actor not authorized for PUBLISH: "contributor" is not in [researcher]',
  );
  assert.equal(
    rolePolicyPublishMissingActorError,
    "actor not authorized for PUBLISH: policy requires an actor in [researcher]",
  );
  assert.equal(rolePolicyStateAfterPublishRejects, "DRAFT");
  assert.equal(rolePolicyHistoryLengthAfterPublishRejects, 0);
  assert.equal(
    rolePolicyArbitrateUnauthorizedError,
    'actor not authorized for ARBITRATE_APPROVE: "contributor" is not in [senior-moderator]',
  );
  assert.equal(
    rolePolicyArbitrateMissingActorError,
    "actor not authorized for ARBITRATE_APPROVE: policy requires an actor in [senior-moderator]",
  );
  assert.equal(rolePolicyStateAfterArbitrateRejects, "DISPUTED");
  assert.equal(rolePolicyHistoryLengthAfterArbitrateRejects, 7);
  assert.equal(rolePolicyTask.history[0].event, "PUBLISH");
  assert.equal(rolePolicyTask.history[0].actor, "researcher");
  assert.equal(rolePolicyTask.history[0].at, "2026-04-06T09:00:00.000Z");
  assert.equal(rolePolicyTask.history[2].actor, undefined);
  assert.equal(rolePolicyTask.history[7].event, "ARBITRATE_APPROVE");
  assert.equal(rolePolicyTask.history[7].actor, "senior-moderator");
  assert.equal(rolePolicyTask.history[7].at, "2026-04-06T09:40:00.000Z");
  assert.equal(rolePolicyDefaultTask.id, "DEMO-030");
  assert.equal(rolePolicyDefaultTask.state, "APPROVED");
  assert.equal(rolePolicyDefaultTask.history.length, 8);
  assert.equal(rolePolicyDefaultTask.history[7].event, "ARBITRATE_APPROVE");
  assert.equal(rolePolicyDefaultTask.history[7].actor, undefined);
  // Independent checks built in the test — the demo segment
  // is not self-certifying: fresh tasks driven here under
  // the same policy and fixed timestamps reproduce every
  // verdict on their own (the script from the RBAC tests).
  const independent = new TaskLifecycle("test-rbac-demo", {
    rolePolicy: DEMO_ROLE_POLICY,
  });
  assert.throws(
    () =>
      independent.dispatch("PUBLISH", {
        actor: "contributor",
        at: "2026-04-06T09:00:00.000Z",
      }),
    /actor not authorized for PUBLISH: "contributor" is not in \[researcher\]/,
  );
  assert.throws(
    () => independent.dispatch("PUBLISH", { at: "2026-04-06T09:00:00.000Z" }),
    /actor not authorized for PUBLISH: policy requires an actor in \[researcher\]/,
  );
  assert.equal(independent.state, "DRAFT");
  assert.equal(independent.history.length, 0);
  independent.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-06T09:00:00.000Z",
  });
  independent.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-04-06T09:05:00.000Z",
  });
  for (const [event, at] of [
    ["START_CAPTURE", "2026-04-06T09:10:00.000Z"],
    ["SUBMIT", "2026-04-06T09:15:00.000Z"],
    ["BEGIN_REVIEW", "2026-04-06T09:20:00.000Z"],
    ["REJECT", "2026-04-06T09:25:00.000Z"],
    ["DISPUTE", "2026-04-06T09:30:00.000Z"],
  ] as const) {
    independent.dispatch(event, { at });
  }
  assert.equal(independent.state, "DISPUTED");
  assert.throws(
    () =>
      independent.dispatch("ARBITRATE_APPROVE", {
        actor: "contributor",
        at: "2026-04-06T09:35:00.000Z",
      }),
    /actor not authorized for ARBITRATE_APPROVE: "contributor" is not in \[senior-moderator\]/,
  );
  assert.equal(independent.history.length, 7);
  independent.dispatch("ARBITRATE_APPROVE", {
    actor: "senior-moderator",
    at: "2026-04-06T09:40:00.000Z",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(independent.history)),
    JSON.parse(JSON.stringify(rolePolicyTask.history)),
  );
  const independentDefault = new TaskLifecycle("test-rbac-demo-default");
  for (const [event, at] of [
    ["PUBLISH", "2026-04-06T09:00:00.000Z"],
    ["ACCEPT", "2026-04-06T09:05:00.000Z"],
    ["START_CAPTURE", "2026-04-06T09:10:00.000Z"],
    ["SUBMIT", "2026-04-06T09:15:00.000Z"],
    ["BEGIN_REVIEW", "2026-04-06T09:20:00.000Z"],
    ["REJECT", "2026-04-06T09:25:00.000Z"],
    ["DISPUTE", "2026-04-06T09:30:00.000Z"],
    ["ARBITRATE_APPROVE", "2026-04-06T09:35:00.000Z"],
  ] as const) {
    independentDefault.dispatch(event, { at });
  }
  assert.equal(independentDefault.state, "APPROVED");
  // The segment follows the keyed audit hash chain
  // segment and prints its lines verbatim (the preseeded
  // idempotency keys segment now closes the demo after it).
  const rbacAt = text.indexOf(
    "Event-level RBAC (rolePolicy gates covered events to the listed actors):",
  );
  assert.ok(
    rbacAt >
      text.indexOf(
        "Keyed audit hash chain (verifyHistoryChain with { auditSecret } verifies an HMAC-chained history only under its secret):",
      ),
    "event-level RBAC segment must follow the keyed audit hash chain segment",
  );
  for (const line of [
    "  policy task DEMO-029 (constructed with rolePolicy { PUBLISH: [researcher], ACCEPT: [contributor], ARBITRATE_APPROVE: [senior-moderator], ARBITRATE_REJECT: [senior-moderator] }): PUBLISH by researcher at 2026-04-06T09:00:00.000Z -> OPEN; ACCEPT by contributor -> ACCEPTED (the allowlist is an authorization check on the actor name, not identity authentication — a real deployment authenticates its actors itself)",
    "  covered event, wrong or missing actor (DEMO-029): PUBLISH by contributor -> rejected: \"actor not authorized for PUBLISH: \"contributor\" is not in [researcher]\"; PUBLISH with no actor -> rejected: \"actor not authorized for PUBLISH: policy requires an actor in [researcher]\"; state after both rejections: DRAFT, history entries: 0 (a rejected dispatch appends nothing — the check runs before the audit entry is written)",
    "  uncovered events are unrestricted (DEMO-029): START_CAPTURE, SUBMIT, BEGIN_REVIEW, REJECT and DISPUTE with no actor at all -> DISPUTED, history entries: 7 (the policy lists only PUBLISH, ACCEPT and the two arbitration events — every other event skips the check entirely)",
    "  arbitration is moderator-only (DEMO-029): ARBITRATE_APPROVE by contributor -> rejected: \"actor not authorized for ARBITRATE_APPROVE: \"contributor\" is not in [senior-moderator]\"; ARBITRATE_APPROVE with no actor -> rejected: \"actor not authorized for ARBITRATE_APPROVE: policy requires an actor in [senior-moderator]\"; state after both rejections: DISPUTED, history entries: 7; ARBITRATE_APPROVE by senior-moderator -> APPROVED, history entries: 8",
    "  no policy, no check (DEMO-030): a task constructed without rolePolicy is driven to DISPUTED and arbitrated with no actor at all -> APPROVED, history entries: 8 (omitting the policy preserves the exact pre-policy behavior — no event requires an actor anywhere)",
  ]) {
    assert.ok(text.includes(line), `missing RBAC line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Preseeded idempotency keys (idempotencyKeys seeds a task with already-consumed dispatch keys):",
    ) > rbacAt,
    "preseeded idempotency keys segment must follow the event-level RBAC segment",
  );
});

test("demo event-level RBAC segment is deterministic: two runs print byte-identical RBAC lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Event-level RBAC (rolePolicy gates covered events to the listed actors):"),
      ls.indexOf("Preseeded idempotency keys (idempotencyKeys seeds a task with already-consumed dispatch keys):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + policy / covered-rejection / uncovered /
  // arbitration / no-policy lines; every value in the
  // segment is a fixed literal (a pinned policy, fixed
  // timestamps, pinned errors), so no normalization is
  // needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.rolePolicy, b.rolePolicy);
  assert.equal(a.rolePolicyTask.state, b.rolePolicyTask.state);
  assert.deepEqual(a.rolePolicyTask.history, b.rolePolicyTask.history);
  assert.equal(
    a.rolePolicyPublishUnauthorizedError,
    b.rolePolicyPublishUnauthorizedError,
  );
  assert.equal(
    a.rolePolicyPublishMissingActorError,
    b.rolePolicyPublishMissingActorError,
  );
  assert.equal(
    a.rolePolicyStateAfterPublishRejects,
    b.rolePolicyStateAfterPublishRejects,
  );
  assert.equal(
    a.rolePolicyHistoryLengthAfterPublishRejects,
    b.rolePolicyHistoryLengthAfterPublishRejects,
  );
  assert.equal(
    a.rolePolicyArbitrateUnauthorizedError,
    b.rolePolicyArbitrateUnauthorizedError,
  );
  assert.equal(
    a.rolePolicyArbitrateMissingActorError,
    b.rolePolicyArbitrateMissingActorError,
  );
  assert.equal(
    a.rolePolicyStateAfterArbitrateRejects,
    b.rolePolicyStateAfterArbitrateRejects,
  );
  assert.equal(
    a.rolePolicyHistoryLengthAfterArbitrateRejects,
    b.rolePolicyHistoryLengthAfterArbitrateRejects,
  );
  assert.equal(a.rolePolicyDefaultTask.state, b.rolePolicyDefaultTask.state);
  assert.deepEqual(
    a.rolePolicyDefaultTask.history,
    b.rolePolicyDefaultTask.history,
  );
});

test("demo shows the preseeded idempotency keys segment in-process: seeded keys dedupe and no-op, fresh keys advance and are consumed, an empty seed is rejected, and a seed-free task is unchanged", async () => {
  const {
    seededIdempotencyTask,
    seededIdempotencyKeys,
    seededIdempotencySnapshotKeysAfterSeed,
    seededIdempotencyNoopReturn,
    seededIdempotencyStateAfterNoop,
    seededIdempotencyHistoryLengthAfterNoop,
    seededIdempotencyNotificationCountAfterNoop,
    seededIdempotencyNotificationEvents,
    seededIdempotencySnapshotKeysAfterFreshKeys,
    seededIdempotencyEmptySeedError,
    seededIdempotencyDefaultTask,
    seededIdempotencyDefaultSnapshotKeys,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // TaskLifecycleOptions docs in src/taskLifecycle.ts and
  // test/idempotencyKeySnapshot.test.ts, never derived from
  // the seeding itself.
  assert.deepEqual(DEMO_SEEDED_IDEMPOTENCY_KEYS, [
    "demo-seed-publish",
    "demo-seed-accept",
  ]);
  assert.deepEqual(seededIdempotencyKeys, DEMO_SEEDED_IDEMPOTENCY_KEYS);
  assert.equal(seededIdempotencyTask.id, "DEMO-031");
  assert.deepEqual(seededIdempotencySnapshotKeysAfterSeed, [
    "demo-seed-publish",
    "demo-seed-accept",
  ]);
  assert.equal(seededIdempotencyNoopReturn, "DRAFT");
  assert.equal(seededIdempotencyStateAfterNoop, "DRAFT");
  assert.equal(seededIdempotencyHistoryLengthAfterNoop, 0);
  assert.equal(seededIdempotencyNotificationCountAfterNoop, 0);
  assert.equal(seededIdempotencyTask.state, "ACCEPTED");
  assert.equal(seededIdempotencyTask.history.length, 2);
  assert.equal(seededIdempotencyTask.history[0].event, "PUBLISH");
  assert.equal(seededIdempotencyTask.history[0].at, "2026-04-07T09:05:00.000Z");
  assert.equal(seededIdempotencyTask.history[1].event, "ACCEPT");
  assert.equal(seededIdempotencyTask.history[1].at, "2026-04-07T09:10:00.000Z");
  assert.deepEqual(seededIdempotencyNotificationEvents, ["PUBLISH", "ACCEPT"]);
  assert.deepEqual(seededIdempotencySnapshotKeysAfterFreshKeys, [
    "demo-seed-publish",
    "demo-seed-accept",
    "demo-fresh-publish",
    "demo-fresh-accept",
  ]);
  assert.deepEqual(seededIdempotencyTask.toJSON().idempotencyKeys, [
    "demo-seed-publish",
    "demo-seed-accept",
    "demo-fresh-publish",
    "demo-fresh-accept",
  ]);
  assert.equal(
    seededIdempotencyEmptySeedError,
    'invalid option: idempotencyKeys entries must be non-empty strings, got ""',
  );
  assert.equal(seededIdempotencyDefaultTask.id, "DEMO-032");
  assert.equal(seededIdempotencyDefaultTask.state, "OPEN");
  assert.equal(seededIdempotencyDefaultTask.history.length, 1);
  assert.equal(seededIdempotencyDefaultSnapshotKeys, undefined);
  assert.equal(seededIdempotencyDefaultTask.toJSON().idempotencyKeys, undefined);
  // Independent checks built in the test — the demo segment
  // is not self-certifying: fresh tasks driven here with the
  // same seed and fixed timestamps reproduce every verdict
  // on their own (the script from the snapshot tests).
  const independent = new TaskLifecycle("test-seeded-demo", {
    idempotencyKeys: [
      "demo-seed-publish",
      "demo-seed-publish",
      "demo-seed-accept",
    ],
  });
  assert.deepEqual(independent.toJSON().idempotencyKeys, [
    "demo-seed-publish",
    "demo-seed-accept",
  ]);
  assert.equal(
    independent.dispatch("ACCEPT", {
      actor: "contributor",
      at: "2026-04-07T09:00:00.000Z",
      idempotencyKey: "demo-seed-accept",
    }),
    "DRAFT",
  );
  assert.equal(independent.state, "DRAFT");
  assert.equal(independent.history.length, 0);
  independent.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-07T09:05:00.000Z",
    idempotencyKey: "demo-fresh-publish",
  });
  independent.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-04-07T09:10:00.000Z",
    idempotencyKey: "demo-fresh-accept",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(independent.history)),
    JSON.parse(JSON.stringify(seededIdempotencyTask.history)),
  );
  assert.throws(
    () =>
      new TaskLifecycle("test-seeded-demo-empty", { idempotencyKeys: [""] }),
    /invalid option: idempotencyKeys entries must be non-empty strings, got ""/,
  );
  const independentDefault = new TaskLifecycle("test-seeded-demo-default");
  independentDefault.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-07T09:00:00.000Z",
  });
  assert.equal(independentDefault.state, "OPEN");
  assert.equal(independentDefault.toJSON().idempotencyKeys, undefined);
  // The segment follows the event-level RBAC segment
  // and prints its lines verbatim (the payout webhook
  // timeout segment now closes the demo after it).
  const seededAt = text.indexOf(
    "Preseeded idempotency keys (idempotencyKeys seeds a task with already-consumed dispatch keys):",
  );
  assert.ok(
    seededAt >
      text.indexOf(
        "Event-level RBAC (rolePolicy gates covered events to the listed actors):",
      ),
    "preseeded idempotency keys segment must follow the event-level RBAC segment",
  );
  for (const line of [
    `  seeded task DEMO-031 (constructed with idempotencyKeys ["demo-seed-publish", "demo-seed-publish", "demo-seed-accept"]): duplicate seed entries are deduped, first occurrence wins — snapshot idempotencyKeys: ["demo-seed-publish","demo-seed-accept"] (the re-attachment path for fromHistory(), whose audit log cannot carry the key set — keys are dispatch configuration, not audit data)`,
    `  seeded key, illegal event (DEMO-031): ACCEPT with idempotencyKey "demo-seed-accept" from DRAFT (no ACCEPT edge leaves DRAFT) -> returns DRAFT; state after: DRAFT, history entries: 0, listener notifications: 0 (a consumed key is a complete no-op — the transition is not even validated, nothing is appended, no listener is notified)`,
    `  same event, fresh keys (DEMO-031): PUBLISH with idempotencyKey "demo-fresh-publish" -> OPEN; ACCEPT with idempotencyKey "demo-fresh-accept" -> ACCEPTED, history entries: 2; snapshot idempotencyKeys after both: ["demo-seed-publish","demo-seed-accept","demo-fresh-publish","demo-fresh-accept"] (each fresh key is consumed by its successful dispatch — a later retry under either is a no-op)`,
    `  invalid seed (construction): idempotencyKeys [""] -> rejected: "invalid option: idempotencyKeys entries must be non-empty strings, got """ (every seed must be a non-empty string — the same bar dispatch applies to a single key, checked at construction before any task exists)`,
    `  no seed, no change (DEMO-032): a task constructed without idempotencyKeys dispatches PUBLISH with no key at all -> OPEN, history entries: 1; snapshot idempotencyKeys: undefined (omitting the seed preserves the exact pre-seeding behavior — the snapshot omits the field while the key set is empty)`,
  ]) {
    assert.ok(text.includes(line), `missing seeded idempotency line: ${line}`);
  }
  assert.equal(
    lines[
      lines.indexOf(
        "Payout webhook timeout (deliverPayoutWebhook enforces a per-attempt timeoutMs, injected hanging fetch — no real network):",
      ) - 2
    ],
    `  no seed, no change (DEMO-032): a task constructed without idempotencyKeys dispatches PUBLISH with no key at all -> OPEN, history entries: 1; snapshot idempotencyKeys: undefined (omitting the seed preserves the exact pre-seeding behavior — the snapshot omits the field while the key set is empty)`,
  );
});

test("demo preseeded idempotency keys segment is deterministic: two runs print byte-identical seeded lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Preseeded idempotency keys (idempotencyKeys seeds a task with already-consumed dispatch keys):"),
      ls.indexOf("Payout webhook timeout (deliverPayoutWebhook enforces a per-attempt timeoutMs, injected hanging fetch — no real network):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + seeded / no-op / fresh-key / invalid-seed /
  // no-seed lines; every value in the segment is a fixed
  // literal (pinned keys, fixed timestamps, a pinned
  // error), so no normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.seededIdempotencyKeys, b.seededIdempotencyKeys);
  assert.equal(a.seededIdempotencyTask.state, b.seededIdempotencyTask.state);
  assert.deepEqual(a.seededIdempotencyTask.history, b.seededIdempotencyTask.history);
  assert.deepEqual(
    a.seededIdempotencySnapshotKeysAfterSeed,
    b.seededIdempotencySnapshotKeysAfterSeed,
  );
  assert.equal(a.seededIdempotencyNoopReturn, b.seededIdempotencyNoopReturn);
  assert.equal(a.seededIdempotencyStateAfterNoop, b.seededIdempotencyStateAfterNoop);
  assert.equal(
    a.seededIdempotencyHistoryLengthAfterNoop,
    b.seededIdempotencyHistoryLengthAfterNoop,
  );
  assert.equal(
    a.seededIdempotencyNotificationCountAfterNoop,
    b.seededIdempotencyNotificationCountAfterNoop,
  );
  assert.deepEqual(
    a.seededIdempotencyNotificationEvents,
    b.seededIdempotencyNotificationEvents,
  );
  assert.deepEqual(
    a.seededIdempotencySnapshotKeysAfterFreshKeys,
    b.seededIdempotencySnapshotKeysAfterFreshKeys,
  );
  assert.equal(a.seededIdempotencyEmptySeedError, b.seededIdempotencyEmptySeedError);
  assert.equal(a.seededIdempotencyDefaultTask.state, b.seededIdempotencyDefaultTask.state);
  assert.deepEqual(
    a.seededIdempotencyDefaultTask.history,
    b.seededIdempotencyDefaultTask.history,
  );
  assert.equal(
    a.seededIdempotencyDefaultSnapshotKeys,
    b.seededIdempotencyDefaultSnapshotKeys,
  );
});

test("demo shows the payout webhook timeout segment in-process: a hanging fetch is reported as timed out, an invalid timeout throws with zero fetches, and a loose timeout succeeds unchanged", async () => {
  const {
    webhook,
    timeoutDeliveryEndpoint,
    timeoutDeliveryTimeoutMs,
    timeoutDeliveryResult,
    timeoutDeliveryFetchCalls,
    timeoutDeliveryInvalidError,
    timeoutDeliveryInvalidFetchCalls,
    timeoutDeliveryLooseResult,
    timeoutDeliveryLooseFetchCalls,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // DeliverPayoutWebhookOptions docs in
  // src/settlementWebhook.ts and
  // test/payoutWebhookDelivery.test.ts, never derived from
  // the demo's own delivery calls.
  assert.equal(
    timeoutDeliveryEndpoint,
    "https://payouts.example.com/hooks/payout",
  );
  assert.equal(timeoutDeliveryTimeoutMs, 50);
  assert.deepEqual(timeoutDeliveryResult, {
    ok: false,
    attempts: 1,
    error: "webhook delivery timed out after 50ms",
  });
  assert.equal(timeoutDeliveryFetchCalls, 1);
  assert.equal(
    timeoutDeliveryInvalidError,
    "cannot deliver payout webhook: timeoutMs must be a positive number, got 0",
  );
  assert.equal(timeoutDeliveryInvalidFetchCalls, 0);
  assert.deepEqual(timeoutDeliveryLooseResult, {
    ok: true,
    attempts: 1,
    status: 200,
  });
  assert.equal(timeoutDeliveryLooseFetchCalls, 1);
  // Independent checks built in the test — the demo segment
  // is not self-certifying: the same three deliveries are
  // driven here with fresh counting fetches (the script
  // from the delivery tests). The hanging fetch only
  // settles when its abort signal fires, exactly like the
  // real fetch; no elapsed duration is asserted anywhere —
  // the pinned 50 ms timeout is the behaviour under test
  // itself.
  let independentHangCalls = 0;
  const independentHangResult = await deliverPayoutWebhook(
    timeoutDeliveryEndpoint,
    webhook,
    {
      fetchImpl: (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          independentHangCalls += 1;
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("The operation was aborted")),
            { once: true },
          );
        }),
      timeoutMs: 50,
      maxAttempts: 1,
    },
  );
  assert.deepEqual(independentHangResult, {
    ok: false,
    attempts: 1,
    error: "webhook delivery timed out after 50ms",
  });
  assert.equal(independentHangCalls, 1);
  let independentInvalidCalls = 0;
  await assert.rejects(
    () =>
      deliverPayoutWebhook(timeoutDeliveryEndpoint, webhook, {
        fetchImpl: async () => {
          independentInvalidCalls += 1;
          return new Response("{}", { status: 200 });
        },
        timeoutMs: 0,
      }),
    /cannot deliver payout webhook: timeoutMs must be a positive number, got 0/,
  );
  assert.equal(independentInvalidCalls, 0);
  let independentLooseCalls = 0;
  const independentLooseResult = await deliverPayoutWebhook(
    timeoutDeliveryEndpoint,
    webhook,
    {
      fetchImpl: async () => {
        independentLooseCalls += 1;
        return new Response("{}", { status: 200 });
      },
      timeoutMs: 5000,
    },
  );
  assert.deepEqual(independentLooseResult, {
    ok: true,
    attempts: 1,
    status: 200,
  });
  assert.equal(independentLooseCalls, 1);
  // The segment follows the preseeded idempotency keys
  // segment and prints its lines verbatim; its
  // loose-timeout line closes the segment (the fan-out
  // timeout override segment now closes the demo).
  const timeoutAt = text.indexOf(
    "Payout webhook timeout (deliverPayoutWebhook enforces a per-attempt timeoutMs, injected hanging fetch — no real network):",
  );
  assert.ok(
    timeoutAt >
      text.indexOf(
        "Preseeded idempotency keys (idempotencyKeys seeds a task with already-consumed dispatch keys):",
      ),
    "payout webhook timeout segment must follow the preseeded idempotency keys segment",
  );
  for (const line of [
    `  endpoint: https://payouts.example.com/hooks/payout (the main task's signed payout webhook, delivered on its own — no fan-out)`,
    `  hanging receiver, pinned timeout: timeoutMs 50 with maxAttempts 1; the injected fetch never answers on its own and only settles when the per-attempt abort fires -> delivery ok=false attempts=1 error="webhook delivery timed out after 50ms"; fetch calls: 1 (the timeout is reported in the result, never thrown — the 50 ms wait is the behaviour under test itself, at its pinned short length, and no elapsed duration is asserted)`,
    `  invalid timeout (configuration): timeoutMs 0 -> rejected: "cannot deliver payout webhook: timeoutMs must be a positive number, got 0"; fetch calls: 0 (an invalid timeout is a caller bug, so it throws before any request is made — a delivery outcome, by contrast, is only ever reported)`,
    `  loose timeout, immediate answer: timeoutMs 5000 and the endpoint answers 200 at once -> delivery ok=true attempts=1 status=200; fetch calls: 1 (a generous deadline changes nothing when the receiver is fast — the success shape is exactly the untimed one)`,
  ]) {
    assert.ok(text.includes(line), `missing timeout line: ${line}`);
  }
  assert.equal(
    lines[
      lines.indexOf(
        "Payout webhook timeout (deliverPayoutWebhook enforces a per-attempt timeoutMs, injected hanging fetch — no real network):",
      ) + 4
    ],
    `  loose timeout, immediate answer: timeoutMs 5000 and the endpoint answers 200 at once -> delivery ok=true attempts=1 status=200; fetch calls: 1 (a generous deadline changes nothing when the receiver is fast — the success shape is exactly the untimed one)`,
  );
});

test("demo payout webhook timeout segment is deterministic: two runs print byte-identical timeout lines", async () => {
  const segment = (ls: string[]) => {
    const at = ls.indexOf("Payout webhook timeout (deliverPayoutWebhook enforces a per-attempt timeoutMs, injected hanging fetch — no real network):");
    return ls.slice(at, at + 5);
  };
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + endpoint / hanging / invalid / loose lines;
  // every value in the segment is a pinned literal (the
  // pinned 50 ms timeout, the pinned error texts, the
  // fetch counts), so no normalization is needed — the
  // only real wait is the pinned 50 ms timeout itself,
  // whose duration is never printed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.timeoutDeliveryEndpoint, b.timeoutDeliveryEndpoint);
  assert.equal(a.timeoutDeliveryTimeoutMs, b.timeoutDeliveryTimeoutMs);
  assert.deepEqual(a.timeoutDeliveryResult, b.timeoutDeliveryResult);
  assert.equal(a.timeoutDeliveryFetchCalls, b.timeoutDeliveryFetchCalls);
  assert.equal(a.timeoutDeliveryInvalidError, b.timeoutDeliveryInvalidError);
  assert.equal(
    a.timeoutDeliveryInvalidFetchCalls,
    b.timeoutDeliveryInvalidFetchCalls,
  );
  assert.deepEqual(a.timeoutDeliveryLooseResult, b.timeoutDeliveryLooseResult);
  assert.equal(
    a.timeoutDeliveryLooseFetchCalls,
    b.timeoutDeliveryLooseFetchCalls,
  );
});

test("demo shows the payout webhook fan-out timeout override segment in-process: a per-endpoint override times out alone, an invalid override fails only its endpoint, and no override is unchanged", async () => {
  const {
    task,
    fanoutTimeoutCallTimeoutMs,
    fanoutTimeoutOverrideMs,
    fanoutTimeoutResult,
    fanoutTimeoutHangFetchCalls,
    fanoutTimeoutFastFetchCalls,
    fanoutTimeoutInvalidResult,
    fanoutTimeoutInvalidFetchCalls,
    fanoutTimeoutPlainResult,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // PayoutWebhookEndpoint docs in src/settlementWebhook.ts
  // and test/payoutWebhookFanout.test.ts, never derived
  // from the demo's own fan-out calls.
  assert.equal(fanoutTimeoutCallTimeoutMs, 5000);
  assert.equal(fanoutTimeoutOverrideMs, 50);
  assert.deepEqual(fanoutTimeoutResult, {
    results: [
      { ok: true, attempts: 1, status: 200 },
      { ok: false, attempts: 3, error: "webhook delivery timed out after 50ms" },
      { ok: true, attempts: 1, status: 200 },
    ],
    delivered: 2,
    failed: 1,
    deadlineExceeded: false,
  });
  assert.equal(fanoutTimeoutHangFetchCalls, 3);
  assert.equal(fanoutTimeoutFastFetchCalls, 2);
  assert.deepEqual(fanoutTimeoutInvalidResult, {
    results: [
      { ok: true, attempts: 1, status: 200 },
      { ok: true, attempts: 1, status: 200 },
      {
        ok: false,
        attempts: 0,
        error:
          "cannot deliver payout webhook: timeoutMs must be a positive number, got 0",
      },
    ],
    delivered: 2,
    failed: 1,
    deadlineExceeded: false,
  });
  assert.equal(fanoutTimeoutInvalidFetchCalls, 0);
  assert.deepEqual(fanoutTimeoutPlainResult, {
    results: [
      { ok: true, attempts: 1, status: 200 },
      { ok: true, attempts: 1, status: 200 },
      { ok: true, attempts: 1, status: 200 },
    ],
    delivered: 3,
    failed: 0,
    deadlineExceeded: false,
  });
  // Independent checks built in the test — the demo segment
  // is not self-certifying: the same three fan-outs are
  // driven here with fresh counting fetches. The hanging
  // fetch only settles when its abort signal fires, exactly
  // like the real fetch; no elapsed duration is asserted
  // anywhere — the pinned 50 ms timeout is the behaviour
  // under test itself.
  const NOW = new Date("2026-03-21T09:00:00.000Z");
  const EVENT_ID = "evt_demo_fanout_timeout_001";
  const endpoints = [
    { url: "https://billing.example.com/hooks/payout", secret: "test-secret-billing" },
    { url: "https://slow.example.com/hooks/payout", secret: "test-secret-slow" },
    { url: "https://notifications.example.com/hooks/payout", secret: "test-secret-notifications" },
  ];
  let independentHangCalls = 0;
  const independentOverride = await deliverPayoutWebhookToMany(
    task,
    endpoints.map((ep) =>
      ep.url === endpoints[1].url
        ? {
            ...ep,
            timeoutMs: 50,
            fetchImpl: ((_url: string, init: RequestInit) =>
              new Promise<Response>((_resolve, reject) => {
                independentHangCalls += 1;
                init.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("The operation was aborted")),
                  { once: true },
                );
              })) as (
              url: string,
              init: RequestInit,
            ) => Promise<Response>,
          }
        : ep,
    ),
    {
      fetchImpl: async () => new Response("{}", { status: 200 }),
      sleepImpl: async () => {},
      backoffMs: 0,
      timeoutMs: 5000,
      now: NOW,
      eventId: EVENT_ID,
    },
  );
  assert.deepEqual(independentOverride, fanoutTimeoutResult);
  assert.equal(independentHangCalls, 3);
  const independentInvalidCalls = new Map<string, number>();
  const independentInvalid = await deliverPayoutWebhookToMany(
    task,
    endpoints.map((ep) =>
      ep.url === endpoints[2].url ? { ...ep, timeoutMs: 0 } : ep,
    ),
    {
      fetchImpl: async (url: string) => {
        independentInvalidCalls.set(
          url,
          (independentInvalidCalls.get(url) ?? 0) + 1,
        );
        return new Response("{}", { status: 200 });
      },
      sleepImpl: async () => {},
      backoffMs: 0,
      timeoutMs: 5000,
      now: NOW,
      eventId: EVENT_ID,
    },
  );
  assert.deepEqual(independentInvalid, fanoutTimeoutInvalidResult);
  assert.equal(independentInvalidCalls.get(endpoints[2].url) ?? 0, 0);
  assert.equal(independentInvalidCalls.get(endpoints[0].url), 1);
  assert.equal(independentInvalidCalls.get(endpoints[1].url), 1);
  const independentPlain = await deliverPayoutWebhookToMany(task, endpoints, {
    fetchImpl: async () => new Response("{}", { status: 200 }),
    sleepImpl: async () => {},
    backoffMs: 0,
    now: NOW,
    eventId: EVENT_ID,
  });
  assert.deepEqual(independentPlain, fanoutTimeoutPlainResult);
  // The segment follows the payout webhook timeout
  // segment and prints its lines verbatim, and the
  // dispatch expectedSeq segment follows it.
  const fanoutTimeoutAt = text.indexOf(
    "Payout webhook fan-out timeout overrides (deliverPayoutWebhookToMany resolves timeoutMs per endpoint — endpoint.timeoutMs ?? call-level timeoutMs, injected fetches — no real network):",
  );
  assert.ok(
    fanoutTimeoutAt >
      text.indexOf(
        "Payout webhook timeout (deliverPayoutWebhook enforces a per-attempt timeoutMs, injected hanging fetch — no real network):",
      ),
    "fan-out timeout override segment must follow the payout webhook timeout segment",
  );
  for (const line of [
    `  shared eventId: evt_demo_fanout_timeout_001, shared at: 2026-03-21T09:00:00.000Z (one logical event for all three endpoints in each call, as in the fan-out segment above; every endpoint signed with its own secret)`,
    `  pinned override, hanging receiver (slow, https://slow.example.com/hooks/payout): per-endpoint timeoutMs 50 overrides the call-level 5000; the endpoint's own injected fetch never answers on its own and only settles when the per-attempt abort fires -> ok=false attempts=3 error="webhook delivery timed out after 50ms"; fetch calls: 3 (a timeout is a retryable failure, so the endpoint burns all 3 attempts at 50 ms each — the waits are the behaviour under test itself, at their pinned short length, and no elapsed duration is asserted)`,
    `  no override, same call (billing + notifications): neither endpoint pins timeoutMs, so the call-level 5000 applies and both answer 200 at once -> billing ok=true attempts=1 status=200, notifications ok=true attempts=1 status=200; fan-out: 2 delivered, 1 failed — results stay in input order (billing, slow, notifications) and the timed-out endpoint did not block the others`,
    `  invalid override, isolated failure (notifications): per-endpoint timeoutMs 0 -> its result is exactly { ok: false, attempts: 0, error: "cannot deliver payout webhook: timeoutMs must be a positive number, got 0" }; fetch calls to that endpoint: 0; billing and slow (answering 200 at once in this call) are unchanged at ok=true attempts=1 status=200 — a bad per-endpoint override is reported for its own endpoint only, where the same value at call level would throw for the whole call before any request`,
    `  no overrides anywhere: no endpoint pins timeoutMs and the call sets none either (the 5000 ms default applies) -> all three endpoints ok=true attempts=1 status=200; fan-out: 3 delivered, 0 failed (omitting the override preserves the exact pre-override fan-out behaviour)`,
  ]) {
    assert.ok(text.includes(line), `missing fan-out timeout line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Dispatch expectedSeq optimistic concurrency (dispatch pins the history length the caller read — fixed timestamps, no network):",
    ) > fanoutTimeoutAt,
    "expectedSeq segment must follow the fan-out timeout override segment",
  );
});

test("demo payout webhook fan-out timeout override segment is deterministic: two runs print byte-identical fan-out timeout lines", async () => {
  const segment = (ls: string[]) => {
    const start = ls.indexOf("Payout webhook fan-out timeout overrides (deliverPayoutWebhookToMany resolves timeoutMs per endpoint — endpoint.timeoutMs ?? call-level timeoutMs, injected fetches — no real network):");
    return ls.slice(start, start + 6);
  };
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + shared / override / no-override / invalid /
  // plain lines; every value in the segment is a pinned
  // literal (the pinned 50 ms override, the pinned error
  // texts, the fetch counts), so no normalization is
  // needed — the only real waits are the pinned 50 ms
  // timeouts themselves, whose durations are never
  // printed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.fanoutTimeoutCallTimeoutMs, b.fanoutTimeoutCallTimeoutMs);
  assert.equal(a.fanoutTimeoutOverrideMs, b.fanoutTimeoutOverrideMs);
  assert.deepEqual(a.fanoutTimeoutResult, b.fanoutTimeoutResult);
  assert.equal(a.fanoutTimeoutHangFetchCalls, b.fanoutTimeoutHangFetchCalls);
  assert.equal(a.fanoutTimeoutFastFetchCalls, b.fanoutTimeoutFastFetchCalls);
  assert.deepEqual(a.fanoutTimeoutInvalidResult, b.fanoutTimeoutInvalidResult);
  assert.equal(
    a.fanoutTimeoutInvalidFetchCalls,
    b.fanoutTimeoutInvalidFetchCalls,
  );
  assert.deepEqual(a.fanoutTimeoutPlainResult, b.fanoutTimeoutPlainResult);
});

test("demo shows the dispatch expectedSeq segment in-process: a correct guard advances one step, a stale guard conflicts untouched, 0 guards an empty history, illegal values throw, and no guard is unchanged", async () => {
  const {
    expectedSeqTask,
    expectedSeqGuardedReturn,
    expectedSeqConflictTask,
    expectedSeqConflictError,
    expectedSeqConflictStateAfter,
    expectedSeqConflictHistoryLengthAfter,
    expectedSeqEmptyTask,
    expectedSeqEmptyReturn,
    expectedSeqIllegalTask,
    expectedSeqNegativeError,
    expectedSeqFractionError,
    expectedSeqUnguardedTask,
    expectedSeqUnguardedReturn,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // DispatchOptions docs in src/taskLifecycle.ts and
  // test/expectedSeq.test.ts, never derived from the
  // demo's own dispatches.
  const AT = (s: number) =>
    new Date(Date.parse("2026-03-22T09:00:00.000Z") + s * 1000).toISOString();
  assert.equal(expectedSeqGuardedReturn, "CAPTURING");
  assert.equal(expectedSeqTask.id, "DEMO-033");
  assert.equal(expectedSeqTask.state, "CAPTURING");
  assert.equal(expectedSeqTask.history.length, 3);
  assert.deepEqual(
    expectedSeqTask.history.map((h) => [h.seq, h.event, h.from, h.to, h.at, h.actor]),
    [
      [1, "PUBLISH", "DRAFT", "OPEN", AT(0), "researcher"],
      [2, "ACCEPT", "OPEN", "ACCEPTED", AT(1), "contributor"],
      [3, "START_CAPTURE", "ACCEPTED", "CAPTURING", AT(2), "contributor"],
    ],
  );
  assert.equal(
    expectedSeqConflictError,
    "dispatch conflict: expected seq 1 but task is at seq 2",
  );
  assert.equal(expectedSeqConflictStateAfter, "ACCEPTED");
  assert.equal(expectedSeqConflictHistoryLengthAfter, 2);
  assert.equal(expectedSeqConflictTask.state, "ACCEPTED");
  assert.equal(expectedSeqConflictTask.history.length, 2);
  assert.equal(expectedSeqEmptyReturn, "OPEN");
  assert.equal(expectedSeqEmptyTask.state, "OPEN");
  assert.equal(expectedSeqEmptyTask.history.length, 1);
  assert.equal(expectedSeqEmptyTask.history[0].seq, 1);
  assert.equal(
    expectedSeqNegativeError,
    "invalid dispatch options: expectedSeq must be a non-negative integer, got -1",
  );
  assert.equal(
    expectedSeqFractionError,
    "invalid dispatch options: expectedSeq must be a non-negative integer, got 1.5",
  );
  assert.equal(expectedSeqIllegalTask.state, "DRAFT");
  assert.equal(expectedSeqIllegalTask.history.length, 0);
  assert.equal(expectedSeqUnguardedReturn, "CAPTURING");
  assert.equal(expectedSeqUnguardedTask.state, "CAPTURING");
  assert.equal(expectedSeqUnguardedTask.history.length, 3);
  // Independent checks built in the test — the demo segment
  // is not self-certifying: the same five forms are driven
  // here on fresh tasks.
  const build = (id: string) => {
    const t = new TaskLifecycle(id);
    t.dispatch("PUBLISH", { actor: "researcher", at: AT(0) });
    t.dispatch("ACCEPT", { actor: "contributor", at: AT(1) });
    return t;
  };
  const independentGuarded = build("TEST-SEQ-001");
  assert.equal(
    independentGuarded.dispatch("START_CAPTURE", {
      actor: "contributor",
      at: AT(2),
      expectedSeq: 2,
    }),
    expectedSeqGuardedReturn,
  );
  assert.deepEqual(
    independentGuarded.history.map((h) => [h.seq, h.event, h.from, h.to, h.at, h.actor]),
    expectedSeqTask.history.map((h) => [h.seq, h.event, h.from, h.to, h.at, h.actor]),
  );
  const independentConflict = build("TEST-SEQ-002");
  const independentHistoryBefore = historyToNdjson(independentConflict.history);
  assert.throws(
    () =>
      independentConflict.dispatch("START_CAPTURE", {
        actor: "contributor",
        at: AT(2),
        expectedSeq: 1,
      }),
    (err: unknown) =>
      err instanceof Error && err.message === expectedSeqConflictError,
  );
  assert.equal(independentConflict.state, expectedSeqConflictStateAfter);
  assert.equal(
    historyToNdjson(independentConflict.history),
    independentHistoryBefore,
  );
  const independentEmpty = new TaskLifecycle("TEST-SEQ-003");
  assert.equal(
    independentEmpty.dispatch("PUBLISH", {
      actor: "researcher",
      at: AT(0),
      expectedSeq: 0,
    }),
    expectedSeqEmptyReturn,
  );
  const independentIllegal = new TaskLifecycle("TEST-SEQ-004");
  for (const [bad, pinned] of [
    [-1, expectedSeqNegativeError],
    [1.5, expectedSeqFractionError],
  ] as Array<[number, string]>) {
    assert.throws(
      () =>
        independentIllegal.dispatch("PUBLISH", {
          actor: "researcher",
          at: AT(0),
          expectedSeq: bad,
        }),
      (err: unknown) => err instanceof Error && err.message === pinned,
    );
  }
  assert.equal(independentIllegal.state, "DRAFT");
  assert.equal(independentIllegal.history.length, 0);
  const independentUnguarded = build("TEST-SEQ-005");
  assert.equal(
    independentUnguarded.dispatch("START_CAPTURE", {
      actor: "contributor",
      at: AT(2),
    }),
    expectedSeqUnguardedReturn,
  );
  // The segment closes the demo: it follows the fan-out
  // timeout override segment, prints its lines verbatim,
  // and its no-guard line is the demo's last line.
  const expectedSeqAt = text.indexOf(
    "Dispatch expectedSeq optimistic concurrency (dispatch pins the history length the caller read — fixed timestamps, no network):",
  );
  assert.ok(
    expectedSeqAt >
      text.indexOf(
        "Payout webhook fan-out timeout overrides (deliverPayoutWebhookToMany resolves timeoutMs per endpoint — endpoint.timeoutMs ?? call-level timeoutMs, injected fetches — no real network):",
      ),
    "expectedSeq segment must follow the fan-out timeout override segment",
  );
  for (const line of [
    `  correct guard (DEMO-033): driven PUBLISH -> ACCEPT under fixed timestamps to seq 2 (state ACCEPTED, history entries: 2); START_CAPTURE with expectedSeq 2 at ${AT(2)} -> CAPTURING, history entries: 3; last entry: seq 3 START_CAPTURE ACCEPTED -> CAPTURING by contributor (the caller pinned the seq it based its decision on and the task was still there, so exactly one step advances)`,
    `  stale guard (DEMO-034): the same pinned 2-entry history; START_CAPTURE with expectedSeq 1 -> rejected: "dispatch conflict: expected seq 1 but task is at seq 2"; state after: ACCEPTED, history entries: 2 (the guard runs before every other dispatch check and changes nothing — no state move, no history entry — so a writer holding a stale snapshot fails loudly instead of advancing a state it never saw, and re-reading the task and retrying with the fresh seq works)`,
    `  empty history (DEMO-035): a fresh task (history entries: 0); PUBLISH with expectedSeq 0 -> OPEN, history entries: 1 (0 is the guard for an empty history — the seq is the history length, which is the last entry's seq once entries exist)`,
    `  illegal guards (DEMO-036): PUBLISH with expectedSeq -1 -> rejected: "invalid dispatch options: expectedSeq must be a non-negative integer, got -1"; PUBLISH with expectedSeq 1.5 -> rejected: "invalid dispatch options: expectedSeq must be a non-negative integer, got 1.5"; state after both: DRAFT, history entries: 0 (a non-integer or negative expectedSeq is a caller configuration error, thrown up front before anything mutates)`,
    `  no guard (DEMO-037): the same pinned 2-entry history; START_CAPTURE with no expectedSeq -> CAPTURING, history entries: 3 (omitting expectedSeq preserves the exact pre-guard behavior)`,
  ]) {
    assert.ok(text.includes(line), `missing expectedSeq line: ${line}`);
  }
  assert.ok(
    text.indexOf(
      "Stale patrol (staleTasks / maxAgeByState screening, notify-only action):",
    ) > expectedSeqAt,
    "stale patrol segment must follow the expectedSeq segment",
  );
});

test("demo dispatch expectedSeq segment is deterministic: two runs print byte-identical expectedSeq lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Dispatch expectedSeq optimistic concurrency (dispatch pins the history length the caller read — fixed timestamps, no network):"),
      ls.indexOf("Constructor id fail-fast (the first door of the audit chain):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + correct / stale / empty / illegal / no-guard
  // lines; every value in the segment is a pinned literal
  // (fixed timestamps, the pinned conflict and
  // configuration error texts), so no normalization is
  // needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.expectedSeqGuardedReturn, b.expectedSeqGuardedReturn);
  assert.equal(a.expectedSeqConflictError, b.expectedSeqConflictError);
  assert.equal(
    a.expectedSeqConflictStateAfter,
    b.expectedSeqConflictStateAfter,
  );
  assert.equal(
    a.expectedSeqConflictHistoryLengthAfter,
    b.expectedSeqConflictHistoryLengthAfter,
  );
  assert.equal(a.expectedSeqEmptyReturn, b.expectedSeqEmptyReturn);
  assert.equal(a.expectedSeqNegativeError, b.expectedSeqNegativeError);
  assert.equal(a.expectedSeqFractionError, b.expectedSeqFractionError);
  assert.equal(a.expectedSeqUnguardedReturn, b.expectedSeqUnguardedReturn);
  assert.deepEqual(
    a.expectedSeqTask.history.map((h) => [h.seq, h.event, h.at]),
    b.expectedSeqTask.history.map((h) => [h.seq, h.event, h.at]),
  );
});

test("demo stale patrol selects only the long-stuck OPEN task and notifies it without dispatching", async () => {
  const {
    patrolTasks,
    patrolStaleSelected,
    patrolStaleActionResults,
    patrolStaleNotifiedIds,
    patrolStaleConfigError,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the
  // staleTasks docs in src/taskLifecycle.ts and
  // test/staleTasks.test.ts, never derived from the demo's
  // own screening.
  assert.deepEqual(
    patrolTasks.map((t) => t.id),
    [
      DEMO_PATROL_STALE_TASK_ID,
      DEMO_PATROL_EXACT_TASK_ID,
      DEMO_PATROL_TERMINAL_TASK_ID,
      DEMO_PATROL_NO_HISTORY_TASK_ID,
      DEMO_PATROL_UNMAPPED_TASK_ID,
    ],
  );
  assert.deepEqual(
    patrolTasks.map((t) => t.state),
    ["OPEN", "OPEN", "PAID", "DRAFT", "IN_REVIEW"],
  );
  assert.deepEqual(
    patrolTasks.map((t) => t.history.length),
    [1, 1, 8, 0, 5],
  );
  assert.equal(patrolTasks[0].history[0].at, DEMO_PATROL_STALE_PUBLISH_AT);
  assert.equal(patrolTasks[1].history[0].at, DEMO_PATROL_EXACT_PUBLISH_AT);
  assert.equal(
    patrolTasks[2].history[patrolTasks[2].history.length - 1].at,
    DEMO_PATROL_TERMINAL_COMPLETE_AT,
  );
  assert.equal(
    patrolTasks[4].history[patrolTasks[4].history.length - 1].at,
    DEMO_PATROL_UNMAPPED_REVIEW_AT,
  );
  // Only the stale OPEN task is selected — exactly-at-budget,
  // terminal, no-history and unmapped-state tasks are not.
  assert.deepEqual(
    patrolStaleSelected.map((t) => t.id),
    [DEMO_PATROL_STALE_TASK_ID],
  );
  assert.equal(patrolStaleSelected[0], patrolTasks[0]);
  // The notify-only disposition attempted exactly that one
  // task, acted, and changed nothing.
  assert.equal(patrolStaleActionResults.length, 1);
  assert.equal(patrolStaleActionResults[0].task, patrolTasks[0]);
  assert.equal(patrolStaleActionResults[0].acted, true);
  assert.equal(patrolStaleActionResults[0].error, undefined);
  assert.deepEqual(patrolStaleNotifiedIds, [DEMO_PATROL_STALE_TASK_ID]);
  // The unknown-state configuration error is pinned verbatim.
  assert.equal(patrolStaleConfigError, DEMO_PATROL_STALE_CONFIG_ERROR);
  assert.equal(
    patrolStaleConfigError,
    'invalid maxAgeByState: unknown state "BOGUS"',
  );
  // Independent checks built in the test — the demo segment
  // is not self-certifying: the same five forms are rebuilt
  // here on fresh tasks and screened with the library entry
  // points directly.
  const now = new Date(DEMO_PATROL_NOW);
  const budgets = {
    DRAFT: DEMO_PATROL_MAX_AGE_MS,
    OPEN: DEMO_PATROL_MAX_AGE_MS,
    PAID: DEMO_PATROL_MAX_AGE_MS,
  };
  const independentStale = new TaskLifecycle("TEST-PATROL-001");
  independentStale.dispatch("PUBLISH", {
    actor: "researcher",
    at: DEMO_PATROL_STALE_PUBLISH_AT,
  });
  const independentExact = new TaskLifecycle("TEST-PATROL-002");
  independentExact.dispatch("PUBLISH", {
    actor: "researcher",
    at: DEMO_PATROL_EXACT_PUBLISH_AT,
  });
  const independentFresh = new TaskLifecycle("TEST-PATROL-003");
  const independent = [independentStale, independentExact, independentFresh];
  assert.deepEqual(
    staleTasks(independent, budgets, now).map((t) => t.id),
    ["TEST-PATROL-001"],
  );
  const independentNotified: string[] = [];
  const independentResults = actOnStaleTasks(
    independent,
    (t) => {
      independentNotified.push(t.id);
    },
    budgets,
    now,
  );
  assert.equal(independentResults.length, 1);
  assert.equal(independentResults[0].acted, true);
  assert.deepEqual(independentNotified, ["TEST-PATROL-001"]);
  assert.equal(independentStale.state, "OPEN");
  assert.throws(
    () => staleTasks(independent, { BOGUS: 1000 } as never, now),
    (err: unknown) =>
      err instanceof Error && err.message === patrolStaleConfigError,
  );
  // The segment closes the demo: it follows the expectedSeq
  // segment, prints its lines verbatim, and its fail-fast
  // line is the demo's last line.
  const patrolAt = text.indexOf(
    "Stale patrol (staleTasks / maxAgeByState screening, notify-only action):",
  );
  assert.ok(
    patrolAt >
      text.indexOf(
        "Dispatch expectedSeq optimistic concurrency (dispatch pins the history length the caller read — fixed timestamps, no network):",
      ),
    "stale patrol segment must follow the expectedSeq segment",
  );
  for (const line of [
    `  fixed now: ${DEMO_PATROL_NOW} — patrol budgets: DRAFT 7 days, OPEN 7 days, PAID 7 days (IN_REVIEW has no budget; dwell from the last history entry, strictly past the budget)`,
    `  ${DEMO_PATROL_STALE_TASK_ID}: state OPEN, entered ${DEMO_PATROL_STALE_PUBLISH_AT}, dwell 21 days — stale: true`,
    `  ${DEMO_PATROL_EXACT_TASK_ID}: state OPEN, entered ${DEMO_PATROL_EXACT_PUBLISH_AT}, dwell 7 days — stale: false`,
    `  ${DEMO_PATROL_TERMINAL_TASK_ID}: state PAID, entered ${DEMO_PATROL_TERMINAL_COMPLETE_AT}, dwell 22 days — stale: false`,
    `  ${DEMO_PATROL_NO_HISTORY_TASK_ID}: state DRAFT, no history (no measurable dwell) — stale: false`,
    `  ${DEMO_PATROL_UNMAPPED_TASK_ID}: state IN_REVIEW, entered ${DEMO_PATROL_UNMAPPED_REVIEW_AT}, dwell 35 days — stale: false`,
    `  staleTasks selection: [${DEMO_PATROL_STALE_TASK_ID}] — exactly-at-budget (${DEMO_PATROL_EXACT_TASK_ID}), terminal (${DEMO_PATROL_TERMINAL_TASK_ID}), no-history (${DEMO_PATROL_NO_HISTORY_TASK_ID}) and unmapped-state (${DEMO_PATROL_UNMAPPED_TASK_ID}) tasks are not selected`,
    `  actOnStaleTasks (action: notify the assignee, dispatch nothing): 1 attempted`,
    `  ${DEMO_PATROL_STALE_TASK_ID}: acted true — notified, task unchanged at OPEN`,
    `  invalid patrol configuration fails fast: staleTasks with an unknown state name throws ${DEMO_PATROL_STALE_CONFIG_ERROR} before any task is read`,
  ]) {
    assert.ok(text.includes(line), `missing stale patrol line: ${line}`);
  }
  assert.equal(
    lines[lines.length - 1],
    `  invalid patrol configuration fails fast: staleTasks with an unknown state name throws ${DEMO_PATROL_STALE_CONFIG_ERROR} before any task is read`,
  );
});

test("demo stale patrol segment is deterministic: two runs print byte-identical patrol lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Stale patrol (staleTasks / maxAgeByState screening, notify-only action):"),
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + fixed-now + five per-task lines + selection +
  // attempted + acted + fail-fast lines; every value in the
  // segment is a pinned literal (fixed timestamps, the pinned
  // configuration error text), so no normalization is needed.
  assert.equal(segA.length, 11);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(
    a.patrolStaleSelected.map((t) => t.id),
    b.patrolStaleSelected.map((t) => t.id),
  );
  assert.deepEqual(a.patrolStaleNotifiedIds, b.patrolStaleNotifiedIds);
  assert.equal(a.patrolStaleConfigError, b.patrolStaleConfigError);
  assert.deepEqual(
    a.patrolTasks.map((t) => [t.state, t.history.length]),
    b.patrolTasks.map((t) => [t.state, t.history.length]),
  );
});

test("demo shows the constructor id fail-fast segment: three bad ids are rejected with the pinned wording and a legal id dispatches normally", async () => {
  const { constructorGuardChecks, constructorGuardTask, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the rules in
  // test/constructorId.test.ts, cross-checked against the demo's own
  // rendering rather than derived from it.
  assert.equal(constructorGuardChecks.length, 3);
  assert.deepEqual(
    constructorGuardChecks.map((check) => check.input),
    ['""', "undefined", "123"],
  );
  for (const check of constructorGuardChecks) {
    assert.equal(check.error, DEMO_CONSTRUCTOR_ID_ERROR);
    assert.equal(check.error, "invalid task: id must be a non-empty string");
  }
  assert.equal(constructorGuardTask.id, DEMO_GUARD_TASK_ID);
  assert.equal(constructorGuardTask.state, "OPEN");
  assert.equal(constructorGuardTask.history.length, 1);
  assert.equal(constructorGuardTask.history[0].event, "PUBLISH");

  // The printed lines are pinned literals — every word derives from fixed
  // inputs, so they are asserted verbatim.
  assert.ok(
    text.includes(
      "Constructor id fail-fast (the first door of the audit chain):",
    ),
  );
  for (const check of constructorGuardChecks) {
    assert.ok(
      text.includes(
        `  new TaskLifecycle(${check.input}) throws: ${check.error}`,
      ),
    );
  }
  assert.ok(
    text.includes(
      `  new TaskLifecycle("${DEMO_GUARD_TASK_ID}") constructs and dispatches PUBLISH → OPEN`,
    ),
  );

  // Independent cross-check: the same three bad ids are rejected on fresh
  // construction calls made directly through the library, not through the
  // demo — the demo segment must agree with the library, not with itself.
  for (const bad of ["", undefined, 123] as const) {
    assert.throws(
      // @ts-expect-error intentional misuse under test
      () => new TaskLifecycle(bad),
      /invalid task: id must be a non-empty string/,
      `expected rejection for ${String(bad)}`,
    );
  }
});

test("demo constructor guard segment is deterministic: two runs print byte-identical guard lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Constructor id fail-fast (the first door of the audit chain):",
      ),
      ls.indexOf(
        "History getter immutability (the audit trail cannot be rewritten at runtime \u2014 fixed timestamps, no network):",
      ),
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Blank line + header + three rejection lines + legal-construction line;
  // every value is a pinned literal (fixed inputs, the pinned error
  // wording, a fixed task id), so no normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.constructorGuardChecks, b.constructorGuardChecks);
  assert.equal(a.constructorGuardTask.id, b.constructorGuardTask.id);
});

test("demo shows the history getter immutability segment: push/splice/entry-write probes throw TypeError and the task is unchanged, then detachment is shown", async () => {
  const { historyImmutabilityChecks, lines } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — written out here from the rules in
  // test/historyFreeze.test.ts, cross-checked against the demo's own
  // rendering rather than derived from it.
  assert.equal(historyImmutabilityChecks.pushError, "TypeError");
  assert.equal(historyImmutabilityChecks.spliceError, "TypeError");
  assert.equal(historyImmutabilityChecks.entryWriteError, "TypeError");
  assert.equal(historyImmutabilityChecks.internalLengthAfterProbes, 2);
  assert.equal(historyImmutabilityChecks.snapshotsDeepEqualButIndependent, true);
  assert.equal(
    historyImmutabilityChecks.detachedSnapshotLengthAfterDispatch,
    2,
  );
  assert.equal(historyImmutabilityChecks.liveLengthAfterDispatch, 3);

  // The printed lines are pinned literals — every word derives from fixed
  // inputs, so they are asserted verbatim.
  assert.ok(
    text.includes(
      "History getter immutability (the audit trail cannot be rewritten at runtime \u2014 fixed timestamps, no network):",
    ),
  );
  assert.ok(
    text.includes(
      `  push a forged entry onto the history snapshot (${DEMO_HISTORY_TASK_ID}): throws TypeError; internal history still 2 entries`,
    ),
  );
  assert.ok(
    text.includes(
      "  splice the history snapshot: throws TypeError; internal history still 2 entries",
    ),
  );
  assert.ok(
    text.includes(
      "  rewrite entry.note on the history snapshot: throws TypeError; internal entry unchanged",
    ),
  );
  assert.ok(
    text.includes(
      "  two history getter calls return deep-equal but reference-independent snapshots (the array is never handed out twice)",
    ),
  );
  assert.ok(
    text.includes(
      "  dispatch START_CAPTURE after the snapshot: the old snapshot stays at 2 entries, the live history grows to 3 \u2014 a frozen detached copy; dispatch() is the only append path",
    ),
  );

  // Independent cross-check: the same three probes throw on fresh library
  // calls made directly through the library, not through the demo — the
  // demo segment must agree with the library, not with itself.
  const probe = new TaskLifecycle("freeze-probe-1");
  probe.dispatch("PUBLISH");
  probe.dispatch("ACCEPT");
  const h = probe.history as unknown as TaskHistoryEntry[];
  const forged: TaskHistoryEntry = {
    seq: 99,
    event: "PUBLISH",
    from: "DRAFT",
    to: "OPEN",
    at: DEMO_HISTORY_BASE_AT,
  };
  assert.throws(() => h.push(forged), TypeError);
  assert.throws(() => h.splice(0, 1), TypeError);
  assert.throws(() => {
    h[0].note = "forged";
  }, TypeError);
  assert.equal(probe.history.length, 2);
  assert.equal(probe.history[0].to, "OPEN");
  assert.equal(probe.history[0].note, undefined);
});

test("demo history immutability segment is deterministic: two runs print byte-identical segment lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "History getter immutability (the audit trail cannot be rewritten at runtime \u2014 fixed timestamps, no network):",
      ) - 1,
      ls.indexOf(
        "Stale patrol (staleTasks / maxAgeByState screening, notify-only action):",
      ),
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Blank line + header + five probe lines + the blank line before the
  // stale patrol; every value is a pinned literal (fixed inputs, the
  // pinned TypeError name, pinned counts), so no normalization is needed.
  assert.equal(segA.length, 8);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.historyImmutabilityChecks, b.historyImmutabilityChecks);
});
