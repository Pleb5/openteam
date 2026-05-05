# Runtime Invariants

These are runtime rules that must be enforced by code and tests, not only by agent prompts.

## Repository Contexts

- Every work target resolves to a Nostr kind `30617` repository announcement before worker handoff.
- Outside-owned announcements must resolve to an orchestrator-owned fork before worker handoff.
- A repo context must be leased to the exact worker/run before work starts.
- The same repo serializes by default; parallel same-repo work requires explicit `parallel` mode.
- Cleanup may only release a context when the lease still matches the run being cleaned up.
- Cleanup must not delete checkouts.
- New non-continuation runs must refresh the repo mirror/object cache before selecting their base commit.
- Idle contexts may be reused only when their recorded `baseCommit` still matches the freshly resolved base for the same repo and mode.
- Continuations must preserve the prior checkout and must not fetch, rebase, or mutate the base automatically.

## Worker Boundaries

- The orchestrator is the only operator DM control-plane agent.
- Worker DMs from operators are not accepted as instructions.
- Worker Nostr inputs, such as triage issue events, are task inputs, not operator control.
- Runtime-owned DM reporting uses the orchestrator identity; workers must not improvise operator status DMs.
- `reporting.allowFrom` grants inbound DM authority, while `reporting.reportTo` controls default job report recipients.
- Provisioning sessions may prepare the repo only; they must not launch, enqueue, start, stop, or watch workers.
- Worker temp files, caches, repro clones, and generated artifacts should stay under checkout-local `.openteam/` runtime paths.
- Worker Git pushes from managed checkouts must use openteam provider-token credentials for the fork remote, not ambient user credential helpers.
- If a checkout declares a Nix dev environment, openteam-launched provisioning, worker, and dev-server processes should run through that environment.
- Project-profile detection provides setup and validation hints only; it must not override repo docs, declared scripts, or declared development environments.
- Nostr-git PR publication must not depend on personal `gh auth`; default publication is branch push plus `openteam repo publish pr ...`.
- Workers should report blockers instead of using GUI openers, system package installs, writes outside checkout/runtime, or broad destructive cleanup.

## Run Truth

- Operator-facing status reports effective state from live signals, not raw stored `running`.
- A run marked running with dead PIDs and no live dev URL is stale operationally.
- A run marked succeeded with an OpenCode infrastructure hard failure in its log is failed operationally.
- A run marked succeeded with `workerState: "failed"` or `verificationState: "failed"` is failed operationally.
- Browser status must not report a dead dev URL as a live web run.
- Run records must preserve phase timings, log paths, known PIDs, context identity, final state, and errors.
- `runtime/status.json` is generated observability state only; run records and the repo registry remain authoritative.
- Stale lease counts in `runtime/status.json` must be derived from effective run state, not raw stored run state.

## Publish And Browser Checks

- Repo publish helpers require a resolved repo context or explicit agent and target.
- Repo publish helpers must use runtime relay policy for the selected repo scope.
- Repo publish contexts must include a valid checkout path, repo identity, agent id, target, and unambiguous publish scope.
- Web-mode success requires the dev server to be reachable before success is recorded.
- Web-mode runs may restart the dev server once after a successful worker phase when final verification fails; the recovery attempt must be visible in run phases and dev-server metadata.
- If the worker succeeds but the dev server cannot be recovered, the run must fail with an explicit verification failure category instead of reporting task success.
- `.openteam/verification-plan.json` describes selected runner capability; runner execution proof must come from `verification.results` and runner logs.
- Browser, Nostr, GUI, desktop, and mobile evidence should use structured result fields rather than only vague prose when those fields apply.
- Workers are responsible for invoking or recording verification evidence during their loop; automatic post-worker runner execution must stay opt-in.
- Worker-recorded failed or blocked verification evidence must fail the run after worker handoff; skipped runners are informational.
- Each new worker run should have a done contract describing required evidence, success policy, and PR policy.
- A successful worker phase with missing or weak evidence must finish as `needs-review`, not plain `succeeded`.
- Normal PR publication should be gated on strong worker-produced verification evidence unless the task explicitly asks for draft/WIP output.
- Normal PR publication and PR update publication must block when the checkout-local base snapshot is stale; draft/WIP and dry-run paths may report stale-base metadata without blocking.
- Run observation must be deterministic and side-effect-light: observation may write `runtime/orchestrator/observations.json` and reports, but it must not mutate run records, start workers, stop workers, or clean leases.
- Guarded mobile-native runners must not install SDKs, boot emulators, create simulators, or write outside the managed checkout/runtime.
- Runtime checks should produce exact invariant failure messages, not heuristic supervision.
