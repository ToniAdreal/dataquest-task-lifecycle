/**
 * Demo: drive one task from DRAFT to PAID — its first submission is
 * REJECTed in QA and RESUBMITted before it passes on re-review — print
 * the append-only audit history, verify that history's hash chain
 * with `verifyHistoryChain` (the intact chain passes; a detached
 * copy whose PAYOUT_COMPLETE entry's `payoutAmount` is altered by 1
 * is detected, and the original history re-verifies untouched), run
 * a second task through the SLA
 * watchdog branch (an advisory deadline passes, `expiredTasks()`
 * screening finds the task, and a watchdog explicitly dispatches
 * EXPIRE into the EXPIRED terminal state), run a third task through
 * the DISPUTE appeal branch (a REJECTED task is DISPUTEd into
 * DISPUTED and an arbitrator's ARBITRATE_REJECT lands it back in
 * REJECTED, consuming the task's one demo dispute), then build the
 * signed payout webhook for the settled task and verify it the way
 * a receiver would, feed its `eventId` through a receiver-side
 * `PayoutEventDedupe` under an injected fixed clock (the first
 * delivery is booked, the redelivery is skipped as a duplicate,
 * and the same id is accepted again once the demo TTL lapses),
 * run the batch builder
 * (`buildPayoutWebhooks`) over all three demo tasks — the
 * settlement-peak pipeline in which each non-PAID task fails only
 * itself and every built webhook is verified in turn — then fan
 * the main task's payout event out with
 * `deliverPayoutWebhookToMany` to three fixed endpoints under one
 * shared fixed `eventId` / `now`, each endpoint signed with its
 * own demo secret and delivered through an injected fake fetch
 * (one endpoint answers 500 on every attempt and exhausts its
 * retries; the other two still succeed — a failing endpoint never
 * blocks the rest), parse a fixed 6-value corpus of would-be
 * `Retry-After` hints with `parsePayoutRetryAfter` under the
 * fan-out segment's shared fixed instant reused as `nowMs`
 * (delay-seconds and HTTP-date forms normalized to milliseconds,
 * a past date clamped to 0, and garbage / absent values falling
 * back to `undefined` — the hint a 429 response would have used
 * to set the risk endpoint's next retry delay) — and finally
 * run a reconciliation screening branch: two more tasks driven to
 * PAID under fixed-literal timestamps, one settled with no
 * `payoutRef` on its `PAYOUT_COMPLETE` entry and one settled for
 * less than its `ACCEPT` quote, screened together with the three
 * earlier tasks by `unreconciledPayouts()` / `mismatchedPayouts()`
 * / `totalPaidOut()` — the post-settlement finance pass a platform
 * runs after payout day — run a sixth task through the dispatch
 * subscription branch (a collecting listener subscribed before any
 * dispatch receives each `(event, from, to)` in order, matching
 * the audit history entry for entry, and — after unsubscribe —
 * receives nothing for one further dispatch), run three more
 * tasks through the stale-task dwell screening branch (each task's
 * history ends at a fixed literal timestamp, so at one fixed
 * screening `now` the dwell in its current state — `now` minus the
 * last history entry's `at` — is exact: one task has sat in OPEN
 * past its dwell budget but its SLA deadline is still ahead, one
 * has sat in IN_REVIEW within its dwell budget but its SLA
 * deadline has passed, and one is within both — so `staleTasks()`
 * and `expiredTasks()` select different subsets of the same batch,
 * printed side by side), run four more tasks through the
 * stale-task batch execution branch (at the same fixed `now`,
 * `actOnStaleTasks()` runs an ABANDON action over the batch: a
 * stale task stuck in SUBMITTED — a state with no ABANDON edge —
 * fails in isolation and is left untouched, the stale ACCEPTED
 * and CAPTURING tasks after it are still abandoned, and a fresh
 * ACCEPTED task is never attempted), run three more tasks through
 * the SLA watchdog batch execution branch (a fresh rebuild of the
 * SLA screening batch's fixed-literal setup under the very same
 * fixed screening `now` — the executor mutates its inputs and the
 * original branch tasks are already settled — on which
 * `expireOverdueTasks()` dispatches EXPIRE for both overdue tasks
 * while the not-yet-overdue task produces no result entry at all,
 * and the screening subset is printed beside the execution's
 * acted set: the two agree), an
 * event-sourcing replay
 * segment: the main task's audit history is exported with
 * `historyToNdjson()`, printed in full, parsed back with
 * `historyFromNdjson()`, and replayed with
 * `TaskLifecycle.fromHistory()` — the history alone, as the single
 * source of truth, rebuilds the same PAID terminal state — and
 * finally an allowed-events listing segment: `allowedEvents(state)`
 * is run over all 13 states in transition-table order and printed
 * as a one-line-per-state overview — the query a task-list UI or a
 * watchdog consults to decide what a task can do next — with the
 * three terminal states (PAID / ABANDONED / EXPIRED) returning the
 * empty list, and the main task's own PAID state called out on its
 * own line as that same empty set — and finally a standalone
 * history parsing segment: a fixed JSON text carrying the same
 * five-entry PUBLISH..BEGIN_REVIEW chain that opens the main
 * task (fixed timestamps, hashless legacy form) is parsed with
 * `parseHistory` alone — no `TaskLifecycle` instance involved —
 * printed entry by entry, and compared against the main task's
 * own history prefix on one line; a detached copy whose third
 * entry's `from` is rewritten is rejected, asserted outside the
 * printed parse and reported on one closing line.
 *
 * Usage: `npm run demo` (builds with tsc, then runs node on the compiled
 * output). Zero runtime dependencies: this file only imports the state
 * machine itself.
 *
 * The script is structured as an importable `runDemo()` (the same
 * shape as the sibling demos in rfc9421-signing-demo and
 * escrow-state-machine-ts): it returns all nine tasks, the screening
 * results, the built webhook and its verification outcome, the
 * multi-endpoint fan-out delivery result and the wire copies the
 * injected fake fetch received, the Retry-After parsing results
 * for the fixed corpus under the fan-out instant, the
 * NDJSON export of the main task's history and the task replayed
 * from it, the allowed-events listing for all 13 states with the
 * main task's own (empty) allowed set, the standalone-parsed
 * external history entries with their main-prefix match verdict
 * and the invalid copy's rejection message, plus the exact `lines` the CLI prints — so tests assert on structured values
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
  PayoutEventDedupe,
  TaskLifecycle,
  actOnStaleTasks,
  allowedEvents,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  deliverPayoutWebhookToMany,
  expireOverdueTasks,
  expiredTasks,
  historyFromNdjson,
  historyToNdjson,
  isOverdue,
  mismatchedPayouts,
  parseHistory,
  parsePayoutRetryAfter,
  payoutMismatch,
  staleTasks,
  totalPaidOut,
  unreconciledPayouts,
  verifyHistoryChain,
  verifyPayoutWebhook,
  type BuildPayoutWebhooksResult,
  type DeliverPayoutWebhookToManyResult,
  type ExpireOverdueResult,
  type PayoutWebhook,
  type PayoutWebhookFetchImpl,
  type StaleActionResult,
  type TaskEvent,
  type TaskHistoryEntry,
  type TaskState,
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

/** One wire call recorded by the demo fan-out segment's fake fetch. */
export interface FanoutCall {
  url: string;
  body: string;
  signature: string;
}

/** One notification collected by the demo's subscription listener. */
export interface SubscriptionNotification {
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
  seq: number;
}

export interface DemoResult {
  task: TaskLifecycle;
  /** `verifyHistoryChain` verdict on the main task's intact history. */
  historyChainVerified: boolean;
  /** `verifyHistoryChain` verdict on the detached tampered copy. */
  tamperedChainVerified: boolean;
  /** The tampered copy's altered PAYOUT_COMPLETE `payoutAmount`. */
  tamperedPayoutAmount: number;
  overdueTask: TaskLifecycle;
  overdueFound: TaskLifecycle[];
  disputeTask: TaskLifecycle;
  webhook: PayoutWebhook;
  webhookVerified: boolean;
  dedupeFirst: boolean;
  dedupeRedelivery: boolean;
  dedupeAfterTtl: boolean;
  batchResults: BuildPayoutWebhooksResult[];
  batchVerified: Array<boolean | undefined>;
  fanoutResult: DeliverPayoutWebhookToManyResult;
  fanoutCalls: FanoutCall[];
  /** `parsePayoutRetryAfter` results for the fixed corpus, in corpus order. */
  retryAfterParsed: Array<number | undefined>;
  unreconciledTask: TaskLifecycle;
  mismatchedTask: TaskLifecycle;
  unreconciledFound: TaskLifecycle[];
  mismatchedFound: TaskLifecycle[];
  totalPaid: number;
  subscriptionTask: TaskLifecycle;
  subscriptionNotifications: SubscriptionNotification[];
  subscriptionMatchesHistory: boolean;
  subscriptionCountAfterUnsubscribe: number;
  staleDwellTasks: TaskLifecycle[];
  staleFound: TaskLifecycle[];
  staleExpiredFound: TaskLifecycle[];
  staleActionTasks: TaskLifecycle[];
  staleActionResults: StaleActionResult[];
  expireExecutionTasks: TaskLifecycle[];
  expireExecutionFound: TaskLifecycle[];
  expireExecutionResults: ExpireOverdueResult[];
  ndjsonText: string;
  replayedTask: TaskLifecycle;
  /** `allowedEvents(state)` for every state, in transition-table order. */
  allowedEventsByState: Array<{ state: TaskState; events: TaskEvent[] }>;
  /** `allowedEvents` for the main task's PAID state — the empty list. */
  mainTaskAllowedEvents: TaskEvent[];
  /** Entries `parseHistory` returns for the fixed external JSON text. */
  parsedHistoryEntries: TaskHistoryEntry[];
  /** Whether the parsed chain equals the main history's first-5 chain. */
  parsedHistoryMatchesMainPrefix: boolean;
  /** Whether the detached chain-broken copy was rejected. */
  parsedHistoryInvalidRejected: boolean;
  /** The rejection message for the invalid copy ("" if it parsed). */
  parsedHistoryInvalidError: string;
  lines: string[];
}

/**
 * Run the demo lifecycle without printing anything, and return the
 * sixteen tasks, the audit hash-chain verification verdicts for
 * the main task's history (intact, and a detached tampered copy),
 * the watchdog screening result, the built + verified
 * payout webhook, the receiver-side dedupe outcomes for its
 * `eventId`, the batch webhook results with their per-item
 * verification outcomes, the fan-out delivery result with the wire
 * calls the injected fake fetch received, the reconciliation
 * screening results with the paid-out total, the subscription branch's collected
 * notifications with their history-match verdict and the
 * post-unsubscribe notification count, the stale-task dwell
 * screening branch's three tasks with its stale and overdue
 * subsets, the stale-task batch execution branch's four tasks
 * with their per-task action results, the SLA watchdog batch
 * execution branch's three rebuilt tasks with its screening
 * subset and per-task expiry results, the NDJSON export of the main task's history
 * and the task replayed from that export, the allowed-events
 * listing for all 13 states with the main task's own (empty)
 * allowed set, the standalone-parsed external history entries
 * with their main-prefix match verdict and the invalid copy's
 * rejection message, and the exact lines
 * `main()` prints — so tests can assert on the demo itself, not
 * just on the library.
 */
export async function runDemo(): Promise<DemoResult> {
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

  // Audit hash-chain segment: the history just printed is
  // hash-chained (each entry links to its predecessor's hash,
  // genesis-linked to GENESIS_PREV_HASH), and everything later in
  // this demo — the payout webhook, the replay segment at the
  // end — is derived from it, so the audit workflow verifies the
  // chain before trusting the history ("verify before replay").
  // verifyHistoryChain recomputes every link and returns a plain
  // boolean — true for the intact chain. To show what a rewrite
  // looks like, build a detached copy (fresh entry objects — the
  // task's history getter hands out frozen copies), alter the
  // PAYOUT_COMPLETE entry's payoutAmount by 1, and verify again:
  // the stored hash no longer recomputes from the altered
  // canonical content, so the verdict flips to false. This demo's
  // main task carries an unkeyed chain (no auditSecret), so no
  // secret argument is passed; a keyed chain would need its
  // secret here and would fail closed without it. The task's own
  // history is never touched, and re-verifying it after the
  // tamper check still passes. The segment adds no new
  // nondeterminism: it only reads the main task's existing
  // history and prints no timestamps or hashes.
  const historyChainVerified = verifyHistoryChain(task.history);
  const tamperedHistory = task.history.map((entry) => ({ ...entry }));
  const tamperedEntry = tamperedHistory.find(
    (entry) => entry.event === "PAYOUT_COMPLETE",
  );
  if (tamperedEntry === undefined || tamperedEntry.payoutAmount === undefined) {
    throw new Error("demo fixture broken: main history has no PAYOUT_COMPLETE payoutAmount");
  }
  const originalPayoutAmount = tamperedEntry.payoutAmount;
  tamperedEntry.payoutAmount = originalPayoutAmount + 1;
  const tamperedPayoutAmount = tamperedEntry.payoutAmount;
  const tamperedChainVerified = verifyHistoryChain(tamperedHistory);
  lines.push(
    "",
    "Audit hash chain (verifyHistoryChain on the main task history):",
    `  intact history: verifyHistoryChain: ${historyChainVerified} (${task.history.length} entries, genesis-linked, every hash recomputes)`,
    `  tampered copy: PAYOUT_COMPLETE payoutAmount ${originalPayoutAmount} -> ${tamperedPayoutAmount} — verifyHistoryChain: ${tamperedChainVerified} (tamper detected: the stored hash no longer recomputes)`,
    `  original history after the tamper check: verifyHistoryChain: ${verifyHistoryChain(task.history)} (detached copy — the task's own history is untouched)`,
  );

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

  // Receiver-side dedupe segment: the other half of the webhook
  // story. Everything above is the sender's view — build, sign,
  // verify. A receiver that stopped at verification would still
  // book the payout twice when the sender (or a fan-out retry)
  // re-delivers the same event, so deduplication on `eventId` is
  // the receiver's own duty (the other half of the at-least-once
  // delivery semantics the README describes). The main webhook's
  // eventId is fed to a PayoutEventDedupe under an injected fixed
  // clock — starting at 2026-03-18T09:00:00.000Z and advanced by
  // hand, so no wall clock is read here:
  //   delivery 1 — first sighting: checkAndRecord returns false,
  //     the receiver books the payout;
  //   delivery 2 — the same eventId again within the TTL:
  //     checkAndRecord returns true (duplicate), the receiver
  //     acknowledges the delivery and skips it, booking nothing
  //     twice;
  //   delivery 3 — the clock is advanced by exactly the TTL
  //     (60_000 ms; the demo shortens the library default of
  //     3_600_000 ms so the expiry act fits the script): at
  //     exactly ttlMs the first-seen record has expired (the
  //     boundary rule in PayoutEventDedupe's docs), so the same
  //     id counts as unseen again and checkAndRecord returns
  //     false — accepted again.
  const DEDUPE_TTL_MS = 60_000;
  let dedupeNowMs = Date.parse("2026-03-18T09:00:00.000Z");
  const dedupe = new PayoutEventDedupe({
    ttlMs: DEDUPE_TTL_MS,
    now: () => dedupeNowMs,
  });
  lines.push("", "Receiver-side dedupe (PayoutEventDedupe on the webhook's eventId):");
  lines.push(
    `  dedupe ttl: ${DEDUPE_TTL_MS} ms (demo policy; the library default is 3600000 ms) — clock injected and fixed at ${new Date(dedupeNowMs).toISOString()}`,
  );
  const dedupeFirst = dedupe.checkAndRecord(payload.eventId);
  lines.push(
    `  delivery 1: eventId ${payload.eventId} -> checkAndRecord ${dedupeFirst} (new event, payout booked)`,
  );
  const dedupeRedelivery = dedupe.checkAndRecord(payload.eventId);
  lines.push(
    `  delivery 2: same eventId redelivered -> checkAndRecord ${dedupeRedelivery} (duplicate, skipped — no second booking)`,
  );
  dedupeNowMs += DEDUPE_TTL_MS;
  const dedupeAfterTtl = dedupe.checkAndRecord(payload.eventId);
  lines.push(
    `  delivery 3: clock advanced by exactly the ttl to ${new Date(dedupeNowMs).toISOString()} -> checkAndRecord ${dedupeAfterTtl} (record expired at the ttl boundary, accepted again)`,
  );

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

  // Multi-endpoint fan-out delivery segment: building a webhook is
  // not delivering it. The batch segment above stops at signed
  // payloads; here the main task's payout event is actually
  // delivered with deliverPayoutWebhookToMany — ONE logical event
  // (shared fixed `now` 2026-03-20T09:00:00.000Z, shared fixed
  // eventId "evt_demo_fanout_001") fanned out to three fixed
  // endpoints, each signed with its OWN demo secret (placeholder
  // values in this source, not real credentials). All delivery
  // goes through an injected fake fetchImpl that records every
  // wire call and answers from a fixed script — billing 200, risk
  // 500 on every attempt, notifications 200 — so the segment
  // performs zero real network I/O; an injected no-op sleepImpl
  // plus backoffMs 0 mean the risk endpoint's retries (the default
  // maxAttempts of 3) never really sleep, so no wall clock is
  // waited on either. Hand-written expectations: results stay in
  // input order — billing ok (1 attempt, status 200), risk FAILED
  // (3 attempts, status 500, error "server responded with status
  // 500"), notifications ok (1 attempt, status 200) — delivered 2,
  // failed 1: the failing endpoint neither blocks nor fails the
  // others. The fake fetch sees 5 calls in total (1 + 3 + 1); the
  // first call per endpoint carries a byte-identical body (the
  // shared eventId / at) under three different signatures, each
  // verifying only under its own endpoint's secret.
  const FANOUT_NOW = new Date("2026-03-20T09:00:00.000Z");
  const FANOUT_EVENT_ID = "evt_demo_fanout_001";
  const fanoutEndpoints = [
    {
      name: "billing",
      url: "https://billing.example.com/hooks/payout",
      secret: "demo-fanout-billing-secret-do-not-use-in-production",
    },
    {
      name: "risk",
      url: "https://risk.example.com/hooks/payout",
      secret: "demo-fanout-risk-secret-do-not-use-in-production",
    },
    {
      name: "notifications",
      url: "https://notifications.example.com/hooks/payout",
      secret: "demo-fanout-notifications-secret-do-not-use-in-production",
    },
  ] as const;
  const fanoutCalls: FanoutCall[] = [];
  const fanoutFetch: PayoutWebhookFetchImpl = async (url, init) => {
    fanoutCalls.push({
      url,
      body: String(init.body ?? ""),
      signature: String(
        new Headers(init.headers).get("x-hub-signature-256") ?? "",
      ),
    });
    return new Response("{}", {
      status: url === fanoutEndpoints[1].url ? 500 : 200,
    });
  };
  const fanoutResult = await deliverPayoutWebhookToMany(
    task,
    fanoutEndpoints.map(({ url, secret }) => ({ url, secret })),
    {
      fetchImpl: fanoutFetch,
      sleepImpl: async () => {},
      backoffMs: 0,
      now: FANOUT_NOW,
      eventId: FANOUT_EVENT_ID,
    },
  );
  lines.push(
    "",
    "Payout webhook fan-out delivery (deliverPayoutWebhookToMany to 3 endpoints, fake fetch — no real network):",
  );
  lines.push(
    `  shared eventId: ${FANOUT_EVENT_ID}, shared at: ${FANOUT_NOW.toISOString()} (one logical event for all endpoints)`,
  );
  fanoutResult.results.forEach((r, i) => {
    const ep = fanoutEndpoints[i];
    lines.push(
      r.ok
        ? `  ${ep.name} (${ep.url}): ok attempts=${r.attempts} status=${r.status}`
        : `  ${ep.name} (${ep.url}): FAILED attempts=${r.attempts} status=${r.status} error=${r.error}`,
    );
  });
  lines.push(
    `  fan-out: ${fanoutResult.delivered} delivered, ${fanoutResult.failed} failed — the failing endpoint did not block the others`,
  );
  const fanoutFirstCalls = fanoutEndpoints.map(
    (ep) => fanoutCalls.find((c) => c.url === ep.url)!,
  );
  const fanoutSharedEvent =
    fanoutFirstCalls.every((c) => c.body === fanoutFirstCalls[0].body) &&
    fanoutFirstCalls.every(
      (c) =>
        (JSON.parse(c.body) as { eventId?: string }).eventId ===
        FANOUT_EVENT_ID,
    );
  lines.push(
    `  shared event check: all endpoints received the same eventId ${FANOUT_EVENT_ID}: ${fanoutSharedEvent} (identical payload bytes, signed per endpoint with its own secret)`,
  );

  // Payout Retry-After parsing segment: the sender-side half of
  // the retry story the fan-out segment acted out. The risk
  // endpoint answered 500 on every attempt, so its retries fell
  // back to exponential backoff — a Retry-After hint is only
  // honored on a 429. This segment shows how such a hint would
  // be read: a fixed 6-value corpus parsed with
  // parsePayoutRetryAfter under the fan-out segment's shared
  // fixed instant reused as `nowMs` (2026-03-20T09:00:00.000Z —
  // no new instant, no network, no randomness, no wall clock).
  // The HTTP-date strings are built with toUTCString() from that
  // instant; toUTCString() has one-second precision and the
  // instant sits exactly on a whole second, so the date
  // expectations below are exact, not ranges. Hand-written
  // expectations — written out here from the documented
  // semantics of parsePayoutRetryAfter, never derived by
  // calling it:
  //   "2"                                -> 2000 (delay-seconds:
  //                                          2 s x 1,000)
  //   "  30 "                            -> 30000 (the value is
  //                                          trimmed, then
  //                                          30 s x 1,000)
  //   HTTP-date at FANOUT_NOW + 5,000 ms -> 5000 (future date
  //                                          delta)
  //   HTTP-date at FANOUT_NOW - 1,000 ms -> 0 (a past date
  //                                          clamps to zero,
  //                                          never negative)
  //   "banana"                           -> undefined
  //                                          (unparsable; the
  //                                          caller falls back
  //                                          to backoff)
  //   null                               -> undefined (absent
  //                                          header; same
  //                                          fallback)
  const retryAfterCorpus: Array<{
    value: string | null;
    expected: number | undefined;
  }> = [
    { value: "2", expected: 2000 },
    { value: "  30 ", expected: 30_000 },
    {
      value: new Date(FANOUT_NOW.getTime() + 5_000).toUTCString(),
      expected: 5_000,
    },
    {
      value: new Date(FANOUT_NOW.getTime() - 1_000).toUTCString(),
      expected: 0,
    },
    { value: "banana", expected: undefined },
    { value: null, expected: undefined },
  ];
  const retryAfterParsed = retryAfterCorpus.map(({ value }) =>
    parsePayoutRetryAfter(value, FANOUT_NOW.getTime()),
  );
  lines.push(
    "",
    "Payout Retry-After parsing (parsePayoutRetryAfter under a fixed now):",
    `  fixed now: ${FANOUT_NOW.toISOString()} (the fan-out segment's shared instant, reused as nowMs; no wall clock)`,
  );
  retryAfterCorpus.forEach(({ value }, i) => {
    const display = value === null ? "null" : `"${value}"`;
    const parsed = retryAfterParsed[i];
    lines.push(
      `  parsePayoutRetryAfter(${display}) -> ${parsed === undefined ? "undefined" : `${parsed} ms`}`,
    );
  });
  lines.push(
    "  retry context: the fan-out risk endpoint answered 500, so its retries used exponential backoff; had it answered 429 with a Retry-After header, the parsed wait above (clamped to maxRetryDelayMs) would have set the next attempt's delay — an absent or unparsable header (undefined) falls back to that backoff",
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

  // Dispatch subscription branch: the demo's only in-process
  // notification fan-out point, acted out on a sixth task. A
  // collecting listener is subscribed BEFORE any dispatch, so it
  // receives every successful dispatch in order — each notification
  // is the (event, from, to) triple plus the seq of the audit entry
  // appended just before the listener ran. The branch then
  // unsubscribes and dispatches one further step: the task moves,
  // the listener hears nothing. Every timestamp in this branch is
  // a fixed literal (2026-03-19): no network, no randomness, no
  // wall clock. Hand-written expectations: the listener collects
  // exactly 3 notifications (PUBLISH DRAFT -> OPEN seq 1, ACCEPT
  // OPEN -> ACCEPTED seq 2, START_CAPTURE ACCEPTED -> CAPTURING
  // seq 3), each equal to the history entry with the same seq;
  // after unsubscribe the count stays 3 while the task lands in
  // SUBMITTED with 4 history entries.
  const subscriptionTask = new TaskLifecycle("DEMO-006");
  const subscriptionNotifications: SubscriptionNotification[] = [];
  const unsubscribeSubscription = subscriptionTask.subscribe(
    (event, from, to, entry) => {
      subscriptionNotifications.push({ event, from, to, seq: entry.seq });
    },
  );
  lines.push("", "Dispatch subscription branch (sixth task, in-process fan-out):");
  lines.push(`Task ${subscriptionTask.id}: ${subscriptionTask.state}`);
  lines.push(
    "  subscribed: 1 collecting listener (notified after each audit append, in subscription order)",
  );
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-03-19T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-03-19T09:05:00.000Z"],
    ["START_CAPTURE", "contributor", "2026-03-19T09:10:00.000Z"],
  ] as const) {
    subscriptionTask.dispatch(event, { actor, at });
  }
  lines.push(
    `  listener received ${subscriptionNotifications.length} notification(s), in dispatch order:`,
  );
  subscriptionNotifications.forEach((n, i) => {
    lines.push(
      `    notification ${i + 1}: ${n.event} ${n.from} -> ${n.to} (entry seq ${n.seq})`,
    );
  });
  const subscriptionMatchesHistory = subscriptionNotifications.every((n) => {
    const entry = subscriptionTask.history[n.seq - 1];
    return (
      entry !== undefined &&
      entry.seq === n.seq &&
      entry.event === n.event &&
      entry.from === n.from &&
      entry.to === n.to
    );
  });
  lines.push(
    `  notifications match the task history: ${subscriptionMatchesHistory} (each (event, from, to) equals the history entry with the same seq)`,
  );
  unsubscribeSubscription();
  lines.push(`  unsubscribed: listenerCount ${subscriptionTask.listenerCount}`);
  const subscriptionFrom = subscriptionTask.state;
  const subscriptionTo = subscriptionTask.dispatch("SUBMIT", {
    actor: "contributor",
    at: "2026-03-19T09:15:00.000Z",
  });
  lines.push(
    `  ${"SUBMIT".padEnd(15)} ${subscriptionFrom.padEnd(12)} -> ${subscriptionTo}  (contributor)`,
  );
  const subscriptionCountAfterUnsubscribe = subscriptionNotifications.length;
  lines.push(
    `  listener received after unsubscribe: ${subscriptionCountAfterUnsubscribe} notification(s) (unchanged — SUBMIT produced no new notification)`,
  );
  lines.push(
    "",
    `Final state (subscription branch): ${subscriptionTask.state} (terminal: ${subscriptionTask.isTerminal})`,
  );

  // Stale-task dwell screening branch: the watchdog's second
  // screening lens, acted out on three more tasks. The SLA branch
  // near the top screens by absolute deadline (`expiredTasks()`:
  // "past the deadline attached to the current state"); this branch
  // screens the same way a "stuck task" watchdog does — by dwell
  // (`staleTasks()`: "in the current state longer than the
  // per-state budget", measured from the last history entry's
  // `at`). The two lenses are independent, and this batch is built so
  // they disagree: every timestamp is a fixed literal and the
  // screening `now` is fixed at 2026-03-22T09:00:00.000Z, so every
  // dwell below is exact (no network, no randomness, no wall
  // clock). Hand-written expectations:
  //   DEMO-007 sits in OPEN since 2026-03-01T09:00:00.000Z —
  //     dwell 1814400000 ms (21 days) > the OPEN budget of
  //     604800000 ms (7 days), so stale; its OPEN SLA deadline is
  //     2026-03-25T09:00:00.000Z, still ahead, so NOT overdue.
  //   DEMO-008 sits in IN_REVIEW since 2026-03-21T09:00:00.000Z —
  //     dwell 86400000 ms (1 day) < the IN_REVIEW budget of
  //     432000000 ms (5 days), so NOT stale; its IN_REVIEW SLA
  //     deadline is 2026-03-21T12:00:00.000Z, already past, so
  //     overdue.
  //   DEMO-009 sits in OPEN since 2026-03-21T09:00:00.000Z —
  //     dwell 86400000 ms (1 day) < the OPEN budget, and it
  //     carries no SLA deadline at all, so neither stale nor
  //     overdue.
  // Screening is pure: staleTasks()/expiredTasks() never dispatch
  // or mutate, so all three tasks keep their states and history
  // lengths (the demo tests pin this).
  const STALE_BRANCH_NOW = new Date("2026-03-22T09:00:00.000Z");
  const STALE_BUDGETS = {
    OPEN: 7 * 24 * 3600_000,
    IN_REVIEW: 5 * 24 * 3600_000,
  } as const;
  const DAY_MS = 24 * 3600_000;
  const driveStaleTask = (
    id: string,
    spec: Array<{ event: TaskEvent; actor: string; at: string }>,
  ): TaskLifecycle => {
    const driven = new TaskLifecycle(id);
    lines.push(`Task ${driven.id}: ${driven.state}`);
    for (const { event, actor, at } of spec) {
      const from = driven.state;
      const to = driven.dispatch(event, { actor, at });
      lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
    }
    return driven;
  };
  lines.push("", "Stale-task dwell screening branch (three more tasks, dwell vs deadline):");
  lines.push(
    `  screened at: ${STALE_BRANCH_NOW.toISOString()} (fixed now; no wall clock)`,
  );
  lines.push(
    `  budgets: OPEN ${STALE_BUDGETS.OPEN} ms (7 days), IN_REVIEW ${STALE_BUDGETS.IN_REVIEW} ms (5 days) — dwell is now minus the last history entry's at`,
  );
  const staleOpenTask = driveStaleTask("DEMO-007", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
  ]);
  staleOpenTask.setSlaDeadline("2026-03-25T09:00:00.000Z", "OPEN");
  lines.push(
    `  SLA deadline (OPEN): ${staleOpenTask.getSlaDeadline("OPEN")}`,
  );
  const staleReviewTask = driveStaleTask("DEMO-008", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-20T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-20T09:05:00.000Z" },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-20T09:10:00.000Z" },
    { event: "SUBMIT", actor: "contributor", at: "2026-03-21T08:55:00.000Z" },
    { event: "BEGIN_REVIEW", actor: "reviewer", at: "2026-03-21T09:00:00.000Z" },
  ]);
  staleReviewTask.setSlaDeadline("2026-03-21T12:00:00.000Z", "IN_REVIEW");
  lines.push(
    `  SLA deadline (IN_REVIEW): ${staleReviewTask.getSlaDeadline("IN_REVIEW")}`,
  );
  const staleFreshTask = driveStaleTask("DEMO-009", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-21T09:00:00.000Z" },
  ]);
  lines.push("  SLA deadline (OPEN): none");
  const staleDwellTasks = [staleOpenTask, staleReviewTask, staleFreshTask];
  const staleFound = staleTasks(staleDwellTasks, STALE_BUDGETS, STALE_BRANCH_NOW);
  const staleExpiredFound = expiredTasks(staleDwellTasks, STALE_BRANCH_NOW);
  for (const t of staleDwellTasks) {
    const enteredAt = t.history[t.history.length - 1].at;
    const dwellMs = STALE_BRANCH_NOW.getTime() - Date.parse(enteredAt);
    const dwellDays = dwellMs / DAY_MS;
    const budget = STALE_BUDGETS[t.state as keyof typeof STALE_BUDGETS];
    lines.push(
      `  ${t.id}: state ${t.state}, entered at ${enteredAt}, dwell ${dwellMs} ms (${dwellDays} ${dwellDays === 1 ? "day" : "days"}) vs ${t.state} budget ${budget} ms -> stale: ${staleFound.includes(t)}, overdue: ${isOverdue(t, STALE_BRANCH_NOW)}`,
    );
  }
  lines.push(
    `  staleTasks([${staleDwellTasks.map((t) => t.id).join(", ")}], budgets, ${STALE_BRANCH_NOW.toISOString()}): ${staleFound.map((t) => t.id).join(", ")} (${staleFound.length} stale)`,
  );
  lines.push(
    `  expiredTasks([${staleDwellTasks.map((t) => t.id).join(", ")}], ${STALE_BRANCH_NOW.toISOString()}): ${staleExpiredFound.map((t) => t.id).join(", ")} (${staleExpiredFound.length} overdue)`,
  );
  lines.push(
    "  contrast: the two screens disagree on the same batch — DEMO-007 is stale but not overdue (dwell past budget, deadline still ahead), DEMO-008 is overdue but not stale (deadline passed, dwell within budget), DEMO-009 is neither",
  );
  lines.push(
    "  screening is pure: no task was dispatched or mutated by either screen",
  );

  // Stale-task batch execution branch: screening alone does not
  // move anything — this branch is the execution half of the
  // watchdog story, acted out on four more tasks at the SAME fixed
  // now as the screening branch above (2026-03-22T09:00:00.000Z;
  // no network, no randomness, no wall clock). The executor is
  // `actOnStaleTasks()` with a custom action that dispatches
  // ABANDON with the fixed execution instant as the audit
  // timestamp (the library default action dispatches the same
  // event with actor "system" at the wall clock; pinning `at`
  // here keeps the demo byte-deterministic). Hand-written
  // expectations under budgets of 7 days for ACCEPTED, CAPTURING
  // and SUBMITTED:
  //   DEMO-010 sits in SUBMITTED since 2026-03-10T09:00:00.000Z —
  //     dwell 12 days, so stale — but SUBMITTED has no ABANDON
  //     edge, so its action fails with
  //     "invalid transition: ABANDON from SUBMITTED" and the task
  //     is left untouched in SUBMITTED. It is placed FIRST in the
  //     batch on purpose: its failure must not block the rest.
  //   DEMO-011 sits in ACCEPTED since 2026-03-05T09:00:00.000Z —
  //     dwell 17 days, so stale — and ABANDON is legal there, so
  //     it lands in ABANDONED.
  //   DEMO-012 sits in CAPTURING since 2026-03-08T09:00:00.000Z —
  //     dwell 14 days, so stale — and ABANDON is legal there too,
  //     so it also lands in ABANDONED.
  //   DEMO-013 sits in ACCEPTED since 2026-03-21T09:00:00.000Z —
  //     dwell 1 day, within budget, so it is not stale: the
  //     executor never attempts it and it produces no result
  //     entry, staying untouched in ACCEPTED.
  // Results therefore read: 3 attempted, 2 acted, 1 failed — one
  // unactionable stale task never blocks the rest of the batch.
  const STALE_ACTION_NOW = STALE_BRANCH_NOW;
  const STALE_ACTION_BUDGETS = {
    ACCEPTED: 7 * DAY_MS,
    CAPTURING: 7 * DAY_MS,
    SUBMITTED: 7 * DAY_MS,
  } as const;
  const driveActionTask = driveStaleTask;
  lines.push("", "Stale-task batch execution branch (actOnStaleTasks over four more tasks):");
  lines.push(
    `  executed at: ${STALE_ACTION_NOW.toISOString()} (fixed now; no wall clock)`,
  );
  lines.push(
    `  budgets: ACCEPTED ${STALE_ACTION_BUDGETS.ACCEPTED} ms (7 days), CAPTURING ${STALE_ACTION_BUDGETS.CAPTURING} ms (7 days), SUBMITTED ${STALE_ACTION_BUDGETS.SUBMITTED} ms (7 days) — action dispatches ABANDON with the fixed execution instant as its audit timestamp`,
  );
  const actionSubmittedTask = driveActionTask("DEMO-010", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-02T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-02T09:05:00.000Z" },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-02T09:10:00.000Z" },
    { event: "SUBMIT", actor: "contributor", at: "2026-03-10T09:00:00.000Z" },
  ]);
  const actionAcceptedTask = driveActionTask("DEMO-011", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-05T09:00:00.000Z" },
  ]);
  const actionCapturingTask = driveActionTask("DEMO-012", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-01T09:05:00.000Z" },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-08T09:00:00.000Z" },
  ]);
  const actionFreshTask = driveActionTask("DEMO-013", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-21T08:55:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-21T09:00:00.000Z" },
  ]);
  const staleActionTasks = [
    actionSubmittedTask,
    actionAcceptedTask,
    actionCapturingTask,
    actionFreshTask,
  ];
  const staleActionResults = actOnStaleTasks(
    staleActionTasks,
    (t) =>
      t.dispatch("ABANDON", {
        actor: "watchdog",
        at: STALE_ACTION_NOW.toISOString(),
      }),
    STALE_ACTION_BUDGETS,
    STALE_ACTION_NOW,
  );
  for (const r of staleActionResults) {
    lines.push(
      r.acted
        ? `  ${r.task.id}: acted=true -> state ${r.task.state} (ABANDON dispatched; the batch kept going)`
        : `  ${r.task.id}: acted=false error="${r.error}" -> state ${r.task.state} (left untouched — the failure is isolated)`,
    );
  }
  lines.push(
    `  ${actionFreshTask.id}: not stale at the fixed now (dwell 86400000 ms (1 day) within the ACCEPTED budget) -> no result entry, untouched in ${actionFreshTask.state}`,
  );
  const staleActed = staleActionResults.filter((r) => r.acted).length;
  lines.push(
    `  execution: ${staleActionResults.length} attempted, ${staleActed} acted, ${staleActionResults.length - staleActed} failed — one unactionable stale task never blocks the rest of the batch`,
  );

  // SLA watchdog batch execution branch: the execution half of
  // the SLA story at the top of this demo, acted out on three
  // more tasks. The SLA branch near the top only screens
  // (`expiredTasks()` finds DEMO-002) and then expires that one
  // task with a hand-written dispatch loop; the batch executor
  // `expireOverdueTasks()` never appeared in the demo, so a
  // reader could not see screening and execution as two steps,
  // nor what the executor's per-task result entries look like.
  // The executor mutates its inputs, and the original SLA batch
  // is already settled (DEMO-001 is PAID, DEMO-002 is EXPIRED),
  // so this branch rebuilds the batch fresh from the same
  // fixed literals and reuses the very same fixed screening
  // instant (SLA_BRANCH_NOW, 2026-03-06T09:00:00.000Z — no new
  // screening instant, no network, no randomness):
  //   DEMO-014 is a byte-for-byte rebuild of DEMO-002's setup —
  //     PUBLISH 2026-03-01T09:00, ACCEPT 2026-03-01T09:05, SLA
  //     deadline (ACCEPTED) 2026-03-03T09:00 — so overdue at the
  //     fixed now, and EXPIRE is legal from ACCEPTED.
  //   DEMO-015 sits in OPEN since 2026-03-02T09:00 with an OPEN
  //     SLA deadline of 2026-03-04T09:00 — also overdue, and
  //     EXPIRE is legal from OPEN.
  //   DEMO-016 sits in ACCEPTED like DEMO-014 but its deadline
  //     is 2026-03-10T09:00, still ahead of the fixed now — not
  //     overdue, so the executor never attempts it and it
  //     produces no result entry, staying untouched in ACCEPTED.
  // Hand-written expectations: the screening subset is
  // [DEMO-014, DEMO-015]; the executor returns exactly one entry
  // per screened task, both expired=true and now EXPIRED, so the
  // screening subset and the execution's acted set agree.
  // Honest limit: `expireOverdueTasks()` takes no action
  // callback, so its EXPIRE dispatches carry the library defaults
  // (no actor, a wall-clock audit timestamp) — this segment
  // prints no history for the rebuilt tasks and no timestamp
  // from those entries, so every printed line below is a fixed
  // literal or derived from one; the demo tests pin the states
  // and outcomes, never those entries' `at`.
  const driveExpireTask = driveStaleTask;
  lines.push("", "SLA watchdog batch execution branch (expireOverdueTasks over a rebuilt SLA batch):");
  lines.push(
    `  executed at: ${SLA_BRANCH_NOW.toISOString()} (the SLA branch's fixed screening now, reused; no new screening instant)`,
  );
  lines.push(
    "  rebuilt batch: the executor mutates its inputs and the original SLA tasks are already settled, so the batch is rebuilt fresh from the same fixed literals (DEMO-014 mirrors DEMO-002's setup exactly)",
  );
  const expireMirrorTask = driveExpireTask("DEMO-014", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-01T09:05:00.000Z" },
  ]);
  expireMirrorTask.setSlaDeadline("2026-03-03T09:00:00.000Z");
  lines.push(
    `  SLA deadline (ACCEPTED): ${expireMirrorTask.getSlaDeadline("ACCEPTED")}`,
  );
  const expireOpenTask = driveExpireTask("DEMO-015", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-02T09:00:00.000Z" },
  ]);
  expireOpenTask.setSlaDeadline("2026-03-04T09:00:00.000Z", "OPEN");
  lines.push(
    `  SLA deadline (OPEN): ${expireOpenTask.getSlaDeadline("OPEN")}`,
  );
  const expireFreshTask = driveExpireTask("DEMO-016", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-01T09:05:00.000Z" },
  ]);
  expireFreshTask.setSlaDeadline("2026-03-10T09:00:00.000Z");
  lines.push(
    `  SLA deadline (ACCEPTED): ${expireFreshTask.getSlaDeadline("ACCEPTED")}`,
  );
  const expireExecutionTasks = [
    expireMirrorTask,
    expireOpenTask,
    expireFreshTask,
  ];
  const expireExecutionFound = expiredTasks(
    expireExecutionTasks,
    SLA_BRANCH_NOW,
  );
  lines.push(
    `  expiredTasks([${expireExecutionTasks.map((t) => t.id).join(", ")}], ${SLA_BRANCH_NOW.toISOString()}): ${expireExecutionFound.map((t) => t.id).join(", ")} (${expireExecutionFound.length} overdue)`,
  );
  const expireExecutionResults = expireOverdueTasks(
    expireExecutionTasks,
    SLA_BRANCH_NOW,
  );
  for (const r of expireExecutionResults) {
    lines.push(
      r.expired
        ? `  ${r.task.id}: expired=true -> state ${r.task.state} (EXPIRE dispatched by the executor)`
        : `  ${r.task.id}: expired=false error="${r.error}" -> state ${r.task.state} (left untouched — the failure is isolated)`,
    );
  }
  lines.push(
    `  ${expireFreshTask.id}: not overdue at the fixed now (deadline ${expireFreshTask.getSlaDeadline("ACCEPTED")} still ahead) -> no result entry, untouched in ${expireFreshTask.state}`,
  );
  const expireActedIds = expireExecutionResults
    .filter((r) => r.expired)
    .map((r) => r.task.id);
  const expireSetsAgree =
    expireActedIds.length === expireExecutionFound.length &&
    expireActedIds.every((id, i) => id === expireExecutionFound[i].id);
  lines.push(
    `  screening vs execution: expiredTasks subset [${expireExecutionFound.map((t) => t.id).join(", ")}] == expireOverdueTasks acted set [${expireActedIds.join(", ")}]: ${expireSetsAgree} (same tasks, same batch order)`,
  );
  const expireFailed = expireExecutionResults.length - expireActedIds.length;
  lines.push(
    `  execution: ${expireExecutionResults.length} attempted, ${expireActedIds.length} expired, ${expireFailed} failed — the not-yet-overdue task was never attempted`,
  );

  // Event-sourcing replay segment (closing): the demo's thesis —
  // the audit history is the single source of truth — acted out on
  // the main task. Its 12-entry history is exported as NDJSON
  // (one canonical JSON entry per line, trailing newline), printed
  // in full, parsed back with historyFromNdjson(), and replayed
  // with TaskLifecycle.fromHistory(). Hand-written expectations:
  // the export has exactly 12 lines; the parsed entries are the
  // original history entry for entry; the replayed task is in
  // state PAID with 12 history entries whose last entry is
  // seq 12 PAYOUT_COMPLETE PAYOUT_PENDING -> PAID, identical to
  // the original's last entry (the demo tests pin all of this,
  // including a full deep equality of the two histories). The
  // segment adds no new nondeterminism: it only serializes the
  // main task's existing history — whose timestamps already vary
  // between runs — and reads no network, no randomness, and no
  // new wall clock.
  const ndjsonText = historyToNdjson(task);
  const ndjsonLines = ndjsonText.trimEnd().split("\n");
  lines.push("", "Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):");
  lines.push(
    `  historyToNdjson(${task.id}): ${ndjsonLines.length} lines (one JSON entry per line, trailing newline)`,
  );
  for (const line of ndjsonLines) {
    lines.push(`  ${line}`);
  }
  const parsedEntries = historyFromNdjson(ndjsonText);
  lines.push(`  historyFromNdjson: ${parsedEntries.length} entries parsed back`);
  const replayedTask = TaskLifecycle.fromHistory(task.id, parsedEntries);
  lines.push(
    `  TaskLifecycle.fromHistory(${task.id}, entries): state ${replayedTask.state}, ${replayedTask.history.length} history entries`,
  );
  const replayedLast = replayedTask.history.at(-1)!;
  const replayMatches =
    replayedTask.state === task.state &&
    historyToNdjson(replayedTask) === ndjsonText;
  lines.push(
    `  replay matches the original (state + full history): ${replayMatches} — last entry seq ${replayedLast.seq} ${replayedLast.event} ${replayedLast.from} -> ${replayedLast.to}`,
  );

  // Allowed-events listing segment (closing): every segment above
  // dispatches a fixed script, so a reader never sees the query a
  // task-list UI or a watchdog consults BEFORE dispatching —
  // "what can this task do next?" `allowedEvents(state)` answers
  // it from the transition table alone: pure, no task instance, no
  // dispatch, no mutation (no network, no randomness, no wall
  // clock). All 13 states are listed in transition-table
  // declaration order. Hand-written expectations — written out
  // here from the transition table in src/taskLifecycle.ts, never
  // derived by calling allowedEvents itself (the demo tests
  // cross-check the printed listing against the committed
  // transition-table snapshot as well):
  //   DRAFT          -> [PUBLISH]
  //   OPEN           -> [ACCEPT, EXPIRE]
  //   ACCEPTED       -> [START_CAPTURE, ABANDON, EXPIRE]
  //   CAPTURING      -> [SUBMIT, ABANDON, EXPIRE]
  //   SUBMITTED      -> [BEGIN_REVIEW, EXPIRE]
  //   IN_REVIEW      -> [APPROVE, REJECT]
  //   APPROVED       -> [REQUEST_PAYOUT]
  //   PAYOUT_PENDING -> [PAYOUT_COMPLETE]
  //   PAID           -> [] (terminal)
  //   REJECTED       -> [DISPUTE, RESUBMIT]
  //   DISPUTED       -> [ARBITRATE_APPROVE, ARBITRATE_REJECT]
  //   ABANDONED      -> [] (terminal)
  //   EXPIRED        -> [] (terminal)
  const ALL_STATES: TaskState[] = [
    "DRAFT",
    "OPEN",
    "ACCEPTED",
    "CAPTURING",
    "SUBMITTED",
    "IN_REVIEW",
    "APPROVED",
    "PAYOUT_PENDING",
    "PAID",
    "REJECTED",
    "DISPUTED",
    "ABANDONED",
    "EXPIRED",
  ];
  const allowedEventsByState = ALL_STATES.map((state) => ({
    state,
    events: allowedEvents(state),
  }));
  const mainTaskAllowedEvents = allowedEvents(task.state);
  lines.push(
    "",
    "Allowed events by state (allowedEvents over all 13 states):",
  );
  for (const { state, events } of allowedEventsByState) {
    lines.push(
      `  ${state.padEnd(15)} -> ${events.length > 0 ? events.join(", ") : "(none — terminal)"}`,
    );
  }
  lines.push(
    `  main task ${task.id} (${task.state}): allowedEvents -> ${mainTaskAllowedEvents.length > 0 ? mainTaskAllowedEvents.join(", ") : "(none)"} — a terminal task offers no further events, so a task-list UI renders no actions for it`,
  );

  // Standalone history parsing segment (closing): every segment
  // above either drives a TaskLifecycle or parses text back
  // through one (the replay segment's historyFromNdjson feeds
  // TaskLifecycle.fromHistory). An import / migration / audit
  // review tool often holds only a bare history value — a JSON
  // text from a snapshot file or another store — and needs it
  // validated on its own, with no task instance at all. That is
  // `parseHistory(history)`: strict structural validation
  // (unknown fields fail closed, gapless seq, from/to chain
  // continuity, legal transitions, canonical timestamps, and a
  // full hash-chain re-verification when the entries carry
  // hashes) returning fresh sanitized entries. The corpus here
  // is a fixed JSON text (no network, no randomness, no wall
  // clock) carrying the same five-entry chain that opens the
  // main task, in hashless legacy form with fixed timestamps.
  // Hand-written expectations — written out here from the main
  // task's opening steps above, never derived by calling
  // parseHistory itself:
  //   seq 1 PUBLISH       DRAFT     -> OPEN      (system)
  //   seq 2 ACCEPT        OPEN      -> ACCEPTED  (contributor)
  //   seq 3 START_CAPTURE ACCEPTED  -> CAPTURING (contributor)
  //   seq 4 SUBMIT        CAPTURING -> SUBMITTED (contributor)
  //   seq 5 BEGIN_REVIEW  SUBMITTED -> IN_REVIEW (reviewer)
  // so the parse returns exactly 5 entries and the final state
  // (the last entry's `to`) is IN_REVIEW; the parsed seq/event/
  // from/to chain equals the main task history's first 5 entries.
  // The invalid check runs outside the printed parse: a detached
  // copy whose third entry's `from` is rewritten from ACCEPTED
  // to OPEN breaks the chain, so parseHistory must throw
  // "invalid history: entry[2]: from OPEN does not continue
  // previous to ACCEPTED" — and the original parse is untouched.
  const PARSE_HISTORY_TEXT = JSON.stringify([
    { seq: 1, event: "PUBLISH", from: "DRAFT", to: "OPEN", at: "2026-03-23T09:00:00.000Z", actor: "system", note: "Researcher publishes the data-collection task" },
    { seq: 2, event: "ACCEPT", from: "OPEN", to: "ACCEPTED", at: "2026-03-23T09:05:00.000Z", actor: "contributor", note: "Contributor picks up the task" },
    { seq: 3, event: "START_CAPTURE", from: "ACCEPTED", to: "CAPTURING", at: "2026-03-23T09:10:00.000Z", actor: "contributor", note: "Data capture begins" },
    { seq: 4, event: "SUBMIT", from: "CAPTURING", to: "SUBMITTED", at: "2026-03-23T09:15:00.000Z", actor: "contributor", note: "Batch uploaded for QA" },
    { seq: 5, event: "BEGIN_REVIEW", from: "SUBMITTED", to: "IN_REVIEW", at: "2026-03-23T09:20:00.000Z", actor: "reviewer", note: "QA specialist starts review" },
  ]);
  const parsedHistoryEntries = parseHistory(
    JSON.parse(PARSE_HISTORY_TEXT) as unknown,
  );
  const parsedHistoryMatchesMainPrefix =
    parsedHistoryEntries.length === 5 &&
    parsedHistoryEntries.every((entry, i) => {
      const main = task.history[i];
      return (
        main !== undefined &&
        entry.seq === main.seq &&
        entry.event === main.event &&
        entry.from === main.from &&
        entry.to === main.to
      );
    });
  let parsedHistoryInvalidRejected = false;
  let parsedHistoryInvalidError = "";
  const parsedHistoryInvalidCopy = parsedHistoryEntries.map((entry) => ({
    ...entry,
  }));
  parsedHistoryInvalidCopy[2] = {
    ...parsedHistoryInvalidCopy[2],
    from: "OPEN",
  };
  try {
    parseHistory(parsedHistoryInvalidCopy);
  } catch (err) {
    parsedHistoryInvalidError = err instanceof Error ? err.message : String(err);
    parsedHistoryInvalidRejected = parsedHistoryInvalidError.includes(
      "does not continue previous to",
    );
  }
  lines.push(
    "",
    "Standalone history parsing (parseHistory on a fixed external history):",
    "  source: fixed JSON text with 5 hashless entries (the PUBLISH..BEGIN_REVIEW chain that opens DEMO-001, fixed timestamps; no TaskLifecycle instance involved)",
  );
  for (const entry of parsedHistoryEntries) {
    lines.push(
      `  entry seq ${entry.seq}: ${entry.event} ${entry.from} -> ${entry.to} (actor ${entry.actor}, at ${entry.at})`,
    );
  }
  const parsedHistoryLast = parsedHistoryEntries.at(-1)!;
  lines.push(
    `  parsed: ${parsedHistoryEntries.length} entries, final state ${parsedHistoryLast.to} (last entry seq ${parsedHistoryLast.seq} ${parsedHistoryLast.event} ${parsedHistoryLast.from} -> ${parsedHistoryLast.to})`,
    `  matches DEMO-001 prefix: ${parsedHistoryMatchesMainPrefix} (the parsed seq/event/from/to chain equals the main task history's first 5 entries)`,
    `  invalid copy: parseHistory FAILED — ${parsedHistoryInvalidError} (a broken chain is rejected and the original parse is untouched)`,
  );

  return { task, historyChainVerified, tamperedChainVerified, tamperedPayoutAmount, overdueTask, overdueFound, disputeTask, webhook, webhookVerified, dedupeFirst, dedupeRedelivery, dedupeAfterTtl, batchResults, batchVerified, fanoutResult, fanoutCalls, retryAfterParsed, unreconciledTask, mismatchedTask, unreconciledFound, mismatchedFound, totalPaid, subscriptionTask, subscriptionNotifications, subscriptionMatchesHistory, subscriptionCountAfterUnsubscribe, staleDwellTasks, staleFound, staleExpiredFound, staleActionTasks, staleActionResults, expireExecutionTasks, expireExecutionFound, expireExecutionResults, ndjsonText, replayedTask, allowedEventsByState, mainTaskAllowedEvents, parsedHistoryEntries, parsedHistoryMatchesMainPrefix, parsedHistoryInvalidRejected, parsedHistoryInvalidError, lines };
}

async function main(): Promise<void> {
  console.log((await runDemo()).lines.join("\n"));
}

// Run only when executed directly (`node dist/src/demo.js`), not when
// imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
