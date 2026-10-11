import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Guards the legacy package entry point (backlog #187, same scope as
// escrow #185): package.json used to declare `main: dist/index.js` /
// `types: dist/index.d.ts`, but tsc emits the entry at
// dist/src/index.js (the tsconfig include spans src/, test/ and
// bench/, so the common root is the repo root). Resolving through
// `main` therefore failed with ERR_MODULE_NOT_FOUND. Backlog #184
// fixed `main`/`types` while adding the `exports` map and covered
// the exports side in packageExports.test.ts; this file pins the
// `main`/`types` side specifically — exact declared layout, files
// existing after build, a usable core API imported through `main`
// alone, and the README Quickstart importing from that same path.

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

type PackageJson = {
  main?: string;
  types?: string;
};

function readPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as PackageJson;
}

test("package.json main/types point at the real build layout (dist/src/)", () => {
  const pkg = readPackageJson();
  assert.equal(pkg.main, "dist/src/index.js");
  assert.equal(pkg.types, "dist/src/index.d.ts");
});

test("every declared main/types entry file exists after build", () => {
  const pkg = readPackageJson();
  for (const target of [pkg.main, pkg.types]) {
    assert.ok(target, "entry target must be declared");
    const resolved = path.join(repoRoot, target);
    assert.ok(
      existsSync(resolved),
      `declared entry "${target}" does not exist after build`,
    );
  }
});

test("importing via the declared main entry exposes a usable core API", async () => {
  const pkg = readPackageJson();
  assert.ok(pkg.main);
  const mod = (await import(
    pathToFileURL(path.join(repoRoot, pkg.main)).href
  )) as Record<string, unknown>;
  assert.equal(typeof mod.TaskLifecycle, "function");

  // The imported API must actually work, not just exist: drive a
  // task through the first Quickstart steps via the main entry.
  const TaskLifecycle = mod.TaskLifecycle as new (id: string) => {
    state: string;
    dispatch: (event: string, opts: { actor: string }) => void;
  };
  const task = new TaskLifecycle("entry-smoke-1");
  assert.equal(task.state, "DRAFT");
  task.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(task.state, "OPEN");
});

test("README Quickstart imports from the declared main entry path", () => {
  const pkg = readPackageJson();
  assert.ok(pkg.main);
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.ok(
    readme.includes(`from "./${pkg.main}"`),
    `README Quickstart must import from "./${pkg.main}" (the declared main entry)`,
  );
  assert.ok(
    !readme.includes('from "./dist/index.js"'),
    "README must not reference the non-existent dist/index.js entry",
  );
});
