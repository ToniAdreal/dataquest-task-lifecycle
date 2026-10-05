import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stateDiagram,
  transition,
  transitionTable,
} from "../src/index.js";

// Tests run compiled: dist/test/diagram.test.js -> CLI is dist/src/diagram.js.
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "diagram.js");

test("npm run diagram prints the code-generated diagram verbatim", () => {
  const out = execFileSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(out.trim(), stateDiagram().trim());
});

test("diagram --check passes when README is in sync", () => {
  // Derives the repo root from its own location, so this works regardless
  // of the caller's cwd; exit code 0 means in sync.
  const out = execFileSync(process.execPath, [CLI, "--check"], {
    encoding: "utf8",
  });
  assert.match(out, /in sync/);
});

test("every rendered diagram edge agrees with transition() behavior", () => {
  // Parse the mermaid lines back into edges: the diagram must never promise
  // a transition that transition() rejects, and must miss none.
  const rendered = new Map<string, string>();
  for (const line of stateDiagram().split("\n")) {
    const m = /^\s*(\w+) --> (\w+) : (\w+)$/.exec(line);
    if (m) rendered.set(`${m[1]}|${m[3]}`, m[2]);
  }
  const edges = transitionTable();
  assert.equal(rendered.size, edges.length);
  for (const { from, event, to } of edges) {
    assert.equal(
      rendered.get(`${from}|${event}`),
      to,
      `diagram missing/wrong: ${event} from ${from}`,
    );
    assert.equal(transition(from, event), to);
  }
});
