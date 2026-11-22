import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
} from "../src/index.js";
import type { PayoutWebhookFetchImpl } from "../src/index.js";

/**
 * Payout-webhook signing-secret shape (backlog #1327, mirroring
 * escrow #1272): `assertSecret` only checked `secret.length === 0`,
 * so a numeric secret slid past the length check and died inside
 * `createHmac` as a bare `TypeError`, and `null`/`undefined` died
 * reading `.length`. A wrong-type secret is a caller bug and must be
 * reported as itself — `cannot build payout webhook: signing secret
 * must be a string or Buffer` — before any signing work happens.
 *
 * Rules under test:
 * - single build: `123` / `null` / `undefined` / `{}` / `true` /
 *   `[]` each throw the verbatim config error, never a TypeError
 * - empty string and empty Buffer still report `must not be empty`
 * - a valid string or Buffer secret still builds and verifies
 * - batch build: a wrong-type secret throws for the whole batch
 *   (zero webhooks); a valid secret still builds every task
 * - fan-out: a bad endpoint secret fails only that endpoint, with
 *   the new message, zero fetch calls, and the good endpoint still
 *   delivers
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
    payoutRef: "xfer-1327-1",
    payoutAmount: 5000,
  });
  assert.equal(t.state, "PAID");
  return t;
}

const SECRET = "whsec_1327";
const SECRET_BUFFER = Buffer.from("whsec_1327_buffer");
const FIXED_NOW = new Date("2026-11-22T12:00:00.000Z");
const FIXED_EVENT_ID = "evt-1327-1";

const WRONG_TYPE_MESSAGE =
  "cannot build payout webhook: signing secret must be a string or Buffer";
const EMPTY_MESSAGE =
  "cannot build payout webhook: signing secret must not be empty";

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

test("build: numeric secret throws a config error, not a bare TypeError", () => {
  const task = toPaid("task-secret-number");
  assertConfigError(
    () => buildPayoutWebhook(task, 123 as never),
    WRONG_TYPE_MESSAGE,
  );
});

test("build: null secret throws a config error, not a bare TypeError", () => {
  const task = toPaid("task-secret-null");
  assertConfigError(
    () => buildPayoutWebhook(task, null as never),
    WRONG_TYPE_MESSAGE,
  );
});

test("build: undefined secret throws a config error, not a bare TypeError", () => {
  const task = toPaid("task-secret-undefined");
  assertConfigError(
    () => buildPayoutWebhook(task, undefined as never),
    WRONG_TYPE_MESSAGE,
  );
});

test("build: object secret throws a config error, not a bare TypeError", () => {
  const task = toPaid("task-secret-object");
  assertConfigError(
    () => buildPayoutWebhook(task, {} as never),
    WRONG_TYPE_MESSAGE,
  );
});

test("build: boolean secret throws a config error, not a bare TypeError", () => {
  const task = toPaid("task-secret-boolean");
  assertConfigError(
    () => buildPayoutWebhook(task, true as never),
    WRONG_TYPE_MESSAGE,
  );
});

test("build: array secret throws a config error, not a bare TypeError", () => {
  const task = toPaid("task-secret-array");
  assertConfigError(
    () => buildPayoutWebhook(task, [] as never),
    WRONG_TYPE_MESSAGE,
  );
});

test("build: empty string secret still reports empty, not wrong-type", () => {
  const task = toPaid("task-secret-empty-string");
  assertConfigError(() => buildPayoutWebhook(task, ""), EMPTY_MESSAGE);
});

test("build: empty Buffer secret still reports empty, not wrong-type", () => {
  const task = toPaid("task-secret-empty-buffer");
  assertConfigError(
    () => buildPayoutWebhook(task, Buffer.alloc(0)),
    EMPTY_MESSAGE,
  );
});

test("build: string secret still builds and verifies", () => {
  const task = toPaid("task-secret-string-ok");
  const { payload, signature } = buildPayoutWebhook(task, SECRET, {
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  assert.equal(payload.eventId, FIXED_EVENT_ID);
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET),
    true,
  );
});

test("build: Buffer secret still builds and verifies", () => {
  const task = toPaid("task-secret-buffer-ok");
  const { payload, signature } = buildPayoutWebhook(task, SECRET_BUFFER, {
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  assert.equal(payload.eventId, FIXED_EVENT_ID);
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(payload), signature, SECRET_BUFFER),
    true,
  );
});

test("batch: wrong-type secret throws for the whole batch, zero webhooks", () => {
  const first = toPaid("task-secret-batch-bad-1");
  const second = toPaid("task-secret-batch-bad-2");
  assertConfigError(
    () => buildPayoutWebhooks([first, second], 123 as never),
    // The batch shares the single build's guard verbatim (same
    // "cannot build payout webhook" prefix, not the plural batch
    // prefix used by the batch's own call-level checks).
    WRONG_TYPE_MESSAGE,
  );
});

test("batch: valid secret still builds every task", () => {
  const first = toPaid("task-secret-batch-ok-1");
  const second = toPaid("task-secret-batch-ok-2");
  const results = buildPayoutWebhooks([first, second], SECRET, {
    now: FIXED_NOW,
  });
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.error, undefined);
    assert.ok(result.webhook);
    assert.equal(
      verifyPayoutWebhook(
        JSON.stringify(result.webhook.payload),
        result.webhook.signature,
        SECRET,
      ),
      true,
    );
  }
});

test("fan-out: bad endpoint secret fails only that endpoint, zero fetch", async () => {
  const task = toPaid("task-secret-fanout");
  let fetchCalls = 0;
  const fetchImpl: PayoutWebhookFetchImpl = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  };
  const noSleep = async () => {};
  const result = await deliverPayoutWebhookToMany(
    task,
    [
      {
        url: "https://bad-secret.example.com/hooks/payout",
        secret: 123 as never,
        fetchImpl,
        sleepImpl: noSleep,
      },
      {
        url: "https://good-secret.example.com/hooks/payout",
        secret: SECRET,
        fetchImpl,
        sleepImpl: noSleep,
      },
    ],
    { now: FIXED_NOW, eventId: FIXED_EVENT_ID },
  );
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].attempts, 0);
  assert.equal(result.results[0].error, WRONG_TYPE_MESSAGE);
  assert.equal(result.results[1].ok, true);
  // Only the good endpoint ever reached fetch: the bad secret fails
  // at build time, before any request is made.
  assert.equal(fetchCalls, 1);
});
