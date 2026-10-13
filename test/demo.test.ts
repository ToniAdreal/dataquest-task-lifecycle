import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

test("demo script runs the DRAFT -> PAID chain with a REJECT -> RESUBMIT loop and prints the audit history", () => {
  const out = execFileSync(
    "node",
    [path.join(repoRoot, "dist", "src", "demo.js")],
    { encoding: "utf8" },
  );

  // Header shows the task starting in DRAFT
  assert.match(out, /Task DEMO-001: DRAFT/);
  // Every transition of the script is logged, including the
  // REJECT -> RESUBMIT loop and the second submission round
  for (const [event, from, to] of [
    ["PUBLISH", "DRAFT", "OPEN"],
    ["ACCEPT", "OPEN", "ACCEPTED"],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING"],
    ["SUBMIT", "CAPTURING", "SUBMITTED"],
    ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW"],
    ["REJECT", "IN_REVIEW", "REJECTED"],
    ["RESUBMIT", "REJECTED", "CAPTURING"],
    ["APPROVE", "IN_REVIEW", "APPROVED"],
    ["REQUEST_PAYOUT", "APPROVED", "PAYOUT_PENDING"],
    ["PAYOUT_COMPLETE", "PAYOUT_PENDING", "PAID"],
  ]) {
    assert.ok(
      out.includes(event) && out.includes(from) && out.includes(to),
      `missing chain step ${event}: ${from} -> ${to}`,
    );
  }
  // The loop is ordered: REJECT comes before RESUBMIT, and RESUBMIT
  // comes before the eventual APPROVE / PAID finish
  const rejectAt = out.indexOf("REJECT");
  const resubmitAt = out.indexOf("RESUBMIT");
  const approveAt = out.indexOf("APPROVE");
  assert.ok(rejectAt >= 0 && resubmitAt > rejectAt, "RESUBMIT must follow REJECT");
  assert.ok(approveAt > resubmitAt, "APPROVE must follow the RESUBMIT loop");
  // Final state + terminal flag
  assert.match(out, /Final state: PAID \(terminal: true\)/);
  // Numbered history rows across both printed audit trails: the main
  // task has exactly 12 entries (8-step happy path + REJECT + RESUBMIT
  // + second SUBMIT + second BEGIN_REVIEW) and the SLA branch task
  // printed below it has exactly 3 (PUBLISH + ACCEPT + EXPIRE).
  const seqRows = out.match(/^\s+\d+  /gm) ?? [];
  assert.equal(seqRows.length, 15);
});

test("demo builds the payout webhook from the settled task and verifies it", () => {
  const out = execFileSync(
    "node",
    [path.join(repoRoot, "dist", "src", "demo.js")],
    { encoding: "utf8" },
  );

  // Webhook section appears after the audit history
  assert.match(out, /Payout webhook \(signed PAYOUT_COMPLETE notification\):/);
  // Payload fields derive from the PAYOUT_COMPLETE audit entry
  assert.match(out, /event:\s+PAYOUT_COMPLETE/);
  assert.match(out, /taskId:\s+DEMO-001/);
  assert.match(out, /payoutRef:\s+xfer-88f2/);
  assert.match(out, /payoutAmount:\s+10098\.5/);
  // eventId is a UUID v4 and the signature is a sha256= HMAC hex digest
  assert.match(
    out,
    /eventId:\s+[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
  );
  assert.match(out, /signature:\s+sha256=[0-9a-f]{64}/);
  // The demo self-verifies with the (clearly labelled) demo secret
  assert.match(out, /verifyPayoutWebhook: ok/);
});

test("demo shows the SLA watchdog branch: screening finds the overdue task, then EXPIRE lands it in EXPIRED", () => {
  const out = execFileSync(
    "node",
    [path.join(repoRoot, "dist", "src", "demo.js")],
    { encoding: "utf8" },
  );

  // Branch header and the second task's fixed-timestamp setup steps
  assert.match(out, /SLA watchdog branch \(second task, advisory deadline\):/);
  assert.match(out, /Task DEMO-002: DRAFT/);
  // The ACCEPTED-state SLA deadline is printed verbatim (fixed literal)
  assert.match(out, /SLA deadline \(ACCEPTED\): 2026-03-03T09:00:00\.000Z/);
  // Screening under the injected fixed now finds exactly DEMO-002:
  // DEMO-001 is PAID (terminal) and carries no deadline
  assert.match(
    out,
    /expiredTasks\(\[DEMO-001, DEMO-002\], 2026-03-06T09:00:00\.000Z\): DEMO-002 \(1 overdue\)/,
  );
  // The deadline is advisory: the task is still ACCEPTED after screening
  assert.match(out, /DEMO-002 still ACCEPTED: the deadline alone never expires a task/);
  // The watchdog's explicit EXPIRE dispatch and the terminal end state
  assert.ok(
    out.includes("EXPIRE") && out.includes("ACCEPTED") && out.includes("EXPIRED"),
    "missing EXPIRE transition ACCEPTED -> EXPIRED",
  );
  assert.match(out, /Final state \(SLA branch\): EXPIRED \(terminal: true\)/);
  // Ordering: screening is printed before the EXPIRE dispatch, and the
  // branch history carries the fixed dispatch timestamps (no wall clock)
  const screenAt = out.indexOf("expiredTasks([DEMO-001, DEMO-002]");
  const expireAt = out.indexOf("EXPIRE", screenAt);
  assert.ok(screenAt >= 0 && expireAt > screenAt, "EXPIRE must follow the screening line");
  assert.match(out, /PUBLISH\s+DRAFT\s+-> OPEN\s+researcher\s+2026-03-01T09:00:00\.000Z/);
  assert.match(out, /EXPIRE\s+ACCEPTED\s+-> EXPIRED\s+watchdog\s+2026-03-06T09:00:00\.000Z/);
  // The main line still finishes PAID with the webhook verification after
  // the branch section
  const branchAt = out.indexOf("SLA watchdog branch");
  const webhookAt = out.indexOf("Payout webhook (signed PAYOUT_COMPLETE notification):");
  assert.ok(webhookAt > branchAt, "payout webhook section must follow the SLA branch");
  assert.match(out, /verifyPayoutWebhook: ok/);
});
