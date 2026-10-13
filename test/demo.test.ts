import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

test("demo script runs the full DRAFT -> PAID chain and prints the audit history", () => {
  const out = execFileSync(
    "node",
    [path.join(repoRoot, "dist", "src", "demo.js")],
    { encoding: "utf8" },
  );

  // Header shows the task starting in DRAFT
  assert.match(out, /Task DEMO-001: DRAFT/);
  // Every transition of the happy path is logged
  for (const [event, from, to] of [
    ["PUBLISH", "DRAFT", "OPEN"],
    ["ACCEPT", "OPEN", "ACCEPTED"],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING"],
    ["SUBMIT", "CAPTURING", "SUBMITTED"],
    ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW"],
    ["APPROVE", "IN_REVIEW", "APPROVED"],
    ["REQUEST_PAYOUT", "APPROVED", "PAYOUT_PENDING"],
    ["PAYOUT_COMPLETE", "PAYOUT_PENDING", "PAID"],
  ]) {
    assert.ok(
      out.includes(event) && out.includes(from) && out.includes(to),
      `missing chain step ${event}: ${from} -> ${to}`,
    );
  }
  // Final state + terminal flag
  assert.match(out, /Final state: PAID \(terminal: true\)/);
  // Audit trail has exactly 8 numbered history entries
  const seqRows = out.match(/^\s+\d+  /gm) ?? [];
  assert.equal(seqRows.length, 8);
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
