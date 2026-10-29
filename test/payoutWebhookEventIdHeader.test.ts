import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  deliverPayoutWebhook,
  deliverPayoutWebhookToMany,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Payout webhook `X-Event-Id` header (backlog #583): the dataquest-side
 * mirror of escrow's settlement-delivery `X-Event-Id` header (#567),
 * distinct from the `Idempotency-Key` header (#568) it now sits
 * alongside. Both headers carry the payload `eventId` on every
 * attempt, but they serve different receivers: `Idempotency-Key` is
 * the standard idempotency header, `X-Event-Id` is the event-dedup
 * header a gateway keys on — including when body parsing fails and
 * there is no parsed body to read an id from.
 *
 * Rules under test, all against a real loopback HTTP server (no fetch
 * stubs, so the header is observed on the actual wire):
 *  - single delivery: header equals the body `eventId`
 *  - retries: every attempt carries the same header value
 *  - fan-out: every endpoint's request independently carries the
 *    shared `eventId` as its header (one logical event, so the value
 *    is the same on every endpoint — not a different id per endpoint)
 *  - a failing endpoint never blocks another endpoint's header
 *  - independent deliveries carry their own, different ids
 *  - the header is a transport hint only: the signature covers the
 *    body, not the header, so verification runs over the body alone
 *    and the receiver must deduplicate on the verified body's
 *    `eventId`; `Idempotency-Key` keeps carrying the same value
 *    alongside it
 */

const SECRET = "whsec_test_payout_eventid_20261025";
const SECRET_BILLING = "whsec_test_payout_eventid_billing_20261025";
const SECRET_RISK = "whsec_test_payout_eventid_risk_20261025";
const NOW = new Date("2026-10-25T00:00:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function paidTask(id: string): TaskLifecycle {
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
    payoutRef: "xfer-evt-1",
    payoutAmount: 4200,
  });
  return t;
}

interface CapturedRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface CaptureServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/**
 * A loopback server that answers with a status chosen per request
 * (a number, or a function of the request count) and records every
 * request's path, headers, and body.
 */
async function startCaptureServer(
  statusFor: number | ((n: number) => number),
): Promise<CaptureServer> {
  const requests: CapturedRequest[] = [];
  let count = 0;
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        count += 1;
        requests.push({
          path: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const status =
          typeof statusFor === "function" ? statusFor(count) : statusFor;
        res.writeHead(status, { "content-type": "application/json" });
        res.end("{}");
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback server did not bind to a port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

test("single delivery carries X-Event-Id equal to the body eventId", async () => {
  const server = await startCaptureServer(200);
  try {
    const webhook = buildPayoutWebhook(paidTask("task-evt-1"), SECRET, {
      eventId: "evt-evt-1",
      now: NOW,
    });
    const result = await deliverPayoutWebhook(
      `${server.baseUrl}/hooks/payout`,
      webhook,
      { allowInsecureHttp: true },
    );
    assert.deepEqual(result, { ok: true, attempts: 1, status: 200 });
    assert.equal(server.requests.length, 1);
    const [req] = server.requests;
    assert.equal(req.headers["x-event-id"], "evt-evt-1");
    const body = JSON.parse(req.body) as { eventId: string };
    assert.equal(body.eventId, "evt-evt-1");
    assert.equal(req.headers["x-event-id"], body.eventId);
    // Coexistence with the #568 header: both carry the same value.
    assert.equal(req.headers["idempotency-key"], "evt-evt-1");
    // The signature header is still the build-time signature, and the
    // body verifies under it — the new header changed nothing signed.
    assert.equal(
      req.headers["x-hub-signature-256"],
      webhook.signature,
    );
    assert.ok(
      verifyPayoutWebhook(
        req.body,
        String(req.headers["x-hub-signature-256"]),
        SECRET,
      ),
    );
  } finally {
    await server.close();
  }
});

test("retries re-POST the same X-Event-Id on every attempt", async () => {
  const server = await startCaptureServer((n) => (n < 3 ? 500 : 200));
  try {
    const webhook = buildPayoutWebhook(paidTask("task-evt-2"), SECRET, {
      eventId: "evt-evt-retry",
      now: NOW,
    });
    const result = await deliverPayoutWebhook(
      `${server.baseUrl}/hooks/payout`,
      webhook,
      { backoffMs: 1, allowInsecureHttp: true },
    );
    assert.deepEqual(result, { ok: true, attempts: 3, status: 200 });
    assert.equal(server.requests.length, 3);
    for (const req of server.requests) {
      assert.equal(req.headers["x-event-id"], "evt-evt-retry");
      assert.equal(req.body, JSON.stringify(webhook.payload));
    }
  } finally {
    await server.close();
  }
});

test("fan-out: every endpoint's request carries the shared eventId header", async () => {
  const server = await startCaptureServer(200);
  try {
    const out = await deliverPayoutWebhookToMany(
      paidTask("task-evt-3"),
      [
        { url: `${server.baseUrl}/billing`, secret: SECRET_BILLING },
        { url: `${server.baseUrl}/risk`, secret: SECRET_RISK },
      ],
      { eventId: "evt-evt-shared", now: NOW, allowInsecureHttp: true },
    );
    assert.equal(out.delivered, 2);
    assert.equal(out.failed, 0);
    assert.equal(server.requests.length, 2);
    // One logical event: both endpoints get the SAME id in the header
    // (and in the body), each request independently carrying it.
    for (const req of server.requests) {
      assert.equal(req.headers["x-event-id"], "evt-evt-shared");
      const body = JSON.parse(req.body) as { eventId: string };
      assert.equal(body.eventId, "evt-evt-shared");
    }
    // Each endpoint's copy verifies under its own secret only.
    const byPath = new Map(server.requests.map((r) => [r.path, r]));
    assert.ok(
      verifyPayoutWebhook(
        byPath.get("/billing")!.body,
        String(byPath.get("/billing")!.headers["x-hub-signature-256"]),
        SECRET_BILLING,
      ),
    );
    assert.ok(
      verifyPayoutWebhook(
        byPath.get("/risk")!.body,
        String(byPath.get("/risk")!.headers["x-hub-signature-256"]),
        SECRET_RISK,
      ),
    );
  } finally {
    await server.close();
  }
});

test("fan-out: a failing endpoint never blocks another endpoint's header", async () => {
  // Path-aware server: /bad always 500, /good always 200. Requests
  // arrive concurrently, so routing must be by path, not by count.
  const requests: CapturedRequest[] = [];
  const pathServer: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          path: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(req.url === "/bad" ? 500 : 200, {
          "content-type": "application/json",
        });
        res.end("{}");
      });
    },
  );
  await new Promise<void>((resolve) =>
    pathServer.listen(0, "127.0.0.1", resolve),
  );
  const address = pathServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback server did not bind to a port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const out = await deliverPayoutWebhookToMany(
      paidTask("task-evt-4"),
      [
        { url: `${baseUrl}/bad`, secret: SECRET, maxAttempts: 1 },
        { url: `${baseUrl}/good`, secret: SECRET },
      ],
      { eventId: "evt-evt-partial", now: NOW, allowInsecureHttp: true },
    );
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
    assert.equal(requests.length, 2);
    for (const req of requests) {
      assert.equal(req.headers["x-event-id"], "evt-evt-partial");
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      pathServer.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("independent deliveries carry their own, different X-Event-Ids", async () => {
  const server = await startCaptureServer(200);
  try {
    const task = paidTask("task-evt-5");
    const first = buildPayoutWebhook(task, SECRET, {
      eventId: "evt-evt-a",
      now: NOW,
    });
    const second = buildPayoutWebhook(task, SECRET, {
      eventId: "evt-evt-b",
      now: NOW,
    });
    await deliverPayoutWebhook(`${server.baseUrl}/hooks/payout`, first, { allowInsecureHttp: true });
    await deliverPayoutWebhook(`${server.baseUrl}/hooks/payout`, second, { allowInsecureHttp: true });
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0].headers["x-event-id"], "evt-evt-a");
    assert.equal(server.requests[1].headers["x-event-id"], "evt-evt-b");
    assert.notEqual(
      server.requests[0].headers["x-event-id"],
      server.requests[1].headers["x-event-id"],
    );
  } finally {
    await server.close();
  }
});

test("the header is not signed: verification runs over the body alone", async () => {
  const server = await startCaptureServer(200);
  try {
    const webhook = buildPayoutWebhook(paidTask("task-evt-6"), SECRET, {
      eventId: "evt-evt-unsigned-header",
      now: NOW,
    });
    await deliverPayoutWebhook(`${server.baseUrl}/hooks/payout`, webhook, { allowInsecureHttp: true });
    const [req] = server.requests;
    // The captured signature is exactly the build-time signature: the
    // header was added at delivery time and never entered the signed
    // bytes. A receiver that (wrongly) trusted the header over the
    // body would be trusting unsigned data — it must verify the body
    // and deduplicate on the verified body's eventId instead.
    assert.equal(req.headers["x-hub-signature-256"], webhook.signature);
    assert.ok(
      verifyPayoutWebhook(
        req.body,
        String(req.headers["x-hub-signature-256"]),
        SECRET,
      ),
    );
    const verified = JSON.parse(req.body) as { eventId: string };
    assert.equal(verified.eventId, req.headers["x-event-id"]);
    assert.equal(verified.eventId, req.headers["idempotency-key"]);
  } finally {
    await server.close();
  }
});
