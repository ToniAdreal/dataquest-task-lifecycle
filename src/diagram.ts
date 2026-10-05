/**
 * CLI: regenerate / verify the mermaid state diagram.
 *
 * Usage:
 *   npm run diagram                                     print the diagram block to stdout
 *   node dist/src/diagram.js --check                    exit 0 iff README.md embeds the exact block (exit 1 on drift)
 *   node dist/src/diagram.js --write docs/lifecycle.mmd  write bare mermaid source (no fences) to a file
 *
 * The diagram is rendered from transitionTable() — the single source of
 * truth — so docs can never drift from the code. Zero runtime dependencies:
 * this file only imports the state machine itself.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDiagram } from "./taskLifecycle.js";

const DIAGRAM = stateDiagram();
// Bare mermaid source for standalone .mmd files (fences stripped).
const MERMAID_SOURCE = DIAGRAM.replace(/^```mermaid\n/, "").replace(
  /\n```$/,
  "",
);

function repoRoot(): string {
  // Compiled file lives at dist/src/diagram.js -> repo root is two levels up.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** True iff README.md embeds the exact generated diagram block. */
export function readmeDiagramInSync(): boolean {
  const readme = readFileSync(join(repoRoot(), "README.md"), "utf8");
  return readme.includes(DIAGRAM);
}

function main(): void {
  const args = process.argv.slice(2);
  const writeIdx = args.indexOf("--write");
  if (writeIdx !== -1 && args[writeIdx + 1]) {
    const target = resolve(process.cwd(), args[writeIdx + 1]);
    writeFileSync(target, MERMAID_SOURCE + "\n", "utf8");
    console.log(`wrote mermaid diagram to ${target}`);
    return;
  }
  if (args.includes("--check")) {
    if (readmeDiagramInSync()) {
      console.log("README.md is in sync with the generated diagram.");
    } else {
      console.error(
        "README.md diagram drifted from code — run `npm run diagram` and paste the output.",
      );
      process.exit(1);
    }
    return;
  }
  console.log(DIAGRAM);
}

main();
