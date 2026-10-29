import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout webhook fan-out x secret rotation combination (backlog #697):
 * the dataquest-side peer of escrow's #681 combination.
 *
 * Fan-out and rotation each have their own coverage
 * (`payoutWebhookFanout.test.ts`, `payoutWebhookSecretRotation.test.ts`),
 * but their combination was unpinned: when one logical settlement event
 * is fanned out to a legacy endpoint (still signed with the old secret)
 * and a migrated endpoint (signed with the new secret), does every
 * delivered copy verify under the rotation candidate list, does closing
 * the window reject exactly the retired copy, and does a failing legacy
 * endpoint block neither the migrated delivery nor its verification?
 *
 * Rules under test:
 *  - one fan-out delivers byte-identical bodies (shared eventId and
 *    `at`) to both endpoints, each signed with its own secret
 *  - each copy verifies under `{ secrets: [new, old] }` and under
 *    `[old, new]` (candidate order is a preference, not a gate)
 *  - a copy never verifies under the other endpoint's single secret
 *    (secrets do not cross endpoints)
 *  - closing the window is per-copy exact: `[new]` alone rejects the
 *    legacy copy but accepts the migrated copy, and `[old]` alone does
 *    the mirror image; an unrelated secret fails both copies
 *  - a legacy endpoint stuck on 500 exhausts only its own retries and
 *    never blocks the migrated endpoint's delivery or verification
 *  - every test injects fetch/sleep stubs: no real network, no real
 *    sleeps
 */

const OLD_SECRET = "whsec_fanout_rotation_old_20261029";
const NEW_SECRET = "whsec_fanout_rotation_new_20261029";
const URL_LEGACY = "https://legacy.example.com/hooks/payout";
const URL_MIGRATED = "https://migrated.example.com/hooks/payout";
const NOW = new Date("2026-10-29T00:00:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-rotation"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-rotation-1",
    payoutAmount: 4200,
  });
  return t;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/**
 * A fetch stub routing by URL: each URL has its own script of
 * responses/errors (the last entry repeats once exhausted), and every
 * call is recorded per URL so per-endpoint attempt counts are exact.
 */
function routerFetch(scripts: Record<string, Array<Response | Error>>): {
  fetchImpl: PayoutWebhookFetchImpl;
  callsTo: (url: string) => RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const seen = new Map<string, number>();
  const fetchImpl: PayoutWebhookFetchImpl = async (url, init) => {
    calls.push({ url, init });
    const script = scripts[url];
    assert.ok(script, `unexpected fetch to ${url}`);
    const n = seen.get(url) ?? 0;
    seen.set(url, n + 1);
    const step = script[Math.min(n, script.length - 1)];
    if (step instanceof Error) throw step;
    // Fresh Response per call: a Response body can only be consumed once.
    return new Response(step.body, { status: step.status, headers: step.headers });
  };
  return { fetchImpl, callsTo: (u) => calls.filter((c) => c.url === u) };
}

const noSleep = async () => {};
const res = (status: number) => new Response("{}", { status });

function bodyOf(call: RecordedCall): string {
  return String(call.init.body);
}
function signatureOf(call: RecordedCall): string {
  return String(new Headers(call.init.headers).get("x-hub-signature-256"));
}

async function fanoutToLegacyAndMigrated(scripts: Record<string, Array<Response | Error>>) {
  const { fetchImpl, callsTo } = routerFetch(scripts);
  const out = await deliverPayoutWebhookToMany(
    paidTask(),
    [
      { url: URL_LEGACY, secret: OLD_SECRET },
      { url: URL_MIGRATED, secret: NEW_SECRET },
    ],
    { fetchImpl, sleepImpl: noSleep, now: NOW, backoffMs: 1, eventId: "evt-fanout-rotation-1" },
  );
  return { out, callsTo };
}

test("legacy + migrated fan-out: identical bodies, each copy verifies under the rotation list in both orders", async () => {
  const { out, callsTo } = await fanoutToLegacyAndMigrated({
    [URL_LEGACY]: [res(200)],
    [URL_MIGRATED]: [res(200)],
  });
  assert.deepEqual(out.results, [
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 0);
  const [legacyCall] = callsTo(URL_LEGACY);
  const [migratedCall] = callsTo(URL_MIGRATED);
  // Same logical event: identical payload bytes (shared eventId + at)…
  assert.equal(bodyOf(legacyCall), bodyOf(migratedCall));
  assert.equal(JSON.parse(bodyOf(legacyCall)).eventId, "evt-fanout-rotation-1");
  // …but independently signed per endpoint.
  assert.notEqual(signatureOf(legacyCall), signatureOf(migratedCall));
  // Both copies verify under the rotation list, in either order.
  for (const candidates of [
    [NEW_SECRET, OLD_SECRET],
    [OLD_SECRET, NEW_SECRET],
  ]) {
    assert.equal(
      verifyPayoutWebhook(bodyOf(legacyCall), signatureOf(legacyCall), undefined, {
        secrets: candidates,
      }),
      true,
      `legacy copy must verify under [${candidates.join(", ")}]`,
    );
    assert.equal(
      verifyPayoutWebhook(bodyOf(migratedCall), signatureOf(migratedCall), undefined, {
        secrets: candidates,
      }),
      true,
      `migrated copy must verify under [${candidates.join(", ")}]`,
    );
  }
});

test("secrets do not cross endpoints: neither copy verifies under the other endpoint's single secret", async () => {
  const { callsTo } = await fanoutToLegacyAndMigrated({
    [URL_LEGACY]: [res(200)],
    [URL_MIGRATED]: [res(200)],
  });
  const [legacyCall] = callsTo(URL_LEGACY);
  const [migratedCall] = callsTo(URL_MIGRATED);
  assert.equal(verifyPayoutWebhook(bodyOf(legacyCall), signatureOf(legacyCall), NEW_SECRET), false);
  assert.equal(verifyPayoutWebhook(bodyOf(migratedCall), signatureOf(migratedCall), OLD_SECRET), false);
});

test("closing the window is per-copy exact: [new] rejects only the legacy copy, [old] rejects only the migrated copy", async () => {
  const { callsTo } = await fanoutToLegacyAndMigrated({
    [URL_LEGACY]: [res(200)],
    [URL_MIGRATED]: [res(200)],
  });
  const [legacyCall] = callsTo(URL_LEGACY);
  const [migratedCall] = callsTo(URL_MIGRATED);
  // Window closed to the new secret only: the retired copy fails, the
  // migrated copy still passes.
  assert.equal(
    verifyPayoutWebhook(bodyOf(legacyCall), signatureOf(legacyCall), undefined, {
      secrets: [NEW_SECRET],
    }),
    false,
  );
  assert.equal(
    verifyPayoutWebhook(bodyOf(migratedCall), signatureOf(migratedCall), undefined, {
      secrets: [NEW_SECRET],
    }),
    true,
  );
  // Mirror image: window rolled back to the old secret only.
  assert.equal(
    verifyPayoutWebhook(bodyOf(legacyCall), signatureOf(legacyCall), undefined, {
      secrets: [OLD_SECRET],
    }),
    true,
  );
  assert.equal(
    verifyPayoutWebhook(bodyOf(migratedCall), signatureOf(migratedCall), undefined, {
      secrets: [OLD_SECRET],
    }),
    false,
  );
  // An unrelated secret fails both copies, whether it is the only
  // candidate or the single positional secret (fail-closed, no match).
  for (const call of [legacyCall, migratedCall]) {
    assert.equal(
      verifyPayoutWebhook(bodyOf(call), signatureOf(call), undefined, {
        secrets: ["someone-elses-secret"],
      }),
      false,
      "rotation list with no matching candidate must fail closed",
    );
    assert.equal(
      verifyPayoutWebhook(bodyOf(call), signatureOf(call), "someone-elses-secret"),
      false,
      "unrelated single secret must fail closed",
    );
  }
});

test("tampered bodies fail closed under the rotation list for both copies", async () => {
  const { callsTo } = await fanoutToLegacyAndMigrated({
    [URL_LEGACY]: [res(200)],
    [URL_MIGRATED]: [res(200)],
  });
  const [legacyCall] = callsTo(URL_LEGACY);
  const [migratedCall] = callsTo(URL_MIGRATED);
  for (const call of [legacyCall, migratedCall]) {
    const tampered = bodyOf(call).replace("4200", "4201");
    assert.notEqual(tampered, bodyOf(call), "tamper fixture must actually change the body");
    assert.equal(
      verifyPayoutWebhook(tampered, signatureOf(call), undefined, {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
      false,
    );
  }
});

test("500 legacy endpoint does not block the migrated endpoint or its rotation verification", async () => {
  const { out, callsTo } = await fanoutToLegacyAndMigrated({
    [URL_LEGACY]: [res(500)],
    [URL_MIGRATED]: [res(200)],
  });
  assert.equal(out.results[0].ok, false, "failing endpoint is first, in input order");
  assert.equal(out.results[0].status, 500);
  assert.equal(out.results[0].attempts, 3, "default maxAttempts exhausted");
  assert.match(out.results[0].error ?? "", /500/);
  assert.deepEqual(out.results[1], { ok: true, attempts: 1, status: 200 });
  assert.equal(out.delivered, 1);
  assert.equal(out.failed, 1);
  assert.equal(callsTo(URL_LEGACY).length, 3, "legacy endpoint exhausted its own retries");
  assert.equal(callsTo(URL_MIGRATED).length, 1, "migrated endpoint was not retried or blocked");
  const [migratedCall] = callsTo(URL_MIGRATED);
  assert.equal(
    verifyPayoutWebhook(bodyOf(migratedCall), signatureOf(migratedCall), undefined, {
      secrets: [NEW_SECRET, OLD_SECRET],
    }),
    true,
    "migrated copy still verifies after the legacy failure",
  );
  // The legacy copies were signed correctly too — the server just
  // refused them — so the last legacy attempt still verifies under
  // rotation. A 500 must not be mistaken for a bad signature.
  const legacyCalls = callsTo(URL_LEGACY);
  assert.equal(
    verifyPayoutWebhook(
      bodyOf(legacyCalls[legacyCalls.length - 1]),
      signatureOf(legacyCalls[legacyCalls.length - 1]),
      undefined,
      { secrets: [NEW_SECRET, OLD_SECRET] },
    ),
    true,
  );
});
