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
 * Payout webhook fan-out x `PayoutEventDedupe` x secret rotation
 * (backlog #756, the dataquest-side peer of escrow #755).
 *
 * The two halves exist separately and say nothing about the
 * combination: `payoutWebhookFanoutDedupe.test.ts` (#740) fans out
 * to 4 endpoints with one secret per endpoint and no rotation
 * candidate list, while `payoutWebhookFanoutRotation.test.ts`
 * (#697) fans out under a `[new, old]` candidate list but never
 * records anything in a dedupe. The gap this file closes: during a
 * rotation window, the SAME old-signed eventId delivered to several
 * endpoints must be verified under each receiver's `[new, old]`
 * candidate list and only then recorded in that receiver's own
 * `PayoutEventDedupe` — and after rotation, a new-signed copy of
 * the same eventId must still be a duplicate, because dedupe is
 * keyed by eventId, not by signature version. Rules under test,
 * with one independent `PayoutEventDedupe` per endpoint and the
 * documented receiver order (verify the raw wire body first,
 * `checkAndRecord` only after a `true` verification, collapsed
 * into a local `receive()` helper):
 *  - one fan-out of an old-signed eventId to 4 endpoints: every
 *    receiver verifies under `[new, old]` and accepts its copy as
 *    a first sighting, each dedupe at size 1
 *  - re-delivering each recorded wire body to its own endpoint
 *    reports duplicate on all four receivers, with hits/misses
 *    counting the flow per receiver
 *  - a tampered delivery to one endpoint verifies false, records
 *    nothing anywhere, and the true delivery to that endpoint is
 *    still a first sighting
 *  - after rotation, a new-signed copy of the SAME eventId is a
 *    duplicate on all four receivers, while a new-signed copy of a
 *    fresh eventId is still processed (the duplicate verdict comes
 *    from the eventId, not from the signature version)
 *  - a copy signed with an unrelated secret is rejected under
 *    `[new, old]`, records nothing, and the true old-signed
 *    delivery to that endpoint is still a first sighting
 */

const OLD_SECRET = "whsec_fanout_dedupe_rotation_old";
const NEW_SECRET = "whsec_fanout_dedupe_rotation_new";
const UNRELATED_SECRET = "whsec_fanout_dedupe_rotation_other";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const URL_C = "https://ledger.example.com/hooks/payout";
const URL_D = "https://audit.example.com/hooks/payout";
const NOW = new Date("2026-10-31T12:00:00.000Z");
const NOW_ISO = "2026-10-31T12:00:00.000Z";
const TAMPERED_ISO = "2026-10-31T12:00:01.000Z";

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-dedupe-rotation"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-dedupe-rotation-1",
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
 * The documented receiver order: verify the raw wire body first
 * under the rotation candidate list; only a verified delivery
 * reaches `checkAndRecord`. A rejected delivery never touches the
 * dedupe store.
 */
function receive(
  raw: string,
  signature: string,
  dedupe: PayoutEventDedupe,
): ReceiveOutcome {
  if (
    !verifyPayoutWebhook(raw, signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
    })
  ) {
    return "rejected";
  }
  const payload = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(payload.eventId) ? "duplicate" : "accepted";
}

const ENDPOINTS = [
  { url: URL_A, secret: OLD_SECRET },
  { url: URL_B, secret: OLD_SECRET },
  { url: URL_C, secret: OLD_SECRET },
  { url: URL_D, secret: OLD_SECRET },
];
const URLS = [URL_A, URL_B, URL_C, URL_D];

/** Fan out one old-signed eventId to all four endpoints. */
async function fanOutOldSigned(eventId: string): Promise<RecordedCall[]> {
  const { fetchImpl, callsTo } = recordingFetch();
  const out = await deliverPayoutWebhookToMany(paidTask(), ENDPOINTS, {
    fetchImpl,
    sleepImpl: async () => {},
    now: NOW,
    eventId,
  });
  assert.equal(out.delivered, 4);
  assert.equal(out.failed, 0);
  return URLS.map((url) => callsTo(url)[0]);
}

test("fan-out of an old-signed eventId: every receiver verifies under [new, old] and records a first sighting", async () => {
  const calls = await fanOutOldSigned("evt-fanout-dedupe-rotation-1");
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  for (let i = 0; i < 4; i++) {
    const raw = bodyOf(calls[i]);
    const sig = signatureOf(calls[i]);
    assert.equal(JSON.parse(raw).eventId, "evt-fanout-dedupe-rotation-1");
    // The old-signed copy verifies under the rotation list in
    // either candidate order; order is a preference, not a gate.
    assert.equal(
      verifyPayoutWebhook(raw, sig, undefined, {
        secrets: [OLD_SECRET, NEW_SECRET],
      }),
      true,
    );
    assert.equal(receive(raw, sig, dedupes[i]), "accepted");
    assert.equal(dedupes[i].size, 1);
    assert.deepEqual(dedupes[i].stats(), {
      size: 1,
      hits: 0,
      misses: 1,
      evictions: 0,
    });
  }
});

test("re-delivery of the old-signed copy is a duplicate on all four receivers", async () => {
  const calls = await fanOutOldSigned("evt-fanout-dedupe-rotation-2");
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  for (let i = 0; i < 4; i++) {
    const raw = bodyOf(calls[i]);
    const sig = signatureOf(calls[i]);
    assert.equal(receive(raw, sig, dedupes[i]), "accepted");
    assert.equal(receive(raw, sig, dedupes[i]), "duplicate");
    assert.deepEqual(dedupes[i].stats(), {
      size: 1,
      hits: 1,
      misses: 1,
      evictions: 0,
    });
  }
});

test("a tampered delivery records nothing and its true old-signed delivery is still first-seen", async () => {
  const calls = await fanOutOldSigned("evt-fanout-dedupe-rotation-tamper");
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  const rawC = bodyOf(calls[2]);
  const sigC = signatureOf(calls[2]);
  // Same eventId, one second moved on `at`: the bytes no longer match
  // the signature, but the eventId the receiver would record is intact.
  const tampered = rawC.replace(NOW_ISO, TAMPERED_ISO);
  assert.notEqual(tampered, rawC);
  assert.equal(
    verifyPayoutWebhook(tampered, sigC, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
    }),
    false,
  );
  assert.equal(receive(tampered, sigC, dedupes[2]), "rejected");
  assert.equal(dedupes[2].size, 0);
  // The forgery did not poison the store: the true delivery is first-seen.
  assert.equal(receive(rawC, sigC, dedupes[2]), "accepted");
  assert.equal(receive(rawC, sigC, dedupes[2]), "duplicate");
});

test("a new-signed copy of the same eventId is still a duplicate, while a fresh eventId is processed", async () => {
  const calls = await fanOutOldSigned("evt-fanout-dedupe-rotation-3");
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  for (let i = 0; i < 4; i++) {
    assert.equal(
      receive(bodyOf(calls[i]), signatureOf(calls[i]), dedupes[i]),
      "accepted",
    );
  }
  // After rotation the sender re-signs the SAME logical event with
  // the new secret. The payload bytes are identical (same eventId,
  // same `at`); only the signature changes. Dedupe is keyed by
  // eventId, so every receiver still reports duplicate.
  const task = paidTask();
  const { payload, signature } = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-fanout-dedupe-rotation-3",
    now: NOW,
  });
  const newRaw = JSON.stringify(payload);
  assert.equal(newRaw, bodyOf(calls[0]), "new-signed copy must share the payload bytes");
  for (let i = 0; i < 4; i++) {
    assert.equal(
      verifyPayoutWebhook(newRaw, signature, undefined, {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
      true,
    );
    assert.equal(receive(newRaw, signature, dedupes[i]), "duplicate");
    assert.equal(dedupes[i].size, 1);
  }
  // A genuinely fresh event, new-signed, is still processed everywhere.
  const fresh = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-fanout-dedupe-rotation-fresh",
    now: NOW,
  });
  const freshRaw = JSON.stringify(fresh.payload);
  for (let i = 0; i < 4; i++) {
    assert.equal(receive(freshRaw, fresh.signature, dedupes[i]), "accepted");
    assert.equal(dedupes[i].size, 2);
  }
});

test("an unrelated-secret copy is rejected and the true old-signed delivery is still first-seen", async () => {
  const calls = await fanOutOldSigned("evt-fanout-dedupe-rotation-cross");
  const dedupeB = new PayoutEventDedupe();
  const task = paidTask();
  const { payload, signature } = buildPayoutWebhook(task, UNRELATED_SECRET, {
    eventId: "evt-fanout-dedupe-rotation-cross",
    now: NOW,
  });
  const foreignRaw = JSON.stringify(payload);
  assert.equal(
    verifyPayoutWebhook(foreignRaw, signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
    }),
    false,
  );
  assert.equal(receive(foreignRaw, signature, dedupeB), "rejected");
  assert.equal(dedupeB.size, 0);
  // The rejected forgery did not poison the store: B's true
  // old-signed delivery is still a first sighting.
  const [callB] = [calls[1]];
  assert.equal(
    receive(bodyOf(callB), signatureOf(callB), dedupeB),
    "accepted",
  );
});
