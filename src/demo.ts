/**
 * Demo: drive one task through the full happy path DRAFT -> PAID and print
 * the append-only audit history.
 *
 * Usage: `npm run demo` (builds with tsc, then runs node on the compiled
 * output). Zero runtime dependencies: this file only imports the state
 * machine itself.
 */

import { TaskLifecycle, type TaskEvent } from "./index.js";

const steps: Array<{
  event: TaskEvent;
  actor: string;
  note: string;
}> = [
  { event: "PUBLISH", actor: "system", note: "Researcher publishes the data-collection task" },
  { event: "ACCEPT", actor: "contributor", note: "Contributor picks up the task" },
  { event: "START_CAPTURE", actor: "contributor", note: "Data capture begins" },
  { event: "SUBMIT", actor: "contributor", note: "Batch uploaded for QA" },
  { event: "BEGIN_REVIEW", actor: "reviewer", note: "QA specialist starts review" },
  { event: "APPROVE", actor: "reviewer", note: "Sample passes QA" },
  { event: "REQUEST_PAYOUT", actor: "contributor", note: "Contributor requests payout" },
  { event: "PAYOUT_COMPLETE", actor: "system", note: "Finance settles the payout" },
];

function main(): void {
  const task = new TaskLifecycle("DEMO-001");
  console.log(`Task ${task.id}: ${task.state}`);

  for (const { event, actor, note } of steps) {
    const from = task.state;
    const to = task.dispatch(event, { actor, note });
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
}

main();
