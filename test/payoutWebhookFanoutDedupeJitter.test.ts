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
 * Payout webhook fan-out x `PayoutEventDedupe` x `jitterMs` combination
 * (backlog #774).
 *
 * `test/payoutWebhookFanoutDedupe.test.ts` (#740) pins fan-out x
 * endpoint-isolated dedupe, and `test/payoutWebhookFanoutJitter.test.ts`
 * (#714) pins fan-out x jitter — but no test ever ran all three
 * together: jittered backoff retries plus per-endpoint dedupe in one
 * fan-out. The combination has two traps the single-feature suites
 * cannot see:
 *  - a retrying endpoint sends the same logical event three times
 *    (500, 500, then 200), yet the receiver must record it exactly
 *    once: sender-side retries are not receiver-side duplicates, and
 *    a failed attempt (answered 500) must never reach the dedupe
 *    store at all
 *  - an endpoint whose retries are exhausted records nothing, so a
 *    later true delivery of the same eventId is still a first
 *    sighting — exhaustion must not poison the store, and the late
 *    first sighting must not disturb any sibling endpoint's dedupe
 *
 * Rules under test, with one independent `PayoutEventDedupe` per
 * endpoint and the documented receiver order (verify the raw wire
 * body first, `checkAndRecord` only after a `true` verification,
 * collapsed into a local `receive()` helper):
 *  - 4-endpoint fan-out with call-level jitter: the 500/500/200
 *    endpoint sleeps twice inside the jitter windows, its three
 *    attempts carry byte-identical bodies, and its successful
 *    delivery is a first sighting (dedupe size 1, not a duplicate),
 *    while the three first-attempt endpoints are first sightings too
 *  - an endpoint that exhausts its retries (500 every attempt)
 *    records nothing: its dedupe stays at size 0, and a later true
 *    delivery of the same eventId (a second fan-out with the eventId
 *    pinned) is still accepted, with a re-presentation after that
 *    reporting duplicate
 *  - per-endpoint dedupes stay independent under jittered retries:
 *    the exhausted endpoint's late first sighting leaves the
 *    siblings' dedupes untouched (their re-presentations are still
 *    duplicates, sizes still 1), and the retrying endpoint's
 *    recording never made a sibling's first delivery a duplicate
 *
 * Every test injects fetch/sleep stubs: no real network, and the
 * exact delay schedule is asserted instead of really sleeping.
 */

const SECRET_A = "whsec_fanout_dedupe_jitter_billing";
const SECRET_B = "whsec_fanout_dedupe_jitter_risk";
const SECRET_C = "whsec_fanout_dedupe_jitter_ledger";
const SECRET_D = "whsec_fanout_dedupe_jitter_audit";
const URL_A = "https://billing.example.com/hooks/payout";
const URL_B = "https://risk.example.com/hooks/payout";
const URL_C = "https://ledger.example.com/hooks/payout";
const URL_D = "https://audit.example.com/hooks/payout";
const NOW = new Date("2026-10-31T00:00:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id = "task-fanout-dedupe-jitter"): TaskLifecycle {
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
    payoutRef: "xfer-fanout-dedupe-jitter-1",
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
 * responses (the last entry repeats once exhausted), and every call
 * is recorded per URL so per-endpoint attempt counts are exact.
 */
function routerFetch(scripts: Record<string, Response[]>): {
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
    // Fresh Response per call: a Response body can only be consumed once.
    return new Response(step.body, { status: step.status, headers: step.headers });
  };
  return { fetchImpl, callsTo: (u) => calls.filter((c) => c.url === u) };
}

/** A sleep stub that records the requested delays instead of sleeping. */
function recordingSleep(): {
  sleepImpl: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleepImpl: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const res = (status: number) => new Response("{}", { status });

function bodyOf(call: RecordedCall): string {
  return String(call.init.body);
}
function signatureOf(call: RecordedCall): string {
  return String(new Headers(call.init.headers).get("x-hub-signature-256"));
}

function inWindow(delay: number, backoff: number, jitter: number): boolean {
  return delay >= backoff && delay <= backoff + jitter;
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

/** Four per-endpoint sleep recorders, wired in endpoint order. */
function fourSleeps() {
  const sleeps = [
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
  ];
  const endpoints = ENDPOINTS.map((e, i) => ({
    ...e,
    sleepImpl: sleeps[i].sleepImpl,
  }));
  return { endpoints, sleeps };
}

test("jittered retry success is a first sighting, not a duplicate, on every endpoint", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500), res(500), res(200)],
    [URL_B]: [res(200)],
    [URL_C]: [res(200)],
    [URL_D]: [res(200)],
  });
  const { endpoints, sleeps } = fourSleeps();
  const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
    fetchImpl,
    now: NOW,
    eventId: "evt-fanout-dedupe-jitter-1",
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
  });
  assert.equal(out.delivered, 4);
  assert.equal(out.failed, 0);
  assert.deepEqual(out.results, [
    { ok: true, attempts: 3, status: 200 },
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
    { ok: true, attempts: 1, status: 200 },
  ]);
  // The retrying endpoint's two sleeps fall inside the jitter windows;
  // the healthy endpoints never slept at all.
  assert.equal(sleeps[0].delays.length, 2);
  assert.ok(inWindow(sleeps[0].delays[0], 100, 1000), "first delay in [100, 1100]");
  assert.ok(inWindow(sleeps[0].delays[1], 200, 1000), "second delay in [200, 1200]");
  for (const i of [1, 2, 3]) {
    assert.deepEqual(sleeps[i].delays, [], `healthy endpoint ${i} must not sleep`);
  }
  // The three attempts at A resent the same logical event: identical
  // bytes, so the successful delivery is the same event the retries
  // were for — not a new event that happens to share an id.
  const callsA = callsTo(URL_A);
  assert.equal(callsA.length, 3);
  assert.ok(
    callsA.every((c) => bodyOf(c) === bodyOf(callsA[0])),
    "all three attempts at A must carry byte-identical bodies",
  );
  assert.equal(JSON.parse(bodyOf(callsA[0])).eventId, "evt-fanout-dedupe-jitter-1");
  // Receiver side: the successful delivery at each endpoint is a
  // first sighting even though A needed three sender attempts, and
  // each endpoint's dedupe holds exactly that one event.
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  const secrets = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
  const urls = [URL_A, URL_B, URL_C, URL_D];
  for (let i = 0; i < 4; i++) {
    const calls = callsTo(urls[i]);
    // For A, only the successful (last) attempt is presented to the
    // receiver: the two 500 attempts were rejected at the transport
    // layer and never reached the dedupe store.
    const call = calls[calls.length - 1];
    assert.equal(receive(bodyOf(call), signatureOf(call), dedupes[i], secrets[i]), "accepted");
    assert.equal(dedupes[i].size, 1);
    // And a genuine re-presentation after that is a duplicate.
    assert.equal(receive(bodyOf(call), signatureOf(call), dedupes[i], secrets[i]), "duplicate");
    assert.deepEqual(dedupes[i].stats(), {
      size: 1,
      hits: 1,
      misses: 1,
      evictions: 0,
    });
  }
});

test("exhausted endpoint records nothing; its later true delivery is still first-seen", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500)],
    [URL_B]: [res(200)],
    [URL_C]: [res(200)],
    [URL_D]: [res(200)],
  });
  const { endpoints, sleeps } = fourSleeps();
  const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
    fetchImpl,
    now: NOW,
    eventId: "evt-fanout-dedupe-jitter-2",
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
  });
  assert.equal(out.delivered, 3);
  assert.equal(out.failed, 1);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].attempts, 3);
  assert.equal(out.results[0].status, 500);
  // A retried with jitter before giving up: two sleeps in-window.
  assert.equal(sleeps[0].delays.length, 2);
  assert.ok(inWindow(sleeps[0].delays[0], 100, 1000));
  assert.ok(inWindow(sleeps[0].delays[1], 200, 1000));
  assert.equal(callsTo(URL_A).length, 3);
  // The healthy endpoints' deliveries are first sightings.
  const dedupes = ENDPOINTS.map(() => new PayoutEventDedupe());
  const secrets = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
  for (const i of [1, 2, 3]) {
    const [call] = callsTo([URL_B, URL_C, URL_D][i - 1]);
    assert.equal(receive(bodyOf(call), signatureOf(call), dedupes[i], secrets[i]), "accepted");
    assert.equal(dedupes[i].size, 1);
  }
  // A answered 500 to every attempt, so no delivery was ever accepted
  // there: its dedupe is empty, not poisoned by the failed attempts.
  assert.equal(dedupes[0].size, 0);
  // The caller reconciles by re-delivering with the same eventId
  // pinned. A's endpoint is healthy now, so its true delivery is
  // still a first sighting — exhaustion did not mark it seen.
  const { fetchImpl: fetchImpl2, callsTo: callsTo2 } = routerFetch({
    [URL_A]: [res(200)],
    [URL_B]: [res(200)],
    [URL_C]: [res(200)],
    [URL_D]: [res(200)],
  });
  const sleeps2 = [
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
    recordingSleep(),
  ];
  const endpoints2 = ENDPOINTS.map((e, i) => ({
    ...e,
    sleepImpl: sleeps2[i].sleepImpl,
  }));
  const out2 = await deliverPayoutWebhookToMany(
    paidTask("task-fanout-dedupe-jitter-retry"),
    endpoints2,
    {
      fetchImpl: fetchImpl2,
      now: NOW,
      eventId: "evt-fanout-dedupe-jitter-2",
      backoffMs: 100,
      jitterMs: 1000,
      maxAttempts: 3,
    },
  );
  assert.equal(out2.delivered, 4);
  const [callA2] = callsTo2(URL_A);
  assert.equal(receive(bodyOf(callA2), signatureOf(callA2), dedupes[0], SECRET_A), "accepted");
  assert.equal(dedupes[0].size, 1);
  assert.equal(receive(bodyOf(callA2), signatureOf(callA2), dedupes[0], SECRET_A), "duplicate");
  assert.deepEqual(dedupes[0].stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
  // A's late first sighting left the siblings untouched: their
  // original deliveries are still duplicates, sizes still 1.
  const urls = [URL_B, URL_C, URL_D];
  for (const i of [1, 2, 3]) {
    const [call] = callsTo(urls[i - 1]);
    assert.equal(receive(bodyOf(call), signatureOf(call), dedupes[i], secrets[i]), "duplicate");
    assert.equal(dedupes[i].size, 1);
  }
});

test("one endpoint's jittered retries never make a sibling's first delivery a duplicate", async () => {
  const { fetchImpl, callsTo } = routerFetch({
    [URL_A]: [res(500), res(500), res(200)],
    [URL_B]: [res(500), res(200)],
    [URL_C]: [res(200)],
    [URL_D]: [res(200)],
  });
  const { endpoints } = fourSleeps();
  const out = await deliverPayoutWebhookToMany(paidTask(), endpoints, {
    fetchImpl,
    now: NOW,
    eventId: "evt-fanout-dedupe-jitter-3",
    backoffMs: 100,
    jitterMs: 1000,
    maxAttempts: 3,
  });
  assert.equal(out.delivered, 4);
  assert.deepEqual(
    out.results.map((r) => r.attempts),
    [3, 2, 1, 1],
    "each endpoint burns only its own retry budget",
  );
  // A records the event first; B's own first delivery of the same
  // eventId — after its own single jittered retry — is still a
  // first sighting, not a duplicate inherited from A.
  const dedupeA = new PayoutEventDedupe();
  const dedupeB = new PayoutEventDedupe();
  const callsA = callsTo(URL_A);
  const callsB = callsTo(URL_B);
  assert.equal(
    receive(bodyOf(callsA[callsA.length - 1]), signatureOf(callsA[callsA.length - 1]), dedupeA, SECRET_A),
    "accepted",
  );
  assert.equal(
    receive(bodyOf(callsB[callsB.length - 1]), signatureOf(callsB[callsB.length - 1]), dedupeB, SECRET_B),
    "accepted",
  );
  assert.equal(dedupeA.size, 1);
  assert.equal(dedupeB.size, 1);
  assert.equal(
    receive(bodyOf(callsA[callsA.length - 1]), signatureOf(callsA[callsA.length - 1]), dedupeA, SECRET_A),
    "duplicate",
  );
  assert.equal(
    receive(bodyOf(callsB[callsB.length - 1]), signatureOf(callsB[callsB.length - 1]), dedupeB, SECRET_B),
    "duplicate",
  );
});
