import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
  type AuditChainOptions,
  type BuildPayoutWebhookOptions,
  type BuildPayoutWebhooksOptions,
  type DeliverPayoutWebhookOptions,
  type DeliverPayoutWebhookToManyOptions,
  type DeliverWebhookResult,
  type DispatchOptions,
  type PayoutEventDedupeOptions,
  type PayoutWebhookEndpoint,
  type PayoutWebhookOutboxAttempt,
  type PayoutWebhookOutboxOptions,
  type PayoutWebhookOutboxRetryOptions,
  type PayoutWebhookPayload,
  type SubscribeOptions,
  type TaskHistoryEntry,
  type TaskLifecycleOptions,
  type TasksByFiltersOptions,
  type VerifyPayoutWebhookOptions,
} from "../src/index.js";

// Backlog #1037: `exactOptionalPropertyTypes` is on (rfc #1021 pilot,
// escrow #1036 mirror). Two rules hold:
//  - data/message shapes genuinely carry undefined at runtime, so their
//    optional fields accept an explicit undefined (absent == undefined
//    there): TaskHistoryEntry (hash/prevHash — adversarial shapes may
//    delete a link), PayoutWebhookPayload (payoutRef/payoutAmount/
//    quotedAmount — a stripped field drops the key on re-stringification),
//    PayoutWebhookOutboxAttempt (at — the outbox clock default),
//    DeliverWebhookResult (status — no response means no status);
//  - config options do NOT accept one: omitting the field is the only
//    way to take the default, so a caller that forwards a
//    possibly-undefined value must omit it (conditional spread)
//    instead of passing it through. This covers TaskLifecycleOptions,
//    DispatchOptions, TasksByFiltersOptions, AuditChainOptions,
//    SubscribeOptions, BuildPayoutWebhookOptions,
//    BuildPayoutWebhooksOptions, VerifyPayoutWebhookOptions,
//    PayoutEventDedupeOptions, PayoutWebhookOutboxOptions,
//    PayoutWebhookOutboxRetryOptions, DeliverPayoutWebhookOptions,
//    DeliverPayoutWebhookToManyOptions, and PayoutWebhookEndpoint.
// Each negative case below must fail to compile without its
// expect-error comment: if a type ever re-admits explicit undefined, tsc
// reports the directive as unused and the suite goes red.

test("exactOptionalPropertyTypes: data shapes still accept explicit undefined, and omitted config optionals keep working", () => {
  const entry: TaskHistoryEntry = {
    seq: 1,
    event: "PUBLISH",
    from: "DRAFT",
    to: "OPEN",
    at: "2026-01-01T00:00:00.000Z",
    prevHash: undefined,
    hash: undefined,
  };
  const payload: PayoutWebhookPayload = {
    event: "PAYOUT_COMPLETE",
    taskId: "t-eopt-1",
    payoutRef: undefined,
    payoutAmount: undefined,
    quotedAmount: undefined,
    at: "2026-01-01T00:00:00.000Z",
    eventId: "evt-eopt-1",
  };
  const attempt: PayoutWebhookOutboxAttempt = {
    endpoint: "https://example.com/hook",
    eventId: "evt-eopt-1",
    ok: false,
    error: "server responded with status 500",
    at: undefined,
  };
  const result: DeliverWebhookResult = {
    ok: false,
    attempts: 1,
    status: undefined,
    error: "fetch failed",
  };
  void entry;
  void payload;
  void attempt;
  void result;

  // Omitted config optionals still take their defaults at runtime.
  const task = new TaskLifecycle("t-eopt-1");
  task.dispatch("PUBLISH", { actor: "researcher" });
  task.dispatch("ACCEPT", { actor: "contributor" });
  task.dispatch("START_CAPTURE", { actor: "contributor" });
  task.dispatch("SUBMIT", { actor: "contributor" });
  task.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  task.dispatch("APPROVE", { actor: "reviewer" });
  task.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  task.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-eopt-1",
    payoutAmount: 4200,
  });
  assert.equal(task.state, "PAID");
  const { payload: built, signature } = buildPayoutWebhook(task, "s3cr3t", {
    eventId: "evt-eopt-1",
    now: new Date("2026-10-09T00:00:00.000Z"),
  });
  assert.equal(built.payoutRef, "xfer-eopt-1");
  assert.equal(verifyPayoutWebhook(built, signature, "s3cr3t"), true);
  // A stripped field drops its key on re-stringification, so the same
  // signature must fail against the stripped body.
  assert.equal(
    verifyPayoutWebhook({ ...built, payoutRef: undefined }, signature, "s3cr3t"),
    false,
  );
});

// Positive controls: omitting an optional config field still compiles.
const omittedLifecycle: TaskLifecycleOptions = {};
const omittedDispatch: DispatchOptions = {};
const omittedFilters: TasksByFiltersOptions = {};
const omittedAuditChain: AuditChainOptions = {};
const omittedSubscribe: SubscribeOptions = {};
const omittedBuild: BuildPayoutWebhookOptions = {};
const omittedBatchBuild: BuildPayoutWebhooksOptions = {};
const omittedVerify: VerifyPayoutWebhookOptions = {};
const omittedDedupe: PayoutEventDedupeOptions = {};
const omittedOutbox: PayoutWebhookOutboxOptions = {};
const omittedRetry: PayoutWebhookOutboxRetryOptions = {};
const omittedDeliver: DeliverPayoutWebhookOptions = {};
const omittedFanout: DeliverPayoutWebhookToManyOptions = {};
const omittedEndpoint: PayoutWebhookEndpoint = {
  url: "https://example.com/hook",
  secret: "s3cr3t",
};
void omittedLifecycle;
void omittedDispatch;
void omittedFilters;
void omittedAuditChain;
void omittedSubscribe;
void omittedBuild;
void omittedBatchBuild;
void omittedVerify;
void omittedDedupe;
void omittedOutbox;
void omittedRetry;
void omittedDeliver;
void omittedFanout;
void omittedEndpoint;

// Negative pins: an explicit undefined on a config option must not compile.
// @ts-expect-error TaskLifecycleOptions.maxResubmits does not accept an explicit undefined
const rejectedMaxResubmits: TaskLifecycleOptions = { maxResubmits: undefined };
// @ts-expect-error TaskLifecycleOptions.rolePolicy does not accept an explicit undefined
const rejectedRolePolicy: TaskLifecycleOptions = { rolePolicy: undefined };
// @ts-expect-error TaskLifecycleOptions.auditSecret does not accept an explicit undefined
const rejectedAuditSecret: TaskLifecycleOptions = { auditSecret: undefined };
// @ts-expect-error TaskLifecycleOptions.requirePayoutRef does not accept an explicit undefined
const rejectedRequirePayoutRef: TaskLifecycleOptions = { requirePayoutRef: undefined };
// @ts-expect-error DispatchOptions.actor does not accept an explicit undefined
const rejectedDispatchActor: DispatchOptions = { actor: undefined };
// @ts-expect-error DispatchOptions.at does not accept an explicit undefined
const rejectedDispatchAt: DispatchOptions = { at: undefined };
// @ts-expect-error DispatchOptions.payoutRef does not accept an explicit undefined
const rejectedDispatchPayoutRef: DispatchOptions = { payoutRef: undefined };
// @ts-expect-error DispatchOptions.expectedSeq does not accept an explicit undefined
const rejectedDispatchExpectedSeq: DispatchOptions = { expectedSeq: undefined };
// @ts-expect-error TasksByFiltersOptions.actor does not accept an explicit undefined
const rejectedFilterActor: TasksByFiltersOptions = { actor: undefined };
// @ts-expect-error TasksByFiltersOptions.state does not accept an explicit undefined
const rejectedFilterState: TasksByFiltersOptions = { state: undefined };
// @ts-expect-error AuditChainOptions.auditSecret does not accept an explicit undefined
const rejectedChainSecret: AuditChainOptions = { auditSecret: undefined };
// @ts-expect-error SubscribeOptions.onError does not accept an explicit undefined
const rejectedSubscribeOnError: SubscribeOptions = { onError: undefined };
// @ts-expect-error BuildPayoutWebhookOptions.now does not accept an explicit undefined
const rejectedBuildNow: BuildPayoutWebhookOptions = { now: undefined };
// @ts-expect-error BuildPayoutWebhookOptions.eventId does not accept an explicit undefined
const rejectedBuildEventId: BuildPayoutWebhookOptions = { eventId: undefined };
// @ts-expect-error BuildPayoutWebhooksOptions.now does not accept an explicit undefined
const rejectedBatchNow: BuildPayoutWebhooksOptions = { now: undefined };
// @ts-expect-error BuildPayoutWebhooksOptions.requirePayoutRef does not accept an explicit undefined
const rejectedBatchRequireRef: BuildPayoutWebhooksOptions = { requirePayoutRef: undefined };
// @ts-expect-error VerifyPayoutWebhookOptions.secrets does not accept an explicit undefined
const rejectedVerifySecrets: VerifyPayoutWebhookOptions = { secrets: undefined };
// @ts-expect-error VerifyPayoutWebhookOptions.maxAgeMs does not accept an explicit undefined
const rejectedVerifyMaxAge: VerifyPayoutWebhookOptions = { maxAgeMs: undefined };
// @ts-expect-error PayoutEventDedupeOptions.ttlMs does not accept an explicit undefined
const rejectedDedupeTtl: PayoutEventDedupeOptions = { ttlMs: undefined };
// @ts-expect-error PayoutEventDedupeOptions.now does not accept an explicit undefined
const rejectedDedupeNow: PayoutEventDedupeOptions = { now: undefined };
// @ts-expect-error PayoutWebhookOutboxOptions.maxAttempts does not accept an explicit undefined
const rejectedOutboxMaxAttempts: PayoutWebhookOutboxOptions = { maxAttempts: undefined };
// @ts-expect-error PayoutWebhookOutboxOptions.now does not accept an explicit undefined
const rejectedOutboxNow: PayoutWebhookOutboxOptions = { now: undefined };
// @ts-expect-error PayoutWebhookOutboxRetryOptions.maxRounds does not accept an explicit undefined
const rejectedRetryMaxRounds: PayoutWebhookOutboxRetryOptions = { maxRounds: undefined };
// @ts-expect-error PayoutWebhookOutboxRetryOptions.signal does not accept an explicit undefined
const rejectedRetrySignal: PayoutWebhookOutboxRetryOptions = { signal: undefined };
// @ts-expect-error DeliverPayoutWebhookOptions.timeoutMs does not accept an explicit undefined
const rejectedDeliverTimeout: DeliverPayoutWebhookOptions = { timeoutMs: undefined };
// @ts-expect-error DeliverPayoutWebhookOptions.signal does not accept an explicit undefined
const rejectedDeliverSignal: DeliverPayoutWebhookOptions = { signal: undefined };
// @ts-expect-error DeliverPayoutWebhookOptions.fetchImpl does not accept an explicit undefined
const rejectedDeliverFetchImpl: DeliverPayoutWebhookOptions = { fetchImpl: undefined };
// @ts-expect-error DeliverPayoutWebhookToManyOptions.eventId does not accept an explicit undefined
const rejectedFanoutEventId: DeliverPayoutWebhookToManyOptions = { eventId: undefined };
// @ts-expect-error DeliverPayoutWebhookToManyOptions.maxEndpoints does not accept an explicit undefined
const rejectedFanoutMaxEndpoints: DeliverPayoutWebhookToManyOptions = { maxEndpoints: undefined };
// @ts-expect-error PayoutWebhookEndpoint.timeoutMs does not accept an explicit undefined
const rejectedEndpointTimeout: PayoutWebhookEndpoint = {
  url: "https://example.com/hook",
  secret: "s3cr3t",
  timeoutMs: undefined,
};
// @ts-expect-error PayoutWebhookEndpoint.signal does not accept an explicit undefined
const rejectedEndpointSignal: PayoutWebhookEndpoint = {
  url: "https://example.com/hook",
  secret: "s3cr3t",
  signal: undefined,
};
void rejectedMaxResubmits;
void rejectedRolePolicy;
void rejectedAuditSecret;
void rejectedRequirePayoutRef;
void rejectedDispatchActor;
void rejectedDispatchAt;
void rejectedDispatchPayoutRef;
void rejectedDispatchExpectedSeq;
void rejectedFilterActor;
void rejectedFilterState;
void rejectedChainSecret;
void rejectedSubscribeOnError;
void rejectedBuildNow;
void rejectedBuildEventId;
void rejectedBatchNow;
void rejectedBatchRequireRef;
void rejectedVerifySecrets;
void rejectedVerifyMaxAge;
void rejectedDedupeTtl;
void rejectedDedupeNow;
void rejectedOutboxMaxAttempts;
void rejectedOutboxNow;
void rejectedRetryMaxRounds;
void rejectedRetrySignal;
void rejectedDeliverTimeout;
void rejectedDeliverSignal;
void rejectedDeliverFetchImpl;
void rejectedFanoutEventId;
void rejectedFanoutMaxEndpoints;
void rejectedEndpointTimeout;
void rejectedEndpointSignal;
