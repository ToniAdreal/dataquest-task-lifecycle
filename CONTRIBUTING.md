# Contributing

Thanks for looking at the code. This repository is an off-chain
reproduction of the DataQuest task lifecycle (a two-sided human-data
marketplace case study) — see `README.md` → "Limitations (honest)" for
what it is and is not, and `SECURITY.md` for the trust boundaries.
Contributions are held to the same honesty bar as the docs: if a claim
is in here, it has been run.

## Prerequisites

- Node.js ≥ 20 (declared in `package.json` → `engines`). CI runs the
  test suite on Node 20 and 22 (`.github/workflows/ci.yml`).
- npm. There is nothing else to install: the implementation uses only
  Node built-ins (`node:crypto` for the audit hash chain and the payout
  webhook signatures), and the only dev dependencies are `typescript`
  and `@types/node`.

## Setup

```bash
npm install
npm test
```

`npm test` first builds the project (`npm run build`, i.e. `tsc`) and
then runs the compiled tests with `node --test dist/test/*.test.js`.
Tests therefore always exercise the build output in `dist/` (which is
git-ignored), never the TypeScript sources directly — after editing
`src/` or `test/`, just re-run `npm test`.

Three more entry points worth knowing:

```bash
npm run demo     # one task through the full DRAFT → PAID chain, audit history printed
npm run diagram  # print the mermaid state diagram generated from transitionTable()
npm run bench    # measure local throughput of the hot paths (builds first, then runs dist/bench/bench.js)
```

`npm run diagram` only prints. To verify the copy embedded in
`README.md`, run `node dist/src/diagram.js --check` after a build
(exit 0 iff in sync); `--write <file>` writes bare mermaid source for
standalone `.mmd` use.

## Repository layout

- `src/` — the library: `taskLifecycle.ts` (state machine, audit hash
  chain, snapshots, replay), `settlementWebhook.ts` (payout webhook
  build / verify / delivery), `ndjson.ts` (history export/import),
  `index.ts` (public exports), plus `demo.ts` and `diagram.ts` behind
  the npm scripts above.
- `test/` — `node:test` suites, one file per feature area.
- `bench/bench.ts` — the benchmark behind `npm run bench`.

## Hard rules

1. **Zero runtime dependencies.** `package.json` must not gain a
   `dependencies` section. New code uses Node built-ins only;
   TypeScript tooling stays in `devDependencies`.
2. **Strict TypeScript, ESM.** `tsconfig.json` builds with
   `strict: true` and `module`/`moduleResolution: NodeNext`. Keep
   import specifiers NodeNext-compatible (explicit `.js` extensions).
3. **Honest numbers and claims.** The test count quoted in
   `README.md` → "Reproducibility" must equal what `npm test`
   actually prints — if you add or remove tests, update it to the
   real output. Benchmark figures must come from a real
   `npm run bench` run, dated like the existing table in
   `README.md` → "Benchmarks"; never pre-fill, round into place, or
   copy numbers from another environment.
4. **Honest scope wording.** Two points are easy to overstate — don't:
   an SLA deadline is advisory only (the library has no scheduler;
   expiry is an explicit `EXPIRE` dispatch, see `README.md` → "SLA
   deadlines"), and a payout webhook is a signed notification, not a
   payment (this library holds no real money and executes no payment;
   see `SECURITY.md`). Docs, comments, and commit messages must keep
   that wording accurate.
5. **Generated artifacts stay in sync with the code.** The state
   diagram is generated from `transitionTable()` — never edit the
   README copy by hand; regenerate it with `npm run diagram`.
   `test/stateDiagram.test.ts` and `test/diagram.test.ts` fail if the
   embedded diagram or any rendered edge drifts from `transition()`
   behavior, and `test/transitionSnapshot.test.ts` fails if the
   transition table changes without regenerating the committed
   snapshot (`test/__snapshots__/transitionTable.snapshot.json`).
6. **Deterministic, offline tests.** Assertions must not depend on
   the external network or unseeded randomness. Where behavior
   depends on time, inject it (the `at` dispatch option, the `now`
   parameters of the watchdog/SLA helpers) instead of reading the
   wall clock.
7. **Audit-history integrity is load-bearing.** History is
   append-only and hash-chained, and snapshots are validated
   fail-closed on rehydration (schema version `v: 1`, unknown fields
   rejected, chain re-verified — see `SECURITY.md`). Changes to the
   canonical serialization, the snapshot shape, or chain semantics
   need tests covering both the acceptance and the rejection paths.

## Before submitting a change

- [ ] `npm test` — the full suite passes.
- [ ] `npx tsc --noEmit` — clean (no type errors). There is no lint
      or formatter step configured in this repo; the strict `tsc`
      build is the static gate, so don't add instructions that assume
      one.
- [ ] If tests were added or removed, the `README.md` test count
      matches the real `npm test` output.
- [ ] If transitions changed, `node dist/src/diagram.js --check`
      passes (after a build) and the transition-table snapshot is
      regenerated.
- [ ] If the benchmark table was touched, its numbers come from a
      real `npm run bench` run, with the run date and environment
      noted.
- [ ] If the lifecycle or dispatch paths changed, `npm run demo`
      still runs the full `DRAFT → PAID` chain end to end.

## Commit style

Commit messages are in English and follow Conventional Commits, as in
the existing history — one focused change per commit:

```
feat: carry quotedAmount in the payout webhook payload
test: pin payout webhook field set after identifier audit
docs: add honest README FAQ on scope, SLA, webhooks, and storage
bench: measure payout reconciliation screening over a 12-task batch
ci: run tests on push and pull requests (Node 20/22)
```

Use the prefix that matches the change (`feat:` / `fix:` / `test:` /
`docs:` / `bench:` / `ci:` / `chore:`) and describe what actually
changed — a subject that overstates the diff is treated like any
other unverified claim.

## Reporting a security issue

Follow `SECURITY.md` → "Reporting a security issue": open an issue on
this repository describing the problem. Never include secrets,
private keys, or any credentials in a report — a description of the
behavior is enough.
