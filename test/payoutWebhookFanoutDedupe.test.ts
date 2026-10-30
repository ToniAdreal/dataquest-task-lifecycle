import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook fan-out x `PayoutEventDedupe` endpoint isolation
 * (backlog #740, the dataquest-side peer of escrow #741).
 *
 * The single-endpoint receiver flow (#726) pins verify-then-record for
 * one receiver. It says nothing about a fan-out, where the SAME
 * eventId is delivered to several endpoints at once: dedupe state must
 * be per receiver, never shared across endpoints, or one endpoint's
 * first sighting would falsely mark another endpoint's first delivery
 * as a duplicate. Rules under test, with one independent
 * `PayoutEventDedupe` per endpoint and the documented receiver order
 * (verify the raw wire body first, `checkAndRecord` only after a
 * `true` verification, collapsed into a local `receive()` helper):
 *  - one fan-out to 4 endpoints: every receiver accepts its own
 *    per-endpoint-signed copy as a first sighting, each dedupe at
 *    size 1, even though all four copies share one eventId
 *  - re-delivering each recorded wire body to its own endpoint
 *    reports duplicate on all four receivers, with hits/misses
 *    counting the flow per receiver
 *  - endpoint isolation, the core of this item: an eventId recorded
 *    at endpoint A alone does NOT make the same eventId a duplicate
 *    at endpoint B — B's first delivery of that eventId is still
 *    accepted, and only then do re-deliveries to A and to B both
 *    report duplicate, while untouched endpoints C and D stay at
 *    size 0
 *  - a tampered delivery to one endpoint verifies false, records
 *    nothing anywhere, and the true delivery to that endpoint is
 *    still a first sighting
 *  - a wire body recorded for endpoint A, presented to endpoint B's
 *    receiver, is rejected (it is signed with A's secret, not B's)
 *    and leaves B's dedupe untouched, so B's true delivery of the
 *    same eventId is still accepted
 */

const SECRET_A = "whsec_fanout_dedupe_billing";
const SECRET_B = "whsec_fanout_dedupe_risk";
const SECRET_C = "whsec_fanout_dedupe_ledger";
const SECRET_D = "whsec_fanout_dedupe_audit";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const URL_C = "https://ledger.example.com/hooks/payout";
const URL_D = "https://audit.example.com/hooks/payout";
const NOW = new Date("2026-10-09T00:00:00.000Z");
const NOW_ISO = "2026-10-09T00:00:00.000Z";
const TAMPERED_ISO = "2026-10-09T00:00:01.000Z";

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-dedupe"): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-fanout-dedupe-1",
    payoutAmount: 4200,
  });
  return t;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records every call and always answers 200. */
function recordingFetch(): {
  fetchImpl: PayoutWebhookFetchImpl;
  callsTo: (url: string) => RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: PayoutWebhookFetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  return { fetchImpl, callsTo: (u) => calls.filter((c) => c.url === u) };
}

function bodyOf(call: RecordedCall): string {
  return String(call.init.body);
}
function signatureOf(call: RecordedCall): string {
  return String(new Headers(call.init.headers).get("x-hub-signature-256"));
}

type ReceiveOutcome = "accepted" | "duplicate" | "rejected";

/**
 * The documented receiver order: verify the raw wire body first; only
 * a verified delivery reaches `checkAndRecord`. A rejected delivery
 * never touches the dedupe store.
 */
function receive(
  raw: string,
  signature: string,
  dedupe: PayoutEventDedupe,
  secret: string,
): ReceiveOutcome {
  if (!verifyPayoutWebhook(raw, signature, secret)) return "rejected";
  const payload = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(payload.eventId) ? "duplicate" : "accepted";
}

const ENDPOINTS = [
  { url: URL_A, secret: SECRET_A },
  { url: URL_B, secret: SECRET_B },
  { url: URL_C, secret: SECRET_C },
  { url: URL_D, secret: SECRET_D },
];

test("fan-out to 4 endpoints: every receiver accepts its own copy as first sighting", async () => {
  const { fetchImpl, callsTo } = recordingFetch();
  const out = await deliverPayoutWebhookToMany(paidTask(), ENDPOINTS, {
    fetchImpl,
    sleepImpl: async () => {},
    now: NOW,
    eventId: "evt-fanout-dedupe-1",
  });
  assert.equal(out.delivered, 4);
  assert.equal(out.failed, 0);
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  const secrets = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
  const urls = [URL_A, URL_B, URL_C, URL_D];
  for (let i = 0; i < 4; i++) {
    const [call] = callsTo(urls[i]);
    assert.equal(JSON.parse(bodyOf(call)).eventId, "evt-fanout-dedupe-1");
    assert.equal(receive(bodyOf(call), signatureOf(call), dedupes[i], secrets[i]), "accepted");
    assert.equal(dedupes[i].size, 1);
  }
});

test("re-delivery to the same endpoint is a duplicate on all four receivers", async () => {
  const { fetchImpl, callsTo } = recordingFetch();
  await deliverPayoutWebhookToMany(paidTask(), ENDPOINTS, {
    fetchImpl,
    sleepImpl: async () => {},
    now: NOW,
    eventId: "evt-fanout-dedupe-2",
  });
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  const secrets = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
  const urls = [URL_A, URL_B, URL_C, URL_D];
  for (let i = 0; i < 4; i++) {
    const [call] = callsTo(urls[i]);
    assert.equal(receive(bodyOf(call), signatureOf(call), dedupes[i], secrets[i]), "accepted");
    assert.equal(receive(bodyOf(call), signatureOf(call), dedupes[i], secrets[i]), "duplicate");
    assert.deepEqual(dedupes[i].stats(), {
      size: 1,
      hits: 1,
      misses: 1,
      evictions: 0,
    });
  }
});

test("endpoint isolation: A recording an eventId does not make B's first delivery a duplicate", () => {
  const task = paidTask("task-fanout-dedupe-isolation");
  const dedupeA = new PayoutEventDedupe();
  const dedupeB = new PayoutEventDedupe();
  const dedupeC = new PayoutEventDedupe();
  const dedupeD = new PayoutEventDedupe();
  // The same logical event, signed per endpoint as a fan-out would.
  const { payload: payloadA, signature: sigA } = buildPayoutWebhook(task, SECRET_A, {
    eventId: "evt-fanout-dedupe-isolation",
    now: NOW,
  });
  const { payload: payloadB, signature: sigB } = buildPayoutWebhook(task, SECRET_B, {
    eventId: "evt-fanout-dedupe-isolation",
    now: NOW,
  });
  const rawA = JSON.stringify(payloadA);
  const rawB = JSON.stringify(payloadB);
  // A sees the event first; B has not seen it yet.
  assert.equal(receive(rawA, sigA, dedupeA, SECRET_A), "accepted");
  assert.equal(dedupeA.size, 1);
  // B's first delivery of the SAME eventId is still a first sighting.
  assert.equal(receive(rawB, sigB, dedupeB, SECRET_B), "accepted");
  assert.equal(dedupeB.size, 1);
  // Only now are re-deliveries duplicates, independently per endpoint.
  assert.equal(receive(rawA, sigA, dedupeA, SECRET_A), "duplicate");
  assert.equal(receive(rawB, sigB, dedupeB, SECRET_B), "duplicate");
  // Endpoints that never received the event are untouched.
  assert.equal(dedupeC.size, 0);
  assert.equal(dedupeD.size, 0);
});

test("a tampered delivery to one endpoint records nothing and its true delivery is still first-seen", async () => {
  const { fetchImpl, callsTo } = recordingFetch();
  await deliverPayoutWebhookToMany(paidTask(), ENDPOINTS, {
    fetchImpl,
    sleepImpl: async () => {},
    now: NOW,
    eventId: "evt-fanout-dedupe-tamper",
  });
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  const [callC] = callsTo(URL_C);
  const rawC = bodyOf(callC);
  const sigC = signatureOf(callC);
  // Same eventId, one second moved on `at`: the bytes no longer match
  // the signature, but the eventId the receiver would record is intact.
  const tampered = rawC.replace(NOW_ISO, TAMPERED_ISO);
  assert.notEqual(tampered, rawC);
  assert.equal(verifyPayoutWebhook(tampered, sigC, SECRET_C), false);
  assert.equal(receive(tampered, sigC, dedupes[2], SECRET_C), "rejected");
  assert.equal(dedupes[2].size, 0);
  // The forgery did not poison the store: the true delivery is first-seen.
  assert.equal(receive(rawC, sigC, dedupes[2], SECRET_C), "accepted");
  assert.equal(receive(rawC, sigC, dedupes[2], SECRET_C), "duplicate");
});

test("A's wire body presented to B's receiver is rejected and leaves B's dedupe untouched", async () => {
  const { fetchImpl, callsTo } = recordingFetch();
  await deliverPayoutWebhookToMany(paidTask(), ENDPOINTS, {
    fetchImpl,
    sleepImpl: async () => {},
    now: NOW,
    eventId: "evt-fanout-dedupe-cross",
  });
  const [callA] = callsTo(URL_A);
  const [callB] = callsTo(URL_B);
  const dedupeB = new PayoutEventDedupe();
  // A's copy is signed with A's secret, so B's verification fails even
  // though the eventId matches B's own copy exactly.
  assert.equal(
    verifyPayoutWebhook(bodyOf(callA), signatureOf(callA), SECRET_B),
    false,
  );
  assert.equal(
    receive(bodyOf(callA), signatureOf(callA), dedupeB, SECRET_B),
    "rejected",
  );
  assert.equal(dedupeB.size, 0);
  // B's own true delivery is still a first sighting.
  assert.equal(
    receive(bodyOf(callB), signatureOf(callB), dedupeB, SECRET_B),
    "accepted",
  );
});
