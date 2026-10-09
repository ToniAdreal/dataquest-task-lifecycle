import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Payout webhook multi-secret rotation verification (backlog #139): the
 * dataquest-side peer of escrow's `verifySettlementWebhook` secrets array
 * (#81).
 *
 * Rules under test:
 *  - `verifyPayoutWebhook(body, signature, undefined, { secrets })`
 *    accepts a notification signed with ANY candidate secret, so an
 *    in-flight notification signed with the old secret still verifies
 *    during the rotation window, and one signed with the new secret
 *    verifies as soon as it is listed
 *  - an unrelated secret fails closed as `false`
 *  - the single-secret legacy call shape is unchanged
 *  - positional `secret` and `opts.secrets` are mutually exclusive
 *    (both → configuration error); neither → configuration error
 *  - an empty `secrets` array, a non-array value, or an array containing
 *    an empty secret is a configuration error, never a silent pass
 *  - `maxAgeMs` freshness is enforced AFTER a rotation match exactly as
 *    in the single-secret shape — rotation does not widen replay bounds
 *  - `buildPayoutWebhook` is unchanged: it always signs with the single
 *    current secret it is given
 */

const OLD_SECRET = "old-s3cr3t";
const NEW_SECRET = "new-s3cr3t";
const NOW = new Date("2026-10-09T10:00:00.000Z");
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

test("notification signed with the new secret passes under { secrets: [new, old] }", () => {
  const task = toPaid("task-rot-new");
  const { payload, signature } = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-rot-new",
    now: NOW,
  });
  const raw = JSON.stringify(payload);
  assert.equal(
    verifyPayoutWebhook(raw, signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
    }),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(payload, signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
    }),
    true,
    "object body shape also verifies",
  );
});

test("notification signed with the old secret still passes inside the window", () => {
  const task = toPaid("task-rot-old");
  const { payload, signature } = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-old",
    now: NOW,
  });
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
    }),
    true,
  );
  // Order is a performance preference only: old-first also passes, and a
  // single-element secrets array behaves like the single-secret shape.
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
      secrets: [OLD_SECRET, NEW_SECRET],
    }),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
      secrets: [OLD_SECRET],
    }),
    true,
  );
});

test("unrelated secret fails closed under rotation", () => {
  const task = toPaid("task-rot-unrelated");
  const { payload, signature } = buildPayoutWebhook(task, "someone-elses-secret", {
    eventId: "evt-rot-unrelated",
    now: NOW,
  });
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
    }),
    false,
  );
  // And a payload signed with a listed secret fails against a list that
  // no longer contains it (window closed).
  const current = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-closed",
    now: NOW,
  });
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(current.payload), current.signature, undefined, {
      secrets: [NEW_SECRET],
    }),
    false,
  );
});

test("single-secret legacy call shape is unchanged", () => {
  const task = toPaid("task-rot-legacy");
  const { payload, signature } = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-legacy",
    now: NOW,
  });
  const raw = JSON.stringify(payload);
  assert.equal(verifyPayoutWebhook(raw, signature, OLD_SECRET), true);
  assert.equal(verifyPayoutWebhook(raw, signature, OLD_SECRET, {}), true);
  assert.equal(verifyPayoutWebhook(raw, signature, NEW_SECRET), false);
  assert.equal(
    verifyPayoutWebhook(raw, signature, OLD_SECRET, {
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
    "legacy shape still composes with the freshness window",
  );
});

test("positional secret and secrets together throw a configuration error", () => {
  const task = toPaid("task-rot-both");
  const { payload, signature } = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-rot-both",
    now: NOW,
  });
  assert.throws(
    () =>
      verifyPayoutWebhook(JSON.stringify(payload), signature, NEW_SECRET, {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
    /cannot verify payout webhook: pass either 'secret' or 'secrets', not both/,
  );
  // Even an empty-string positional secret counts as "given" for the
  // mutual-exclusion check (it is not undefined).
  assert.throws(
    () =>
      verifyPayoutWebhook(JSON.stringify(payload), signature, "", {
        secrets: [NEW_SECRET],
      }),
    /pass either 'secret' or 'secrets', not both/,
  );
});

test("empty secrets array and empty entries throw configuration errors", () => {
  const task = toPaid("task-rot-empty");
  const { payload, signature } = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-rot-empty",
    now: NOW,
  });
  const raw = JSON.stringify(payload);
  assert.throws(
    () => verifyPayoutWebhook(raw, signature, undefined, { secrets: [] }),
    /cannot verify payout webhook: secrets must be a non-empty array/,
  );
  assert.throws(
    () =>
      verifyPayoutWebhook(raw, signature, undefined, {
        secrets: [NEW_SECRET, ""],
      }),
    /cannot verify payout webhook: secrets\[1\] must not be empty/,
  );
  assert.throws(
    () =>
      verifyPayoutWebhook(raw, signature, undefined, {
        secrets: [Buffer.alloc(0)],
      }),
    /cannot verify payout webhook: secrets\[0\] must not be empty/,
  );
  assert.throws(
    () =>
      verifyPayoutWebhook(raw, signature, undefined, {
        secrets: "not-an-array" as unknown as (string | Buffer)[],
      }),
    /cannot verify payout webhook: secrets must be a non-empty array/,
  );
});

test("neither secret nor secrets throws a configuration error", () => {
  const task = toPaid("task-rot-neither");
  const { payload, signature } = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-rot-neither",
    now: NOW,
  });
  assert.throws(
    () => verifyPayoutWebhook(JSON.stringify(payload), signature, undefined),
    /cannot verify payout webhook: a signing secret is required/,
  );
  assert.throws(
    () => verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {}),
    /cannot verify payout webhook: a signing secret is required/,
  );
});

test("rotation match still enforces maxAgeMs freshness afterwards", () => {
  const task = toPaid("task-rot-fresh");
  // Signed with the OLD secret two hours ago: cryptographically valid
  // under rotation, but stale — rotation must not widen the replay bound.
  const stale = buildPayoutWebhook(task, OLD_SECRET, {
    eventId: "evt-rot-stale",
    now: new Date(NOW.getTime() - 2 * ONE_HOUR),
  });
  assert.equal(
    verifyPayoutWebhook(stale.payload, stale.signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
    }),
    true,
    "without maxAgeMs the rotated signature alone decides",
  );
  assert.equal(
    verifyPayoutWebhook(stale.payload, stale.signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
    "signature hit but past maxAgeMs still returns false",
  );
  // A fresh notification signed with either secret passes both gates.
  const fresh = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-rot-fresh",
    now: new Date(NOW.getTime() - 5 * 60_000),
  });
  assert.equal(
    verifyPayoutWebhook(fresh.payload, fresh.signature, undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
});

test("Buffer secrets work inside the rotation array", () => {
  const task = toPaid("task-rot-buffer");
  const { payload, signature } = buildPayoutWebhook(task, Buffer.from(OLD_SECRET), {
    eventId: "evt-rot-buffer",
    now: NOW,
  });
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
      secrets: [Buffer.from(NEW_SECRET), Buffer.from(OLD_SECRET)],
    }),
    true,
  );
  // Mixed string/Buffer candidates are accepted too.
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, undefined, {
      secrets: [NEW_SECRET, Buffer.from(OLD_SECRET)],
    }),
    true,
  );
});

test("malformed signatures fail closed under rotation, never throw", () => {
  const task = toPaid("task-rot-malformed");
  const { payload } = buildPayoutWebhook(task, NEW_SECRET, {
    eventId: "evt-rot-malformed",
    now: NOW,
  });
  for (const bad of ["", "sha256=", "sha256=zzz", "sha256=" + "0".repeat(64)]) {
    assert.equal(
      verifyPayoutWebhook(JSON.stringify(payload), bad, undefined, {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
      false,
      `expected false for ${JSON.stringify(bad)}`,
    );
  }
});
