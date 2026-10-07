import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  type ListenerErrorContext,
  type SubscribeOptions,
} from "../src/index.js";

function newTask(id = "t-onerr"): TaskLifecycle {
  return new TaskLifecycle(id);
}

test("subscribe onError: receives the error and the dispatch context", () => {
  const t = newTask();
  const caught: Array<{ err: unknown; ctx: ListenerErrorContext }> = [];
  const boom = new Error("boom: bad fan-out consumer");
  t.subscribe(
    () => {
      throw boom;
    },
    {
      onError: (err, ctx) => {
        caught.push({ err, ctx });
      },
    },
  );

  const to = t.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(to, "OPEN"); // dispatch returned normally
  assert.equal(t.history.length, 1); // audit entry intact

  assert.equal(caught.length, 1);
  assert.equal(caught[0].err, boom); // the exact error instance
  assert.deepEqual(caught[0].ctx, {
    event: "PUBLISH",
    from: "DRAFT",
    to: "OPEN",
  });
});

test("subscribe onError: a failing listener does not starve its peers", () => {
  const t = newTask();
  const errors: unknown[] = [];
  const peers: string[] = [];
  t.subscribe(
    () => {
      throw new Error("boom");
    },
    {
      onError: (err) => {
        errors.push(err);
      },
    },
  );
  t.subscribe(() => peers.push("peer-after"));
  t.subscribe(() => peers.push("peer-last"));

  t.dispatch("PUBLISH");

  assert.equal(errors.length, 1);
  assert.deepEqual(peers, ["peer-after", "peer-last"]);
  assert.equal(t.history.length, 1);
  assert.equal(t.history[0].event, "PUBLISH");
});

test("subscribe onError: no hook keeps the documented silence", () => {
  const t = newTask();
  let peerRan = false;
  t.subscribe(() => {
    throw new Error("silent boom");
  });
  t.subscribe(() => {
    peerRan = true;
  });

  // No onError: the throw stays swallowed, dispatch is unaffected.
  assert.doesNotThrow(() => t.dispatch("PUBLISH"));
  assert.equal(peerRan, true);
  assert.equal(t.history.length, 1);
});

test("subscribe onError: a throwing onError cannot break dispatch", () => {
  const t = newTask();
  const peers: string[] = [];
  t.subscribe(
    () => {
      throw new Error("listener boom");
    },
    {
      onError: () => {
        throw new Error("onError boom");
      },
    },
  );
  t.subscribe(() => peers.push("peer"));

  const to = t.dispatch("PUBLISH");
  assert.equal(to, "OPEN");
  assert.deepEqual(peers, ["peer"]);
  assert.equal(t.history.length, 1);

  // The task keeps working after the double failure.
  assert.equal(t.dispatch("ACCEPT"), "ACCEPTED");
  assert.equal(t.history.length, 2);
});

test("subscribe onError: unsubscribe stops error delivery", () => {
  const t = newTask();
  let calls = 0;
  const unsub = t.subscribe(
    () => {
      throw new Error("boom");
    },
    {
      onError: () => {
        calls++;
      },
    },
  );
  t.dispatch("PUBLISH");
  assert.equal(calls, 1);

  unsub();
  assert.equal(t.listenerCount, 0);
  t.dispatch("ACCEPT");
  assert.equal(calls, 1); // no more error delivery after unsubscribe

  unsub(); // idempotent, must not throw
});

test("subscribe onError: each listener's hook gets its own error", () => {
  const t = newTask();
  const first: unknown[] = [];
  const second: unknown[] = [];
  t.subscribe(
    () => {
      throw new Error("first-boom");
    },
    {
      onError: (err) => {
        first.push(err);
      },
    },
  );
  t.subscribe(
    () => {
      throw new Error("second-boom");
    },
    {
      onError: (err) => {
        second.push(err);
      },
    },
  );

  t.dispatch("PUBLISH");

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal((first[0] as Error).message, "first-boom");
  assert.equal((second[0] as Error).message, "second-boom");
  assert.notEqual(first[0], second[0]);
});

test("subscribe onError: onError is not called when the listener succeeds", () => {
  const t = newTask();
  let calls = 0;
  let deliveries = 0;
  t.subscribe(
    () => {
      deliveries++;
    },
    {
      onError: () => {
        calls++;
      },
    },
  );
  t.dispatch("PUBLISH");
  assert.equal(deliveries, 1);
  assert.equal(calls, 0);
});

test("subscribe onError: invalid options fail fast with clear errors", () => {
  const t = newTask();
  const badListener = () => {};

  assert.throws(
    () => t.subscribe(badListener, "nope" as unknown as SubscribeOptions),
    /invalid subscribe: options must be an object, got string/,
  );
  assert.throws(
    () => t.subscribe(badListener, null as unknown as SubscribeOptions),
    /invalid subscribe: options must be an object, got object/,
  );
  assert.throws(
    () => t.subscribe(badListener, [] as unknown as SubscribeOptions),
    /invalid subscribe: options must be an object, got array/,
  );
  assert.throws(
    () =>
      t.subscribe(badListener, {
        onError: "nope" as unknown as () => void,
      }),
    /invalid subscribe: onError must be a function, got string/,
  );
  assert.throws(
    () =>
      t.subscribe(badListener, {
        onError: 42 as unknown as () => void,
      }),
    /invalid subscribe: onError must be a function, got number/,
  );

  // Nothing was registered by the failed attempts.
  assert.equal(t.listenerCount, 0);
});

test("subscribe onError: errors in later dispatches keep reporting", () => {
  const t = newTask();
  const contexts: ListenerErrorContext[] = [];
  t.subscribe(
    () => {
      throw new Error("always boom");
    },
    {
      onError: (_err, ctx) => {
        contexts.push(ctx);
      },
    },
  );

  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");

  assert.deepEqual(contexts, [
    { event: "PUBLISH", from: "DRAFT", to: "OPEN" },
    { event: "ACCEPT", from: "OPEN", to: "ACCEPTED" },
  ]);
  assert.equal(t.history.length, 2);
});
