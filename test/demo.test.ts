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
  // Audit trail has exactly 12 numbered history entries
  // (8-step happy path + REJECT + RESUBMIT + second SUBMIT + second BEGIN_REVIEW)
  const seqRows = out.match(/^\s+\d+  /gm) ?? [];
  assert.equal(seqRows.length, 12);
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
