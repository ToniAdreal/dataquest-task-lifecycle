import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook fan-out limits x `PayoutEventDedupe`
 * (backlog #761, the dataquest-side peer of escrow #758).
 *
 * The limits file pins the cap; the dedupe file pins per-receiver
 * first-sighting for a delivered fan-out. Neither says what happens
 * to receiver dedupe state when a fan-out is refused outright, or
 * when it only partly succeeds. Rules under test, with one
 * independent `PayoutEventDedupe` per endpoint and the documented
 * receiver order (verify the raw wire body first, `checkAndRecord`
 * only after a `true` verification, collapsed into a local
 * `receive()` helper):
 *  - an over-`maxEndpoints` batch is refused before any request:
 *    zero fetches reach any endpoint, so all four receivers'
 *    dedupes stay empty — a refused batch records nothing anywhere
 *  - a 3-endpoint batch where one endpoint keeps returning 500
 *    until its retries are exhausted: that endpoint fails alone,
 *    the other two endpoints' first deliveries are first sightings
 *    (each dedupe at size 1, re-delivery a duplicate), and the
 *    failed endpoint's dedupe stays empty even though its wire body
 *    was attempted twice — a failed delivery is not a recording, so
 *    the endpoint's later true delivery of the same eventId is
 *    still a first sighting
 */

const SECRET_A = "whsec_fanout_limits_dedupe_billing";
const SECRET_B = "whsec_fanout_limits_dedupe_risk";
const SECRET_C = "whsec_fanout_limits_dedupe_ledger";
const SECRET_D = "whsec_fanout_limits_dedupe_audit";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const URL_C = "https://ledger.example.com/hooks/payout";
const URL_D = "https://audit.example.com/hooks/payout";
const NOW = new Date("2026-10-31T16:00:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-limits-dedupe"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-limits-dedupe-1",
    payoutAmount: 4200,
  });
  return t;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
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

/** A fetch stub routing by URL: each URL has its own fixed status. */
function routerFetch(statusByUrl: Record<string, number>): {
  fetchImpl: PayoutWebhookFetchImpl;
  callsTo: (url: string) => RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: PayoutWebhookFetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: statusByUrl[url] });
  };
  return { fetchImpl, callsTo: (u) => calls.filter((c) => c.url === u) };
}

const ENDPOINTS_4 = [
  { url: URL_A, secret: SECRET_A },
  { url: URL_B, secret: SECRET_B },
  { url: URL_C, secret: SECRET_C },
  { url: URL_D, secret: SECRET_D },
];

test("over-maxEndpoints batch throws before any request: all four receivers' dedupes stay empty", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: 200,
    [URL_B]: 200,
    [URL_C]: 200,
    [URL_D]: 200,
  });
  await assert.rejects(
    () =>
      deliverPayoutWebhookToMany(paidTask(), ENDPOINTS_4, {
        fetchImpl,
        sleepImpl: async () => {},
        now: NOW,
        eventId: "evt-fanout-limits-dedupe-cap",
        maxEndpoints: 3,
      }),
    /4 endpoints exceed maxEndpoints 3/,
  );
  for (const url of [URL_A, URL_B, URL_C, URL_D]) {
    assert.equal(callsTo(url).length, 0, `cap breach must not fetch ${url}`);
  }
  // No delivery reached any receiver, so no receiver recorded anything.
  for (const dedupe of ENDPOINTS_4.map(() => new PayoutEventDedupe())) {
    assert.equal(dedupe.size, 0);
  }
});

test("partial fan-out failure: successes record first sightings, the failed endpoint records nothing, its later true delivery is still first-seen", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: 200,
    [URL_B]: 500,
    [URL_C]: 200,
  });
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_A, secret: SECRET_A },
      { url: URL_B, secret: SECRET_B },
      { url: URL_C, secret: SECRET_C },
    ],
    {
      fetchImpl,
      sleepImpl: async () => {},
      now: NOW,
      eventId: "evt-fanout-limits-dedupe-partial",
      maxAttempts: 2,
      backoffMs: 1,
    },
  );
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.results[0], { ok: true, attempts: 1, status: 200 });
  assert.equal(out.results[1].ok, false);
  assert.equal(out.results[1].attempts, 2, "500 retries are exhausted, not cut short");
  assert.equal(out.results[1].status, 500);
  assert.match(out.results[1].error ?? "", /server responded with status 500/);
  assert.deepEqual(out.results[2], { ok: true, attempts: 1, status: 200 });
  assert.equal(callsTo(URL_A).length, 1);
  assert.equal(callsTo(URL_B).length, 2, "the failing endpoint burned both attempts");
  assert.equal(callsTo(URL_C).length, 1);

  const dedupeA = new PayoutEventDedupe();
  const dedupeB = new PayoutEventDedupe();
  const dedupeC = new PayoutEventDedupe();
  const [callA] = callsTo(URL_A);
  const [callC] = callsTo(URL_C);
  // Successful endpoints' first deliveries are first sightings.
  assert.equal(receive(bodyOf(callA), signatureOf(callA), dedupeA, SECRET_A), "accepted");
  assert.equal(dedupeA.size, 1);
  assert.equal(receive(bodyOf(callA), signatureOf(callA), dedupeA, SECRET_A), "duplicate");
  assert.equal(receive(bodyOf(callC), signatureOf(callC), dedupeC, SECRET_C), "accepted");
  assert.equal(dedupeC.size, 1);
  assert.equal(receive(bodyOf(callC), signatureOf(callC), dedupeC, SECRET_C), "duplicate");
  // The failed delivery never reached its receiver: two attempts on
  // the wire, zero recordings in the store.
  assert.equal(dedupeB.size, 0);

  // The endpoint recovers: a later true delivery of the same eventId
  // is still a first sighting, and only then a duplicate.
  const recovery = routerFetch({ [URL_B]: 200 });
  const out2 = await deliverPayoutWebhookToMany(
    paidTask("task-fanout-limits-dedupe-recovery"),
    [{ url: URL_B, secret: SECRET_B }],
    {
      fetchImpl: recovery.fetchImpl,
      sleepImpl: async () => {},
      now: NOW,
      eventId: "evt-fanout-limits-dedupe-partial",
    },
  );
  assert.equal(out2.delivered, 1);
  assert.equal(out2.failed, 0);
  const [recoveredCall] = recovery.callsTo(URL_B);
  assert.equal(
    receive(bodyOf(recoveredCall), signatureOf(recoveredCall), dedupeB, SECRET_B),
    "accepted",
  );
  assert.equal(dedupeB.size, 1);
  assert.equal(
    receive(bodyOf(recoveredCall), signatureOf(recoveredCall), dedupeB, SECRET_B),
    "duplicate",
  );
  // The recovery touched only the failed endpoint's receiver.
  assert.equal(dedupeA.size, 1);
  assert.equal(dedupeC.size, 1);
});
