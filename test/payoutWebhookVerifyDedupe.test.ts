import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";

/**
 * Payout webhook receiver flow: `verifyPayoutWebhook` -> `PayoutEventDedupe`
 * (backlog #726, the dataquest-side peer of escrow #725).
 *
 * The dedupe docs require receivers to verify first and only then record
 * the `eventId` — verify-then-record, never record-then-verify — because
 * recording before verification would let a forged payload poison the
 * dedupe store and turn the real delivery into a "duplicate". Rules
 * under test, via the documented receiver snippet collapsed into a
 * local `receive()` helper (raw wire body first, signature second,
 * `checkAndRecord` only after a `true` verification):
 *  - a first verified delivery is accepted (first sighting) and its
 *    verified re-delivery is still verified-true but reported duplicate,
 *    with the dedupe size unchanged and hits/misses counting the flow
 *  - a tampered-body delivery verifies false and records nothing, so
 *    the same eventId's true delivery afterwards is still a first
 *    sighting (not a duplicate poisoned by the forgery)
 *  - a forged delivery carrying an already-seen eventId is rejected and
 *    leaves the dedupe stats untouched; a true re-delivery of the same
 *    bytes still reports duplicate
 *  - after the TTL boundary the same eventId counts as unseen again
 *    (boundary: age exactly `ttlMs` is expired, per the dedupe docs)
 *  - inside a rotation window, an old-signed delivery verifies and is
 *    deduplicated exactly like a new-signed one: an old-signed repeat
 *    and a new-signed delivery of the same eventId are both duplicates
 *  - an all-mismatch candidate pair verifies false and records nothing,
 *    and the same eventId's correctly-signed delivery is then a first
 *    sighting
 *  - honest deviation from the backlog wording: an empty `secrets`
 *    array does NOT return false — it throws a caller configuration
 *    error (`secrets must be a non-empty array`), exactly as the
 *    single-secret empty-secret case throws. The fail-closed conclusion
 *    is identical (nothing is ever verified, nothing is recorded);
 *    the test pins the real throwing behaviour, as escrow #725 did
 *    for the same wording on its side.
 */

const SECRET = "dataquest-verify-dedupe-secret";
const OLD_SECRET = "dataquest-verify-dedupe-old-secret";
const NEW_SECRET = "dataquest-verify-dedupe-new-secret";
const NOW = new Date("2026-10-09T10:00:00.000Z");
const NOW_ISO = "2026-10-09T10:00:00.000Z";
const TAMPERED_ISO = "2026-10-09T10:00:01.000Z";
const TTL = 60_000;

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
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(t.state, "PAID");
  return t;
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
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
  secret: string | undefined,
  secrets?: (string | Buffer)[],
): ReceiveOutcome {
  const verified =
    secrets !== undefined
      ? verifyPayoutWebhook(raw, signature, undefined, { secrets })
      : verifyPayoutWebhook(raw, signature, secret);
  if (!verified) return "rejected";
  const payload = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(payload.eventId) ? "duplicate" : "accepted";
}

test("first verified delivery is accepted, its verified re-delivery is a duplicate", () => {
  const task = toPaid("task-verify-dedupe-first");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-verify-dedupe-first",
    now: NOW,
  });
  const raw = JSON.stringify(payload);
  const dedupe = new PayoutEventDedupe();
  assert.equal(receive(raw, signature, dedupe, SECRET), "accepted");
  assert.equal(dedupe.size, 1);
  // The re-delivery still verifies true — only the dedupe verdict flips.
  assert.equal(verifyPayoutWebhook(raw, signature, SECRET), true);
  assert.equal(receive(raw, signature, dedupe, SECRET), "duplicate");
  assert.equal(dedupe.size, 1);
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("a tampered body is rejected and records nothing, so the true delivery is still first-seen", () => {
  const task = toPaid("task-verify-dedupe-tamper");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-verify-dedupe-tamper",
    now: NOW,
  });
  const raw = JSON.stringify(payload);
  // Same eventId, one second moved on `at`: the bytes no longer match
  // the signature, but the eventId the receiver would record is intact.
  const tampered = raw.replace(NOW_ISO, TAMPERED_ISO);
  assert.notEqual(tampered, raw);
  const dedupe = new PayoutEventDedupe();
  assert.equal(verifyPayoutWebhook(tampered, signature, SECRET), false);
  assert.equal(receive(tampered, signature, dedupe, SECRET), "rejected");
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  // The forgery did not poison the store: the true delivery is first-seen.
  assert.equal(receive(raw, signature, dedupe, SECRET), "accepted");
  assert.equal(receive(raw, signature, dedupe, SECRET), "duplicate");
});

test("a forged delivery for an already-seen eventId is rejected and leaves stats untouched", () => {
  const task = toPaid("task-verify-dedupe-forged");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-verify-dedupe-forged",
    now: NOW,
  });
  const raw = JSON.stringify(payload);
  const dedupe = new PayoutEventDedupe();
  assert.equal(receive(raw, signature, dedupe, SECRET), "accepted");
  const before = dedupe.stats();
  // Wrong secret, same eventId bytes: verification fails, dedupe untouched.
  assert.equal(verifyPayoutWebhook(raw, signature, "unrelated-secret"), false);
  assert.equal(
    receive(raw, signature, dedupe, "unrelated-secret"),
    "rejected",
  );
  assert.deepEqual(dedupe.stats(), before);
  // The true bytes still report duplicate — the forgery changed nothing.
  assert.equal(receive(raw, signature, dedupe, SECRET), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("after the TTL boundary the same eventId is first-seen again", () => {
  const clock = fakeClock();
  const task = toPaid("task-verify-dedupe-ttl");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-verify-dedupe-ttl",
    now: NOW,
  });
  const raw = JSON.stringify(payload);
  const dedupe = new PayoutEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(receive(raw, signature, dedupe, SECRET), "accepted");
  assert.equal(receive(raw, signature, dedupe, SECRET), "duplicate");
  clock.advance(TTL - 1);
  assert.equal(receive(raw, signature, dedupe, SECRET), "duplicate");
  clock.advance(1);
  // Age exactly TTL: expired, so the same verified delivery is accepted.
  assert.equal(receive(raw, signature, dedupe, SECRET), "accepted");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 2,
    misses: 2,
    evictions: 0,
  });
});

test("rotation-window old-signed delivery is deduplicated like a new-signed one", () => {
  const task = toPaid("task-verify-dedupe-rotation");
  const oldSigned = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-verify-dedupe-rotation",
    now: NOW,
  });
  const newSigned = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-verify-dedupe-rotation",
    now: NOW,
  });
  const oldRaw = JSON.stringify(oldSigned.payload);
  const newRaw = JSON.stringify(newSigned.payload);
  const dedupe = new PayoutEventDedupe();
  const secrets = [NEW_SECRET, OLD_SECRET];
  assert.equal(
    receive(oldRaw, oldSigned.signature, dedupe, undefined, secrets),
    "accepted",
  );
  // Old-signed repeat: verified true, dedupe duplicate.
  assert.equal(
    receive(oldRaw, oldSigned.signature, dedupe, undefined, secrets),
    "duplicate",
  );
  // Same logical event re-signed with the new secret: still a duplicate.
  assert.equal(
    receive(newRaw, newSigned.signature, dedupe, undefined, secrets),
    "duplicate",
  );
  assert.equal(dedupe.size, 1);
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 2,
    misses: 1,
    evictions: 0,
  });
});

test("all-mismatch candidate pair verifies false and records nothing", () => {
  const task = toPaid("task-verify-dedupe-mismatch");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-verify-dedupe-mismatch",
    now: NOW,
  });
  const raw = JSON.stringify(payload);
  const dedupe = new PayoutEventDedupe();
  const wrong = ["wrong-new-secret", "wrong-old-secret"];
  assert.equal(
    verifyPayoutWebhook(raw, signature, undefined, { secrets: wrong }),
    false,
  );
  assert.equal(
    receive(raw, signature, dedupe, undefined, wrong),
    "rejected",
  );
  assert.equal(dedupe.size, 0);
  // The correctly-signed delivery afterwards is still a first sighting.
  assert.equal(receive(raw, signature, dedupe, SECRET), "accepted");
});

test("an empty secrets array throws a configuration error and records nothing", () => {
  const task = toPaid("task-verify-dedupe-empty");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-verify-dedupe-empty",
    now: NOW,
  });
  const raw = JSON.stringify(payload);
  const dedupe = new PayoutEventDedupe();
  assert.throws(
    () => verifyPayoutWebhook(raw, signature, undefined, { secrets: [] }),
    /secrets must be a non-empty array/,
  );
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
});
