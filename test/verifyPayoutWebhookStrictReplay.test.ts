import test from "node:test";
import assert from "node:assert/strict";
import {
  PayoutEventDedupe,
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
  verifyPayoutWebhookStrict,
} from "../src/index.js";

/**
 * End-to-end replay rejection for `verifyPayoutWebhookStrict`
 * (backlog #1456): the strict entry point's real job is to make a
 * captured webhook un-replayable, and the unit-level age-boundary
 * tests in `verifyPayoutWebhookStrict.test.ts` never show that job
 * being done against a whole intercepted delivery. Rules under test:
 *
 *  - the documented receiver pipeline — strict-verify first, then
 *    `PayoutEventDedupe.checkAndRecord(eventId)` — is what stops a
 *    replay. The two layers split the work: strict bounds the replay
 *    window to 5 minutes (a signature has no expiry, so without the
 *    age gate a captured body would verify forever), and inside that
 *    window the dedupe store is what catches the byte-identical
 *    re-delivery — strict alone still returns `true` for it, so a
 *    receiver that verifies but never deduplicates pays twice.
 *  - the same legitimately-signed bytes replayed past the 5-minute
 *    age window are rejected by strict (`false`); the signature is
 *    still valid — the legacy `verifyPayoutWebhook` still returns
 *    `true` — so only the age gate rejects, and the replay never
 *    reaches the dedupe store (no second record, no hit counted).
 *    At exactly 5 minutes old the replay still verifies (inclusive
 *    boundary) and is caught by the dedupe store instead.
 *  - an intercepted body re-keyed with a fresh `eventId` — the
 *    obvious dodge around the dedupe store — fails the signature
 *    check (strict and legacy alike return `false`): the `eventId`
 *    is inside the signed payload, so re-keying invalidates the
 *    signature, and the forged key is never recorded, so the
 *    genuine delivery afterwards is not mistaken for a duplicate.
 *  - an intercepted stale body with its `at` rewritten to look
 *    fresh fails the same way: the timestamp is inside the signed
 *    payload, so the age gate cannot be bypassed by editing it.
 *
 * No `src/` change: these tests pin the intended end-to-end
 * behaviour of the existing strict entry point and dedupe store.
 */

const SECRET = "whsec_test_strict_replay_20261128";
const NOW = Date.parse("2026-11-28T10:00:00.000Z");
const FIVE_MINUTES = 300_000;
const ONE_HOUR = 3_600_000;
const EVENT_ID = "evt-strict-replay";

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(id: string): TaskLifecycle {
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
    payoutRef: "xfer-strict-replay",
    payoutAmount: 10098.5,
  });
  assert.equal(t.state, "PAID");
  return t;
}

/** A legitimately-signed webhook built at a fixed time, as raw bytes. */
function intercepted(builtAtMs: number): {
  bodyString: string;
  signature: string;
} {
  const task = toPaid(`task-strict-replay-${builtAtMs}`);
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    now: new Date(builtAtMs),
    eventId: EVENT_ID,
  });
  return { bodyString: JSON.stringify(payload), signature };
}

function fakeClock(start: number) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * The documented receiver pipeline: strict-verify the raw bytes
 * first (a rejection never touches the dedupe store), then record
 * the `eventId`. Returns "rejected" | "accepted" | "duplicate".
 */
function receive(
  dedupe: PayoutEventDedupe,
  bodyString: string,
  signature: string,
  nowMs: number,
): "rejected" | "accepted" | "duplicate" {
  const verified = verifyPayoutWebhookStrict(bodyString, signature, SECRET, {
    now: new Date(nowMs),
  });
  if (!verified) return "rejected";
  const parsed = JSON.parse(bodyString) as { eventId: string };
  return dedupe.checkAndRecord(parsed.eventId) ? "duplicate" : "accepted";
}

test("replay: first delivery accepted, identical re-delivery inside the window is a dedupe duplicate", () => {
  const clock = fakeClock(NOW);
  const dedupe = new PayoutEventDedupe({ ttlMs: ONE_HOUR, now: clock.now });
  const { bodyString, signature } = intercepted(NOW);

  assert.equal(receive(dedupe, bodyString, signature, NOW), "accepted");
  assert.equal(dedupe.size, 1);

  // One minute later the same bytes still verify — strict alone
  // would let them through again — but the dedupe store catches
  // the re-delivery, so the payout is not processed twice.
  clock.advance(60_000);
  assert.equal(
    verifyPayoutWebhookStrict(bodyString, signature, SECRET, {
      now: new Date(NOW + 60_000),
    }),
    true,
  );
  assert.equal(
    receive(dedupe, bodyString, signature, NOW + 60_000),
    "duplicate",
  );
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("replay: the same signed bytes past the 5-minute age window are rejected by strict", () => {
  const clock = fakeClock(NOW);
  const dedupe = new PayoutEventDedupe({ ttlMs: ONE_HOUR, now: clock.now });
  const { bodyString, signature } = intercepted(NOW);

  assert.equal(receive(dedupe, bodyString, signature, NOW), "accepted");

  // Past the window the replay is refused before it ever reaches
  // the dedupe store: no second record, no hit counted.
  assert.equal(
    receive(dedupe, bodyString, signature, NOW + FIVE_MINUTES + 1),
    "rejected",
  );
  assert.equal(dedupe.size, 1);
  assert.equal(dedupe.stats().hits, 0);
  // The signature itself is still valid — only the strict age gate
  // rejects the replay (the MAX_AGE class of rejection).
  assert.equal(verifyPayoutWebhook(bodyString, signature, SECRET), true);
  // The object form is rejected the same way.
  const parsed = JSON.parse(bodyString) as Parameters<
    typeof verifyPayoutWebhookStrict
  >[0];
  assert.equal(
    verifyPayoutWebhookStrict(parsed, signature, SECRET, {
      now: new Date(NOW + FIVE_MINUTES + 1),
    }),
    false,
  );
});

test("replay: at exactly 5 minutes old the replay still verifies and is caught by dedupe instead", () => {
  const clock = fakeClock(NOW);
  const dedupe = new PayoutEventDedupe({ ttlMs: ONE_HOUR, now: clock.now });
  const { bodyString, signature } = intercepted(NOW);

  assert.equal(receive(dedupe, bodyString, signature, NOW), "accepted");
  // Inclusive boundary: exactly 5 minutes old still verifies, so
  // the dedupe store — not the age gate — is what stops this replay.
  assert.equal(
    verifyPayoutWebhookStrict(bodyString, signature, SECRET, {
      now: new Date(NOW + FIVE_MINUTES),
    }),
    true,
  );
  assert.equal(
    receive(dedupe, bodyString, signature, NOW + FIVE_MINUTES),
    "duplicate",
  );
});

test("replay: an intercepted body re-keyed with a fresh eventId fails the signature", () => {
  const clock = fakeClock(NOW);
  const dedupe = new PayoutEventDedupe({ ttlMs: ONE_HOUR, now: clock.now });
  const { bodyString, signature } = intercepted(NOW);

  assert.equal(receive(dedupe, bodyString, signature, NOW), "accepted");

  // The attacker swaps in a fresh eventId to dodge the dedupe
  // store — but the eventId is inside the signed payload, so the
  // re-keyed body no longer matches its signature.
  const tampered = JSON.stringify({
    ...JSON.parse(bodyString),
    eventId: "evt-attacker-rekeyed",
  });
  assert.equal(
    verifyPayoutWebhookStrict(tampered, signature, SECRET, {
      now: new Date(NOW),
    }),
    false,
  );
  assert.equal(verifyPayoutWebhook(tampered, signature, SECRET), false);
  assert.equal(receive(dedupe, tampered, signature, NOW), "rejected");
  // The forged key was never recorded: `has` reads false, and the
  // genuine eventId still has exactly its one record.
  assert.equal(dedupe.has("evt-attacker-rekeyed"), false);
  assert.equal(dedupe.has(EVENT_ID), true);
  assert.equal(dedupe.size, 1);
});

test("replay: an intercepted stale body with `at` rewritten to look fresh fails the signature", () => {
  const clock = fakeClock(NOW);
  const dedupe = new PayoutEventDedupe({ ttlMs: ONE_HOUR, now: clock.now });
  // A 10-minute-old delivery, intercepted and re-presented with
  // its timestamp edited forward to NOW to slip past the age gate.
  const { bodyString, signature } = intercepted(NOW - 10 * 60_000);
  const refreshed = JSON.stringify({
    ...JSON.parse(bodyString),
    at: new Date(NOW).toISOString(),
  });
  // The timestamp is inside the signed payload, so editing it
  // invalidates the signature — the age gate cannot be bypassed
  // by rewriting `at`, and the replay is rejected outright.
  assert.equal(
    verifyPayoutWebhookStrict(refreshed, signature, SECRET, {
      now: new Date(NOW),
    }),
    false,
  );
  assert.equal(verifyPayoutWebhook(refreshed, signature, SECRET), false);
  assert.equal(receive(dedupe, refreshed, signature, NOW), "rejected");
  assert.equal(dedupe.has(EVENT_ID), false);
  assert.equal(dedupe.size, 0);
});
