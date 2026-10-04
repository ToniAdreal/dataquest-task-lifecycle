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
