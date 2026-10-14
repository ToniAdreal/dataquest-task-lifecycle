import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runDemo, DEMO_WEBHOOK_SECRET } from "../src/demo.js";
import { verifyPayoutWebhook } from "../src/index.js";

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
 * signature (a function of those). Every other byte — wording,
 * spacing, ordering, blank lines — must match exactly.
 */
function normalize(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g,
      "<uuid>",
    )
    .replace(/sha256=[0-9a-f]{64}/g, "sha256=<signature>");
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
  verifyPayoutWebhook: ok`;

test("demo lines match the pre-refactor golden output, line for line", () => {
  const { lines } = runDemo();
  assert.equal(lines.length, 79);
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
  // payout webhook section, which still closes the demo.
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

test("CLI entry point still runs as a subprocess and prints the same golden output", () => {
  const out = execFileSync(
    "node",
    [path.join(repoRoot, "dist", "src", "demo.js")],
    { encoding: "utf8" },
  );

  assert.equal(out.trimEnd().split("\n").length, 79);
  assert.equal(normalize(out.trimEnd()), GOLDEN_DEMO_OUTPUT);
  assert.match(out, /Task DEMO-001: DRAFT/);
  assert.match(out, /verifyPayoutWebhook: ok/);
});
