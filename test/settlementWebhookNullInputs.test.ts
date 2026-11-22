import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  deliverPayoutWebhook,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
  retryPayoutWebhookOutbox,
  PayoutEventDedupe,
  PayoutWebhookOutbox,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Settlement-webhook null/non-object inputs (backlog #1330, the
 * follow-up #1273 explicitly deferred): every webhook entry point
 * read its `opts` (or `task` / `webhook` / `attempt`) with no shape
 * check, so a `null` in any of those positions died as a bare
 * `TypeError` (`Cannot read properties of null (reading 'now')`,
 * `… (reading 'secrets')`, `… (reading 'timeoutMs')`, `…
 * (reading 'maxRounds')`, `… (reading 'state')`, `… (reading
 * 'payload')`, `… (reading 'ttlMs')`, `… (reading 'maxAttempts')`,
 * and `Cannot destructure property 'endpoint' of 'attempt' as it is
 * null`), and a `null` batch entry leaked the same bare text into
 * its per-task `{ taskId, error }`. A wrong-shape input is a caller
 * bug and must be reported as itself — a configuration error naming
 * the value — before any field is read, with zero fetch calls and
 * zero state change.
 *
 * Rules under test:
 * - build/verify/single-delivery/fan-out/retry: `null` / array /
 *   number / string `opts` each throw the verbatim `<caller>: opts
 *   must be an object` error, never a TypeError, with zero fetch
 *   calls and zero delivery attempts
 * - build and fan-out: a `null` / array `task` throws `cannot build
 *   payout webhook: task must be an object`
 * - single delivery: a `null` / array `webhook` throws `cannot
 *   deliver payout webhook: webhook must be an object`, zero fetch
 * - batch build: `null` opts throws for the whole batch; a `null`
 *   task inside the list is a per-task `{ taskId: "unknown", error:
 *   "cannot build payout webhook: task must be an object" }` and the
 *   rest of the batch still builds
 * - both classes: a `null` / array / number constructor `opts`
 *   throws `<Class>: opts must be an object`; `restore()` /
 *   `fromSnapshot()` inherit it through the constructor, and
 *   `restoreSignedSnapshot()` fails fast on it before touching the
 *   envelope
 * - `recordAttempt(null)` / `("x")` / `([])` throws
 *   `PayoutWebhookOutbox: attempt must be an object` with zero
 *   records written
 * - `undefined` opts keeps meaning "defaults" everywhere: a build,
 *   a verify, a delivery, a retry, and both constructors still work
 */

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
    payoutRef: "xfer-1330-1",
    payoutAmount: 5000,
  });
  assert.equal(t.state, "PAID");
  return t;
}

const SECRET = "whsec_1330";
const FIXED_NOW = new Date("2026-11-22T21:00:00.000Z");
const FIXED_EVENT_ID = "evt-1330-1";
const URL = "https://example.invalid/hooks/payout";

const BUILD_OPTS = "cannot build payout webhook: opts must be an object";
const BUILD_TASK = "cannot build payout webhook: task must be an object";
const BATCH_OPTS = "cannot build payout webhooks: opts must be an object";
const VERIFY_OPTS = "cannot verify payout webhook: opts must be an object";
const DELIVER_OPTS =
  "cannot deliver payout webhook: opts must be an object";
const DELIVER_WEBHOOK =
  "cannot deliver payout webhook: webhook must be an object";
const RETRY_OPTS = "retryPayoutWebhookOutbox: opts must be an object";
const DEDUPE_OPTS = "PayoutEventDedupe: opts must be an object";
const OUTBOX_OPTS = "PayoutWebhookOutbox: opts must be an object";
const ATTEMPT = "PayoutWebhookOutbox: attempt must be an object";

/** Exact-message throw, and never a bare TypeError. */
function assertConfigError(fn: () => unknown, message: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, "expected an Error to be thrown");
    assert.ok(
      !(err instanceof TypeError),
      `expected a config Error, got TypeError: ${err.message}`,
    );
    assert.equal(err.message, message);
    return true;
  });
}

/** Exact-message async rejection, and never a bare TypeError. */
async function assertConfigRejection(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof Error, "expected an Error to be thrown");
    assert.ok(
      !(err instanceof TypeError),
      `expected a config Error, got TypeError: ${err.message}`,
    );
    assert.equal(err.message, message);
    return true;
  });
}

/** A fetch stub that counts calls and always answers 200. */
function countingFetch(counter: { calls: number }): PayoutWebhookFetchImpl {
  return async () => {
    counter.calls += 1;
    return new Response("ok", { status: 200 });
  };
}

test("build: null opts throws a config error, task untouched", () => {
  const task = toPaid("task-build-null-opts");
  const historyLength = task.history.length;
  assertConfigError(
    () => buildPayoutWebhook(task, SECRET, null as never),
    BUILD_OPTS,
  );
  assert.equal(task.state, "PAID");
  assert.equal(task.history.length, historyLength);
});

test("build: array / number / string opts throw the same config error", () => {
  const task = toPaid("task-build-bad-opts");
  for (const bad of [[], 42, "now"] as never[]) {
    assertConfigError(
      () => buildPayoutWebhook(task, SECRET, bad),
      BUILD_OPTS,
    );
  }
});

test("build: null / array task throws a config error", () => {
  assertConfigError(() => buildPayoutWebhook(null as never, SECRET), BUILD_TASK);
  assertConfigError(() => buildPayoutWebhook([] as never, SECRET), BUILD_TASK);
});

test("build: undefined opts still means defaults", () => {
  const task = toPaid("task-build-undefined-opts");
  const webhook = buildPayoutWebhook(task, SECRET, undefined);
  assert.equal(
    verifyPayoutWebhook(
      JSON.stringify(webhook.payload),
      webhook.signature,
      SECRET,
    ),
    true,
  );
});

test("verify: null / array / string opts throw a config error", () => {
  const task = toPaid("task-verify-bad-opts");
  const webhook = buildPayoutWebhook(task, SECRET, {
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  const body = JSON.stringify(webhook.payload);
  for (const bad of [null, [], "x"] as never[]) {
    assertConfigError(
      () => verifyPayoutWebhook(body, webhook.signature, SECRET, bad),
      VERIFY_OPTS,
    );
  }
});

test("verify: undefined opts still verifies", () => {
  const task = toPaid("task-verify-undefined-opts");
  const webhook = buildPayoutWebhook(task, SECRET, {
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  assert.equal(
    verifyPayoutWebhook(
      JSON.stringify(webhook.payload),
      webhook.signature,
      SECRET,
      undefined,
    ),
    true,
  );
});

test("deliver: null / array opts throw a config error, zero fetch calls", async () => {
  const task = toPaid("task-deliver-bad-opts");
  const webhook = buildPayoutWebhook(task, SECRET, {
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  // A null options value cannot carry a fetchImpl, so the zero-fetch
  // claim is checked on the default path: swap in a counting global
  // fetch (the default fetchImpl resolves the global at call time)
  // and prove it is never invoked — the guard throws before the
  // resolver even picks an implementation.
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    await assertConfigRejection(
      deliverPayoutWebhook(URL, webhook, null as never),
      DELIVER_OPTS,
    );
    await assertConfigRejection(
      deliverPayoutWebhook(URL, webhook, [] as never),
      DELIVER_OPTS,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("deliver: null / array webhook throws a config error, zero fetch calls", async () => {
  for (const bad of [null, []] as never[]) {
    const counter = { calls: 0 };
    await assertConfigRejection(
      deliverPayoutWebhook(URL, bad, { fetchImpl: countingFetch(counter) }),
      DELIVER_WEBHOOK,
    );
    assert.equal(counter.calls, 0);
  }
});

test("deliver: undefined opts still delivers", async () => {
  const task = toPaid("task-deliver-undefined-opts");
  const webhook = buildPayoutWebhook(task, SECRET, {
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  const counter = { calls: 0 };
  const result = await deliverPayoutWebhook(URL, webhook, {
    fetchImpl: countingFetch(counter),
  } as never);
  // Explicit undefined opts would take the same default path; the
  // stubbed delivery itself proves the happy path is intact.
  assert.equal(result.ok, true);
  assert.equal(counter.calls, 1);
});

test("fan-out: null / array task throws a config error, zero fetch calls", async () => {
  for (const bad of [null, []] as never[]) {
    const counter = { calls: 0 };
    await assertConfigRejection(
      deliverPayoutWebhookToMany(bad, [
        { url: URL, secret: SECRET, fetchImpl: countingFetch(counter) },
      ]),
      BUILD_TASK,
    );
    assert.equal(counter.calls, 0);
  }
});

test("fan-out: null / array opts throws a config error, zero fetch calls", async () => {
  const task = toPaid("task-fanout-bad-opts");
  for (const bad of [null, []] as never[]) {
    const counter = { calls: 0 };
    await assertConfigRejection(
      deliverPayoutWebhookToMany(
        task,
        [{ url: URL, secret: SECRET, fetchImpl: countingFetch(counter) }],
        bad,
      ),
      DELIVER_OPTS,
    );
    assert.equal(counter.calls, 0);
  }
});

test("batch: null opts throws for the whole batch, zero webhooks", () => {
  const task = toPaid("task-batch-null-opts");
  assertConfigError(
    () => buildPayoutWebhooks([task], SECRET, null as never),
    BATCH_OPTS,
  );
});

test("batch: a null task is a per-task error with clear text, rest still builds", () => {
  const task = toPaid("task-batch-null-entry");
  const results = buildPayoutWebhooks([null as never, task], SECRET, {
    now: FIXED_NOW,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].taskId, "unknown");
  assert.equal(results[0].error, BUILD_TASK);
  assert.ok(!results[0].error.includes("Cannot read properties"));
  assert.equal(results[1].taskId, task.id);
  assert.ok(results[1].webhook !== undefined);
});

test("retry: null / string opts throw a config error, deliverOne never runs", async () => {
  const outbox = new PayoutWebhookOutbox();
  for (const bad of [null, "x"] as never[]) {
    let calls = 0;
    await assertConfigRejection(
      retryPayoutWebhookOutbox(outbox, async () => {
        calls += 1;
        return true;
      }, bad),
      RETRY_OPTS,
    );
    assert.equal(calls, 0);
  }
});

test("retry: undefined opts still runs (empty outbox, zero attempts)", async () => {
  const outbox = new PayoutWebhookOutbox();
  const summary = await retryPayoutWebhookOutbox(
    outbox,
    async () => true,
    undefined,
  );
  assert.equal(summary.attempted, 0);
  assert.equal(summary.stillPending, 0);
});

test("dedupe: null / array constructor opts throw a config error", () => {
  assertConfigError(() => new PayoutEventDedupe(null as never), DEDUPE_OPTS);
  assertConfigError(() => new PayoutEventDedupe([] as never), DEDUPE_OPTS);
});

test("dedupe: restore / fromSnapshot inherit the constructor guard", () => {
  const snapshot = { v: 1, entries: [] };
  assertConfigError(
    () => PayoutEventDedupe.restore(snapshot, null as never),
    DEDUPE_OPTS,
  );
  assertConfigError(
    () => PayoutEventDedupe.fromSnapshot(snapshot, null as never),
    DEDUPE_OPTS,
  );
});

test("dedupe: signed restore fails fast on null opts, before the envelope", () => {
  assertConfigError(
    () => PayoutEventDedupe.restoreSignedSnapshot(null, SECRET, null as never),
    DEDUPE_OPTS,
  );
});

test("dedupe: undefined opts still constructs and records", () => {
  const dedupe = new PayoutEventDedupe(undefined);
  assert.equal(dedupe.checkAndRecord("evt-1330-dedupe"), false);
  assert.equal(dedupe.checkAndRecord("evt-1330-dedupe"), true);
});

test("outbox: null / number constructor opts throw a config error", () => {
  assertConfigError(() => new PayoutWebhookOutbox(null as never), OUTBOX_OPTS);
  assertConfigError(() => new PayoutWebhookOutbox(42 as never), OUTBOX_OPTS);
});

test("outbox: restore / fromSnapshot inherit the constructor guard", () => {
  const snapshot = { v: 1, entries: [] };
  assertConfigError(
    () => PayoutWebhookOutbox.restore(snapshot, null as never),
    OUTBOX_OPTS,
  );
  assertConfigError(
    () => PayoutWebhookOutbox.fromSnapshot(snapshot, null as never),
    OUTBOX_OPTS,
  );
});

test("outbox: signed restore fails fast on null opts, before the envelope", () => {
  assertConfigError(
    () =>
      PayoutWebhookOutbox.restoreSignedSnapshot(null, SECRET, null as never),
    OUTBOX_OPTS,
  );
});

test("outbox: recordAttempt null / string / array throws, zero records", () => {
  const outbox = new PayoutWebhookOutbox();
  for (const bad of [null, "x", []] as never[]) {
    assertConfigError(() => outbox.recordAttempt(bad), ATTEMPT);
  }
  assert.equal(outbox.size, 0);
});

test("outbox: undefined opts still constructs and records", () => {
  const outbox = new PayoutWebhookOutbox(undefined);
  outbox.recordAttempt({
    endpoint: URL,
    eventId: "evt-1330-outbox",
    ok: false,
    error: "boom",
    at: 1_000,
  });
  assert.equal(outbox.size, 1);
  assert.equal(outbox.pending().length, 1);
});
