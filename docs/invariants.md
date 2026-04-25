# Runtime Invariants

These are runtime rules that must be enforced by code and tests, not only by agent prompts.

## Repository Contexts

- Every work target resolves to a Nostr kind `30617` repository announcement before worker handoff.
- Outside-owned announcements must resolve to an orchestrator-owned fork before worker handoff.
- A repo context must be leased to the exact worker/run before work starts.
- The same repo serializes by default; parallel same-repo work requires explicit `parallel` mode.
- Cleanup may only release a context when the lease still matches the run being cleaned up.
- Cleanup must not delete checkouts.

## Worker Boundaries

- The orchestrator is the only operator DM control-plane agent.
- Worker DMs from operators are not accepted as instructions.
- Worker Nostr inputs, such as triage issue events, are task inputs, not operator control.
- Provisioning sessions may prepare the repo only; they must not launch, enqueue, start, stop, or watch workers.

## Run Truth

- Operator-facing status reports effective state from live signals, not raw stored `running`.
- A run marked running with dead PIDs and no live dev URL is stale operationally.
- Browser status must not report a dead dev URL as a live web run.
- Run records must preserve phase timings, log paths, known PIDs, context identity, final state, and errors.

## Publish And Browser Checks

- Repo publish helpers require a resolved repo context or explicit agent and target.
- Repo publish helpers must use runtime relay policy for the selected repo scope.
- Web-mode success requires the dev server to be reachable before success is recorded.
- Runtime checks should produce exact invariant failure messages, not heuristic supervision.
