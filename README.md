# dataquest-task-lifecycle

Task lifecycle state machine for a two-sided human-data marketplace,
reproduced from the **DataQuest** portfolio case study (human-action data
marketplace for embodied AI). Covers the full path from task creation to
payout, plus the edge cases the case study calls out: **abandonment**,
**expiration**, and **dispute resolution**.

TypeScript, zero runtime dependencies.

## Install

Node.js ≥ 20.

```bash
npm install
npm run build
npm test   # 9 tests, all local
```

## Quickstart

```ts
import { TaskLifecycle } from "./dist/index.js";

const task = new TaskLifecycle("task-042");
task.dispatch("PUBLISH", { actor: "researcher" });
task.dispatch("ACCEPT", { actor: "contributor" });
task.dispatch("START_CAPTURE", { actor: "contributor" });
task.dispatch("SUBMIT", { actor: "contributor" });
task.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
task.dispatch("APPROVE", { actor: "reviewer", note: "meets rubric" });
task.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
task.dispatch("PAYOUT_COMPLETE", { actor: "system" });
console.log(task.state); // PAID
```

## State machine

```
DRAFT ──PUBLISH──▶ OPEN ──ACCEPT──▶ ACCEPTED ──START_CAPTURE──▶ CAPTURING
                                                              │ SUBMIT
                                                              ▼
                        ┌──────────────────────────────── SUBMITTED ──BEGIN_REVIEW──▶ IN_REVIEW
                        │                                                                   │ APPROVE
                        │ RESUBMIT                                                          ▼
                        │                                                              APPROVED ──REQUEST_PAYOUT──▶ PAYOUT_PENDING ──PAYOUT_COMPLETE──▶ PAID
                     REJECTED ◀──REJECT────────────────────────────────────────────────────┘
                        │ DISPUTE
                        ▼
                     DISPUTED ──ARBITRATE_APPROVE──▶ APPROVED
                        │ ARBITRATE_REJECT
                        ▼
                     REJECTED   (senior-moderator arbitration, per the case study's
                                 Dispute Resolution Center)

OPEN / ACCEPTED / CAPTURING / SUBMITTED ──EXPIRE──▶ EXPIRED
ACCEPTED / CAPTURING ──ABANDON──▶ ABANDONED
```

- `transition(state, event)` is a pure function; invalid transitions throw.
- `TaskLifecycle` wraps it with an append-only history (seq, event,
  from → to, ISO timestamp, actor, note).
- `allowedEvents(state)` / `isTerminal(state)` helpers for UI gating.
- Terminal states: `PAID`, `ABANDONED`, `EXPIRED`.

## Limitations (honest)

- **Off-chain reproduction.** The case study is a product-design artifact;
  this models the *rules* of the lifecycle, not a production backend. No
  persistence, no auth/RBAC, no deadline scheduler (expiry is an explicit
  event, not a timer), no notification fan-out.
- **Simplified arbitration.** One appeal round is modeled; production would
  bound appeals and add SLAs per state.
- **No reputation/quality scoring.** The case study's contributor tiers and
  earnings wallet are out of scope here.

## Reproducibility

`npm test` runs 9 tests covering the happy path, reject→resubmit,
dispute→arbitration (both outcomes), abandonment, expiration, invalid
transitions, and terminal-state locking. No network, no randomness in
assertions.

## License

MIT
