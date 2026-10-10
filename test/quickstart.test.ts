import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Guards the README Quickstart: the first code a new reader runs must
// actually run against the current API. The Quickstart ts block is
// extracted from README.md, its declared import specifier is resolved
// against the repo root (and must point at a file the build really
// produces), rewritten to that file's URL, and the result is executed
// with node. Any drift — renamed export, changed dispatch signature,
// broken chain, stale import path — makes this test fail and names
// the drift point.

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

function extractQuickstartBlock(): string {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  // Index-based section slicing (a lazy regex capture can legally match
  // empty here, so don't parse the section boundaries with one).
  const start = readme.indexOf("\n## Quickstart\n");
  assert.ok(start >= 0, "README drift: no ## Quickstart section found");
  const rest = readme.slice(start + "\n## Quickstart\n".length);
  const nextHeading = rest.indexOf("\n## ");
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  const fenceStart = section.indexOf("```ts\n");
  assert.ok(
    fenceStart >= 0,
    "README drift: Quickstart section has no ```ts code block to execute",
  );
  const codeStart = fenceStart + "```ts\n".length;
  const fenceEnd = section.indexOf("\n```", codeStart);
  assert.ok(
    fenceEnd >= 0,
    "README drift: Quickstart ts code block is not closed",
  );
  return section.slice(codeStart, fenceEnd + 1);
}

function quickstartEntryPoint(block: string): string {
  // The block's import specifier is resolved exactly as a reader at the
  // repo root would resolve it — if it points at a file the build does
  // not produce, that is the drift this test exists to catch. (It did:
  // the block once imported "./dist/index.js", but tsc emits the entry
  // at dist/src/index.js; the README was fixed, this pins the fix.)
  const spec = /from\s+"(\.[^"]+)"/.exec(block);
  assert.ok(spec, "README drift: Quickstart import has no relative specifier");
  const resolved = path.join(repoRoot, spec[1]);
  assert.ok(
    existsSync(resolved),
    `README drift: Quickstart imports "${spec[1]}", which does not exist after build`,
  );
  return resolved;
}

test("README Quickstart code block executes and ends in PAID", () => {
  const block = extractQuickstartBlock();
  const entry = quickstartEntryPoint(block);
  const spec = /from\s+"(\.[^"]+)"/.exec(block)![1];
  const snippet = block.replaceAll(spec, pathToFileURL(entry).href);

  const snippetPath = path.join(repoRoot, "dist", "quickstart-snippet.mjs");
  writeFileSync(snippetPath, snippet);
  try {
    const out = execFileSync("node", [snippetPath], { encoding: "utf8" });
    // The block's only output is `console.log(task.state)` and the
    // README annotates it `// PAID` — the run must agree exactly.
    assert.equal(
      out.trim(),
      "PAID",
      `Quickstart drift: expected final output "PAID", got ${JSON.stringify(out.trim())}`,
    );
  } catch (err) {
    assert.fail(
      `Quickstart drift: code block failed to execute: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    rmSync(snippetPath, { force: true });
  }
});

test("README Quickstart dispatches the full documented chain in order", () => {
  const block = extractQuickstartBlock();
  const events = [...block.matchAll(/dispatch\("([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(events, [
    "PUBLISH",
    "ACCEPT",
    "START_CAPTURE",
    "SUBMIT",
    "BEGIN_REVIEW",
    "APPROVE",
    "REQUEST_PAYOUT",
    "PAYOUT_COMPLETE",
  ]);
  // Every name the block imports must really be exported by the entry
  // point (the execution test above proves it too; this pinpoints the
  // drifted name in the failure message).
  const entry = quickstartEntryPoint(block);
  const imported = /import\s*\{([^}]*)\}\s*from/.exec(block);
  assert.ok(imported, "README drift: Quickstart import has no named imports");
  for (const name of imported[1].split(",").map((s) => s.trim()).filter(Boolean)) {
    assert.match(
      readFileSync(entry, "utf8"),
      new RegExp(`\\b${name}\\b`),
      `Quickstart drift: "${name}" is not referenced by dist/index.js`,
    );
  }
});
