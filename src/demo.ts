/**
 * Demo: drive one task through the full happy path DRAFT -> PAID, print
 * the append-only audit history, then build the signed payout webhook
 * for the settled task and verify it the way a receiver would.
 *
 * Usage: `npm run demo` (builds with tsc, then runs node on the compiled
 * output). Zero runtime dependencies: this file only imports the state
 * machine itself.
 */

import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
  type TaskEvent,
} from "./index.js";

/**
 * Signing secret for the demo webhook only — a placeholder printed in
 * the source, NOT a real credential. A real deployment loads its
 * secret from its own credential store and never commits it.
 */
const DEMO_WEBHOOK_SECRET = "demo-secret-do-not-use-in-production";

const steps: Array<{
  event: TaskEvent;
  actor: string;
  note: string;
  payoutRef?: string;
  payoutAmount?: number;
}> = [
  { event: "PUBLISH", actor: "system", note: "Researcher publishes the data-collection task" },
  { event: "ACCEPT", actor: "contributor", note: "Contributor picks up the task" },
  { event: "START_CAPTURE", actor: "contributor", note: "Data capture begins" },
  { event: "SUBMIT", actor: "contributor", note: "Batch uploaded for QA" },
  { event: "BEGIN_REVIEW", actor: "reviewer", note: "QA specialist starts review" },
  { event: "APPROVE", actor: "reviewer", note: "Sample passes QA" },
  { event: "REQUEST_PAYOUT", actor: "contributor", note: "Contributor requests payout" },
  {
    event: "PAYOUT_COMPLETE",
    actor: "system",
    note: "Finance settles the payout",
    // Settlement evidence carried on the audit entry (same fixture
    // values the webhook tests use): the payout webhook payload below
    // derives payoutRef/payoutAmount from exactly this entry.
    payoutRef: "xfer-88f2",
    payoutAmount: 10098.5,
  },
];

function main(): void {
  const task = new TaskLifecycle("DEMO-001");
  console.log(`Task ${task.id}: ${task.state}`);

  for (const { event, actor, note, payoutRef, payoutAmount } of steps) {
    const from = task.state;
    const to = task.dispatch(event, {
      actor,
      note,
      ...(payoutRef !== undefined ? { payoutRef } : {}),
      ...(payoutAmount !== undefined ? { payoutAmount } : {}),
    });
    console.log(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
  }

  console.log(`\nFinal state: ${task.state} (terminal: ${task.isTerminal})`);
  console.log("History (append-only audit trail):");
  console.log("  seq  event            from          -> to             actor        at");
  for (const h of task.history) {
    console.log(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(16)} ${h.from.padEnd(13)} -> ${h.to.padEnd(13)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}`,
    );
  }

  // The PAID state is where PAYOUT_COMPLETE settlement webhooks fire:
  // build the signed notification from the audit history, print what a
  // receiver would get, then verify it with the same secret.
  const { payload, signature } = buildPayoutWebhook(task, DEMO_WEBHOOK_SECRET);
  console.log("\nPayout webhook (signed PAYOUT_COMPLETE notification):");
  console.log(`  event:        ${payload.event}`);
  console.log(`  taskId:       ${payload.taskId}`);
  console.log(`  payoutRef:    ${payload.payoutRef}`);
  console.log(`  payoutAmount: ${payload.payoutAmount}`);
  console.log(`  at:           ${payload.at}`);
  console.log(`  eventId:      ${payload.eventId}`);
  console.log(`  signature:    ${signature}`);
  const verified = verifyPayoutWebhook(payload, signature, DEMO_WEBHOOK_SECRET);
  console.log(`  verifyPayoutWebhook: ${verified ? "ok" : "FAILED"}`);
}

main();
