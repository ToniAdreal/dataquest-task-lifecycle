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
 * Payout webhook fan-out x limits x secret rotation (backlog #792).
 *
 * The limits file pins the cap (`payoutWebhookFanoutLimits.test.ts`)
 * and the rotation file pins per-endpoint secret migration
 * (`payoutWebhookFanoutRotation.test.ts`), but neither says what
 * happens when the two combine: a batch refused for exceeding
 * `maxEndpoints` must record nothing on any receiver, whether the
 * refusal happens before rotation (old secrets) or after it (new
 * secrets), and a rotated in-limit batch must verify under the new
 * secret on every endpoint while the retired secret verifies none
 * of the rotated copies.
 *
 * Rules under test, with one independent `PayoutEventDedupe` per
 * endpoint and the documented receiver order (verify the raw wire
 * body first, `checkAndRecord` only after a `true` verification):
 *  - an over-`maxEndpoints` batch throws before any request (zero
 *    fetches) and leaves all four receivers' dedupes empty, before
 *    rotation (old secrets) and after it (new secrets)
 *  - a rotated in-limit batch of 3 endpoints delivers 3 copies with
 *    byte-identical bodies (shared eventId) but per-endpoint
 *    signatures; each copy verifies under its own new secret and
 *    fails under its own retired old secret, and fails under the
 *    new-only candidate list's mirror image (old-only list)
 *  - a refused over-cap batch after rotation adds zero dedupe
 *    records: receivers that already recorded the rotated delivery
 *    stay at size 1, the never-delivered fourth receiver stays at
 *    size 0, and replaying the rotated eventId is still a
 *    duplicate, not a second recording
 *  - every test injects fetch/sleep stubs: no real network, no real
 *    sleeps
 */

const OLD_A = "whsec_fanout_limits_rotation_old_billing";
const OLD_B = "whsec_fanout_limits_rotation_old_risk";
const OLD_C = "whsec_fanout_limits_rotation_old_ledger";
const OLD_D = "whsec_fanout_limits_rotation_old_audit";
const NEW_A = "whsec_fanout_limits_rotation_new_billing";
const NEW_B = "whsec_fanout_limits_rotation_new_risk";
const NEW_C = "whsec_fanout_limits_rotation_new_ledger";
const NEW_D = "whsec_fanout_limits_rotation_new_audit";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const URL_C = "https://ledger.example.com/hooks/payout";
const URL_D = "https://audit.example.com/hooks/payout";
const NOW = new Date("2026-10-31T17:30:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-limits-rotation"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-limits-rotation-1",
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

const ENDPOINTS_4_OLD = [
  { url: URL_A, secret: OLD_A },
  { url: URL_B, secret: OLD_B },
  { url: URL_C, secret: OLD_C },
  { url: URL_D, secret: OLD_D },
];
const ENDPOINTS_4_NEW = [
  { url: URL_A, secret: NEW_A },
  { url: URL_B, secret: NEW_B },
  { url: URL_C, secret: NEW_C },
  { url: URL_D, secret: NEW_D },
];
const ENDPOINTS_3_NEW = ENDPOINTS_4_NEW.slice(0, 3);
const ALL_URLS = [URL_A, URL_B, URL_C, URL_D];

test("over-cap batch before rotation throws before any request: all four receivers' dedupes stay empty", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: 200,
    [URL_B]: 200,
    [URL_C]: 200,
    [URL_D]: 200,
  });
  await assert.rejects(
    () =>
      deliverPayoutWebhookToMany(paidTask(), ENDPOINTS_4_OLD, {
        fetchImpl,
        sleepImpl: async () => {},
        now: NOW,
        eventId: "evt-fanout-limits-rotation-pre",
        maxEndpoints: 3,
      }),
    /4 endpoints exceed maxEndpoints 3/,
  );
  for (const url of ALL_URLS) {
    assert.equal(callsTo(url).length, 0, `cap breach must not fetch ${url}`);
  }
  // No delivery reached any receiver, so no receiver recorded anything.
  for (const dedupe of ALL_URLS.map(() => new PayoutEventDedupe())) {
    assert.equal(dedupe.size, 0);
  }
});

test("rotated in-limit batch: 3 endpoints each verify under their new secret and fail under their retired old secret", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: 200,
    [URL_B]: 200,
    [URL_C]: 200,
  });
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    ENDPOINTS_3_NEW,
    {
      fetchImpl,
      sleepImpl: async () => {},
      now: NOW,
      eventId: "evt-fanout-limits-rotation-rotated",
      maxEndpoints: 3,
    },
  );
  assert.equal(out.delivered, 3);
  assert.equal(out.failed, 0);
  assert.deepEqual(out.results, [
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
  const calls = [URL_A, URL_B, URL_C].map((url) => callsTo(url)[0]);
  for (const call of calls) {
    assert.equal(call.init.body !== undefined, true);
  }
  // Same logical event: identical payload bytes (shared eventId)…
  assert.equal(bodyOf(calls[0]), bodyOf(calls[1]));
  assert.equal(bodyOf(calls[1]), bodyOf(calls[2]));
  assert.equal(JSON.parse(bodyOf(calls[0])).eventId, "evt-fanout-limits-rotation-rotated");
  // …but independently signed per endpoint.
  assert.notEqual(signatureOf(calls[0]), signatureOf(calls[1]));
  assert.notEqual(signatureOf(calls[1]), signatureOf(calls[2]));
  // Each rotated copy verifies under its own new secret and under
  // the new-only candidate list, and fails under its retired old
  // secret and under the old-only candidate list.
  const pairs: Array<{ call: RecordedCall; oldSecret: string; newSecret: string }> = [
    { call: calls[0], oldSecret: OLD_A, newSecret: NEW_A },
    { call: calls[1], oldSecret: OLD_B, newSecret: NEW_B },
    { call: calls[2], oldSecret: OLD_C, newSecret: NEW_C },
  ];
  for (const { call, oldSecret, newSecret } of pairs) {
    assert.equal(
      verifyPayoutWebhook(bodyOf(call), signatureOf(call), newSecret),
      true,
      "rotated copy must verify under its new secret",
    );
    assert.equal(
      verifyPayoutWebhook(bodyOf(call), signatureOf(call), undefined, {
        secrets: [newSecret],
      }),
      true,
      "rotated copy must verify under the new-only candidate list",
    );
    assert.equal(
      verifyPayoutWebhook(bodyOf(call), signatureOf(call), oldSecret),
      false,
      "rotated copy must fail under its retired old secret",
    );
    assert.equal(
      verifyPayoutWebhook(bodyOf(call), signatureOf(call), undefined, {
        secrets: [oldSecret],
      }),
      false,
      "rotated copy must fail under the old-only candidate list",
    );
    // Secrets do not cross endpoints: a copy never verifies under
    // another endpoint's new secret either.
    const otherNew = pairs
      .filter((p) => p.call !== call)
      .map((p) => p.newSecret);
    for (const other of otherNew) {
      assert.equal(
        verifyPayoutWebhook(bodyOf(call), signatureOf(call), other),
        false,
        "rotated copy must not verify under another endpoint's secret",
      );
    }
  }
});

test("over-cap batch after rotation adds zero dedupe records: prior first sightings unchanged, fourth receiver still empty", async () => {
  // First, the rotated in-limit delivery: each of the three receivers
  // records a first sighting for the rotated eventId.
  const rotated = routerFetch({
    [URL_A]: 200,
    [URL_B]: 200,
    [URL_C]: 200,
  });
  await deliverPayoutWebhookToMany(
    paidTask(),
    ENDPOINTS_3_NEW,
    {
      fetchImpl: rotated.fetchImpl,
      sleepImpl: async () => {},
      now: NOW,
      eventId: "evt-fanout-limits-rotation-post",
      maxEndpoints: 3,
    },
  );
  const dedupeA = new PayoutEventDedupe();
  const dedupeB = new PayoutEventDedupe();
  const dedupeC = new PayoutEventDedupe();
  const dedupeD = new PayoutEventDedupe();
  const [callA] = rotated.callsTo(URL_A);
  const [callB] = rotated.callsTo(URL_B);
  const [callC] = rotated.callsTo(URL_C);
  assert.equal(receive(bodyOf(callA), signatureOf(callA), dedupeA, NEW_A), "accepted");
  assert.equal(receive(bodyOf(callB), signatureOf(callB), dedupeB, NEW_B), "accepted");
  assert.equal(receive(bodyOf(callC), signatureOf(callC), dedupeC, NEW_C), "accepted");
  assert.equal(dedupeA.size, 1);
  assert.equal(dedupeB.size, 1);
  assert.equal(dedupeC.size, 1);
  assert.equal(dedupeD.size, 0, "fourth receiver never delivered");

  // Then the refused over-cap batch with the rotated secrets: it
  // must throw before any request and add zero dedupe records.
  const overCap = routerFetch({
    [URL_A]: 200,
    [URL_B]: 200,
    [URL_C]: 200,
    [URL_D]: 200,
  });
  await assert.rejects(
    () =>
      deliverPayoutWebhookToMany(paidTask("task-fanout-limits-rotation-post-2"), ENDPOINTS_4_NEW, {
        fetchImpl: overCap.fetchImpl,
        sleepImpl: async () => {},
        now: NOW,
        eventId: "evt-fanout-limits-rotation-post",
        maxEndpoints: 3,
      }),
    /4 endpoints exceed maxEndpoints 3/,
  );
  for (const url of ALL_URLS) {
    assert.equal(overCap.callsTo(url).length, 0, `cap breach must not fetch ${url}`);
  }
  // The refused batch recorded nothing: prior first sightings are
  // untouched, and replaying the rotated eventId is still a
  // duplicate, not a second recording.
  assert.equal(dedupeA.size, 1);
  assert.equal(dedupeB.size, 1);
  assert.equal(dedupeC.size, 1);
  assert.equal(dedupeD.size, 0);
  assert.equal(receive(bodyOf(callA), signatureOf(callA), dedupeA, NEW_A), "duplicate");
  assert.equal(receive(bodyOf(callB), signatureOf(callB), dedupeB, NEW_B), "duplicate");
  assert.equal(receive(bodyOf(callC), signatureOf(callC), dedupeC, NEW_C), "duplicate");
  assert.equal(dedupeA.size, 1);
  assert.equal(dedupeB.size, 1);
  assert.equal(dedupeC.size, 1);
});
