/**
 * Demo: drive one task from DRAFT to PAID — its first submission is
 * REJECTed in QA and RESUBMITted before it passes on re-review — print
 * the append-only audit history, run a second task through the SLA
 * watchdog branch (an advisory deadline passes, `expiredTasks()`
 * screening finds the task, and a watchdog explicitly dispatches
 * EXPIRE into the EXPIRED terminal state), run a third task through
 * the DISPUTE appeal branch (a REJECTED task is DISPUTEd into
 * DISPUTED and an arbitrator's ARBITRATE_REJECT lands it back in
 * REJECTED, consuming the task's one demo dispute), then build the
 * signed payout webhook for the settled task and verify it the way
 * a receiver would, run the batch builder
 * (`buildPayoutWebhooks`) over all three demo tasks — the
 * settlement-peak pipeline in which each non-PAID task fails only
 * itself and every built webhook is verified in turn — and finally
 * run a reconciliation screening branch: two more tasks driven to
 * PAID under fixed-literal timestamps, one settled with no
 * `payoutRef` on its `PAYOUT_COMPLETE` entry and one settled for
 * less than its `ACCEPT` quote, screened together with the three
 * earlier tasks by `unreconciledPayouts()` / `mismatchedPayouts()`
 * / `totalPaidOut()` — the post-settlement finance pass a platform
 * runs after payout day.
 *
 * Usage: `npm run demo` (builds with tsc, then runs node on the compiled
 * output). Zero runtime dependencies: this file only imports the state
 * machine itself.
 *
 * The script is structured as an importable `runDemo()` (the same
 * shape as the sibling demos in rfc9421-signing-demo and
 * escrow-state-machine-ts): it returns all five tasks, the screening
 * results, the built webhook and its verification outcome, plus the
 * exact `lines` the CLI prints — so tests assert on structured values
 * in-process instead of only regex-matching a child process's stdout.
 * The CLI entry point at the bottom prints those lines unchanged:
 * `npm run demo` output is line-for-line what the pre-refactor
 * top-level script printed (the golden comparison lives in
 * `test/demo.test.ts`, normalizing only the values that already
 * varied between any two runs of the old script — the main task's
 * wall-clock history timestamps and the webhook's `at` / `eventId` /
 * signature, which derive from them and from a random UUID).
 */

import { fileURLToPath } from "node:url";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  expiredTasks,
  mismatchedPayouts,
  payoutMismatch,
  totalPaidOut,
  unreconciledPayouts,
  verifyPayoutWebhook,
  type BuildPayoutWebhooksResult,
  type PayoutWebhook,
  type TaskEvent,
} from "./index.js";

/**
 * Signing secret for the demo webhook only — a placeholder printed in
 * the source, NOT a real credential. A real deployment loads its
 * secret from its own credential store and never commits it.
 */
export const DEMO_WEBHOOK_SECRET = "demo-secret-do-not-use-in-production";

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
  { event: "REJECT", actor: "reviewer", note: "Sample fails QA: gaps in the capture" },
  {
    event: "RESUBMIT",
    actor: "contributor",
    note: "Contributor fixes the batch and resubmits (uses 1 of the demo's 2 allowed RESUBMITs)",
  },
  { event: "SUBMIT", actor: "contributor", note: "Revised batch uploaded for QA" },
  { event: "BEGIN_REVIEW", actor: "reviewer", note: "QA specialist re-reviews the revised batch" },
  { event: "APPROVE", actor: "reviewer", note: "Revised sample passes QA" },
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

export interface DemoResult {
  task: TaskLifecycle;
  overdueTask: TaskLifecycle;
  overdueFound: TaskLifecycle[];
  disputeTask: TaskLifecycle;
  webhook: PayoutWebhook;
  webhookVerified: boolean;
  batchResults: BuildPayoutWebhooksResult[];
  batchVerified: Array<boolean | undefined>;
  unreconciledTask: TaskLifecycle;
  mismatchedTask: TaskLifecycle;
  unreconciledFound: TaskLifecycle[];
  mismatchedFound: TaskLifecycle[];
  totalPaid: number;
  lines: string[];
}

/**
 * Run the demo lifecycle without printing anything, and return the
 * five tasks, the watchdog screening result, the built + verified
 * payout webhook, the batch webhook results with their per-item
 * verification outcomes, the reconciliation screening results with
 * the paid-out total, and the exact lines `main()` prints — so
 * tests can assert on the demo itself, not just on the library.
 */
export function runDemo(): DemoResult {
  // The demo sets an explicit resubmit budget of 2 so the REJECT ->
  // RESUBMIT loop below shows the budget being consumed (this script
  // uses 1 of the 2). The library default for `maxResubmits` is
  // unlimited — the budget here is a demo policy choice, not a
  // built-in cap, and a third RESUBMIT on this task would throw
  // "resubmit budget exhausted".
  const task = new TaskLifecycle("DEMO-001", { maxResubmits: 2 });
  const lines: string[] = [`Task ${task.id}: ${task.state}`];

  for (const { event, actor, note, payoutRef, payoutAmount } of steps) {
    const from = task.state;
    const to = task.dispatch(event, {
      actor,
      note,
      ...(payoutRef !== undefined ? { payoutRef } : {}),
      ...(payoutAmount !== undefined ? { payoutAmount } : {}),
    });
    lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
  }

  lines.push("", `Final state: ${task.state} (terminal: ${task.isTerminal})`);
  lines.push("History (append-only audit trail):");
  lines.push("  seq  event            from          -> to             actor        at");
  for (const h of task.history) {
    lines.push(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(16)} ${h.from.padEnd(13)} -> ${h.to.padEnd(13)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}`,
    );
  }

  // SLA watchdog branch: a second task whose ACCEPTED-state SLA
  // deadline has already passed at the screening instant. The deadline
  // is advisory only — it never moves the task by itself — so the
  // branch first screens the batch with expiredTasks() under a fixed
  // `now`, shows the task is still ACCEPTED, and only then does the
  // watchdog explicitly dispatch EXPIRE, exactly the wiring the README
  // FAQ describes. Every timestamp in this branch is a fixed literal
  // or the injected screening `now`: no wall clock is read here.
  const SLA_BRANCH_NOW = new Date("2026-03-06T09:00:00.000Z");
  const overdueTask = new TaskLifecycle("DEMO-002");
  lines.push("", "SLA watchdog branch (second task, advisory deadline):");
  lines.push(`Task ${overdueTask.id}: ${overdueTask.state}`);
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-03-01T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-03-01T09:05:00.000Z"],
  ] as const) {
    const from = overdueTask.state;
    const to = overdueTask.dispatch(event, { actor, at });
    lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
  }
  overdueTask.setSlaDeadline("2026-03-03T09:00:00.000Z");
  lines.push(
    `  SLA deadline (ACCEPTED): ${overdueTask.getSlaDeadline("ACCEPTED")}`,
  );
  const overdueFound = expiredTasks([task, overdueTask], SLA_BRANCH_NOW);
  lines.push(
    `  expiredTasks([${task.id}, ${overdueTask.id}], ${SLA_BRANCH_NOW.toISOString()}): ${overdueFound.map((t) => t.id).join(", ")} (${overdueFound.length} overdue)`,
  );
  lines.push(
    `  ${overdueTask.id} still ${overdueTask.state}: the deadline alone never expires a task`,
  );
  for (const found of overdueFound) {
    const from = found.state;
    const to = found.dispatch("EXPIRE", {
      actor: "watchdog",
      at: SLA_BRANCH_NOW.toISOString(),
    });
    lines.push(`  ${"EXPIRE".padEnd(15)} ${from.padEnd(12)} -> ${to}  (watchdog)`);
  }
  lines.push(
    "",
    `Final state (SLA branch): ${overdueTask.state} (terminal: ${overdueTask.isTerminal})`,
  );
  lines.push("History (SLA branch, append-only audit trail):");
  lines.push("  seq  event            from          -> to             actor        at");
  for (const h of overdueTask.history) {
    lines.push(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(16)} ${h.from.padEnd(13)} -> ${h.to.padEnd(13)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}`,
    );
  }

  // DISPUTE appeal branch: a third task that is REJECTED in QA and
  // then appealed instead of resubmitted. The contributor DISPUTEs
  // the rejection (REJECTED -> DISPUTED) and a moderator arbitrates
  // against the appeal (ARBITRATE_REJECT -> REJECTED), so the branch
  // ends back in REJECTED — not a terminal state. The demo sets an
  // explicit dispute budget of 1 so the appeal shows the budget
  // being consumed (this script uses 1 of the 1). The library
  // default for `maxDisputes` is unlimited — the budget here is a
  // demo policy choice, not a built-in cap, and a second DISPUTE on
  // this task would throw "dispute budget exhausted". Every
  // timestamp in this branch is a fixed literal: no wall clock is
  // read here.
  const disputeTask = new TaskLifecycle("DEMO-003", { maxDisputes: 1 });
  lines.push("", "DISPUTE appeal branch (third task, dispute budget):");
  lines.push(`Task ${disputeTask.id}: ${disputeTask.state}`);
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-03-10T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-03-10T09:05:00.000Z"],
    ["START_CAPTURE", "contributor", "2026-03-10T09:10:00.000Z"],
    ["SUBMIT", "contributor", "2026-03-11T09:00:00.000Z"],
    ["BEGIN_REVIEW", "reviewer", "2026-03-11T09:05:00.000Z"],
    ["REJECT", "reviewer", "2026-03-11T09:10:00.000Z"],
    ["DISPUTE", "contributor", "2026-03-11T10:00:00.000Z"],
    ["ARBITRATE_REJECT", "moderator", "2026-03-12T09:00:00.000Z"],
  ] as const) {
    const from = disputeTask.state;
    const to = disputeTask.dispatch(event, { actor, at });
    lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
  }
  lines.push(
    "  dispute budget: 1 of 1 DISPUTEs used (demo sets maxDisputes: 1; the library default is unlimited)",
  );
  lines.push(
    "",
    `Final state (DISPUTE branch): ${disputeTask.state} (terminal: ${disputeTask.isTerminal})`,
  );
  lines.push("History (DISPUTE branch, append-only audit trail):");
  lines.push("  seq  event            from          -> to             actor        at");
  for (const h of disputeTask.history) {
    lines.push(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(16)} ${h.from.padEnd(13)} -> ${h.to.padEnd(13)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}`,
    );
  }

  // The PAID state is where PAYOUT_COMPLETE settlement webhooks fire:
  // build the signed notification from the audit history, print what a
  // receiver would get, then verify it with the same secret.
  const webhook = buildPayoutWebhook(task, DEMO_WEBHOOK_SECRET);
  const { payload, signature } = webhook;
  lines.push("", "Payout webhook (signed PAYOUT_COMPLETE notification):");
  lines.push(`  event:        ${payload.event}`);
  lines.push(`  taskId:       ${payload.taskId}`);
  lines.push(`  payoutRef:    ${payload.payoutRef}`);
  lines.push(`  payoutAmount: ${payload.payoutAmount}`);
  lines.push(`  at:           ${payload.at}`);
  lines.push(`  eventId:      ${payload.eventId}`);
  lines.push(`  signature:    ${signature}`);
  const webhookVerified = verifyPayoutWebhook(payload, signature, DEMO_WEBHOOK_SECRET);
  lines.push(`  verifyPayoutWebhook: ${webhookVerified ? "ok" : "FAILED"}`);

  // Batch payout webhook segment: the settlement-peak pipeline. A
  // single build handles one settled task; at settlement time the
  // norm is a batch — every demo task at once — built with
  // buildPayoutWebhooks under the shared demo secret, one shared
  // fixed `now`, and a deterministic eventId factory, so this whole
  // segment is byte-identical on every run (no network, no
  // randomness, no wall clock). The batch deliberately mixes the
  // PAID main task with the two non-PAID branch tasks: each non-PAID
  // task lands as `{ taskId, error }` only, fails only itself, and
  // never blocks the tasks after it — DEMO-003 is still attempted
  // after DEMO-002 errors. Every built webhook is then verified
  // with the demo secret, exactly as in the single-build section.
  const BATCH_NOW = new Date("2026-03-13T09:00:00.000Z");
  let batchSeq = 0;
  const batchResults = buildPayoutWebhooks(
    [task, overdueTask, disputeTask],
    DEMO_WEBHOOK_SECRET,
    {
      now: BATCH_NOW,
      eventIdFactory: () =>
        `evt_demo_batch_${String(++batchSeq).padStart(3, "0")}`,
    },
  );
  const batchVerified: Array<boolean | undefined> = batchResults.map((r) =>
    r.webhook
      ? verifyPayoutWebhook(r.webhook.payload, r.webhook.signature, DEMO_WEBHOOK_SECRET)
      : undefined,
  );
  lines.push("", "Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):");
  lines.push(
    `  shared now: ${BATCH_NOW.toISOString()} (eventIds from a deterministic factory)`,
  );
  batchResults.forEach((r, i) => {
    if (r.webhook) {
      lines.push(
        `  ${r.taskId}: webhook eventId=${r.webhook.payload.eventId} payoutRef=${r.webhook.payload.payoutRef} payoutAmount=${r.webhook.payload.payoutAmount} verifyPayoutWebhook: ${batchVerified[i] ? "ok" : "FAILED"}`,
      );
    } else {
      lines.push(`  ${r.taskId}: error: ${r.error}`);
    }
  });
  const batchBuilt = batchResults.filter((r) => r.webhook).length;
  lines.push(
    `  batch: ${batchBuilt} webhook(s) built, ${batchResults.length - batchBuilt} error(s) — a non-PAID task fails only itself and never blocks later tasks`,
  );

  // Reconciliation screening branch: payout day is not the end of
  // the story — finance then screens the settled tasks for the ones
  // whose settlement lacks external evidence or disagrees with the
  // quote. Two more tasks are driven to PAID here, each with one
  // deliberate flaw, every timestamp a fixed literal (no network,
  // no randomness, no wall clock):
  //   DEMO-004 settles exactly as quoted (ACCEPT quotedAmount 2500,
  //     PAYOUT_COMPLETE payoutAmount 2500) but its PAYOUT_COMPLETE
  //     entry carries NO payoutRef — paid, yet unevidenced, so
  //     unreconciledPayouts() must flag it and mismatchedPayouts()
  //     must not.
  //   DEMO-005 settles under payoutRef "xfer-91c7" but for 3750.5
  //     against an ACCEPT quote of 4000 (delta -249.5) — evidenced,
  //     yet short, so mismatchedPayouts() must flag it and
  //     unreconciledPayouts() must not.
  // The main task DEMO-001 (payoutRef "xfer-88f2", payoutAmount
  // 10098.5, no recorded quote) must be flagged by neither screen.
  // Hand-computed expectations for the screening over all five demo
  // tasks: unreconciled = [DEMO-004], mismatched = [DEMO-005],
  // totalPaidOut = 10098.5 + 2500 + 3750.5 = 16349 (the EXPIRED and
  // REJECTED tasks contribute nothing).
  const drivePaidTask = (
    id: string,
    spec: Array<{
      event: TaskEvent;
      actor: string;
      at: string;
      quotedAmount?: number;
      payoutRef?: string;
      payoutAmount?: number;
    }>,
  ): TaskLifecycle => {
    const driven = new TaskLifecycle(id);
    lines.push(`Task ${driven.id}: ${driven.state}`);
    for (const { event, actor, at, quotedAmount, payoutRef, payoutAmount } of spec) {
      const from = driven.state;
      const to = driven.dispatch(event, {
        actor,
        at,
        ...(quotedAmount !== undefined ? { quotedAmount } : {}),
        ...(payoutRef !== undefined ? { payoutRef } : {}),
        ...(payoutAmount !== undefined ? { payoutAmount } : {}),
      });
      lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
    }
    return driven;
  };
  lines.push("", "Reconciliation screening branch (two more PAID tasks, then the finance pass):");
  const unreconciledTask = drivePaidTask("DEMO-004", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-14T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-14T09:05:00.000Z", quotedAmount: 2500 },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-14T09:10:00.000Z" },
    { event: "SUBMIT", actor: "contributor", at: "2026-03-15T09:00:00.000Z" },
    { event: "BEGIN_REVIEW", actor: "reviewer", at: "2026-03-15T09:05:00.000Z" },
    { event: "APPROVE", actor: "reviewer", at: "2026-03-15T09:10:00.000Z" },
    { event: "REQUEST_PAYOUT", actor: "contributor", at: "2026-03-15T09:15:00.000Z" },
    { event: "PAYOUT_COMPLETE", actor: "system", at: "2026-03-15T09:20:00.000Z", payoutAmount: 2500 },
  ]);
  lines.push(
    "  note: PAYOUT_COMPLETE records payoutAmount=2500 and no payoutRef (the ACCEPT quote was also 2500, so the amount itself agrees)",
  );
  const mismatchedTask = drivePaidTask("DEMO-005", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-16T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-16T09:05:00.000Z", quotedAmount: 4000 },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-16T09:10:00.000Z" },
    { event: "SUBMIT", actor: "contributor", at: "2026-03-17T09:00:00.000Z" },
    { event: "BEGIN_REVIEW", actor: "reviewer", at: "2026-03-17T09:05:00.000Z" },
    { event: "APPROVE", actor: "reviewer", at: "2026-03-17T09:10:00.000Z" },
    { event: "REQUEST_PAYOUT", actor: "contributor", at: "2026-03-17T09:15:00.000Z" },
    { event: "PAYOUT_COMPLETE", actor: "system", at: "2026-03-17T09:20:00.000Z", payoutRef: "xfer-91c7", payoutAmount: 3750.5 },
  ]);
  lines.push(
    "  note: ACCEPT quoted 4000 but PAYOUT_COMPLETE settled 3750.5 under payoutRef xfer-91c7 (the amount, not the evidence, is the problem)",
  );
  const screenedTasks = [task, overdueTask, disputeTask, unreconciledTask, mismatchedTask];
  const unreconciledFound = unreconciledPayouts(screenedTasks);
  const mismatchedFound = mismatchedPayouts(screenedTasks);
  const totalPaid = totalPaidOut(screenedTasks);
  lines.push(`  screened: ${screenedTasks.map((t) => t.id).join(", ")} (all five demo tasks)`);
  lines.push(
    `  unreconciledPayouts: ${unreconciledFound.map((t) => t.id).join(", ")} (${unreconciledFound.length} hit: PAID but no payoutRef on the PAYOUT_COMPLETE entry)`,
  );
  lines.push(
    `  mismatchedPayouts: ${mismatchedFound
      .map((t) => {
        const m = payoutMismatch(t)!;
        return `${t.id} (quoted ${m.quoted}, paid ${m.paid}, delta ${m.delta})`;
      })
      .join(", ")} (${mismatchedFound.length} hit: settled amount differs from the ACCEPT quote)`,
  );
  lines.push(
    `  totalPaidOut: ${totalPaid} (10098.5 + 2500 + 3750.5 across the 3 PAID tasks; the EXPIRED and REJECTED tasks contribute nothing)`,
  );

  return { task, overdueTask, overdueFound, disputeTask, webhook, webhookVerified, batchResults, batchVerified, unreconciledTask, mismatchedTask, unreconciledFound, mismatchedFound, totalPaid, lines };
}

function main(): void {
  console.log(runDemo().lines.join("\n"));
}

// Run only when executed directly (`node dist/src/demo.js`), not when
// imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
