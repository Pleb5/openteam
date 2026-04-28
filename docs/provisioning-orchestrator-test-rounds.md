# Provisioning and Orchestrator Test Rounds

Date: 2026-04-27

Goal: add broad executable coverage that reduces failed runs around repository provisioning, orchestrator task control, reporting, DMs, and observability.

Primary test file added:

- `tests/provisioning-orchestrator-e2e.test.ts`

Baseline before adding the new file:

- Command: `bun test ./tests`
- Result: 110 pass, 0 fail

Final verification after all rounds:

- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts`
- Result: 81 pass, 0 fail
- Command: `bun test ./tests`
- Result: 191 pass, 0 fail
- Command: `bun run check`
- Result: pass

## Round 1 - Repo Identity and Fork Planning

Designed and ran 9 tests for:

- canonical `30617:<npub>:<d>` repo references
- direct `<npub>/<repo>` repo references
- clone URL extraction from announcement content
- invalid announcements missing `d`
- relay normalization and deduplication
- relay hints from direct Nostr targets
- fork clone template expansion
- rejection of non-smart-HTTP upstream clone URLs
- fork announcement tags for upstream/default-branch linkage

Result:

- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 1 -"`
- 9 pass, 0 fail

Findings:

- Repo/fork planning behavior is deterministic and fast enough to test without network.
- Direct target relay hints and fork tags are good early indicators that workers will see the right repo workflow context.

Follow-up design from learning:

- Move from pure identity planning into real temporary Git repo resolution and lease creation.

## Round 2 - Repo Context Leasing and Provisioning Handoff

Designed and ran 8 tests for:

- resolving cached Nostr repo announcements into leased checkouts
- reusing idle same-commit contexts for serial work
- creating separate contexts for explicit parallel work
- blocking serial work when a context is actively leased
- avoiding reuse across mode mismatches
- failing continuations with missing prior context
- failing continuations with missing checkout
- failing continuations with mode mismatch

Result:

- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 2 -"`
- 8 pass, 0 fail

Findings:

- Temporary Git repos exercise the real mirror/checkout path without external network.
- Continuation preflight catches the most important bad handoffs before worker launch.

Follow-up design from learning:

- Add guardrail coverage for the provisioning phase itself, especially recursive worker-control attempts and missing checkout tooling.

## Round 3 - Provisioning Guardrails and Checkout Runtime

Designed and ran 8 tests for:

- blocking `launch` during provisioning
- blocking unknown worker-control commands during provisioning
- allowing safe inspection commands during provisioning
- detecting `bun run src/cli.ts launch`
- detecting script-based worker commands
- allowing repo policy inspection
- confining temp/cache/artifact paths to checkout runtime dirs
- requiring openteam shim, verification plan, and verification results before handoff

Result:

- Initial run had 1 test assertion failure: the scanner returned `openteam worker`, not the longer `scripts/openteam worker` fragment.
- Refined the test to assert command detection rather than exact matched substring.
- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 3 -"`
- 8 pass, 0 fail

Findings:

- The product behavior was correct; the first assertion was too specific about the regex match.
- Checkout runtime preparation has a compact, high-value preflight surface.

Follow-up design from learning:

- Add stale-run and cleanup tests to verify bad provisioning/worker outcomes produce actionable runtime state instead of leaked leases.

## Round 4 - Run Diagnosis and Stale Cleanup

Designed and ran 8 tests for:

- running records without pids
- running records with dead pids
- live runner pid detection
- succeeded records with hard OpenCode failures
- terminal runs that still hold matching leases
- terminal logs with verification blockers
- stale cleanup releasing matching leases
- stale cleanup preserving mismatched leases

Result:

- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 4 -"`
- 8 pass, 0 fail

Findings:

- Effective state is correctly derived from live signals and logs, not just stored run state.
- Lease cleanup is conservative: it releases only matching holders and avoids stealing another run's context.

Follow-up design from learning:

- Expand coverage around evidence quality and publication gates, because many failed runs become ambiguous at the "worker succeeded but evidence is weak" boundary.

## Round 5 - Evidence Gates and Publication Decisions

Designed and ran 8 tests for:

- strong bug-fix command evidence with logs
- weak command evidence without substantive artifact
- failed verification blocking normal PR publication
- blocked browser verification producing `needs-review`
- QA negative verdicts satisfying report-only contracts
- Nostr event evidence grouping
- explicit draft publication with incomplete evidence
- run evidence view surfacing missing UI evidence and PR blockers

Result:

- Initial run had 1 test assertion failure due capitalization in missing evidence wording.
- Refined the assertion to check semantic browser evidence rather than exact case.
- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 5 -"`
- 8 pass, 0 fail

Findings:

- Evidence policies are doing the most important reliability work: they prevent weak or failed evidence from being reported as normal completion.
- Test assertions should avoid coupling to wording that is not part of the operator contract.

Follow-up design from learning:

- Add observation and DM policy coverage so repeated weak-evidence states do not become repeated noisy reports.

## Round 6 - Observations and DM Reporting Policy

Designed and ran 8 tests for:

- initial observation event emission
- evidence transitions from none to strong
- needs-review filtering
- family-level suppression of repeated needs-review categories
- reporting new needs-review categories within the same family
- warning throttling in digest mode
- digest grouping and pending-item clearing
- failed task reports pointing at `runs show`

Result:

- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 6 -"`
- 8 pass, 0 fail

Findings:

- Family-level report suppression already protects operators from repeated same-category needs-review reports.
- New failure categories still report, which is the right operator-facing distinction.

Follow-up design from learning:

- Cover continuation generation and family-key ancestry, because reporting suppression depends on accurate family identity.

## Round 7 - Continuation and Repair Flows

Designed and ran 8 tests for:

- repair-evidence task wording
- base agent id reuse for runtime-id runs
- carrying only successful prior evidence
- disabling evidence carry while preserving prompt context
- prompt details for prior state/category/blockers/evidence
- family key ancestry to root run
- family fallback when parent file is unavailable
- normal continue task wording

Result:

- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 7 -"`
- 8 pass, 0 fail

Findings:

- Continuations preserve enough context for focused repair while avoiding failed/blocked evidence carry.
- Family-key fallback is safe when older run files are missing, but this is also where future attempt budgeting should attach.

Follow-up design from learning:

- Add orchestrator DM command parsing coverage to reduce accidental worker starts from ambiguous operator requests.

## Round 8 - Orchestrator Command Routing

Designed and ran 8 tests for:

- `?` help parsing
- status aliases
- quoted stop targets
- start commands with mode and model
- watch default role
- work default role and parallel flag
- plan shortcut conversion to researcher task
- unmatched requests falling back to conversational handling

Result:

- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 8 -"`
- 8 pass, 0 fail

Findings:

- Fast command grammar can be tested without spawning workers.
- Unmatched requests safely fall back instead of being mis-parsed into lifecycle actions.

Follow-up design from learning:

- Add verification planning and project-profile tests so the provisioning phase knows whether it can produce useful evidence.

## Round 9 - Verification Planning and Project Profile Coverage

Designed and ran 8 tests for:

- undefined runner references
- browser runner unavailable without MCP command
- result append and reset ordering
- manual browser evidence shape
- browser runner requiring explicit worker-recorded evidence
- local command runner success artifacts
- Nix flake wrapping
- workspace protocol dependency blockers

Result:

- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 9 -"`
- 8 pass, 0 fail

Findings:

- Verification planning reports missing capability rather than silently pretending a runner can execute.
- Workspace protocol blockers are visible during profile detection, which is important for provisioning repo roots instead of submodules alone.

Follow-up design from learning:

- Add top-level runtime/status tests so operators see derived truth from worker records, live workers, leases, and cleanup state.

## Round 10 - Status and Observability Surfaces

Designed and ran 8 tests for:

- live orchestrator worker counting
- dead worker pruning
- effective failed run counting
- stale leased contexts without matching live runs
- matching live running lease suppression
- status report stale run summaries
- invalid run JSON tolerance
- cleanup metadata preservation

Result:

- Command: `bun test ./tests/provisioning-orchestrator-e2e.test.ts -t "Round 10 -"`
- 8 pass, 0 fail

Findings:

- Runtime status is built from effective run summaries and live worker signals.
- Invalid run files do not break status collection.
- Cleanup metadata persists across refreshes, which supports operator trust in reconciliation history.

## Residual Gaps

- These tests do not launch real detached OpenCode workers.
- Provider-backed fork creation is not mocked yet, so GitHub/GitLab/GRASP API failure paths still need contract tests.
- Browser verification is covered as structured evidence and capability planning, not by launching a real browser session here.
- DM relay publish/retry behavior remains outside this local deterministic test set.
