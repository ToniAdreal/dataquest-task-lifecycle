import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runDemo, DEMO_WEBHOOK_SECRET } from "../src/demo.js";
import {
  PayoutEventDedupe,
  TaskLifecycle,
  historyFromNdjson,
  historyToNdjson,
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
  replay matches the original (state + full history): true — last entry seq 12 PAYOUT_COMPLETE PAYOUT_PENDING -> PAID`;

test("demo lines match the pre-refactor golden output, line for line", () => {
  const { lines } = runDemo();
  assert.equal(lines.length, 150);
  assert.equal(normalize(lines.join("\n")), GOLDEN_DEMO_OUTPUT);
});

test("demo runs the DRAFT -> PAID chain with a REJECT -> RESUBMIT loop in-process", () => {
  const { task, lines } = runDemo();
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

test("demo builds the payout webhook from the settled task and verifies it (structured)", () => {
  const { webhook, webhookVerified, lines } = runDemo();
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

test("demo shows the receiver-side dedupe segment in-process: first delivery booked, redelivery skipped, same id accepted again after the TTL", () => {
  const { dedupeFirst, dedupeRedelivery, dedupeAfterTtl, webhook, lines } = runDemo();
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

test("demo dedupe segment is deterministic in outcome: two runs agree on all three checkAndRecord results", () => {
  const dedupeLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Receiver-side dedupe (PayoutEventDedupe on the webhook's eventId):"),
      ls.indexOf("Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):") - 1,
    );
  const a = runDemo();
  const b = runDemo();
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

test("demo shows the SLA watchdog branch in-process: screening finds DEMO-002, then EXPIRE lands it in EXPIRED", () => {
  const { overdueTask, overdueFound, lines } = runDemo();
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

test("demo shows the DISPUTE appeal branch in-process: DISPUTE lands DEMO-003 in DISPUTED, arbitration returns it to REJECTED", () => {
  const { disputeTask, lines } = runDemo();
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

test("demo builds the batch payout webhooks in-process: per-item isolation and per-item verification", () => {
  const { batchResults, batchVerified, lines } = runDemo();
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
  // with one line per result plus the summary (the reconciliation
  // branch follows it and closes the demo).
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

test("demo batch segment is deterministic: two runs print byte-identical batch lines", () => {
  const batchLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):"),
      ls.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):") - 1,
    );
  const a = batchLines(runDemo().lines);
  const b = batchLines(runDemo().lines);
  assert.equal(a.length, 6);
  assert.deepEqual(a, b);
  // The fixed shared `now` is printed literally — no wall clock, no
  // random eventId anywhere in the segment.
  assert.match(a.join("\n"), /shared now: 2026-03-13T09:00:00\.000Z/);
});

test("demo shows the reconciliation screening branch in-process: unreconciled, mismatched, and total match the hand-computed expectations", () => {
  const { unreconciledTask, mismatchedTask, unreconciledFound, mismatchedFound, totalPaid, lines } =
    runDemo();
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
  // The branch is printed after the batch section (the
  // subscription branch follows it, then the event-sourcing
  // replay segment closes the demo), with the three screening
  // lines verbatim.
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

test("demo reconciliation segment is deterministic: two runs print byte-identical reconciliation lines", () => {
  const reconLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Reconciliation screening branch (two more PAID tasks, then the finance pass):"),
      ls.indexOf("Dispatch subscription branch (sixth task, in-process fan-out):") - 1,
    );
  const a = reconLines(runDemo().lines);
  const b = reconLines(runDemo().lines);
  // Header + (task header + 8 transitions + note) x2 + 4 screening
  // lines; every timestamp in the segment is a fixed literal that
  // never reaches the printed lines, so no normalization is needed.
  assert.equal(a.length, 25);
  assert.deepEqual(a, b);
});


test("demo shows the dispatch subscription branch in-process: ordered notifications match history, silence after unsubscribe", () => {
  const {
    subscriptionTask,
    subscriptionNotifications,
    subscriptionMatchesHistory,
    subscriptionCountAfterUnsubscribe,
    lines,
  } = runDemo();
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

test("demo subscription segment is deterministic: two runs print byte-identical subscription lines", () => {
  const subLines = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Dispatch subscription branch (sixth task, in-process fan-out):"),
      ls.indexOf("Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):") - 1,
    );
  const a = subLines(runDemo().lines);
  const b = subLines(runDemo().lines);
  // Header + task header + subscribed line + received header + 3
  // notification lines + match line + unsubscribed line + SUBMIT
  // line + after-unsubscribe line + blank + final-state line;
  // every timestamp in the segment is a fixed literal that never
  // reaches the printed lines, so no normalization is needed.
  assert.equal(a.length, 13);
  assert.deepEqual(a, b);
});

test("demo shows the event-sourcing replay segment in-process: NDJSON export parses back and fromHistory rebuilds the same PAID task", () => {
  const { task, ndjsonText, replayedTask, lines } = runDemo();
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

test("demo event-sourcing segment agrees across two runs once the main task's own varying values are normalized", () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):") - 1,
    );
  const a = runDemo();
  const b = runDemo();
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

test("CLI entry point still runs as a subprocess and prints the same golden output", () => {
  const out = execFileSync(
    "node",
    [path.join(repoRoot, "dist", "src", "demo.js")],
    { encoding: "utf8" },
  );

  assert.equal(out.trimEnd().split("\n").length, 150);
  assert.equal(normalize(out.trimEnd()), GOLDEN_DEMO_OUTPUT);
  assert.match(out, /Task DEMO-001: DRAFT/);
  assert.match(out, /verifyPayoutWebhook: ok/);
});
