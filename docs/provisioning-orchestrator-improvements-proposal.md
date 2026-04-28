# Provisioning and Orchestrator Stability Improvements

Date: 2026-04-27

Scope: provisioning repositories, orchestrator role behavior, reporting, DMs, and observability. The core goal is fewer failed or misleading runs.

## Current Strengths

- Repo context leasing is conservative: serial work blocks on active leases, explicit parallel work gets a separate context, and stale cleanup releases only matching leases.
- Continuation preflight catches missing contexts, missing checkouts, busy contexts, and mode mismatches before worker launch.
- Provisioning mode blocks recursive worker-control commands and prepares checkout-local temp, cache, artifact, and verification paths.
- Evidence policy prevents normal success and PR publication when worker evidence is missing, weak, failed, or blocked.
- Runtime status and run summaries report effective state from live process, URL, log, verification, and lease signals.
- DM reporting can suppress repeated same-family needs-review reports while still reporting a new failure category.

## Proposal

1. Add durable run-family attempt policy.

   Persist a small `runtime/orchestrator/run-families.json` record keyed by root run id. Store attempt count, last failure category, last evidence level, last recommended action, and last launched command. Refuse or require explicit operator confirmation when a family repeats the same failure category twice, or when a continuation task does not state what changed.

2. Promote provisioning into an explicit state machine.

   Track `provisionState`, `provisionFailureCategory`, `projectProfilePath`, and `verificationToolingReady` on the run record. Treat missing checkout tooling, recursive worker-control detection, workspace dependency blockers, and dev-env wrapper failures as provisioning terminal states instead of generic task failures.

3. Add provider/fork contract tests with mocked APIs.

   Cover GitHub create, GitHub existing repo, GitLab create, GitLab conflict/existing lookup, auth failure, empty token, GRASP publish-before-push, and push failure aggregation. These are currently the highest-risk provisioning paths not exercised by local deterministic tests.

4. Make lease reconciliation a first-class background action.

   The status path detects stale leases today. Add a periodic reconciler that can dry-run by default, emit one digest item per stale context, and optionally clean leases that match terminal or stale run records. Keep the current expected-lease guard.

5. Add DM outbox persistence and retry accounting.

   Store report attempts with event type, run id, family key, recipient, body fingerprint, relay result, and retry count. This makes reporting reliability observable and prevents duplicate DMs after a transient relay failure.

6. Expand operator status around run families.

   Add family summary fields to `status`, `runs list`, and observation digests: root run id, attempts, latest category, evidence level, PR eligibility, and next command. This helps the orchestrator report blockers instead of repeatedly launching similar repair tasks.

7. Tighten continuation launch gates.

   Before `runs continue` or `runs repair-evidence`, check family attempt history, context lease state, checkout existence, mode, current evidence policy, and whether the new task is materially different. For same-category repeated failures, default to a report-only blocker.

8. Strengthen verification collection after worker exit.

   If `autoRunAfterWorker` is enabled, record runtime-produced verification results separately from worker-produced evidence and make the final report distinguish them. Workers should still be responsible for task-specific evidence, but runtime checks can catch regressions before stale or misleading success reports.

9. Add a reliability fixture suite for process lifecycle.

   Build fake long-running worker processes and fake dev servers to test signal handling, stale detection thresholds, dev URL recovery, restart metadata, and terminal cleanup without depending on OpenCode.

10. Improve observability metrics.

   Add counters for provisioning failures by category, worker hard failures, verification blockers, stale cleanup count, repeated family attempts, suppressed DM reports, digest sends, and DM publish failures. Emit them into `runtime/status.json` first; a Prometheus/exporter layer can come later.

## Suggested Priority

1. Run-family attempt policy and continuation gates. Status: implemented in `src/run-family-policy.ts`, wired into `runs continue` and `runs repair-evidence`, and covered by Round 7 tests in `tests/provisioning-orchestrator-e2e.test.ts`.
2. Provider/fork mocked contract tests. Status: implemented with mocked GitHub/GitLab API fetchers, GRASP publish-before-push coverage, empty-token filtering, auth failure reporting, and fork push failure aggregation in `tests/repo.test.ts`.
3. Provisioning state fields and failure categories. Status: implemented with `provisionState`, `provisionFailureCategory`, `projectProfilePath`, and `verificationToolingReady` on run records, categorized provisioning terminal failures in `src/launcher.ts`, and summary/diagnosis visibility in `runs list` / `runs diagnose`.
4. DM outbox persistence and retry accounting. Status: implemented in `src/dm-outbox.ts` and wired into runtime report sends, with durable recipient-level attempts, report metadata, body fingerprints, relay outcome, and retry counts.
5. Process lifecycle reliability fixtures. Status: implemented in `tests/process-lifecycle.test.ts` with healthy/unhealthy dev endpoint fixtures, live/dead PID signals, stale activity thresholds, and terminal cleanup/lease release coverage.

These changes would turn the current diagnostic surface into an active reliability control loop: detect bad states, avoid repeating the same failed action, and tell the operator exactly what needs a different intervention.
