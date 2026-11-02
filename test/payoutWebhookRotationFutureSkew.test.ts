import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Payout webhook secret rotation x future-skew tolerance (backlog #814).
 *
 * `verifyPayoutWebhook`'s `opts.secrets` (rotation) and
 * `opts.maxFutureSkewMs` (future tolerance) only ever met in separate
 * files: the rotation file never set a future window, and the
 * future-skew file never passed a secrets array. Nothing pinned
 * whether the two dimensions decide orthogonally — an in-flight
 * notification signed with the old secret and stamped slightly in
 * the future (sender clock ahead) during a rotation window.
 *
 * Rules pinned here:
 *  - an old-secret notification stamped inside the future window
 *    passes under `secrets: [new, old]`, in either list order
 *  - a new-secret notification stamped inside the future window
 *    passes under the same list
 *  - a notification stamped beyond the future window fails no
 *    matter which listed secret signed it — the window is not
 *    widened by rotation, and rotation is not widened by the window
 *  - the future boundary is inclusive for a rotated secret too:
 *    exactly `maxFutureSkewMs` ahead passes, 1ms further fails
 *  - an expired payload is still bounded by `maxAgeMs` when a
 *    future window is also set — the future window never frees
 *    an old payload — while a fresh rotated payload passes both
 *    bounds
 *  - the passes above are not vacuous: a wrong-secret list and a
 *    body tampered back into the window both fail inside the window
 */

const OLD_SECRET = "whsec_test_payout_rotation_old_20261102";
const NEW_SECRET = "whsec_test_payout_rotation_new_20261102";
const NOW = new Date("2026-11-02T10:00:00.000Z");
const ONE_HOUR = 3_600_000;

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

test("old secret + inside-window future stamp passes under rotation, either list order", () => {
  const task = toPaid("task-rot-skew-old");
  const { payload, signature } = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-skew-old",
    now: new Date(NOW.getTime() + 30 * 60_000),
  });
  const opts = { maxFutureSkewMs: ONE_HOUR, now: NOW };
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      ...opts,
    }),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(payload, signature, undefined, {
      secrets: [OLD_SECRET, NEW_SECRET],
      ...opts,
    }),
    true,
    "object body shape and old-first order also pass",
  );
});

test("new secret + inside-window future stamp passes under rotation", () => {
  const task = toPaid("task-rot-skew-new");
  const { payload, signature } = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-rot-skew-new",
    now: new Date(NOW.getTime() + 30 * 60_000),
  });
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
});

test("beyond-window future stamp fails under rotation whichever secret signed it", () => {
  const task = toPaid("task-rot-skew-beyond");
  const opts = { maxFutureSkewMs: ONE_HOUR, now: NOW };
  for (const [label, secret] of [
    ["old", OLD_SECRET],
    ["new", NEW_SECRET],
  ] as const) {
    const { payload, signature } = buildPayoutWebhook(task, secret, {
      eventId: `evt-rot-skew-beyond-${label}`,
      now: new Date(NOW.getTime() + 2 * ONE_HOUR),
    });
    // The signature itself is valid under rotation — only the
    // future-skew gate rejects it, for either secret.
    assert.equal(
      verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
      true,
      `${label}-secret signature alone verifies`,
    );
    assert.equal(
      verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
        secrets: [NEW_SECRET, OLD_SECRET],
        ...opts,
      }),
      false,
      `${label}-secret beyond-window stamp must fail`,
    );
  }
});

test("future boundary is inclusive for a rotated secret: exactly at it passes, 1ms past fails", () => {
  const task = toPaid("task-rot-skew-boundary");
  const atBoundary = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-skew-boundary",
    now: new Date(NOW.getTime() + ONE_HOUR),
  });
  assert.equal(
    verifyPayoutWebhook(atBoundary.payload, atBoundary.signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  const pastBoundary = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-skew-past-boundary",
    now: new Date(NOW.getTime() + ONE_HOUR + 1),
  });
  assert.equal(
    verifyPayoutWebhook(pastBoundary.payload, pastBoundary.signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
});

test("expired rotated payload is still bounded by maxAgeMs despite a future window", () => {
  const task = toPaid("task-rot-skew-expired");
  const stale = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-skew-expired",
    now: new Date(NOW.getTime() - 2 * ONE_HOUR),
  });
  assert.equal(
    verifyPayoutWebhook(stale.payload, stale.signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    true,
    "without maxAgeMs the future bound alone never rejects a past stamp",
  );
  assert.equal(
    verifyPayoutWebhook(stale.payload, stale.signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      maxAgeMs: ONE_HOUR,
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    false,
    "signature hit but past maxAgeMs still returns false with a future window set",
  );
  // A fresh rotated payload passes both bounds, so the failure above
  // is the age gate, not the combination itself.
  const fresh = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-skew-fresh",
    now: new Date(NOW.getTime() - 5 * 60_000),
  });
  assert.equal(
    verifyPayoutWebhook(fresh.payload, fresh.signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      maxAgeMs: ONE_HOUR,
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
});

test("inside-window passes are not vacuous: wrong secret and tampered body both fail", () => {
  const task = toPaid("task-rot-skew-vacuity");
  const { payload, signature } = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-skew-vacuity",
    now: new Date(NOW.getTime() + 30 * 60_000),
  });
  const opts = { maxFutureSkewMs: ONE_HOUR, now: NOW };
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
      secrets: [NEW_SECRET],
      ...opts,
    }),
    false,
    "old secret no longer listed: window closed, inside-window stamp still fails",
  );
  // Tampering `at` back to now cannot help: the attacker cannot
  // re-sign, so the signature check rejects the forged body.
  const forged = { ...payload, at: NOW.toISOString() };
  assert.equal(
    verifyPayoutWebhook(forged, signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      ...opts,
    }),
    false,
  );
});
