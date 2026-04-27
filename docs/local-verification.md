# Agentic Local Verification

openteam verification is worker-facing agentic tooling, not a CI replacement.
The orchestrator provisions, launches, observes, and collects evidence; workers use verification tools during their task loop until they are confident enough to return a result.

The expected loop is:

1. inspect the task, repo, docs, and project profile
2. reproduce or understand the target behavior
3. edit or investigate
4. verify with repo-native checks, browser/GUI tools, live Nostr data, or native-device tools as appropriate
5. record concise evidence with `openteam verify run ...` or `openteam verify record ...`
6. continue until success, a clear blocker, or serious uncertainty is reached

Deterministic CI is still useful, but it is not the main openteam mechanism.
openteam's advantage is long-running async worker jobs with real tools, real accounts, real repo access, Nostr observability, and evidence that the operator can inspect later.

## Current Capability Inventory

The existing verification system already gives workers these capabilities:

- per-run `.openteam/project-profile.json` with detected docs, stacks, likely commands, and setup blockers
- per-run `.openteam/verification-plan.json` with selected runner metadata
- `repo-native` command evidence through `openteam verify run repo-native`
- stack-triggered runner selection for web, desktop, Electron, Tauri, GTK, Qt, Android, and iOS candidates
- Nix/dev-env wrapping for provisioning, workers, dev servers, and verification runner commands
- managed command logs under `.openteam/artifacts/verification/`
- worker evidence recording with `openteam verify record`
- browser evidence recording with `openteam verify browser`
- generic artifact recording with `openteam verify artifact`
- URL health checks for browser evidence when requested
- Playwright MCP capability planning for web-mode browser validation
- explicit `desktop-command` runner metadata for configured desktop smoke/build/test commands
- guarded mobile-native runner blockers for Android ADB and iOS simulator, disabled by default
- run evidence collection into run records after worker handoff
- failed or blocked worker verification evidence fails the run
- missing or weak evidence turns otherwise successful work into `needs-review`
- `runs evidence`, `runs observe`, and `runs watch` views for evidence level, missing evidence, and PR eligibility
- PR publication gating on strong evidence unless draft/WIP publication is explicit
- evidence repair and continuation flows that carry prior successful evidence forward

Current gaps:

- CLI products are treated as repo-native commands, not as interactive software with terminal transcripts and behavioral assertions.
- Desktop software can be represented by configured commands, but openteam does not yet manage a GUI session, capture window state, take desktop screenshots, or drive interactions.
- Browser verification has a good agentic path through Playwright MCP, but equivalent CLI and desktop flows still need first-class worker commands.
- Mobile-native runners exist only as guardrails and are not part of the next focus.

## Phase 1: Runner Foundation

Status: implemented as planning and observability only.

Phase 1 adds a first-class verification capability plan:

- `verification.defaultRunners` chooses runner ids by task mode.
- `verification.runners` defines local runner capabilities.
- every new managed run writes `.openteam/verification-plan.json` in the checkout.
- run records store `verification.planPath` and the selected runner metadata.
- `runs list`, `runs show`, `runs diagnose`, and `browser attach` expose the planned runners and collected results.
- config validation detects missing runner references, invalid runner kinds, invalid modes, invalid timeouts, and unavailable browser runner configuration.

Default local runners:

- `repo-native`: repo docs/scripts/project-profile driven checks; planned for code and web runs.
- `browser`: local Playwright MCP browser validation; planned for web runs.
- `desktop-command`: enabled by default for detected desktop stacks, but only executes explicit configured commands.
- `android-adb`: disabled by default; reserved for guarded local Android emulator/device verification.
- `ios-simulator`: disabled by default; reserved for guarded local iOS simulator verification.

Important invariant: the plan is capability metadata, not evidence.
Execution evidence lives in `.openteam/verification-results.json`, run-record `verification.results`, and linked artifacts/logs.

## Phase 2: Local Runner Execution

Status: implemented as worker-invoked local command execution, worker evidence recording, desktop command metadata, and guarded mobile-native blockers.

Phase 2 makes local verification adapters available to workers through `openteam verify`:

1. `openteam verify list` shows available verification capabilities for the current checkout.
2. `openteam verify run <runner-id>` runs configured local command/native checks and writes one log per command under `.openteam/artifacts/verification/`.
3. command runners run inside the detected dev environment, using the same Nix/dev-env wrapper as worker and provisioning processes.
4. explicit configured runner commands take precedence; `repo-native` can fall back to the smallest project-profile command hint.
5. `openteam verify record <runner-id> --state ... --note ...` lets workers record evidence from browser MCP, desktop GUI use, Nostr live-data checks, or other agentic verification they performed directly.
6. `desktop-command` supports desktop software smoke/build/test flows that can run locally from explicit repo-native commands.
7. `android-adb` and `ios-simulator` are guarded and disabled by default.

Worker-facing commands:

```bash
openteam verify list
openteam verify run repo-native
openteam verify browser --flow "repo grid light theme" --url "$OPENTEAM_DEV_URL" --screenshot .openteam/artifacts/playwright/repo-grid-light.png --dev-health
openteam verify artifact .openteam/artifacts/nostr/comment.json --type nostr --runner repo-comment --event-id nevent1...
openteam verify record browser --state succeeded --note "Verified login and repo creation in browser with worker Nostr account."
openteam verify record desktop-command --state blocked --blocker "No local display server available for the configured desktop smoke test."
```

Runner results record:

- runner id and kind
- source: `worker`, `runtime`, or `operator`
- state, start time, finish time, and duration
- command, cwd, exit code, and signal when applicable
- evidence type: repo-native, browser, Nostr, desktop, mobile, manual, or runtime
- artifact/log paths
- screenshots, URL, flow name, console summary, network summary, and Nostr event ids when supplied
- notes from agentic verification
- blocker category when the runner cannot execute

By default, openteam does not run local verification after the worker exits.
`verification.autoRunAfterWorker` defaults to `false`.
The launcher only collects worker-produced verification evidence and uses failed/blocked worker evidence to mark the run failed.
Automatic post-worker runner execution is an escape hatch, not the default architecture.

The web-mode final dev-server health check remains a runtime sanity check.
It is not a substitute for worker browser verification.

## Phase 3: Evidence Gates and Publication Policy

Status: implemented for run finalization, run evidence reporting, and Nostr-git PR publication helpers.

The runtime now classifies collected evidence as:

- `strong`: enough worker-produced evidence for the task class
- `weak`: some evidence exists, but it is not enough for normal completion/publication
- `none`: no successful verification evidence was recorded
- `blocked`: the worker recorded a verification blocker
- `failed`: the worker recorded failed verification

When the OpenCode worker exits successfully but evidence is `weak` or `none`, openteam records the run as `needs-review` instead of plain `succeeded`.
This keeps local state intact and tells the orchestrator/operator that follow-up verification or continuation is needed.

Normal `openteam repo publish pr ...` and `openteam repo publish pr-update ...` are guarded by the same policy.
They require strong evidence from the active run or checkout.
For builder UI/web work, strong evidence means both browser-visible behavior evidence and repo-native command evidence.
If evidence is incomplete, the helper blocks normal PR publication and explains the missing evidence.
Draft/WIP publication must be explicit with `--draft`, `--wip`, or a `draft`/`wip` label.

Use:

```bash
openteam runs evidence <run-id>
```

to inspect the done contract, evidence level, missing evidence, PR eligibility, artifacts, and recommended next action.

## Phase 4: Evidence Artifact Capture and Browser UX

Status: implemented as local structured evidence capture.

Workers can now record browser evidence without inventing a freeform schema:

```bash
openteam verify browser \
  --flow "repo grid light theme" \
  --url "$OPENTEAM_DEV_URL" \
  --screenshot .openteam/artifacts/playwright/repo-grid-light.png \
  --console "No console errors during the checked flow." \
  --network "No failed git metadata requests." \
  --dev-health
```

`verify browser` records a `browser` evidence result with URL, flow name, screenshots, console/network summaries, optional URL health, and any additional artifacts.
It does not drive the browser itself; the worker still uses Playwright MCP or direct GUI tools, then records what was verified.

Workers can also attach artifacts directly:

```bash
openteam verify artifact .openteam/artifacts/nostr/comment.json \
  --type nostr \
  --runner repo-comment \
  --event-id nevent1... \
  --note "Published repo-visible issue comment with repro verdict."
```

`verify record` accepts the same structured fields:

- `--type <repo-native|browser|nostr|desktop|mobile|manual|runtime>`
- `--artifact <path>`
- `--screenshot <path>`
- `--url <url>`
- `--flow <name>`
- `--console <text>` or `--console-file <path>`
- `--network <text>` or `--network-file <path>`
- `--event-id <id>`
- `--dev-health` / `--check-url`

`runs evidence` groups evidence by type so the orchestrator can quickly see whether a task has repo-native checks, browser/UI proof, Nostr event proof, desktop/mobile proof, or only manual notes.

The run observer uses the same evidence view during polling.
`openteam runs observe <run-id>` shows the current effective state, live signals, evidence level, PR eligibility, and recommended action for one run.
`openteam runs watch --active` prints only transitions across recent runs.
The long-running orchestrator service persists the same last-seen observation state under `runtime/orchestrator/observations.json`.

Evidence repair:

```bash
openteam runs repair-evidence <run-id>
openteam runs continue <run-id> --task "finish the remaining work and verify it"
```

These commands reuse the prior idle repo context and inject prior evidence, missing requirements, and PR blockers into the worker prompt.
Only prior successful evidence is copied into the new checkout's verification results; failed or blocked prior results are prompt context that the worker must replace with fresh evidence.
If the context is still busy, continuation fails instead of taking over another active run's lease.

Mobile-native guard policy:

- `android-adb` only runs when enabled, `adb` is on PATH, a device/emulator is already connected, and an explicit command is configured.
- `ios-simulator` only runs when enabled, the host is macOS, `xcrun` is on PATH, a simulator is already booted, and an explicit command is configured.
- mobile runners never install Android Studio, Xcode, emulators, SDKs, system packages, or write outside the managed checkout/runtime.

## Phase 5: CLI Product Verification

Status: next low-hanging phase.

CLI applications need a product-verification path separate from plain build/test commands.
The goal is to let a worker prove command-line behavior with a reproducible transcript, input script, exit status, and task-specific assertions.

Add a `cli` evidence type and a `cli-session` runner kind.
The runner should execute inside the same checkout, environment, temp/cache directories, and dev-env wrapper as `repo-native`.
It should write artifacts under `.openteam/artifacts/verification/cli/`.

Worker-facing commands:

```bash
openteam verify cli --flow "login rejects invalid token" -- npm run app -- login --token bad
openteam verify cli --flow "wizard creates config" --stdin-file .openteam/artifacts/verification/cli/wizard-input.txt --expect "created" -- ./bin/myapp init
openteam verify cli --runner cli-smoke --flow "help output lists repo commands" --expect "repo publish" -- openteam --help
```

Phase 5 scope:

- run arbitrary task-scoped CLI commands after `--`
- optionally attach the evidence to a configured runner id
- record command, cwd, environment summary, exit code, signal, timeout, and duration
- record stdout/stderr transcript paths as artifacts
- support `--stdin` and `--stdin-file` for simple interactive prompts
- support `--expect <regex>` and `--reject <regex>` assertions against the transcript
- support `--cwd <relative-path>` while still requiring the path to stay inside the checkout
- support `--timeout-ms`
- mark assertion mismatch as failed evidence, not a vague note
- count successful CLI evidence as both agentic evidence and command evidence for CLI-oriented implementation, bug-fix, and QA tasks

Keep Phase 5 deliberately pipe-based.
It should cover most CLI tools, one-shot commands, REPLs with scripted stdin, and setup wizards that do not require terminal control sequences.
Full terminal UI verification belongs in Phase 6 because it needs a pseudo-terminal.

Implementation notes:

- Extend `VerificationEvidenceType` with `cli`.
- Extend `VerificationRunnerKind` with `cli-session`.
- Add `openteam verify cli`.
- Reuse the existing command runner's log, timeout, dev-env wrapping, and result append behavior.
- Add transcript artifact fields rather than overloading `logFile` for every stream.
- Teach project-profile detection to surface likely CLI entrypoints from package bins, Cargo binaries, Go commands, Python console scripts, and repo docs when easy.

## Phase 6: Terminal UI and Desktop GUI Sessions

Status: design target after Phase 5.

This phase should give agents a real local UI verification surface for terminal UIs and desktop applications without letting workers call random GUI openers directly.
The worker asks openteam to manage the session; openteam owns launch, artifact paths, cleanup, and evidence shape.

Add a local capability probe:

```bash
openteam verify capabilities
```

The probe should report availability for:

- display environment: `DISPLAY`, `WAYLAND_DISPLAY`, or headless/virtual display command
- terminal session support: `script`, `node-pty`, or another configured PTY backend
- window listing: `wmctrl`, `xdotool`, compositor-specific alternatives, or platform-specific APIs
- screenshot capture: `gnome-screenshot`, `grim`, `spectacle`, ImageMagick `import`, `screencapture`, or configured command
- desktop input: `xdotool`, platform automation, or configured command
- accessibility snapshot: AT-SPI, platform accessibility APIs, or configured command

Terminal UI commands:

```bash
openteam verify terminal --flow "search filters rows" -- ./target/debug/my-tui
openteam verify terminal --stdin-file .openteam/artifacts/verification/tui/keys.txt --expect-screen "3 results" -- cargo run --bin app
```

Desktop GUI commands:

```bash
openteam verify desktop launch desktop-command --flow "settings dialog opens"
openteam verify desktop screenshot --session <session-id> --note "Main window after importing fixture"
openteam verify desktop record --session <session-id> --state succeeded --note "Opened real fixture and verified row count in the desktop window."
openteam verify desktop stop --session <session-id>
```

Phase 6 scope:

- launch a configured desktop command in a managed verification session
- keep process ids, logs, display metadata, and cleanup metadata under `.openteam/artifacts/verification/desktop/`
- set checkout-local home/config/cache directories where supported so app state is isolated
- wait for a process, window title, socket, log line, or configured readiness command
- capture one or more screenshots as artifacts
- record window title/class/id metadata when available
- record display and automation blockers explicitly when local GUI capability is unavailable
- support terminal UI PTY transcript capture with a stable terminal size
- let workers record manual observations against a managed session when automated interaction is unavailable

Phase 6 should not install GUI packages, start system services, boot mobile simulators, or write app state outside the managed checkout/runtime.
If a desktop task requires missing host GUI capability, the runner records `blocked` evidence with the missing tool or display.

## Phase 7: Desktop Interaction Recipes

Status: later local enhancement.

Once launch and screenshots are reliable, add small, explicit interaction primitives instead of pretending openteam has a universal GUI brain.

Useful primitives:

- click by coordinates inside the captured window
- type text
- send hotkeys
- wait for window title/text/log pattern
- take screenshot before and after an interaction
- attach a repo fixture file to the app by configured path or drag/drop command when the platform supports it
- record accessibility tree snippets when a local API is available

Stack recipes should stay opt-in and explicit:

- Electron: configured app command plus window-title readiness and screenshots
- Tauri: configured dev/build/run command plus window-title readiness and screenshots
- GTK/Qt: configured binary command plus window metadata and screenshots
- Java/Swing/JavaFX: configured command plus window metadata and screenshots
- terminal TUIs: PTY backend plus transcript/screen assertions

The first useful desktop target is evidence capture, not universal automation.
Workers can still use direct human-style observation when the session is visible, but they should record structured evidence through `openteam verify desktop ...`.

## Low-Hanging Implementation Queue

Recommended order:

1. Add `cli` evidence type, `cli-session` runner kind, and `openteam verify cli`.
2. Add `openteam verify capabilities` so workers can discover local terminal/desktop affordances before trying a GUI flow.
3. Add `desktop-session` metadata on top of the existing `desktop-command` runner: launch, logs, PID, readiness, screenshot artifact, stop.
4. Add PTY-backed `openteam verify terminal` for terminal UI apps when a local PTY backend is available.
5. Add a small desktop screenshot command that records display/window metadata and a screenshot artifact without interaction.
6. Add optional desktop input commands only behind detected/configured local automation tools.
7. Update done-contract and evidence-policy wording so CLI and desktop tasks require CLI/desktop evidence rather than generic manual notes.
8. Add config examples for Electron, Tauri, GTK/Qt, and CLI tools in `config/openteam.local.example.json`.

## Boundary

Keep these simple and local:

- repo-native CLI checks
- Nix/dev-env wrapping
- Playwright MCP for single-browser validation
- explicit local desktop-app verification commands, including Electron, Tauri, GTK, Qt, and similar desktop stacks
- CLI product verification with transcripts, scripted stdin, and assertions
- terminal UI verification with a local PTY backend when available
- desktop GUI launch, screenshot, logs, window metadata, and explicit local automation when available

Mobile-native verification remains guarded and parked.
Do not spend the next phases on Android ADB, iOS simulators, device farms, or mobile-native app tooling.

## Evidence Contract

Workers should return success only with evidence.
The orchestrator creates a done contract for each run and injects it into the worker prompt.
The done contract is stored in the run record and summarized by `openteam runs evidence <run-id>`.
The minimum useful evidence is:

- what was verified
- which account/data/context was used
- what command, browser flow, GUI flow, or Nostr event was involved
- where logs, screenshots, artifacts, or event ids can be inspected
- what remains risky or unverified

If the worker cannot verify, it should record `blocked` or `failed` evidence instead of returning a confident success.
PR publication should happen only after successful verification evidence exists, unless the task explicitly asks for draft/WIP work.

Do not add network/device-farm behavior in this phase.
Remote MCP, CI, BrowserStack, Firebase Test Lab, AWS Device Farm, and macOS/iOS runner farms should be separate explicit adapters with their own leases, timeouts, artifacts, cost controls, and secret boundaries.
