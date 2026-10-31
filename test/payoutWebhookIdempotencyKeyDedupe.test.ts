import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook `Idempotency-Key` x `PayoutEventDedupe` (backlog #768).
 *
 * The two single-feature suites never exercised the combination:
 * `payoutWebhookIdempotencyHeader.test.ts` (#568) pins that every
 * delivery attempt carries `Idempotency-Key: <payload eventId>` on
 * the wire, and `payoutWebhookFanoutDedupe.test.ts` (#740) pins the
 * receiver-side dedupe flow — but nothing pinned that a webhook
 * built twice with the same eventId carries the same header on both
 * deliveries AND that the receiver deduplicates those two deliveries
 * as one event.
 *
 * Rules under test, with the documented receiver order (verify the
 * raw wire body first, `checkAndRecord` only after a `true`
 * verification, dedupe keyed on the verified body's `eventId`):
 *  - the same eventId built twice carries a byte-identical
 *    `Idempotency-Key` header on both deliveries, equal to the body
 *    `eventId`; the receiver accepts the first and reports the
 *    second as a duplicate
 *  - different eventIds carry different headers and are both first
 *    sightings
 *  - a tampered body fails verification, records nothing, and the
 *    true delivery afterwards is still a first sighting
 *  - the header is unsigned transport hint only (see #568): it never
 *    drives the dedupe decision — a redelivery whose presented header
 *    was spoofed is still a duplicate on the verified body eventId,
 *    and a first delivery with a spoofed header is still accepted
 *  - retry attempts carry the same header, so a retried delivery is
 *    a redelivery for dedupe purposes, not a new event
 *  - the dedupe key is the eventId alone: reusing one eventId across
 *    two different tasks still dedupes the second delivery (reusing
 *    an eventId is a caller bug — the batch docs warn against it —
 *    but the receiver must not silently double-book it)
 */

const SECRET = "whsec_test_payout_idem_dedupe_20261031";
const URL = "https://receiver.example.com/hooks/payout";
const NOW = new Date("2026-10-31T00:00:00.000Z");
const NOW_ISO = "2026-10-31T00:00:00.000Z";
const TAMPERED_ISO = "2026-10-31T00:00:01.000Z";

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(
  id: string,
  payoutRef = "xfer-idem-dedupe-1",
  payoutAmount = 4200,
): TaskLifecycle {
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
    payoutRef,
    payoutAmount,
  });
  return t;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records every call and answers with scripted statuses. */
function recordingFetch(statuses: number[]): {
  fetchImpl: PayoutWebhookFetchImpl;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let n = 0;
  const fetchImpl: PayoutWebhookFetchImpl = async (url, init) => {
    calls.push({ url, init });
    const status = statuses[Math.min(n, statuses.length - 1)];
    n += 1;
    return new Response("{}", { status });
  };
  return { fetchImpl, calls };
}

function bodyOf(call: RecordedCall): string {
  return String(call.init.body);
}
function headerOf(call: RecordedCall, name: string): string {
  return String(new Headers(call.init.headers).get(name));
}
function signatureOf(call: RecordedCall): string {
  return headerOf(call, "x-hub-signature-256");
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

/**
 * Same as `receive`, but the presented `Idempotency-Key` header value
 * is passed in explicitly so the test can show it is read and then
 * deliberately NOT used as the dedupe key: the header is unsigned,
 * so a value that disagrees with the verified body is untrusted and
 * must neither create a new entry nor block the body's own dedupe
 * outcome.
 */
function receiveWithPresentedHeader(
  raw: string,
  signature: string,
  presentedIdempotencyKey: string,
  dedupe: PayoutEventDedupe,
  secret: string,
): ReceiveOutcome {
  if (!verifyPayoutWebhook(raw, signature, secret)) return "rejected";
  const payload = JSON.parse(raw) as { eventId: string };
  // The presented header is intentionally not the dedupe key.
  void presentedIdempotencyKey;
  return dedupe.checkAndRecord(payload.eventId) ? "duplicate" : "accepted";
}

test("same eventId built twice: byte-identical Idempotency-Key, first accepted then duplicate", async () => {
  const task = paidTask("task-idem-dedupe-1");
  const first = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-idem-dedupe-1",
    now: NOW,
  });
  const second = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-idem-dedupe-1",
    now: NOW,
  });
  // Two builds of the same event are the same signed payload.
  assert.deepEqual(second.payload, first.payload);
  assert.equal(second.signature, first.signature);

  const { fetchImpl, calls } = recordingFetch([200]);
  const firstResult = await deliverPayoutWebhook(URL, first, { fetchImpl });
  const secondResult = await deliverPayoutWebhook(URL, second, { fetchImpl });
  assert.deepEqual(firstResult, { ok: true, attempts: 1, status: 200 });
  assert.deepEqual(secondResult, { ok: true, attempts: 1, status: 200 });
  assert.equal(calls.length, 2);
  const [callA, callB] = calls;
  // The header is byte-identical across both deliveries and equals
  // the body eventId on each wire copy (X-Event-Id rides alongside
  // with the same value, per #583).
  assert.equal(headerOf(callA, "idempotency-key"), "evt-idem-dedupe-1");
  assert.equal(headerOf(callB, "idempotency-key"), "evt-idem-dedupe-1");
  assert.equal(
    headerOf(callA, "idempotency-key"),
    headerOf(callB, "idempotency-key"),
  );
  assert.equal(
    headerOf(callA, "idempotency-key"),
    (JSON.parse(bodyOf(callA)) as { eventId: string }).eventId,
  );
  assert.equal(
    headerOf(callB, "idempotency-key"),
    (JSON.parse(bodyOf(callB)) as { eventId: string }).eventId,
  );
  assert.equal(headerOf(callA, "x-event-id"), "evt-idem-dedupe-1");
  assert.equal(headerOf(callB, "x-event-id"), "evt-idem-dedupe-1");

  const dedupe = new PayoutEventDedupe();
  assert.equal(
    receive(bodyOf(callA), signatureOf(callA), dedupe, SECRET),
    "accepted",
  );
  assert.equal(
    receive(bodyOf(callB), signatureOf(callB), dedupe, SECRET),
    "duplicate",
  );
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("different eventIds carry different Idempotency-Keys and are both first sightings", async () => {
  const task = paidTask("task-idem-dedupe-2");
  const first = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-idem-dedupe-a",
    now: NOW,
  });
  const second = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-idem-dedupe-b",
    now: NOW,
  });
  const { fetchImpl, calls } = recordingFetch([200]);
  await deliverPayoutWebhook(URL, first, { fetchImpl });
  await deliverPayoutWebhook(URL, second, { fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(headerOf(calls[0], "idempotency-key"), "evt-idem-dedupe-a");
  assert.equal(headerOf(calls[1], "idempotency-key"), "evt-idem-dedupe-b");
  assert.notEqual(
    headerOf(calls[0], "idempotency-key"),
    headerOf(calls[1], "idempotency-key"),
  );

  const dedupe = new PayoutEventDedupe();
  assert.equal(
    receive(bodyOf(calls[0]), signatureOf(calls[0]), dedupe, SECRET),
    "accepted",
  );
  assert.equal(
    receive(bodyOf(calls[1]), signatureOf(calls[1]), dedupe, SECRET),
    "accepted",
  );
  assert.deepEqual(dedupe.stats(), {
    size: 2,
    hits: 0,
    misses: 2,
    evictions: 0,
  });
});

test("tampered body verifies false, records nothing, true delivery still first-seen", async () => {
  const webhook = buildPayoutWebhook(paidTask("task-idem-dedupe-3"), SECRET, {
    eventId: "evt-idem-dedupe-tamper",
    now: NOW,
  });
  const { fetchImpl, calls } = recordingFetch([200]);
  await deliverPayoutWebhook(URL, webhook, { fetchImpl });
  const [call] = calls;
  const raw = bodyOf(call);
  const sig = signatureOf(call);
  // Same eventId, one second moved on `at`: the bytes no longer match
  // the signature, but the eventId the receiver would record is intact.
  const tampered = raw.replace(NOW_ISO, TAMPERED_ISO);
  assert.notEqual(tampered, raw);
  assert.equal(
    (JSON.parse(tampered) as { eventId: string }).eventId,
    "evt-idem-dedupe-tamper",
  );
  assert.equal(verifyPayoutWebhook(tampered, sig, SECRET), false);

  const dedupe = new PayoutEventDedupe();
  assert.equal(receive(tampered, sig, dedupe, SECRET), "rejected");
  assert.equal(dedupe.size, 0);
  // The forgery did not poison the store: the true delivery is first-seen.
  assert.equal(receive(raw, sig, dedupe, SECRET), "accepted");
  assert.equal(receive(raw, sig, dedupe, SECRET), "duplicate");
  assert.equal(dedupe.size, 1);
});

test("unsigned header never drives dedupe: spoofed header still duplicate, spoofed first delivery still accepted", () => {
  const webhook = buildPayoutWebhook(paidTask("task-idem-dedupe-4"), SECRET, {
    eventId: "evt-idem-dedupe-spoof",
    now: NOW,
  });
  const raw = JSON.stringify(webhook.payload);
  const sig = webhook.signature;

  const dedupe = new PayoutEventDedupe();
  assert.equal(
    receiveWithPresentedHeader(raw, sig, "evt-idem-dedupe-spoof", dedupe, SECRET),
    "accepted",
  );
  // The redelivery's body and signature are genuine, but its
  // presented header was spoofed to a different id. A header-keyed
  // receiver would wrongly accept it as a new event; the documented
  // receiver keys on the verified body eventId, so it is a duplicate.
  assert.equal(
    receiveWithPresentedHeader(raw, sig, "evt-spoofed-header", dedupe, SECRET),
    "duplicate",
  );
  assert.equal(dedupe.size, 1);

  // The other direction: a first delivery whose header is already
  // spoofed is still accepted on its verified body eventId — the
  // header alone neither creates nor blocks an entry.
  const fresh = new PayoutEventDedupe();
  assert.equal(
    receiveWithPresentedHeader(raw, sig, "evt-spoofed-header", fresh, SECRET),
    "accepted",
  );
  assert.equal(
    receiveWithPresentedHeader(raw, sig, "evt-idem-dedupe-spoof", fresh, SECRET),
    "duplicate",
  );
  assert.equal(fresh.size, 1);
});

test("retries carry the same Idempotency-Key, so a retried delivery is a redelivery for dedupe", async () => {
  const webhook = buildPayoutWebhook(paidTask("task-idem-dedupe-5"), SECRET, {
    eventId: "evt-idem-dedupe-retry",
    now: NOW,
  });
  const { fetchImpl, calls } = recordingFetch([500, 200]);
  const result = await deliverPayoutWebhook(URL, webhook, {
    fetchImpl,
    sleepImpl: async () => {},
    backoffMs: 1,
  });
  assert.deepEqual(result, { ok: true, attempts: 2, status: 200 });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(headerOf(call, "idempotency-key"), "evt-idem-dedupe-retry");
    assert.equal(bodyOf(call), JSON.stringify(webhook.payload));
  }
  // Both attempts are the same signed body, so the receiver sees the
  // retry as a redelivery, not a second payout event.
  const dedupe = new PayoutEventDedupe();
  assert.equal(
    receive(bodyOf(calls[0]), signatureOf(calls[0]), dedupe, SECRET),
    "accepted",
  );
  assert.equal(
    receive(bodyOf(calls[1]), signatureOf(calls[1]), dedupe, SECRET),
    "duplicate",
  );
  assert.equal(dedupe.size, 1);
});

test("same eventId reused across two tasks still dedupes the second delivery", async () => {
  const first = buildPayoutWebhook(
    paidTask("task-idem-dedupe-6a", "xfer-idem-dedupe-6a", 4200),
    SECRET,
    { eventId: "evt-idem-dedupe-shared", now: NOW },
  );
  const second = buildPayoutWebhook(
    paidTask("task-idem-dedupe-6b", "xfer-idem-dedupe-6b", 5100),
    SECRET,
    { eventId: "evt-idem-dedupe-shared", now: NOW },
  );
  // Different tasks, different bodies and signatures — but the same
  // eventId, hence the same header.
  assert.notEqual(JSON.stringify(first.payload), JSON.stringify(second.payload));
  assert.notEqual(first.signature, second.signature);
  assert.equal(first.payload.eventId, second.payload.eventId);

  const { fetchImpl, calls } = recordingFetch([200]);
  await deliverPayoutWebhook(URL, first, { fetchImpl });
  await deliverPayoutWebhook(URL, second, { fetchImpl });
  assert.equal(headerOf(calls[0], "idempotency-key"), "evt-idem-dedupe-shared");
  assert.equal(headerOf(calls[1], "idempotency-key"), "evt-idem-dedupe-shared");

  const dedupe = new PayoutEventDedupe();
  assert.equal(
    receive(bodyOf(calls[0]), signatureOf(calls[0]), dedupe, SECRET),
    "accepted",
  );
  assert.equal(
    receive(bodyOf(calls[1]), signatureOf(calls[1]), dedupe, SECRET),
    "duplicate",
  );
  assert.equal(dedupe.size, 1);
});
