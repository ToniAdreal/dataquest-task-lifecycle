import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runDemo, DEMO_WEBHOOK_SECRET } from "../src/demo.js";
import { readmeDiagramInSync } from "../src/diagram.js";
import {
  PayoutEventDedupe,
  TaskLifecycle,
  actOnStaleTasks,
  allowedEvents,
  expireOverdueTasks,
  expiredTasks,
  historyFromNdjson,
  historyToNdjson,
  isOverdue,
  parseHistory,
  parsePayoutRetryAfter,
  payoutMismatch,
  staleTasks,
  stateDiagram,
  transitionTable,
  transitionTableJson,
  verifyHistoryChain,
  verifyPayoutWebhook,
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
  reading the detail: delta = paid - quoted, rounded to cents — negative is an underpayment, positive an overpayment (the per-task follow-up finance runs after mismatchedPayouts flags a task)`;

test("demo lines match the pre-refactor golden output, line for line", async () => {
  const { lines } = await runDemo();
  assert.equal(lines.length, 302);
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
  // line + after-unsubscribe line + blank + final-state line;
  // every timestamp in the segment is a fixed literal that never
  // reaches the printed lines, so no normalization is needed.
  assert.equal(a.length, 13);
  assert.deepEqual(a, b);
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
      ls.indexOf("Stale-task batch execution branch (actOnStaleTasks over four more tasks):") - 1,
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
  // parsed-count, fromHistory, and match lines.
  assert.equal(segA.length, 18);
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

  assert.equal(out.trimEnd().split("\n").length, 302);
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
  // The executor's EXPIRE entries carry the library defaults —
  // no actor is recorded — so the test pins event/from/to only,
  // never those entries' wall-clock `at`.
  assert.deepEqual(
    expireExecutionTasks.slice(0, 2).map((t) => {
      const last = t.history.at(-1)!;
      return [last.event, last.from, last.to, last.actor];
    }),
    [
      ["EXPIRE", "ACCEPTED", "EXPIRED", undefined],
      ["EXPIRE", "OPEN", "EXPIRED", undefined],
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
  // The segment closes the demo: it follows the JSON snapshot
  // round-trip segment, prints its lines verbatim, and its
  // reading line is the demo's last line.
  const detailAt = text.indexOf(
    "Single-task payout reconciliation detail (payoutMismatch on the screened tasks):",
  );
  assert.ok(
    detailAt >
      text.indexOf("JSON snapshot round-trip (toJSON/fromJSON on the main task):"),
    "single-task payout reconciliation detail segment must follow the JSON snapshot round-trip segment",
  );
  for (const line of [
    "  DEMO-005: payoutMismatch -> quoted 4000, paid 3750.5, delta -249.5 (underpaid by 249.5 — the batch screen's one mismatched hit, opened up per task)",
    "  DEMO-004: payoutMismatch -> undefined (quoted 2500, paid 2500 — settled exactly as quoted, so there is no mismatch to report)",
  ]) {
    assert.ok(text.includes(line), `missing payout detail line: ${line}`);
  }
  assert.equal(
    lines[lines.length - 1],
    "  reading the detail: delta = paid - quoted, rounded to cents — negative is an underpayment, positive an overpayment (the per-task follow-up finance runs after mismatchedPayouts flags a task)",
  );
});

test("demo single-task payout reconciliation detail segment is deterministic: two runs print byte-identical detail lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Single-task payout reconciliation detail (payoutMismatch on the screened tasks):"),
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
